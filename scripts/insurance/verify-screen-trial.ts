// Audit saved evidence only. This script never calls a model.
import { readFileSync, writeFileSync } from "node:fs";
import { sql, closeDb } from "@aihot/backend/db";

const dir = ".data/insurance-ingestion/screening-trial";
try {
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8"));
  const results = JSON.parse(readFileSync(`${dir}/results.json`, "utf8"));
  const budgetRecord = JSON.parse(readFileSync(`${dir}/budget.json`, "utf8"));
  if (!results.finishedAt || results.results.length !== 100) throw new Error("The fixed 100-article trial is not finished");
  const receiptIds = results.results.map((r: any) => r.receiptId).filter((id: any) => Number.isSafeInteger(id));
  const attempts = await sql`SELECT a.service,r.purpose,a.receipt_id,a.status,a.usage,a.cost,a.currency,a.started_at
    FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
    WHERE a.receipt_id=ANY(${receiptIds}::bigint[]) AND a.started_at>=${new Date(manifest.preparedAt)} ORDER BY a.id`;
  const [currentBudget] = await sql`SELECT * FROM budgets WHERE service=${budgetRecord.service}`;
  const current = await sql`SELECT id,revision FROM articles WHERE id=ANY(${manifest.inputs.map((input: any) => input.id)}::text[])`;
  const budgetRestored = ["per_minute", "per_hour", "per_day", "note"].every(key => currentBudget[key] === budgetRecord.originalBudget[key]);
  const [otherPaid] = await sql`SELECT count(*)::int AS n FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
    WHERE a.started_at>=${new Date(manifest.preparedAt)} AND (r.purpose<>'prefilter_article' OR a.service<>${budgetRecord.service})`;
  const usage = attempts.reduce((total, row) => ({ inputTokens: total.inputTokens + Number(row.usage?.prompt_tokens ?? 0),
    outputTokens: total.outputTokens + Number(row.usage?.completion_tokens ?? 0) }), { inputTokens: 0, outputTokens: 0 });
  const flags = results.results.flatMap((result: any) => {
    const input = manifest.inputs.find((a: any) => a.id === result.articleId);
    const body = input.bodyText ?? "";
    return /^Prime\b/.test(body) ? [{ articleId: result.articleId, title: result.title, label: result.label,
      issue: "The stored public text carries a Prime marker and may be a limited preview. Absence of insurance in that preview cannot establish the full article is unrelated." }] : [];
  });
  const report = { verifiedAt: new Date().toISOString(), manifestSha256: results.manifestSha256,
    samples: results.results.length, sources: new Set(manifest.inputs.map((a: any) => a.source.name)).size,
    screened: results.screened, failed: results.failed, unresolved: results.unresolved, labels: results.labels,
    staleResults: results.results.filter((r: any) => current.find(a => a.id === r.articleId)?.revision !== r.revision).length,
    newRequests: attempts.length, reusedJudgements: results.results.filter((r: any) => r.receiptReused).length,
    otherPaidRequests: otherPaid.n, budgetRestored, usage,
    costAvailable: attempts.length > 0 && attempts.every(a => a.cost !== null),
    accuracyEvaluated: false, deletedArticles: 0, publicArticlesGenerated: 0, reviewFlags: flags,
    withinRequestBudget: attempts.length <= manifest.maxNewRequests };
  writeFileSync(`${dir}/verification.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  if (!report.withinRequestBudget || !budgetRestored || report.otherPaidRequests) process.exitCode = 1;
} finally { await closeDb(); }
