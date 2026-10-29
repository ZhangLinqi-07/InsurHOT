// Bounded real-data trial. The worker stays off and every model request uses the engine's receipts.
// node --env-file=.env scripts/insurance/trial.ts [--sources id,id] [--analyze 8]
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { processArticle } from "@aihot/backend/jobs/content";
import { groupArticle } from "@aihot/backend/events/group";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { composeDaily, dueDaily } from "@aihot/backend/reports/compose";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { enrichNfra } from "../../modules/insurance/backend/nfra.ts";

const arg = (key: string, fallback: string) => { const at=process.argv.indexOf(key); return at<0 ? fallback : process.argv[at+1] ?? fallback; };
const ids=arg("--sources","nfra-928,caa-10,sina-56850,eastmoney-insurance,rss-insurance-journal,rss-reinsurance-news,pingan-news,picc-news,chinare-news,chinalife-news").split(",").filter(Boolean);
const count=Number(arg("--analyze","0"));
const output=resolve(arg("--out",".data/trial/latest.json"));
const skipCollect=process.argv.includes("--skip-collect");
if (!Number.isInteger(count)||count<0||count>20) throw new Error("--analyze must be an integer from 0 to 20");
if (!skipCollect && process.env.COLLECT_ENABLED!=="true") throw new Error("Set COLLECT_ENABLED=true for this explicit trial process");
if (count && process.env.MODEL_CALLS_ENABLED!=="true") throw new Error("Set MODEL_CALLS_ENABLED=true to run the paid model trial");
mkdirSync(dirname(output),{recursive:true});
const report: Record<string,unknown>={startedAt:new Date().toISOString(),model:process.env.LLM_MODEL,sourceIds:ids,requestedAnalyses:count,skipCollection:skipCollect,collections:[],articles:[]};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2));
try {
  if(count) await sql`UPDATE budgets SET per_minute=60,per_hour=150,per_day=200,note='InsurHOT bounded local trial' WHERE service='llm'`;
  for(const id of skipCollect ? [] : ids){
    const result=await collectSource(id,{force:true});
    (report.collections as unknown[]).push(result); save(); console.log(JSON.stringify({stage:"collect",...result}));
  }
  report.nfraBodies=await enrichNfra(12); save();
  // Round-robin over sources, so a large listing cannot crowd every other source out of the trial.
  const candidates=await sql<{id:string;source_id:string;title:string;url:string;body_status:string}[]>`
    SELECT id,source_id,title,url,body_status FROM (
      SELECT a.*,row_number() OVER(PARTITION BY source_id ORDER BY published_at DESC NULLS LAST,discovered_at DESC) AS rank
      FROM articles a WHERE source_id=ANY(${ids}::text[])
        AND processing_state = 'new'
    ) q ORDER BY rank,source_id LIMIT ${count}`;
  for(const article of candidates){
    const row: Record<string,unknown>={...article};
    try {
      if(article.body_status!=="ok") row.extraction=await extractArticleBody(article.id);
      row.processing=await processArticle(article.id);
      const [analysis]=await sql`SELECT relevance,category,tags,title_zh,summary_zh,score,selected,output->'scores' AS scores FROM analyses WHERE article_id=${article.id} ORDER BY input_revision DESC,id DESC LIMIT 1`;
      row.analysis=analysis??null;
      if(analysis?.relevance==="pass") row.grouping=await groupArticle(article.id);
      const [state]=await sql`SELECT a.revision,a.body_status,length(a.body_text) AS body_chars,a.processing_state,a.processing_error,a.grouping_status,p.visibility,p.eligible,p.selected,p.backfill
        FROM articles a LEFT JOIN publications p ON p.article_id=a.id WHERE a.id=${article.id}`;
      row.final=state;
      row.chainComplete=["analyzed","blocked","skipped"].includes(state?.processing_state) && !!analysis && (analysis.relevance!=="pass"||state.grouping_status==="complete");
    } catch(error){row.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
    (report.articles as unknown[]).push(row);save();console.log(JSON.stringify({stage:"article",...row}));
  }
  report.hot=await computeHotRanking();
  try{report.daily=await composeDaily(dueDaily());}catch(error){report.daily={status:"not_generated",reason:error instanceof Error?error.message:String(error)};}
  report.counts=await sql`SELECT (SELECT count(*) FROM articles)::int AS collected,(SELECT count(*) FROM articles WHERE body_status='ok')::int AS confirmed_bodies,
    (SELECT count(*) FROM analyses)::int AS analyses,(SELECT count(*) FROM publications WHERE visibility='public' AND eligible)::int AS readable_items,
    (SELECT count(*) FROM publications WHERE selected)::int AS selected,(SELECT count(*) FROM stories)::int AS events`;
  report.receipts=await sql`SELECT service,model,purpose,status,count(*)::int AS calls,sum((usage->>'prompt_tokens')::bigint)::text AS input_tokens,
    sum((usage->>'completion_tokens')::bigint)::text AS output_tokens FROM receipts GROUP BY service,model,purpose,status ORDER BY purpose,status`;
  report.finishedAt=new Date().toISOString();save();
  console.log(JSON.stringify({stage:"complete",counts:report.counts,hot:report.hot,daily:report.daily}));
}finally{await stopBoss();await closeDb();}
