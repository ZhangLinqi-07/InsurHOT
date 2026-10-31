import { stub, tag } from "../../../tests/setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { SCORE_SYSTEM, STRUCTURE_SYSTEM } from "@aihot/backend/editorial/analyze";
import { activeRubric, RUBRIC_AXES } from "@aihot/industry/rubric";
import insurance from "../server.ts";
import { READING_SCORE_SYSTEM } from "../backend/reading-score.ts";
import { processNewsWorkflow, workflowFingerprint, backlogPolicyKey, backlogItemKey } from "../backend/workflow.ts";

installModules([insurance]);
for (const step of ["SCORE", "STRUCTURE", "SUMMARIZE", "UNDERSTAND"]) process.env[`${step}_MODEL`] = "default";
process.env.LLM_MODEL = "test-workflow-model";
process.env.LLM_API_KEY = "test-key";
function answer(req: { body: string }) {
  const body = JSON.parse(req.body), system = body.messages[0]?.content;
  let data: unknown;
  if (system === SCORE_SYSTEM) {
    if (activeRubric()) {
      const paragraph = JSON.parse(body.messages.at(-1).content).paragraphs.find((p: { id: string }) => p.id === "P1");
      data = { event: { type: "industry_event", subject: "机构", action: "发布", jurisdiction: "中国", stage: "published", date: null, claim: "发布资料" },
        axes: Object.fromEntries(RUBRIC_AXES.map(axis => [axis, { score: 0, reason: "没有明确价值", benchmark: { description: "常规资料", source: "P1" },
          evidence: [{ paragraphId: "P1", quote: paragraph.text.slice(0, 20) }] }])), caps: [], uncertainties: [] };
    } else data = { attentionScore: 0 };
  } else if (system === STRUCTURE_SYSTEM) data = { scope: "unknown", category: null, tags: [], subjects: [], fact: null };
  else if (system === READING_SCORE_SYSTEM) data = { impact: 10, information: 10, usefulness: 10, total: 30 };
  else return { choices: [{ message: { content: "title_zh: 机构发布常规资料\nsummary_zh: 机构发布常规资料，供从业者查阅。\nbody_zh:" } }] };
  return { choices: [{ message: { content: JSON.stringify(data) } }] };
}
const provider = await stub((_n, req) => answer(req));
process.env.LLM_BASE_URL = provider.url;
after(async () => { installModules([]); await provider.close(); await stopBoss(); await closeDb(); });

test("only frozen current material inside the date window enters the rules-only historical workflow", async () => {
  const runId = `backlog-${tag()}`, source = `workflow-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,config,tier) VALUES(${source},'Workflow source','rss','{}'::jsonb,'T1')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`, title: "Source material",
    publishedAt: new Date("2026-06-01T00:00:00Z"), bodyText: "Public source material for the insurance collection.".repeat(30), bodyStatus: "ok", via: "import" });
  await sql`UPDATE articles SET created_at='2026-10-01T00:00:00Z',publication_time='2026-06-01' WHERE id=${articleId}`;
  const [a] = await sql`SELECT revision,content_hash FROM articles WHERE id=${articleId}`;
  await sql`INSERT INTO settings(key,value) VALUES('insurance.workflow',${sql.json({ enabled: true, startedAt: "2026-10-29T00:00:00Z" })})
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`;
  await sql`INSERT INTO insurance_news_workflow(article_id,input_revision) VALUES(${articleId},${a.revision})`;
  const job = { articleId, revision: a.revision, backlogRun: runId };
  assert.equal((await processNewsWorkflow({ articleId, revision: a.revision })).status, "outside-scope");
  assert.equal((await processNewsWorkflow(job)).status, "outside-scope");
  const batch = { enabled: true, frozenAt: "2026-10-30T00:00:00Z", from: "2026-04-29T16:00:00Z", to: "2026-10-30T00:00:00Z",
    manifestHash: "frozen-test-manifest", fingerprint: (await workflowFingerprint()).fingerprint };
  const item = { status: "queued", revision: a.revision, contentHash: "wrong-version", manifestHash: batch.manifestHash };
  await sql`INSERT INTO settings(key,value) VALUES(${backlogPolicyKey(runId)},${sql.json(batch)}),(${backlogItemKey(runId,articleId)},${sql.json(item)})`;
  assert.equal((await processNewsWorkflow(job)).status, "outside-scope");
  item.contentHash = a.content_hash;
  await sql`UPDATE settings SET value=${sql.json(item)} WHERE key=${backlogItemKey(runId,articleId)}`;
  for (const invalid of [{ ...batch, from: "2026-07-01T00:00:00Z" }, { ...batch, fingerprint: "changed-workflow" }, { ...batch, enabled: false }]) {
    await sql`UPDATE settings SET value=${sql.json(invalid)} WHERE key=${backlogPolicyKey(runId)}`;
    assert.equal((await processNewsWorkflow(job)).status, "outside-scope");
  }
  await sql`UPDATE settings SET value=${sql.json(batch)} WHERE key=${backlogPolicyKey(runId)}`;
  await sql`UPDATE sources SET enabled=false WHERE id=${source}`;
  assert.equal((await processNewsWorkflow(job)).status, "outside-scope");
  assert.equal(provider.hits(), 0);
  await sql`UPDATE sources SET enabled=true WHERE id=${source}`;
  assert.equal((await processNewsWorkflow(job)).status, "complete");
  const hits = provider.hits();
  assert.equal((await processNewsWorkflow(job)).status, "complete");
  assert.equal(provider.hits(), hits);
  assert.equal((await processNewsWorkflow({ ...job, revision: a.revision + 1 })).status, "outside-scope");
  const [policy] = await sql`SELECT value FROM settings WHERE key='insurance.workflow'`;
  assert.equal(policy.value.startedAt, "2026-10-29T00:00:00Z");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE purpose='prefilter_article'`)[0]!.n, 0);
});

test("eight frozen item lanes score concurrently without relevance calls or duplicate paid requests", async () => {
  let active = 0, peak = 0;
  const concurrent = await stub(async (_n, req) => { active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 120)); active--; return answer(req); });
  process.env.LLM_BASE_URL = concurrent.url;
  try {
    const source = `eight-${tag()}`, runId = `eight-${tag()}`;
    await sql`INSERT INTO sources(id,name,kind,config,tier) VALUES(${source},'Concurrent source','rss','{}'::jsonb,'T1')`;
    const batch = { enabled: true, frozenAt: "2026-10-30T00:00:00Z", from: "2026-04-29T16:00:00Z", to: "2026-10-30T00:00:00Z",
      manifestHash: "eight-frozen-manifest", fingerprint: (await workflowFingerprint()).fingerprint };
    await sql`INSERT INTO settings(key,value) VALUES(${backlogPolicyKey(runId)},${sql.json(batch)})`;
    const jobs = [];
    for (let index = 0; index < 8; index++) {
      const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}/${index}`, title: `Source material ${index}`,
        publishedAt: new Date("2026-06-01T00:00:00Z"), bodyText: "Public insurance source material.".repeat(30), bodyStatus: "ok", via: "import" });
      await sql`UPDATE articles SET created_at='2026-10-01T00:00:00Z',publication_time='2026-06-01' WHERE id=${articleId}`;
      const [a] = await sql`SELECT revision,content_hash FROM articles WHERE id=${articleId}`;
      await sql`INSERT INTO insurance_news_workflow(article_id,input_revision) VALUES(${articleId},${a.revision})`;
      await sql`INSERT INTO settings(key,value) VALUES(${backlogItemKey(runId,articleId)},${sql.json({ status: "queued", revision: a.revision, contentHash: a.content_hash, manifestHash: batch.manifestHash })})`;
      jobs.push({ articleId, revision: a.revision, backlogRun: runId });
    }
    assert.ok((await Promise.all(jobs.map(job => processNewsWorkflow(job)))).every(result => result.status === "complete"));
    assert.ok(peak >= 8);
    const hits = concurrent.hits();
    await Promise.all(jobs.map(job => processNewsWorkflow(job)));
    assert.equal(concurrent.hits(), hits);
    const [saved] = await sql`SELECT count(*) FILTER(WHERE purpose='score_article' AND status='completed')::int AS scores,
      count(*) FILTER(WHERE purpose='prefilter_article')::int AS relevance FROM receipts
      WHERE split_part(split_part(subject,':',2),'@',1)=ANY(${jobs.map(job => job.articleId)}::text[])`;
    assert.ok(saved.scores >= 16); assert.equal(saved.relevance, 0);
    const reading = await sql`SELECT receipt_ids,passes FROM insurance_reading_scores WHERE article_id=ANY(${jobs.map(job => job.articleId)}::text[])`;
    assert.equal(reading.length, 8);
    assert.ok(reading.every(row => row.receipt_ids.length === 2 && row.passes.length === 2));
  } finally { process.env.LLM_BASE_URL = provider.url; await concurrent.close(); }
});
