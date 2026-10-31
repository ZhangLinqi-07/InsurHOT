import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { credential } from "@aihot/backend/config";
import { modelFor } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";
import { failureKind } from "@aihot/backend/providers/receipts";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { isChineseSource } from "../../modules/insurance/backend/source-scope.ts";
import { readingInputHash, READING_SCORE_VERSION, scoreClassifiedArticle } from "../../modules/insurance/backend/reading-score.ts";

installModules(SERVER_MODULES);
const valueOf = (flag: string) => { const at = process.argv.indexOf(flag); return at < 0 ? null : process.argv[at + 1] ?? null; };
const execute = process.argv.includes("--run");
const limit = Number(valueOf("--limit") ?? 0);
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
const manifestPath = valueOf("--manifest") ?? `.data/reading-score/${new Date().toISOString().replace(/[:.]/g, "-")}/manifest.json`;
const reportPath = `${dirname(manifestPath)}/report.json`;
mkdirSync(dirname(manifestPath), { recursive: true });

interface Item { id: string; sourceId: string; title: string; summary: string; category: string; inputHash: string; publishedAt: string | null }
interface Manifest { version: string; preparedAt: string; modelKey: string; model: string; service: string; host: string; order: string; items: Item[] }
try {
  const modelKey = await modelFor("score");
  const spec = MODELS[modelKey]!;
  const host = new URL(credential("models", spec.baseUrlEnv) ?? "http://unconfigured").hostname;
  if (host !== "api.camel-hub.cn") throw new Error("This assigned scoring run requires the configured Camel endpoint");
  let manifest: Manifest;
  if (valueOf("--manifest")) manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  else {
    const rows = await sql`SELECT p.article_id,p.source_id,p.title,p.summary,p.category,p.published_at
      FROM publications p WHERE p.eligible AND p.visibility='public' AND p.classification IS NOT NULL AND p.category IS NOT NULL
        AND length(trim(coalesce(p.summary,'')))>0 ORDER BY p.published_at DESC NULLS LAST,p.article_id`;
    // Preserve the previous China-first backlog scope and newest-first order, with stable article-id ties.
    rows.sort((a, b) => Number(isChineseSource(b.source_id)) - Number(isChineseSource(a.source_id)));
    const items = rows.map(p => ({ id: String(p.article_id), sourceId: String(p.source_id), title: String(p.title), summary: String(p.summary),
      category: String(p.category), inputHash: readingInputHash(p as unknown as Item), publishedAt: p.published_at?.toISOString() ?? null }));
    manifest = { version: READING_SCORE_VERSION, preparedAt: new Date().toISOString(), modelKey, model: spec.model, service: spec.service, host,
      order: "China sources first, then other sources; within each scope published_at descending, article_id ascending", items };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  if (manifest.version !== READING_SCORE_VERSION || manifest.modelKey !== modelKey || manifest.model !== spec.model || manifest.host !== host)
    throw new Error("Prompt or model changed since this manifest was prepared; prepare a new manifest");
  const existing = await sql`SELECT article_id,input_hash FROM insurance_reading_scores WHERE prompt_version=${READING_SCORE_VERSION} AND model=${spec.model}`;
  const known = new Set(existing.map(p => `${p.article_id}:${p.input_hash}`));
  const pending = manifest.items.filter(p => !known.has(`${p.id}:${p.inputHash}`)).length;
  const [budget] = await sql`SELECT service,per_minute,per_hour,per_day,note FROM budgets WHERE service=${spec.service}`;
  const report: Record<string, any> = { version: READING_SCORE_VERSION, preparedAt: manifest.preparedAt, checkedAt: new Date().toISOString(), execute,
    manifestPath, manifestHash: createHash("sha256").update(readFileSync(manifestPath)).digest("hex"), total: manifest.items.length,
    pending, minimumNewRequests: pending * 2, budget, order: manifest.order, model: spec.model, host,
    moneyEstimate: null, moneyEstimateReason: "Camel unit prices are not configured; receipts retain actual usage", counts: {}, results: [] };
  const save = () => {
    report.checkedAt = new Date().toISOString();
    report.counts = Object.fromEntries([...new Set(report.results.map((p: any) => p.status))].map(status => [String(status), report.results.filter((p: any) => p.status === status).length]));
    report.processed = report.results.length;
    report.remainingInManifest = manifest.items.length - report.results.length;
    report.completed = manifest.items.filter(item => known.has(`${item.id}:${item.inputHash}`)).length;
    report.remainingUnscored = manifest.items.length - report.completed;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  };
  save();
  if (execute) {
    if (process.env.MODEL_CALLS_ENABLED !== "true") throw new Error("Use local-node.mjs --models for the authorized Camel scoring process");
    for (const item of manifest.items.slice(0, limit || manifest.items.length)) {
      let result: Record<string, unknown>;
      try { result = { id: item.id, at: new Date().toISOString(), ...await scoreClassifiedArticle(item.id, { model: modelKey, expectedHash: item.inputHash }) }; }
      catch (error) { result = { id: item.id, at: new Date().toISOString(), status: "failed", failureKind: failureKind(error), reason: (error as Error).message.slice(0, 500) }; }
      if (result.status === "scored") known.add(`${item.id}:${item.inputHash}`);
      report.results.push(result); save();
      console.log(JSON.stringify({ done: report.results.length, total: report.total, ...result }));
      if (["budget", "off", "busy", "outage", "unknown"].includes(String(result.failureKind))) { report.stopped = result.reason; save(); break; }
    }
    report.finishedAt = new Date().toISOString(); save();
  }
  console.log(JSON.stringify({ manifestPath, reportPath, total: report.total, pending, minimumNewRequests: report.minimumNewRequests,
    counts: report.counts, completed: report.completed, remainingUnscored: report.remainingUnscored,
    remainingInManifest: report.remainingInManifest, stopped: report.stopped ?? null, model: report.model, host }));
} finally { await stopBoss(); await closeDb(); }
