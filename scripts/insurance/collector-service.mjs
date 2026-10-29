import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export async function startCollector(){
  const dir=resolve(root,'.data/insurance-ingestion');
  mkdirSync(dir,{recursive:true});
  const stateFile=resolve(dir,'service.json');
  if(existsSync(stateFile)){
    const state=JSON.parse(readFileSync(stateFile,'utf8'));
    try{process.kill(state.pid,0);return state;}catch{}
  }
  for(const file of ['stop','stopped.json'])if(existsSync(resolve(dir,file)))unlinkSync(resolve(dir,file));
  const out=openSync(resolve(dir,'service.log'),'a');
  const err=openSync(resolve(dir,'service.err.log'),'a');
  const child=spawn(process.execPath,[resolve(root,'scripts/insurance/local-node.mjs'),'--collect-only',resolve(root,'scripts/insurance/collector-daemon.ts')],{
    cwd:root,detached:true,windowsHide:true,stdio:['ignore',out,err],
  });
  await once(child,'spawn');child.unref();closeSync(out);closeSync(err);
  const state={pid:child.pid,startedAt:new Date().toISOString(),mode:'free-collection-only',modelsEnabled:false};
  writeFileSync(stateFile,JSON.stringify(state,null,2));
  return state;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await startCollector()));
