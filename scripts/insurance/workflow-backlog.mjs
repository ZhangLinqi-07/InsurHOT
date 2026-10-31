// A single finite producer for the existing insurance.news-workflow consumer.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const imp=p=>import(pathToFileURL(resolve(root,p)).href);
const {sql,closeDb}=await imp('packages/backend/src/db.ts');
const {installModules}=await imp('packages/backend/src/modules.ts');
const {SERVER_MODULES}=await imp('site/modules/server.ts');installModules(SERVER_MODULES);
const {backlogWorkflowQueue,workflowFingerprint,workflowPolicy,backlogPolicyKey,backlogItemKey}=await imp('modules/insurance/backend/workflow.ts');
const {enqueueOn,stopBoss}=await imp('packages/backend/src/jobs/queue.ts');
const arg=name=>{const at=process.argv.indexOf(name);return at<0?null:process.argv[at+1]};
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=v=>createHash('sha256').update(v).digest('hex');
const write=(p,value)=>{writeFileSync(p+'.tmp',JSON.stringify(value,null,2));renameSync(p+'.tmp',p)};
const sourcePath=arg('--inventory');if(!sourcePath)throw Error('--inventory is required');
const inventory=read(sourcePath),runId=inventory.runId;
if(!/^[a-zA-Z0-9-]{1,80}$/.test(runId))throw Error('Invalid frozen run ID');
const dir=resolve(root,'.data/workflow-backlog',runId);mkdirSync(dir,{recursive:true});
const manifestPath=resolve(dir,'manifest.json'),statusPath=resolve(dir,'status.json');
const execute=process.argv.includes('--run');let lease;
try{
 const version=await workflowFingerprint();
 let manifest;
 if(existsSync(manifestPath))manifest=read(manifestPath);
 else{
  const protectedIds=new Set(read(resolve(root,'.data/relevance-camel-resume-20261030/final-reconciliation.json')).ledger.filter(a=>a.outcome==='PASS').map(a=>a.id));
  const items=inventory.items.filter(a=>a.scope==='within-half-year');
  if(items.length!==inventory.within||new Set(items.map(a=>a.id)).size!==items.length||items.some(a=>protectedIds.has(a.id)))throw Error('Frozen scope has duplicates or previously screened protected records');
  manifest={runId,preparedAt:new Date().toISOString(),frozenAt:inventory.frozenAt,from:inventory.from,to:inventory.to,boundary:inventory.boundary,
   inventoryHash:hash(readFileSync(sourcePath)),fingerprint:version.fingerprint,version:version.version,
   exclusions:inventory.counts,total:items.length,preflightHolds:items.filter(a=>a.preflightHold).length,
   execution:'one finite pass through the existing serial insurance.news-workflow queue; valid native receipts and stages are reused',
   items:items.map(a=>({id:a.id,revision:a.revision,contentHash:a.content_hash,sourceId:a.source_id,title:a.title,publishedAt:a.published_at,
    publicationTime:a.publication_time,createdAt:a.created_at,materialVersionSaved:a.material_version_saved,preflightHold:a.preflightHold}))};
  write(manifestPath,manifest);
 }
 if(manifest.inventoryHash!==hash(readFileSync(sourcePath))||manifest.fingerprint!==version.fingerprint)throw Error('Frozen inventory or workflow configuration changed; no requests started');
 const manifestHash=hash(readFileSync(manifestPath));
 if(!execute){console.log(JSON.stringify({runId,total:manifest.total,preflightHolds:manifest.preflightHolds,readyBeforeNativeMaterialGates:manifest.total-manifest.preflightHolds,
  exclusions:manifest.exclusions,from:manifest.from,to:manifest.to,fingerprint:manifest.fingerprint,manifestHash,models:manifest.version.routes,newModelCalls:0}));}
 else{
  if(process.env.MODEL_CALLS_ENABLED!=='true'||process.env.COLLECT_ENABLED!=='false')throw Error('Run with local-node.mjs --workflow');
  const ready=read(resolve(root,'.data/insurance-workflow/ready.json'));
  if(ready.workflowFingerprint!==manifest.fingerprint)throw Error('The existing workflow consumer has not loaded the pinned workflow version');
  try{process.kill(ready.pid,0)}catch{throw Error('The existing workflow consumer is not running')}
  lease=await sql.reserve();const [lock]=await lease`SELECT pg_try_advisory_lock(hashtext('insurance.workflow.backlog.driver'),0) AS locked`;
  if(!lock.locked)throw Error('Another one-time workflow producer is already active');
  const metaKey=backlogPolicyKey(runId),previous=await sql`SELECT value FROM settings WHERE key=${metaKey}`;
  if(previous[0]&&previous[0].value.manifestHash!==manifestHash)throw Error('A different manifest already owns this run ID');
  if(previous[0]?.value.status==='complete'){console.log(JSON.stringify(previous[0].value));process.exitCode=0;}
  else{
   const startedAt=previous[0]?.value.startedAt??new Date().toISOString();
   const meta={enabled:true,status:'running',runId,manifestHash,fingerprint:manifest.fingerprint,from:manifest.from,to:manifest.to,frozenAt:manifest.frozenAt,
    startedAt,pid:process.pid,total:manifest.total,consumerPid:ready.pid,concurrency:8};
   await sql`INSERT INTO settings(key,value,updated_by) VALUES(${metaKey},${sql.json(meta)},'insurance.workflow.backlog')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now(),updated_by=excluded.updated_by`;
   await sql`INSERT INTO settings(key,value,updated_by) VALUES('insurance.workflow.backlog.active',${sql.json({runId})},'insurance.workflow.backlog') ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`;
   for(let offset=0;offset<manifest.items.length;offset+=250){
    const values=manifest.items.slice(offset,offset+250).map(a=>({key:backlogItemKey(runId,a.id),value:{id:a.id,revision:a.revision,contentHash:a.contentHash,
     manifestHash,status:a.preflightHold||!a.materialVersionSaved?'held':'pending',reason:a.preflightHold??(!a.materialVersionSaved?'Original material revision snapshot is missing':null)},updated_by:'insurance.workflow.backlog'}));
    await sql`INSERT INTO settings ${sql(values,'key','value','updated_by')} ON CONFLICT(key) DO NOTHING`;
   }
   const members=(await sql`SELECT key,value FROM settings WHERE starts_with(key,${metaKey+'.article.'})`).map(a=>({key:a.key,...a.value}));
   if(members.length!==manifest.total||members.some(a=>a.manifestHash!==manifestHash))throw Error('Frozen membership does not match the manifest');
   const frozen=new Map(manifest.items.map(a=>[a.id,a]));const terminal=new Set(['complete','blocked','held','failed']);
   let stopping=false;process.on('SIGINT',()=>{stopping=true});process.on('SIGTERM',()=>{stopping=true});
   const set=async(item,status,reason=null,extra={})=>{Object.assign(item,{status,reason,updatedAt:new Date().toISOString()},extra);const {key,...value}=item;
    await sql`UPDATE settings SET value=${sql.json(value)},updated_at=now() WHERE key=${key}`;};
   const summary=async(status)=>{
    const counts=members.reduce((a,v)=>(a[v.status]=(a[v.status]??0)+1,a),{});
    const ids=manifest.items.map(a=>a.id);
    const receipts=await sql`SELECT id,purpose,status,created_at,received_at,completed_at,subject FROM receipts
      WHERE created_at>=${startedAt}::timestamptz AND split_part(split_part(subject,':',2),'@',1)=ANY(${ids}::text[]) ORDER BY id ASC LIMIT 3`;
    const [receiptCounts]=await sql`SELECT count(*)::int AS native_receipts,count(*) FILTER(WHERE received_at IS NOT NULL)::int AS responses
      FROM receipts WHERE created_at>=${startedAt}::timestamptz AND split_part(subject,':',2)=ANY(${ids}::text[])`;
    const [publication]=await sql`SELECT count(*) FILTER(WHERE eligible AND visibility='public')::int AS eligible,
      count(*) FILTER(WHERE selected AND eligible AND visibility='public')::int AS selected FROM publications WHERE article_id=ANY(${ids}::text[])`;
    const result={...meta,status,at:new Date().toISOString(),counts,accounted:members.filter(a=>terminal.has(a.status)).length,
     remaining:members.filter(a=>!terminal.has(a.status)).length,firstReceipts:receipts,receiptCounts,publication,
     latestTerminal:members.filter(a=>terminal.has(a.status)&&a.updatedAt).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,5).map(a=>({id:a.id,status:a.status,reason:a.reason,at:a.updatedAt})),
     active:members.filter(a=>a.status==='queued').map(a=>({id:a.id,revision:a.revision,stage:a.stage,nextAttemptAt:a.nextAttemptAt}))};
    write(statusPath,result);console.log(JSON.stringify(result));return result;
   };
   await summary('running');
   while(!stopping&&!existsSync(resolve(dir,'STOP'))){
    const policy=await workflowPolicy();
    if(!policy?.enabled||(await workflowFingerprint()).fingerprint!==manifest.fingerprint){await summary('paused-workflow-or-config-changed');break;}
    const queued=members.filter(a=>a.status==='queued');
    if(queued.length){
     const rows=await sql`SELECT a.id,a.revision,a.content_hash,a.published_at,a.publication_time,s.enabled,s.participation_mode,coalesce(o.visibility,'public') AS visibility,
       w.input_revision,w.stage,w.status,w.error,w.error_kind,w.next_attempt_at
       FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN editorial_overrides o ON o.article_id=a.id
       LEFT JOIN insurance_news_workflow w ON w.article_id=a.id WHERE a.id=ANY(${queued.map(a=>a.id)}::text[])`;
     const lookup=new Map(rows.map(a=>[a.id,a]));
     for(const item of queued){const row=lookup.get(item.id),f=frozen.get(item.id);
      if(!row||row.revision!==item.revision||row.content_hash!==f.contentHash){await set(item,'held','Material changed after the frozen snapshot');continue;}
      if(!row.enabled||row.participation_mode!=='editorial'||row.visibility!=='public'||!row.publication_time||!row.published_at||new Date(row.published_at)<new Date(manifest.from)||new Date(row.published_at)>new Date(manifest.to)){await set(item,'held','Current source, visibility or original publication date no longer meets the frozen rules');continue;}
      if(row.input_revision!==item.revision){await set(item,'held','A different revision owns the native workflow checkpoint');continue;}
      item.stage=row.stage;item.nextAttemptAt=row.next_attempt_at;
      if(terminal.has(row.status)){await set(item,row.status,row.error,{stage:row.stage,failureKind:row.error_kind});continue;}
      if(row.status==='waiting'&&row.error==='Waiting for article text'){await set(item,'held','Native workflow is waiting for original article text',{stage:row.stage});continue;}
      if(row.status==='waiting'&&new Date(row.next_attempt_at)>new Date())continue;
      await enqueueOn(backlogWorkflowQueue,{articleId:item.id,revision:item.revision,backlogRun:runId},{singletonKey:`${item.id}@${item.revision}`});
     }
    }
    const open=members.filter(a=>a.status==='queued').length;
    for(const item of members.filter(a=>a.status==='pending').slice(0,Math.max(0,12-open))){
     await sql.begin(async tx=>{
      const [a]=await tx`SELECT revision,content_hash FROM articles WHERE id=${item.id} FOR UPDATE`;
      if(!a||a.revision!==item.revision||a.content_hash!==item.contentHash){item.status='held';item.reason='Material changed after the frozen snapshot';}
      else{
       await tx`INSERT INTO insurance_news_workflow(article_id,input_revision) VALUES(${item.id},${item.revision}) ON CONFLICT(article_id) DO NOTHING`;
       const [w]=await tx`SELECT input_revision,status,stage,error FROM insurance_news_workflow WHERE article_id=${item.id}`;
       if(w.input_revision!==item.revision){item.status='held';item.reason='A different revision owns the native workflow checkpoint';}
       else if(terminal.has(w.status)){item.status=w.status;item.reason=w.error;item.stage=w.stage;}
       else item.status='queued';
      }
      item.updatedAt=new Date().toISOString();const {key,...value}=item;
      await tx`UPDATE settings SET value=${tx.json(value)},updated_at=now() WHERE key=${key}`;
      if(item.status==='queued')await enqueueOn(backlogWorkflowQueue,{articleId:item.id,revision:item.revision,backlogRun:runId},{singletonKey:`${item.id}@${item.revision}`},tx);
     });
    }
    const finished=members.every(a=>terminal.has(a.status));const result=await summary(finished?'complete':'running');
    if(finished){meta.enabled=false;meta.status='complete';meta.finishedAt=result.at;await sql`UPDATE settings SET value=${sql.json(meta)},updated_at=now() WHERE key=${metaKey}`;break;}
    await delay(10000);
   }
   if(stopping||existsSync(resolve(dir,'STOP'))){meta.enabled=false;meta.status='paused';await sql`UPDATE settings SET value=${sql.json(meta)},updated_at=now() WHERE key=${metaKey}`;await summary('paused');}
  }
 }
}catch(error){console.error(JSON.stringify({event:'blocked',message:String(error),at:new Date().toISOString()}));process.exitCode=1;}
finally{if(lease){await lease`SELECT pg_advisory_unlock(hashtext('insurance.workflow.backlog.driver'),0)`;lease.release()}await stopBoss();await closeDb()}
