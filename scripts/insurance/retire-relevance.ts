// One-time retirement of the insurance site's LLM relevance gate. No model requests or batch resume.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";

const execute = process.argv.includes("--run");
const prefixes = ["insurance.relevance.", "insurance.screen-trial."];
try {
  if (process.env.MODEL_CALLS_ENABLED === "true") throw new Error("Retire relevance state with model calls disabled");
  const settings = await sql`SELECT key,value,updated_at,updated_by FROM settings
    WHERE starts_with(key,${prefixes[0]}) OR starts_with(key,${prefixes[1]}) OR key='models.prefilter' ORDER BY key`;
  const checkpoints = await sql`SELECT * FROM insurance_news_workflow
    WHERE stage='screen' OR (classification IS NULL AND status IN ('pending','waiting')) ORDER BY article_id`;
  const runs = await sql`SELECT key,value FROM settings WHERE key LIKE 'insurance.workflow.backlog.%' AND value->>'enabled'='true'`;
  if (runs.length) throw new Error("Pause finite backlog runs before changing the workflow");
  const result: Record<string, unknown> = { at: new Date().toISOString(), legacySettings: settings.length,
    oldCheckpoints: checkpoints.length, mode: execute ? "run" : "plan", modelCalls: 0 };
  if (execute) {
    const dir = `.data/no-llm-prefilter/${new Date().toISOString().replaceAll(":", "-")}`;
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/legacy-state.json`;
    const data = JSON.stringify({ at: result.at, settings, checkpoints }, null, 2);
    writeFileSync(file, data);
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== createHash("sha256").update(data).digest("hex"))
      throw new Error("Retirement snapshot verification failed");
    await sql.begin(async tx => {
      await tx`UPDATE insurance_news_workflow SET stage='classify',status='pending',attempts=0,next_attempt_at=now(),
        error_kind=NULL,error=NULL,updated_at=now() WHERE stage='screen'`;
      await tx`UPDATE insurance_news_workflow SET stage='classify',updated_at=now()
        WHERE classification IS NULL AND status IN ('pending','waiting') AND stage IN ('analyze','score','group')`;
      // Previously completed scores, articles, receipts, reports and paused run memberships stay intact.
      await tx`DELETE FROM settings WHERE key=ANY(${settings.map(row => row.key)}::text[])`;
    });
    result.snapshot = file;
    writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result));
} finally { await closeDb(); }
