// Complete grouping and report inspection from saved analyses, without repeating any article analysis.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { groupArticle } from "@aihot/backend/events/group";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { composeDaily, dueDaily } from "@aihot/backend/reports/compose";

const filename=".data/trial/latest.json";
const initial=".data/trial/initial-report.json";
if(!existsSync(initial))copyFileSync(filename,initial);
const report=JSON.parse(readFileSync(initial,"utf8"));
report.supersedes=initial;
report.reportCorrection="The initial metadata query used columns absent from this schema. This supplement reads the saved analyses and completes grouping without repeating analysis calls.";
report.finalizedAt=new Date().toISOString();
try{
  const before=await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose IN ('prefilter_article','score_article','structure_article','understand_article','summarize_article','mend_wording')`;
  report.articles=[];
  const original=JSON.parse(readFileSync(initial,"utf8"));
  for(const article of original.articles){
    const {error:reportingError,...row}=article;
    const [analysis]=await sql`SELECT relevance,category,tags,title_zh,summary_zh,score,selected,output->'scores' AS scores,receipt_ids FROM analyses WHERE article_id=${article.id} ORDER BY input_revision DESC,id DESC LIMIT 1`;
    row.analysis=analysis??null;
    if(analysis?.relevance==="pass"){
      const [previous]=await sql`SELECT grouping_status FROM articles WHERE id=${article.id}`;
      row.grouping=previous.grouping_status==="complete"?{verdict:"already-complete"}:await groupArticle(article.id);
    }
    const [state]=await sql`SELECT a.revision,a.body_status,length(a.body_text) AS body_chars,a.processing_state,a.processing_error,a.grouping_status,
      p.visibility,p.eligible,p.selected,p.backfill FROM articles a LEFT JOIN publications p ON p.article_id=a.id WHERE a.id=${article.id}`;
    row.final=state;
    row.chainComplete=["analyzed","blocked","skipped"].includes(state?.processing_state) && !!analysis && (analysis.relevance!=="pass"||state.grouping_status==="complete");
    report.articles.push(row);
    writeFileSync(filename,JSON.stringify(report,null,2));
    console.log(JSON.stringify({stage:"finalize",...row}));
  }
  const after=await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose IN ('prefilter_article','score_article','structure_article','understand_article','summarize_article','mend_wording')`;
  report.analysisCallsRepeated=Number(after[0].n)-Number(before[0].n);
  report.hot=await computeHotRanking();
  try{report.daily=await composeDaily(dueDaily());}catch(error){report.daily={status:"not_generated",reason:error instanceof Error?error.message:String(error)};}
  report.counts=await sql`SELECT (SELECT count(*) FROM articles)::int AS collected,(SELECT count(*) FROM articles WHERE body_status='ok')::int AS confirmed_bodies,
    (SELECT count(*) FROM analyses)::int AS analyses,(SELECT count(*) FROM publications WHERE visibility='public' AND eligible)::int AS readable_items,
    (SELECT count(*) FROM publications WHERE selected)::int AS selected,(SELECT count(*) FROM stories)::int AS events`;
  report.receipts=await sql`SELECT service,model,purpose,status,count(*)::int AS calls,sum((usage->>'prompt_tokens')::bigint)::text AS input_tokens,
    sum((usage->>'completion_tokens')::bigint)::text AS output_tokens FROM receipts GROUP BY service,model,purpose,status ORDER BY purpose,status`;
  report.finishedAt=new Date().toISOString();
  writeFileSync(filename,JSON.stringify(report,null,2));
  console.log(JSON.stringify({stage:"complete",repeated:report.analysisCallsRepeated,counts:report.counts,hot:report.hot,daily:report.daily}));
}finally{await stopBoss();await closeDb();}
