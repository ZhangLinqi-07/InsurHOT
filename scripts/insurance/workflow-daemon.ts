import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss, ensureQueue, recordRun, workModuleQueues } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";
import { composeDueReports } from "@aihot/backend/reports/compose";
import { computeHotRanking, snapshotHeat } from "@aihot/backend/events/hot";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { sweepNewsWorkflow, workflowPolicy, workflowFingerprint } from "../../modules/insurance/backend/workflow.ts";

if (process.env.MODEL_CALLS_ENABLED !== "true" || process.env.COLLECT_ENABLED !== "false") throw new Error("Use local-node.mjs --workflow");
installModules(SERVER_MODULES);
const dir = ".data/insurance-workflow";
mkdirSync(dir, { recursive: true });
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
let heartbeat: ReturnType<typeof startHeartbeat> | undefined;
try {
  if (!(await workflowPolicy())?.enabled) throw new Error("Enable the new-news workflow before starting this service");
  const boss = await getBoss();
  await workModuleQueues(boss);
  // Only these schedules run here. The general worker also consumes historical analysis and translation jobs.
  const schedules = [
    { name: "insurance.workflow.sweep", cron: "* * * * *", run: sweepNewsWorkflow },
    { name: "hot.rank", cron: "*/5 * * * *", run: () => computeHotRanking() },
    { name: "hot.snapshot", cron: "2 * * * *", run: () => snapshotHeat() },
    { name: "reports.compose", cron: "0,30 * * * *", run: async () => (await workflowPolicy())?.enabled ? composeDueReports() : { disabled: true } },
  ];
  for (const schedule of schedules) {
    const queue = `cron.${schedule.name}`;
    await ensureQueue(queue, { policy: "singleton", retryLimit: 0, expireInSeconds: 3600 });
    await boss.schedule(queue, schedule.cron, {}, { tz: "Asia/Shanghai", missed: "once" });
    await boss.work(queue, { pollingIntervalSeconds: 15 }, () => recordRun(schedule.name, schedule.run));
  }
  heartbeat = startHeartbeat("insurance-workflow");
  await recordRun("insurance.workflow.sweep", () => sweepNewsWorkflow());
  await recordRun("hot.snapshot", () => snapshotHeat());
  await recordRun("hot.rank", () => computeHotRanking());
  writeFileSync(`${dir}/ready.json`, JSON.stringify({ pid: process.pid, readyAt: new Date().toISOString(), policy: await workflowPolicy(), workflowFingerprint: (await workflowFingerprint()).fingerprint }));
  console.log(JSON.stringify({ event: "ready", pid: process.pid, mode: "new-news-only", reports: "Asia/Shanghai" }));
  while (!stopping && !existsSync(`${dir}/stop`)) await delay(1000);
} finally {
  if (heartbeat) clearInterval(heartbeat);
  await stopBoss();
  await closeDb();
  writeFileSync(`${dir}/stopped.json`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
}
