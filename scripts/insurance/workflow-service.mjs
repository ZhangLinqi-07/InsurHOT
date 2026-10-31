import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const dir=resolve(root,'.data/insurance-workflow');
const stateFile=resolve(dir,'service.json');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const control=command=>JSON.parse(execFileSync(process.execPath,[resolve(root,'scripts/insurance/local-node.mjs'),resolve(root,'scripts/insurance/workflow-control.ts'),command],{cwd:root,windowsHide:true,encoding:'utf8'}).trim());

export async function startWorkflow({enable=false}={}){
  mkdirSync(dir,{recursive:true});
  const status=control(enable?'enable':'status');
  if(!status.policy?.enabled)return null;
  if(existsSync(stateFile)){
    const state=JSON.parse(readFileSync(stateFile,'utf8'));
    if(alive(state.pid))return state;
  }
  for(const file of ['stop','stopped.json','ready.json'])if(existsSync(resolve(dir,file)))unlinkSync(resolve(dir,file));
  const out=openSync(resolve(dir,'service.log'),'a');
  const err=openSync(resolve(dir,'service.err.log'),'a');
  const child=spawn(process.execPath,[resolve(root,'scripts/insurance/local-node.mjs'),'--workflow',resolve(root,'scripts/insurance/workflow-daemon.ts')],{
    cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err],
  });
  await once(child,'spawn');child.unref();closeSync(out);closeSync(err);
  const state={pid:child.pid,startedAt:new Date().toISOString(),mode:'new-news-only',boundary:status.policy.startedAt,modelsEnabled:true};
  writeFileSync(stateFile,JSON.stringify(state,null,2));
  for(let n=0;n<60;n++){
    if(existsSync(resolve(dir,'ready.json')))return state;
    if(!alive(child.pid))throw new Error('Workflow exited. Inspect .data/insurance-workflow/service.err.log');
    await delay(500);
  }
  throw new Error('Workflow startup is still pending. Inspect .data/insurance-workflow/service.err.log');
}

export async function stopWorkflow({disable=false}={}){
  const status=control(disable?'disable':'status');
  if(!existsSync(stateFile))return status;
  const state=JSON.parse(readFileSync(stateFile,'utf8'));
  writeFileSync(resolve(dir,'stop'),'stop');
  for(let n=0;n<50&&alive(state.pid);n++)await delay(1000);
  if(alive(state.pid))throw new Error('Workflow is finishing a paid stage. Stop again after its current request completes.');
  return status;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const command=process.argv[2]??'status';
  if(command==='enable'||command==='start')console.log(JSON.stringify(await startWorkflow({enable:command==='enable'})));
  else if(command==='disable'||command==='stop')console.log(JSON.stringify(await stopWorkflow({disable:command==='disable'})));
  else if(command==='status'){
    const service=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):null;
    console.log(JSON.stringify({...control('status'),service:service?{...service,running:alive(service.pid)}:null}));
  }
  else throw new Error('Use enable, start, stop, disable or status');
}
