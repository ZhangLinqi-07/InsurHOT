// Finite, versioned batch. Existing paid-request budgets remain authoritative; never raises them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { analyzeArticle, analysisPromptVersion } from "@aihot/backend/editorial/analyze";
import { translatePreview, PREVIEW_TRANSLATE_VERSION } from "@aihot/backend/editorial/preview-translate";
import { modelFor } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";
import { failureKind } from "@aihot/backend/providers/receipts";
import { publishArticle } from "@aihot/backend/publication/publish";
import { groupArticle } from "@aihot/backend/events/group";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { isChineseText } from "@aihot/backend/lib/text";
import { isChineseSource } from "../../modules/insurance/backend/source-scope.ts";

installModules(SERVER_MODULES);
const mode = process.argv.includes("--translate") ? "foreign-preview" : "china";
const execute = process.argv.includes("--run");
const version = mode === "china" ? analysisPromptVersion() : PREVIEW_TRANSLATE_VERSION;
const dir = `.data/auditable-v01/${mode}/${createHash("sha256").update(version).digest("hex").slice(0, 12)}`;
mkdirSync(dir, { recursive: true });
const manifestPath = `${dir}/manifest.json`;
const reportPath = `${dir}/report.json`;
try {
  const model = await modelFor(mode === "china" ? "score" : "translate");
  const service = MODELS[model]!.service;
  const route = { model, actualModel: MODELS[model]!.model, service };
  const sources = await sql`SELECT id,name,enabled FROM sources ORDER BY id`;
  const scopedSources = sources.filter(s => mode === "china" ? isChineseSource(s.id) : !isChineseSource(s.id));
  let manifest: any;
  if (existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  else {
    const candidates = await sql`SELECT a.id,a.source_id,a.revision,a.content_hash,a.title,a.excerpt,a.language,a.body_status,length(a.body_text) AS body_chars,
      coalesce(p.eligible,false) AS published FROM articles a LEFT JOIN publications p ON p.article_id=a.id
      WHERE a.source_id IN ${sql(scopedSources.map(s => s.id))}
        AND (${mode !== "china"} OR NOT EXISTS(SELECT 1 FROM analyses an WHERE an.article_id=a.id AND an.input_revision=a.revision))
      ORDER BY coalesce(p.eligible,false) DESC,a.published_at DESC NULLS LAST,a.id`;
    const items = candidates.filter(a => mode === "china" || !isChineseText(a.title, a.language) || (!!a.excerpt && !isChineseText(a.excerpt, a.language)))
      .map(({ excerpt, ...a }) => a);
    manifest = { mode, preparedAt: new Date().toISOString(), version, route, sources: scopedSources, items,
      scope: "collected article backlog; origin is explicit source mapping, relevance does not verify publisher trust",
      cost: { currencyEstimate: null, reason: "CAMEL account pricing and monetary costs are not configured or returned in existing receipts",
        minimumRequests: items.length, planningRequests: mode === "china" ? [items.length, items.length * 8] : [items.length, items.length],
        excludes: "retries and optional grouping beyond the planning allowance; budgets always stop new sends" } };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  if (manifest.version !== version || JSON.stringify(manifest.route) !== JSON.stringify(route)) throw new Error("Manifest prompt/model changed; create a new versioned manifest before sending");
  const manifestHash = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  const [budget] = await sql`SELECT * FROM budgets WHERE service=${service}`;
  const [counts] = await sql`SELECT count(*) FILTER(WHERE started_at>now()-interval '1 minute')::int AS minute,
    count(*) FILTER(WHERE started_at>now()-interval '1 hour')::int AS hour,count(*)::int AS day
    FROM receipt_attempts WHERE service=${service} AND origin='live' AND started_at>now()-interval '1 day'`;
  const available = budget ? Math.max(0, Math.min(budget.per_hour - counts.hour, budget.per_day - counts.day)) : 0;
  const report: any = { mode, manifestHash, checkedAt: new Date().toISOString(), total: manifest.items.length,
    sourceCount: scopedSources.length, budget, attemptsInWindows: counts, availableRequests: available, cost: manifest.cost, counts: {}, results: [] };
  if (!execute) { writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
  else {
    if (process.env.MODEL_CALLS_ENABLED !== "true") throw new Error("Run through local-node.mjs --models for the user-authorized batch");
    const save = () => { report.checkedAt = new Date().toISOString(); report.counts = Object.fromEntries([...new Set(report.results.map((r: any) => r.status))].map(status => [String(status), report.results.filter((r: any) => r.status === status).length]));
      report.remaining = report.total - report.results.filter((r: any) => ["complete", "blocked", "held", "awaiting-material", "translated", "skipped"].includes(r.status)).length;
      writeFileSync(reportPath, JSON.stringify(report, null, 2)); };
    if (!available) { report.stopped = "existing CAMEL budget exhausted; no request sent, no budget changed"; save(); }
    else for (const frozen of manifest.items) {
      const key = `insurance.batch.${mode}.${frozen.id}@${frozen.revision}.${createHash("sha256").update(version).digest("hex").slice(0, 12)}`;
      const [prior] = await sql`SELECT value FROM settings WHERE key=${key}`;
      if (prior && !["budget", "off", "busy", "outage"].includes(prior.value.failureKind)) { report.results.push(prior.value); save(); continue; }
      const input = await loadAnalyzeInput(frozen.id);
      let result: any = { id: frozen.id, revision: frozen.revision, version, at: new Date().toISOString() };
      if (!input || input.revision !== frozen.revision) result = { ...result, status: "held", reason: "material revision changed since manifest" };
      else try {
        if (mode === "foreign-preview") result = { ...result, ...await translatePreview(frozen.id) };
        else if (!(input.bodyText || input.excerpt || input.xPost?.text)?.trim()) result = { ...result, status: "awaiting-material", reason: "no original text; no model call or score" };
        else {
          {
            const analysis = await analyzeArticle(frozen.id);
            result.analysisId = analysis?.analysisId;
            result.score = analysis?.output?.score;
            if (analysis?.stale || analysis?.needsBody) result = { ...result, status: "held", reason: analysis.stale ? "stale analysis" : "body fetch required" };
            else {
              await publishArticle(frozen.id);
              if (analysis?.output?.selected) result.grouping = await groupArticle(frozen.id);
              const [state] = await sql`SELECT p.selected,p.eligible,an.output->'rubric'->>'reviewRequired' AS review_required FROM publications p
                LEFT JOIN analyses an ON an.id=p.analysis_id WHERE p.article_id=${frozen.id}`;
              result = { ...result, status: state?.review_required === "true" ? "held" : "complete", selected: state?.selected ?? false, eligible: state?.eligible ?? false };
            }
          }
        }
      } catch (error) { result = { ...result, status: "failed", failureKind: failureKind(error), reason: (error as Error).message.slice(0, 500) }; }
      await sql`INSERT INTO settings(key,value,updated_by) VALUES(${key},${sql.json(result)},'insurance.backlog')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()`;
      report.results.push(result); save();
      console.log(JSON.stringify({ mode, done: report.results.length, total: report.total, id: result.id, status: result.status, reason: result.reason }));
      if (["budget", "off", "busy", "outage", "unknown"].includes(result.failureKind)) { report.stopped = result.reason; save(); break; }
    }
    save(); console.log(JSON.stringify({ mode, total: report.total, counts: report.counts, remaining: report.remaining, stopped: report.stopped ?? null }));
  }
} finally { await stopBoss(); await closeDb(); }
