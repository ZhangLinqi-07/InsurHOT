// User-authorised fixed trial: 100 frozen articles, at most one prefilter request per article.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql, closeDb } from "@aihot/backend/db";
import { loadAnalyzeInput, type AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { modelFor } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";
import { PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { screenFrozenArticle } from "../../modules/insurance/backend/screening.ts";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";

installModules(SERVER_MODULES);

const dir = ".data/insurance-ingestion/screening-trial";
const runId = "insurance-relevance-100-20261029";
mkdirSync(dir, { recursive: true });
const manifestPath = `${dir}/manifest.json`;
const outputPath = `${dir}/results.json`;
let originalBudget: any = null;
let service = "";
try {
  if (!existsSync(manifestPath)) {
    const selected = await sql`SELECT id FROM (
      SELECT a.id,a.source_id,a.published_at,a.backfill,row_number() OVER(PARTITION BY a.source_id ORDER BY a.backfill,a.published_at DESC,a.id) AS source_rank
      FROM articles a JOIN sources s ON s.id=a.source_id WHERE s.enabled AND a.processing_state='new'
        AND a.body_status='ok' AND length(a.body_text)>=200 AND a.published_at >= '2024-10-28T16:00:00Z'
        AND NOT EXISTS(SELECT 1 FROM analyses an WHERE an.article_id=a.id AND an.input_revision=a.revision)
    ) candidates ORDER BY source_rank,backfill,published_at DESC,source_id,id LIMIT 100`;
    if (selected.length !== 100) throw new Error("Need 100 eligible real articles before preparing this trial");
    const inputs: AnalyzeInputArticle[] = [];
    for (const row of selected) inputs.push((await loadAnalyzeInput(row.id))!);
    const manifest = { runId, preparedAt: new Date().toISOString(), requestedArticles: 100, maxNewRequests: 100,
      promptVersion: PROMPT_VERSIONS.prefilter, model: await modelFor("prefilter"), inputs,
      baselineAttempts: await sql`SELECT service,count(*)::int AS n FROM receipt_attempts GROUP BY service` };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  if (manifest.runId !== runId || manifest.inputs.length !== 100 || manifest.maxNewRequests !== 100 || manifest.promptVersion !== PROMPT_VERSIONS.prefilter
    || manifest.model !== await modelFor("prefilter")) throw new Error("Trial manifest or model/prompt changed");
  if (process.argv.includes("--prepare")) {
    console.log(JSON.stringify({ runId, manifestSha256, samples: manifest.inputs.length, model: manifest.model, prepared: true }));
  } else {
    if (process.env.MODEL_CALLS_ENABLED !== "true") throw new Error("Use local-node.mjs --models for the explicitly authorised trial");
    if (existsSync(outputPath) && JSON.parse(readFileSync(outputPath, "utf8")).finishedAt) throw new Error("This fixed trial already finished; no new calls authorised");
    service = MODELS[manifest.model].service;
    const [budget] = await sql`SELECT * FROM budgets WHERE service=${service}`;
    if (!budget) throw new Error("The model service must have an existing budget row");
    originalBudget = budget;
    const [counts] = await sql`SELECT count(*) FILTER(WHERE started_at>now()-interval '1 hour')::int AS hour,
      count(*)::int AS day FROM receipt_attempts WHERE service=${service} AND origin='live' AND started_at>now()-interval '1 day'`;
    writeFileSync(`${dir}/budget.json`, JSON.stringify({ at: new Date().toISOString(), service, originalBudget, counts, runId, maxNewRequests: 100 }, null, 2));
    await sql`UPDATE budgets SET per_minute=${Math.min(20, budget.per_minute)},per_hour=${counts.hour + 100},per_day=${counts.day + 100},note=${runId} WHERE service=${service}`;
    const results: any[] = [];
    const save = async (finished = false) => {
      const attempts = await sql`SELECT service,count(*)::int AS n FROM receipt_attempts GROUP BY service`;
      const report = { runId, manifestSha256, requestedArticles: 100, maxNewRequests: 100, promptVersion: manifest.promptVersion, model: manifest.model,
        checkedAt: new Date().toISOString(), ...(finished ? { finishedAt: new Date().toISOString() } : {}),
        screened: results.filter(r => r.status === "screened").length, failed: results.filter(r => r.status === "failed").length,
        unresolved: results.filter(r => r.status === "attempted").length,
        labels: Object.fromEntries(["PASS", "BLOCK", "UNKNOWN"].map(label => [label, results.filter(r => r.label === label).length])),
        baselineAttempts: manifest.baselineAttempts, currentAttempts: attempts, results };
      writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
    };
    let nextCallAt = 0;
    for (const frozen of manifest.inputs) {
      if (Date.now() < nextCallAt) await delay(nextCallAt - Date.now());
      nextCallAt = Date.now() + 3100;
      const input: AnalyzeInputArticle = { ...frozen, publishedAt: frozen.publishedAt ? new Date(frozen.publishedAt) : null,
        discoveredAt: frozen.discoveredAt ? new Date(frozen.discoveredAt) : null };
      const result = await screenFrozenArticle(input, runId);
      results.push({ title: input.title, url: input.url, source: input.source.name, publishedAt: input.publishedAt, ...result });
      await save();
      console.log(JSON.stringify({ done: results.length, status: result.status, label: result.label, receiptId: result.receiptId, error: result.error }));
    }
    await save(true);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    console.log(JSON.stringify({ completed: true, screened: report.screened, failed: report.failed, labels: report.labels, outputPath }));
  }
} finally {
  if (originalBudget) await sql`UPDATE budgets SET per_minute=${originalBudget.per_minute},per_hour=${originalBudget.per_hour},per_day=${originalBudget.per_day},note=${originalBudget.note}
    WHERE service=${service} AND note=${runId}`;
  await stopBoss();
  await closeDb();
}
