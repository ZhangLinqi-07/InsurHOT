import {spawn,execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createConnection} from 'node:net';
import {startCollector} from './collector-service.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const stateFile=resolve(root,'.data/local-services.json');
const [major,minor,patch]=process.versions.node.split('.').map(Number);
if(major<24||major===24&&(minor<22||minor===22&&patch<1))throw new Error('Use Node.js 24.22.1 or newer.');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
if(existsSync(stateFile)&&JSON.parse(readFileSync(stateFile,'utf8').replace(/^\uFEFF/,'' )).services.some(s=>alive(s.pid)))throw new Error('InsurHOT is already running. Use stop-local.ps1 first.');
for(const port of [3000,3001]){
  const occupied=await new Promise(resolve=>{
    const socket=createConnection({host:'127.0.0.1',port});
    const finish=value=>{socket.destroy();resolve(value);};
    socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(1000,()=>finish(false));
  });
  if(occupied)throw new Error(`Port ${port} is already occupied.`);
}
if(process.platform==='win32'){
  const hostFile=resolve(root,'.data/wsl-host.json');
  const host=existsSync(hostFile)?JSON.parse(readFileSync(hostFile,'utf8').replace(/^\uFEFF/,'')):null;
  if(!host||!alive(host.pid)){
    const hold=spawn('wsl.exe',['-d','Ubuntu','--exec','sleep','infinity'],{detached:true,windowsHide:true,stdio:'ignore'});
    await once(hold,'spawn');hold.unref();
    writeFileSync(hostFile,JSON.stringify({pid:hold.pid,purpose:'Keep WSL PostgreSQL available to InsurHOT'}));
  }
  execFileSync('wsl.exe',['-d','Ubuntu','-u','root','--','bash','-lc','pg_ctlcluster 16 main start; pg_isready -p 55432'],{windowsHide:true,stdio:'ignore'});
}
const services=[];
for(const [name,entry] of [['api','apps/api/src/main.ts'],['web','apps/web/server.ts']]){
  const out=openSync(resolve(root,`.data/${name}.log`),'a');
  const err=openSync(resolve(root,`.data/${name}.err.log`),'a');
  const child=spawn(process.execPath,[resolve(root,'scripts/insurance/local-node.mjs'),resolve(root,entry)],{
    cwd:root,env:{...process.env,NODE_ENV:'production'},detached:true,windowsHide:true,stdio:['ignore',out,err],
  });
  await once(child,'spawn');child.unref();closeSync(out);closeSync(err);
  services.push({name,pid:child.pid});
}
writeFileSync(stateFile,JSON.stringify({startedAt:new Date().toISOString(),url:'http://localhost:3000',live:false,services},null,2));
let ready=false;
for(let n=0;n<40;n++){
  try{const r=await fetch('http://localhost:3000/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
  await delay(500);
}
if(!ready)throw new Error('InsurHOT did not become ready. Inspect .data/api.err.log and .data/web.err.log.');
await startCollector();
console.log('InsurHOT ready at http://localhost:3000; free source collection is running, model processing remains off.');
