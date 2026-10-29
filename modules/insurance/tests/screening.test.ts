import "../../../tests/setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stub } from "../../../tests/setup.ts";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { screenFrozenArticle } from "../backend/screening.ts";
import { installModules } from "@aihot/backend/modules";

after(async () => { await stopBoss(); await closeDb(); });
process.env.PREFILTER_MODEL = "default";
process.env.LLM_MODEL = "test-relevance-model";
process.env.LLM_API_KEY = "test-key";
process.env.LLM_REASONING_TOKENS = "0";

test("relevance-only screening completes its receipt without scoring or publication when no publication policy is installed", async () => {
  const provider = await stub((_hit, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.messages.length, 2);
    return { choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "保险责任披露规则" }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  });
  process.env.LLM_BASE_URL = provider.url;
  try {
    await sql`INSERT INTO sources(id,name,kind,config,tier) VALUES ('screening-source','Insurance source','rss','{}'::jsonb,'T1')`;
    const material = await upsertMaterial({ sourceId: "screening-source", url: "https://example.org/insurance/rules", title: "保险信息披露规则",
      bodyText: "保险公司应当向投保人完整披露责任范围。".repeat(30), bodyStatus: "ok", via: "import" });
    const input = (await loadAnalyzeInput(material.articleId))!;
    const first = await screenFrozenArticle(input, "fixed-test");
    const again = await screenFrozenArticle(input, "fixed-test");
    assert.equal(first.status, "screened");assert.equal(first.label, "PASS");
    assert.deepEqual(again, first);assert.equal(provider.hits(), 1);
    const [receipt] = await sql`SELECT status,purpose FROM receipts WHERE id=${first.receiptId!}`;
    assert.equal(receipt.status, "completed");assert.equal(receipt.purpose, "prefilter_article");
    const [analysis] = await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${input.id}`;
    assert.equal(analysis.n, 0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=${input.id}`)[0].n, 0);
    const [state] = await sql`SELECT processing_state FROM articles WHERE id=${input.id}`;
    assert.equal(state.processing_state, "new");
  } finally { await provider.close(); }
});

test("an installed publication policy publishes a successful current screening in the same save without scoring", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "保险监管" }) } }] }));
  process.env.LLM_BASE_URL = provider.url;
  installModules([{ name: "insurance", screenedPublication: { screeningPrefix: "insurance.relevance.", from: "2024-10-28T16:00:00Z" } }]);
  try {
    const material = await upsertMaterial({ sourceId: "screening-source", url: "https://example.org/insurance/published",
      title: "Original insurance regulation", language: "en", publishedAt: new Date("2025-02-01Z"),
      excerpt: "Source excerpt", bodyText: "Source text about insurance".repeat(30), bodyStatus: "ok", via: "import" });
    const result = await screenFrozenArticle((await loadAnalyzeInput(material.articleId))!, "published-test");
    assert.equal(result.status, "screened");assert.equal(provider.hits(), 1);
    const [publication] = await sql`SELECT eligible,selected,title,summary,score,analysis_id FROM publications WHERE article_id=${material.articleId}`;
    assert.equal(publication.eligible, true);assert.equal(publication.selected, false);
    assert.equal(publication.title, "Original insurance regulation");assert.equal(publication.summary, "Source excerpt");
    assert.equal(publication.score, null);assert.equal(publication.analysis_id, null);
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${material.articleId}`)[0].n, 0);
  } finally { installModules([]);await provider.close(); }
});

test("a failed model output stays in the fixed trial and does not trigger another paid attempt", async () => {
  const provider = await stub(() => ({ choices: [{ message: { content: "unusable response" } }] }));
  process.env.LLM_BASE_URL = provider.url;
  try {
    const material = await upsertMaterial({ sourceId: "screening-source", url: "https://example.org/insurance/failed", title: "保险研究报告",
      bodyText: "研究保险风险和偿付能力。".repeat(30), bodyStatus: "ok", via: "import" });
    const input = (await loadAnalyzeInput(material.articleId))!;
    const result = await screenFrozenArticle(input, "failed-test");
    assert.equal(result.status, "failed");assert.equal(result.failureKind, "unusable");
    assert.equal((await screenFrozenArticle(input, "failed-test")).status, "failed");
    assert.equal(provider.hits(), 1);
    await assert.rejects(screenFrozenArticle({ ...input, bodyText: "changed material" }, "failed-test"), /manifest changed/);
  } finally { await provider.close(); }
});
