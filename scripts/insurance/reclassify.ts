import { mkdirSync, writeFileSync } from "node:fs";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { classifyInsurance, CLASSIFICATION_VERSION } from "../../modules/insurance/backend/classification.ts";
import { reclassifyInsuranceArticle } from "../../modules/insurance/backend/reclassify.ts";

installModules(SERVER_MODULES);
const execute = process.argv.includes("--run");
const directory = `.data/classification/${new Date().toISOString().replace(/[:.]/g, "-")}`;
mkdirSync(directory, { recursive: true });
try {
  const rows = await sql`SELECT p.article_id,p.title,p.original_title,p.summary,p.category,p.classification,o.fields->>'category' AS manual_category
    FROM publications p LEFT JOIN editorial_overrides o ON o.article_id=p.article_id ORDER BY p.article_id`;
  const counts: Record<string, number> = {};
  const beforeAfter = rows.map(p => {
    const result = classifyInsurance({ title: p.title, originalTitle: p.original_title, summary: p.summary });
    const after = p.manual_category?.trim() || result.category;
    counts[after] = (counts[after] ?? 0) + 1;
    return { id: p.article_id, before: p.category, after, manual: !!p.manual_category, classification: p.classification };
  });
  writeFileSync(`${directory}/before.json`, JSON.stringify({ version: CLASSIFICATION_VERSION, rows: beforeAfter }, null, 2));
  const report = { version: CLASSIFICATION_VERSION, execute, total: rows.length, categoryChanges: beforeAfter.filter(p => p.before !== p.after).length,
    manual: beforeAfter.filter(p => p.manual).length, categories: counts, done: 0, changed: 0, categoryChanged: 0 };
  if (execute) for (const p of rows) {
    const result = await reclassifyInsuranceArticle(p.article_id);
    report.done++;
    if (result.changed) report.changed++;
    if (result.categoryChanged) report.categoryChanged++;
    if (report.done % 100 === 0) {
      writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ done: report.done, total: report.total, changed: report.changed }));
    }
  }
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory }));
} finally { await stopBoss(); await closeDb(); }
