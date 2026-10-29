import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { collectFreeDue, enrichFreeBodies, enrichNfra } from "../../modules/insurance/backend/collector.ts";
import { archiveSlice } from "../../modules/insurance/backend/archive.ts";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { republishScreenedArticles } from "@aihot/backend/publication/publish";
import { SERVER_MODULES } from "@aihot/site/modules/server";

if (process.env.MODEL_CALLS_ENABLED !== "false" || process.env.COLLECT_ENABLED !== "true") throw new Error("Use local-node.mjs --collect-only for the free collector");
installModules(SERVER_MODULES);
const dir = ".data/insurance-ingestion";
mkdirSync(dir, { recursive: true });
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
const stopped = () => stopping || existsSync(`${dir}/stop`);
let rounds = 0;
try {
  console.log(JSON.stringify({ screeningsPublished: await republishScreenedArticles(), modelsEnabled: false }));
  do {
    const started = new Date().toISOString();
    const round: Record<string, unknown> = { startedAt: started, modelsEnabled: false };
    try {
      // Live collection always gets its turn before another historical page.
      round.live = await collectFreeDue(8);
      if (!stopped()) round.archive = await archiveSlice(4);
      if (!stopped()) round.bodies = await enrichFreeBodies(3);
      if (!stopped()) round.nfraBodies = await enrichNfra(3);
    } catch (error) { round.error = error instanceof Error ? error.message : String(error); }
    round.finishedAt = new Date().toISOString();
    appendFileSync(`${dir}/rounds.jsonl`, JSON.stringify(round) + "\n");
    writeFileSync(`${dir}/heartbeat.json`, JSON.stringify({ pid: process.pid, rounds: ++rounds, ...round }, null, 2));
    console.log(JSON.stringify({ at: round.finishedAt, rounds, error: round.error, live: (round.live as any[])?.length, archive: (round.archive as any[])?.length }));
    if (process.argv.includes("--once")) break;
    for (let i = 0; i < 15 && !stopped(); i++) await delay(1000);
  } while (!stopped());
} finally {
  await stopBoss();
  await closeDb();
  writeFileSync(`${dir}/stopped.json`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
}
