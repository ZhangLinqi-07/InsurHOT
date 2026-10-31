import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { sql, closeDb } from "@aihot/backend/db";
import { readIngestionPolicy } from "../../modules/insurance/backend/archive.ts";
import { workflowStatus } from "../../modules/insurance/backend/workflow.ts";

const dir = ".data/insurance-ingestion";
mkdirSync(dir, { recursive: true });
try {
  const policy = readIngestionPolicy();
  const workflow = await workflowStatus();
  const catalog = JSON.parse(readFileSync("industry/source-catalog.json", "utf8"));
  const sources = await sql`SELECT id,name,kind,enabled,last_fetch_at,last_ok_at,next_fetch_at,last_error,fail_count FROM sources ORDER BY id`;
  const archive = await sql`SELECT substring(key from length('insurance.archive.')+1) AS source_id,value AS progress FROM settings WHERE key LIKE 'insurance.archive.%' ORDER BY key`;
  const articles = await sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE body_status='ok')::int AS with_body,
    count(*) FILTER(WHERE processing_state='new')::int AS awaiting_processing,min(published_at) AS earliest,max(published_at) AS latest FROM articles`;
  const perSource = await sql`SELECT s.id,count(a.id)::int AS total,count(a.id) FILTER(WHERE a.body_status='ok')::int AS with_body,
    min(a.published_at) AS earliest,max(a.published_at) AS latest FROM sources s LEFT JOIN articles a ON a.source_id=s.id GROUP BY s.id`;
  const receipts = await sql`SELECT service,status,count(*)::int AS n FROM receipts GROUP BY service,status ORDER BY service,status`;
  const attempts = await sql`SELECT service,count(*)::int AS n FROM receipt_attempts GROUP BY service ORDER BY service`;
  const supplemental = (policy as any).supplementalAssociations ?? [];
  const trialPath = `${dir}/screening-trial/results.json`;
  const trial = existsSync(trialPath) ? JSON.parse(readFileSync(trialPath, "utf8")) : null;
  const screeningTrial = trial ? { runId: trial.runId, screened: trial.screened, failed: trial.failed, labels: trial.labels,
    finishedAt: trial.finishedAt ?? null, continuousModelsEnabled: workflow.policy?.enabled ?? false } : null;
  const entries = catalog.sources.map((entry: any) => {
    const exact = (entry.runtimeMapping?.collectorIds ?? []).filter((id: string) => sources.some(s => s.id === id && s.enabled));
    const related = supplemental.filter((a: any) => a.catalogIds.includes(entry.catalogId));
    const collectors = [...new Set([...exact, ...related.map((a: any) => a.sourceId)])] as string[];
    return { catalogId: entry.catalogId, name: entry.name, url: entry.url, accountId: entry.accountId,
      status: entry.accountId ? "awaiting-authorized-wechat-service" : exact.length ? "configured-channel-only"
        : related.length ? "publisher-news-channel-only" : entry.currentCollectionStatus,
      collectorIds: collectors, archive: collectors.map(id => ({ sourceId: id, pagination: policy.plans.find(p => p.sourceId === id)?.pagination.kind,
        progress: archive.find(a => a.source_id === id)?.progress ?? null })),
      limitation: "Collector and archive results describe those channels only. No whole-site completeness claim." };
  });
  const report = { checkedAt: new Date().toISOString(), from: policy.from,
    mode: workflow.policy?.enabled ? "free-collection-with-new-news-workflow"
      : trial && !trial.finishedAt ? "free-collection-with-bounded-screening-trial" : "free-collection-models-off",
    workflow, screeningTrial, sourceInventoryEntries: entries.length,
    configuredSources: sources.length, enabledSources: sources.filter(s => s.enabled).length,
    paginatedArchives: policy.plans.filter(p => p.pagination.kind !== "single").length,
    archiveStates: Object.fromEntries(["running", "exhausted", "limited", "failed"].map(status => [status, archive.filter(a => a.progress.status === status).length])),
    articles: articles[0], receipts, attempts, sources, perSource, entries,
    service: existsSync(`${dir}/service.json`) ? JSON.parse(readFileSync(`${dir}/service.json`, "utf8")) : null,
    heartbeat: existsSync(`${dir}/heartbeat.json`) ? JSON.parse(readFileSync(`${dir}/heartbeat.json`, "utf8")) : null };
  const output = process.argv.includes("--baseline") ? `${dir}/baseline.json` : `${dir}/status.json`;
  if (process.argv.includes("--baseline") && existsSync(output)) throw new Error("The ingestion baseline already exists; keep it for comparison");
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  if (process.argv.includes("--baseline")) {
    writeFileSync(`${dir}/source-backup.json`, JSON.stringify({ at: report.checkedAt, sources: await sql`SELECT * FROM sources` }, null, 2));
  }
  console.log(JSON.stringify({ checkedAt: report.checkedAt, configuredSources: report.configuredSources, enabledSources: report.enabledSources,
    paginatedArchives: report.paginatedArchives, archiveStates: report.archiveStates, articles: report.articles, screeningTrial, receipts, attempts, output }));
} finally { await closeDb(); }
