// Optional paid services are enabled only by this site's own .env, never by machine-wide credentials.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const local=parseEnv(readFileSync(resolve(root,'.env'),'utf8'));
for(const key of Object.keys(process.env)){
  if(/^(?:EMBEDDING_|DASHSCOPE_|DEEPSEEK_|ZHIPU_|XIAOMI_MIMO_|SOCIALDATA_|FEISHU_|DEV_AUTH_|LLM_|PREFILTER_MODEL$|SCORE_MODEL$|UNDERSTAND_MODEL$|SUMMARIZE_MODEL$|WORDING_MODEL$|STRUCTURE_MODEL$|GROUP_MODEL$|GROUP_REVIEW_MODEL$|DIGEST_MODEL$|REPORT_MODEL$|TRANSLATE_MODEL$)/.test(key)
    || ['DAJIALA_KEY','JINA_API_KEY','AIHOT_CREDENTIALS_DIR','INGEST_TOKEN','ADMIN_FEISHU_UNION_IDS','ADMIN_EMAILS'].includes(key)) delete process.env[key];
}
Object.assign(process.env,local);
const args=process.argv.slice(2);
while(args[0]?.startsWith('--')){
  const flag=args.shift();
  if(flag==='--models')process.env.MODEL_CALLS_ENABLED='true';
  else if(flag==='--workflow'){
    process.env.MODEL_CALLS_ENABLED='true';
    process.env.DATABASE_POOL_MAX ??= '32';
    process.env.COLLECT_ENABLED='false';
    // This service owns news processing only. Collection runs in the existing free service.
    for(const key of Object.keys(process.env)){
      if(/^(?:EMBEDDING_|DASHSCOPE_|SOCIALDATA_)/.test(key)||['JINA_API_KEY','DAJIALA_KEY'].includes(key))delete process.env[key];
      if(/^FEISHU_.*_ENABLED$/.test(key)||key==='INDEXNOW_SUBMIT_ENABLED')process.env[key]='false';
    }
  }
  else if(flag==='--collect')process.env.COLLECT_ENABLED='true';
  else if(flag==='--collect-only'){
    process.env.COLLECT_ENABLED='true';
    process.env.MODEL_CALLS_ENABLED='false';
    process.env.AIHOT_CREDENTIALS_DIR=resolve(root,'.data/insurance-ingestion/no-credentials');
    for(const key of Object.keys(process.env)){
      if(/^(?:LLM_|EMBEDDING_|DASHSCOPE_|DEEPSEEK_|ZHIPU_|XIAOMI_MIMO_|SOCIALDATA_)/.test(key)||['JINA_API_KEY','DAJIALA_KEY'].includes(key))delete process.env[key];
      if(/^FEISHU_.*_ENABLED$/.test(key)||key==='INDEXNOW_SUBMIT_ENABLED')process.env[key]='false';
    }
  }
  else throw new Error(`Unknown local launcher option ${flag}`);
}
if(!args.length)throw new Error('Pass a Node script after optional --models / --collect / --workflow');
const target=resolve(process.cwd(),args.shift());
process.argv=[process.execPath,target,...args];
await import(pathToFileURL(target).href);
