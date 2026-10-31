import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { modelSources } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";
import { stableJson } from "@aihot/backend/lib/ids";
import { CLASSIFICATION_VERSION } from "./classification.ts";
import { sql, type Db } from "@aihot/backend/db";
import { defineQueue } from "@aihot/backend/modules";
import { enqueueOn, shutdownSignal } from "@aihot/backend/jobs/queue";
import { analyzeArticle, awaitsMaterial, loadAnalyzeInput, waitsForPage, PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";
import { groupArticle } from "@aihot/backend/events/group";
import { BudgetExceededError, failureKind } from "@aihot/backend/providers/receipts";
import { classifyInsurance } from "./classification.ts";
import { scoreClassifiedArticle, READING_SCORE_VERSION } from "./reading-score.ts";

const POLICY_KEY = "insurance.workflow";
export interface WorkflowPolicy { enabled: boolean; startedAt: string }
export interface NewsJob { articleId: string; revision: number; backlogRun?: string }

const WORKFLOW_CODE_HASH = createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
export const backlogPolicyKey = (runId: string) => `insurance.workflow.backlog.${runId}`;
export const backlogItemKey = (runId: string, id: string) => `${backlogPolicyKey(runId)}.article.${id}`;

/** A finite backlog run pins the same implementation, prompts and actual model routes. */
export async function workflowFingerprint() {
  const routes = Object.fromEntries(Object.entries(await modelSources()).map(([step, route]) => {
    const model = MODELS[route.model]!;
    return [step, { key: route.model, model: model.model, service: model.service }];
  }));
  const version = { implementation: WORKFLOW_CODE_HASH, admission: "program-rules-only",
    prompts: Object.fromEntries(Object.entries(PROMPT_VERSIONS).filter(([key]) => key !== "prefilter")), classification: CLASSIFICATION_VERSION,
    readingScore: READING_SCORE_VERSION, routes };
  return { fingerprint: createHash("sha256").update(stableJson(version)).digest("hex"), version };
}

export async function workflowPolicy(db: Db = sql): Promise<WorkflowPolicy | null> {
  const [saved] = await db`SELECT value FROM settings WHERE key=${POLICY_KEY}`;
  return saved?.value ?? null;
}

/** Resuming preserves the original boundary. Existing articles and archive imports stay outside. */
export async function setWorkflowEnabled(enabled: boolean): Promise<WorkflowPolicy> {
  const [saved] = await sql`INSERT INTO settings(key,value,updated_by)
    VALUES(${POLICY_KEY},${sql.json({ enabled, startedAt: new Date().toISOString() })},'insurance.workflow')
    ON CONFLICT(key) DO UPDATE SET value=jsonb_set(settings.value,'{enabled}',to_jsonb(${enabled}::boolean)),updated_at=now(),updated_by=excluded.updated_by
    RETURNING value`;
  return saved!.value;
}

async function inScope(job: NewsJob) {
  const policy = await workflowPolicy();
  if (!policy?.enabled || process.env.MODEL_CALLS_ENABLED !== "true") return false;
  if (job.backlogRun) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(job.backlogRun)) return false;
    const [batch] = await sql`SELECT value FROM settings WHERE key=${backlogPolicyKey(job.backlogRun)}`;
    const [item] = await sql`SELECT value FROM settings WHERE key=${backlogItemKey(job.backlogRun, job.articleId)}`;
    if (!batch?.value.enabled || !item || item.value.status !== "queued" || item.value.revision !== job.revision
      || item.value.manifestHash !== batch.value.manifestHash
      || batch.value.fingerprint !== (await workflowFingerprint()).fingerprint) return false;
    const [a] = await sql`SELECT 1 FROM articles a JOIN sources s ON s.id=a.source_id
      LEFT JOIN editorial_overrides o ON o.article_id=a.id
      WHERE a.id=${job.articleId} AND a.revision=${job.revision} AND a.content_hash=${item.value.contentHash}
        AND a.created_at<=${batch.value.frozenAt}::timestamptz AND s.enabled AND s.participation_mode='editorial'
        AND coalesce(o.visibility,'public')='public' AND a.publication_time IS NOT NULL
        AND a.published_at>=${batch.value.from}::timestamptz AND a.published_at<=${batch.value.to}::timestamptz`;
    return !!a;
  }
  // A frozen member belongs to its one-time queue while that run is enabled.
  const [active] = await sql`SELECT value FROM settings WHERE key='insurance.workflow.backlog.active'`;
  if (active?.value.runId) {
    const [batch] = await sql`SELECT value FROM settings WHERE key=${backlogPolicyKey(active.value.runId)}`;
    const [member] = await sql`SELECT value FROM settings WHERE key=${backlogItemKey(active.value.runId, job.articleId)}`;
    if (batch?.value.enabled && member?.value.revision === job.revision && ["pending", "queued"].includes(member.value.status)) return false;
  }
  const [a] = await sql`SELECT 1 FROM articles a JOIN sources s ON s.id=a.source_id
    LEFT JOIN editorial_overrides o ON o.article_id=a.id
    WHERE a.id=${job.articleId} AND a.revision=${job.revision} AND a.created_at>=${policy.startedAt}::timestamptz
      AND NOT a.backfill AND s.enabled AND s.participation_mode='editorial'
      AND coalesce(o.visibility,'public')='public' AND a.published_at IS NOT NULL AND a.published_at<=now()`;
  return !!a;
}

export const newsWorkflowQueue = defineQueue<NewsJob>({
  name: "insurance.news-workflow",
  options: { policy: "short", retryLimit: 0, expireInSeconds: 1800 },
  // Event grouping is serial so reports of the same new event cannot create two identities.
  worker: { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: 2 },
  run: async jobs => {
    const results = [];
    for (const job of jobs) results.push(await processNewsWorkflow(job));
    return results;
  },
});

/** The approved finite backlog has eight item lanes; daily news keeps its own serial queue. */
export const backlogWorkflowQueue = defineQueue<NewsJob>({
  name: "insurance.backlog-workflow",
  options: { policy: "short", retryLimit: 0, expireInSeconds: 1800 },
  worker: { localConcurrency: 8, batchSize: 1, pollingIntervalSeconds: 2 },
  run: async jobs => {
    const results = [];
    for (const job of jobs) results.push(await processNewsWorkflow(job));
    return results;
  },
});

/** Queue only this site's newly arrived editorial material, never the engine's accumulated queues. */
export async function sweepNewsWorkflow(limit = 40) {
  const policy = await workflowPolicy();
  if (!policy?.enabled || process.env.MODEL_CALLS_ENABLED !== "true") return { enqueued: 0 };
  const rows = await sql<{ id: string; revision: number }[]>`SELECT a.id,a.revision FROM articles a JOIN sources s ON s.id=a.source_id
    LEFT JOIN insurance_news_workflow w ON w.article_id=a.id
    LEFT JOIN editorial_overrides o ON o.article_id=a.id
    WHERE a.created_at>=${policy.startedAt}::timestamptz AND NOT a.backfill AND s.enabled AND s.participation_mode='editorial'
      AND coalesce(o.visibility,'public')='public' AND a.published_at IS NOT NULL AND a.published_at<=now()
      AND (coalesce(a.body_text,a.excerpt,a.x_post->>'text','')<>'' OR a.x_post IS NOT NULL)
      AND (a.body_status<>'pending' OR a.body_text IS NOT NULL OR a.x_post IS NOT NULL)
      AND (w.article_id IS NULL OR w.input_revision<>a.revision
        OR (w.status IN ('pending','waiting') AND w.next_attempt_at<=now()))
    ORDER BY a.discovered_at,a.id LIMIT ${limit}`;
  let enqueued = 0;
  for (const row of rows) {
    await sql.begin(async tx => {
      await tx`INSERT INTO insurance_news_workflow(article_id,input_revision) VALUES(${row.id},${row.revision})
        ON CONFLICT(article_id) DO UPDATE SET input_revision=excluded.input_revision,stage='classify',classification=NULL,status='pending',attempts=0,
          next_attempt_at=now(),error_kind=NULL,error=NULL,updated_at=now()
        WHERE insurance_news_workflow.input_revision<>excluded.input_revision`;
      if (await enqueueOn(newsWorkflowQueue, { articleId: row.id, revision: row.revision }, { singletonKey: `${row.id}@${row.revision}` }, tx)) enqueued++;
    });
  }
  return { enqueued };
}

async function checkpoint(job: NewsJob, stage: string, status = "pending", reason: string | null = null) {
  await sql`UPDATE insurance_news_workflow SET stage=${stage},status=${status},attempts=0,error_kind=NULL,error=${reason},updated_at=now()
    WHERE article_id=${job.articleId} AND input_revision=${job.revision}`;
}

/** Paid stages reuse their native receipts. A crash resumes from the saved stage and material revision. */
export async function processNewsWorkflow(job: NewsJob) {
  if (!await inScope(job)) return { status: "outside-scope" };
  const [saved] = await sql`SELECT stage,status FROM insurance_news_workflow WHERE article_id=${job.articleId} AND input_revision=${job.revision}`;
  if (!saved || ["complete", "blocked", "held", "failed"].includes(saved.status)) return { status: saved?.status ?? "missing" };
  let stage = String(saved.stage);
  try {
    const input = await loadAnalyzeInput(job.articleId);
    if (!input || input.revision !== job.revision) return { status: "stale" };
    if (awaitsMaterial(input) || waitsForPage(input)) {
      await checkpoint(job, stage, "waiting", "Waiting for article text");
      await sql`UPDATE insurance_news_workflow SET next_attempt_at=now()+interval '5 minutes' WHERE article_id=${job.articleId} AND input_revision=${job.revision}`;
      return { status: "waiting-material" };
    }
    if (stage === "classify") {
      const classification = classifyInsurance({ title: input.title, originalTitle: input.title, summary: input.excerpt });
      await sql`UPDATE insurance_news_workflow SET classification=${sql.json(classification.evidence as never)},updated_at=now()
        WHERE article_id=${job.articleId} AND input_revision=${job.revision}`;
      stage = "analyze";
      await checkpoint(job, stage);
    }
    if (stage === "analyze") {
      shutdownSignal.signal.throwIfAborted();
      if (!await inScope(job)) return { status: "outside-scope" };
      const [existing] = await sql`SELECT id FROM analyses WHERE article_id=${job.articleId} AND input_revision=${job.revision} ORDER BY id DESC LIMIT 1`;
      if (!existing) {
        // The existing editorial rubric still owns selection, grounded writing and report admission.
        const analysis = await analyzeArticle(job.articleId);
        if (!analysis || analysis.stale || analysis.needsBody) return { status: "stale" };
      }
      await publishArticle(job.articleId);
      stage = "score";
      await checkpoint(job, stage);
    }
    if (stage === "score") {
      shutdownSignal.signal.throwIfAborted();
      if (!await inScope(job)) return { status: "outside-scope" };
      const result = await scoreClassifiedArticle(job.articleId);
      if (result.status !== "scored") {
        await checkpoint(job, stage, result.status === "stale" ? "waiting" : "held", result.reason);
        return result;
      }
      stage = "group";
      await checkpoint(job, stage);
    }
    if (stage === "group") {
      shutdownSignal.signal.throwIfAborted();
      if (!await inScope(job)) return { status: "outside-scope" };
      const [current] = await sql`SELECT grouping_status FROM articles WHERE id=${job.articleId} AND revision=${job.revision}`;
      if (current?.grouping_status !== "complete") {
        // Both queues share one database lease while event identities and representative selection are written.
        const lease = await sql.reserve();
        try {
          await lease`SELECT pg_advisory_lock(hashtext('insurance.workflow.group'),0)`;
          shutdownSignal.signal.throwIfAborted();
          if (!await inScope(job)) return { status: "outside-scope" };
          const [latest] = await sql`SELECT grouping_status FROM articles WHERE id=${job.articleId} AND revision=${job.revision}`;
          if (latest?.grouping_status !== "complete") await groupArticle(job.articleId);
        } finally {
          await lease`SELECT pg_advisory_unlock(hashtext('insurance.workflow.group'),0)`;
          lease.release();
        }
      }
      await checkpoint(job, "done", "complete");
    }
    return { status: "complete" };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const kind = failureKind(error);
    const [current] = await sql`SELECT attempts FROM insurance_news_workflow WHERE article_id=${job.articleId} AND input_revision=${job.revision}`;
    const attempts = Number(current?.attempts ?? 0) + (kind === "budget" || kind === "busy" || kind === "off" ? 0 : 1);
    const status = ["unknown", "refused", "unusable"].includes(kind) || attempts >= 4 ? "held" : "waiting";
    const seconds = error instanceof BudgetExceededError ? error.retryAfterSeconds : Math.min(3600, 60 * 2 ** attempts);
    await sql`UPDATE insurance_news_workflow SET status=${status},attempts=${attempts},error_kind=${kind},error=${String(error).slice(0,800)},
      next_attempt_at=now()+make_interval(secs=>${seconds}),updated_at=now() WHERE article_id=${job.articleId} AND input_revision=${job.revision}`;
    return { status, stage, failureKind: kind };
  }
}

export async function workflowStatus() {
  const states = await sql`SELECT stage,status,error_kind,count(*)::int AS n,min(next_attempt_at) AS next_attempt_at FROM insurance_news_workflow GROUP BY stage,status,error_kind ORDER BY stage,status`;
  return { policy: await workflowPolicy(), states };
}
