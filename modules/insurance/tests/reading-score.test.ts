import { stub, tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { installModules } from "@aihot/backend/modules";
import { publishArticle, refreshPublicationScore } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { ReadingScoreSchema, READING_SCORE_VERSION, scoreClassifiedArticle, storedReadingScore } from "../backend/reading-score.ts";

const first = { impact: 30, information: 23, usefulness: 20, total: 73 };
const second = { impact: 31, information: 23, usefulness: 20, total: 74 };
const requests: Array<{ title: string; summary: string }> = [];
let respond: (n: number) => Promise<unknown> = async n => n % 2 ? first : second;
let localCalls = 0, classifications = 0;
const provider = await stub(async (_n, req) => {
  const body = JSON.parse(req.body);
  const input = JSON.parse(body.messages.at(-1).content);
  assert.deepEqual(Object.keys(input).sort(), ["summary", "title"]);
  assert.ok(!req.body.includes("PRIVATE-BODY-NEVER-SCORE"));
  requests.push(input);
  const result = await respond(++localCalls);
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } };
});
process.env.LLM_BASE_URL = `${provider.url}/v1`;
process.env.LLM_API_KEY = "test-key";
process.env.LLM_MODEL = "test-camel-model";
installModules([{ name: "insurance", publicationScore: storedReadingScore,
  classifyArticle: () => { classifications++; return { category: "regulation", evidence: { version: "keywords-test" } }; } }]);
after(async () => { installModules([]); await provider.close(); await stopBoss(); await closeDb(); });

async function article() {
  localCalls = 0; requests.length = 0; classifications = 0;
  respond = async n => n % 2 ? first : second;
  const id = `reading-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${id},'阅读价值测试信源','rss','T1','editorial')`;
  const { articleId } = await upsertMaterial({ sourceId: id, url: `https://example.org/${id}`, title: `监管发布保险规则 ${id}`,
    bodyText: `PRIVATE-BODY-NEVER-SCORE ${id}`, bodyStatus: "ok", via: "import", publishedAt: new Date() });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,category,score,selected)
    VALUES(${articleId},1,'rule','pass',${`监管发布保险规则 ${id}`},'规则明确适用范围与实施时间。','regulation',88,false)`;
  await publishArticle(articleId);
  classifications = 0;
  return articleId;
}

test("reading-score JSON requires bounded integer dimensions and a correct sum", () => {
  assert.equal(ReadingScoreSchema.safeParse(first).success, true);
  assert.equal(ReadingScoreSchema.safeParse({ ...first, total: 74 }).success, false);
  assert.equal(ReadingScoreSchema.safeParse({ ...first, impact: 41, total: 84 }).success, false);
  assert.equal(ReadingScoreSchema.safeParse({ ...first, usefulness: 19.5, total: 72.5 }).success, false);
  assert.equal(ReadingScoreSchema.safeParse({ impact: 0, information: 0, usefulness: 0, total: 0 }).success, true);
});

test("two independent title/summary calls update the saved score without rerunning classification or structure", async () => {
  const id = await article();
  const [before] = await sql`SELECT * FROM publications WHERE article_id=${id}`;
  const result = await scoreClassifiedArticle(id, { model: "default" });
  assert.deepEqual([result.status, result.score, localCalls, classifications], ["scored", 73, 2, 0]);
  assert.deepEqual(requests[0], requests[1]);
  const [after] = await sql`SELECT * FROM publications WHERE article_id=${id}`;
  for (const key of Object.keys(before).filter(key => !["score", "score_evidence", "revision", "updated_at"].includes(key)))
    assert.deepEqual(after[key], before[key], key);
  assert.equal(after.score_evidence.version, READING_SCORE_VERSION);
  assert.deepEqual(after.score_evidence.passes.map((p: { total: number }) => p.total), [73, 74]);
  assert.notEqual(after.score_evidence.receiptIds[0], after.score_evidence.receiptIds[1]);
  const cached = await scoreClassifiedArticle(id, { model: "default" });
  assert.deepEqual([cached.status, cached.reused, localCalls, classifications], ["scored", true, 2, 0]);
  // Ordinary republication must keep the new score instead of restoring the earlier analysis's 88.
  await publishArticle(id);
  assert.equal((await sql`SELECT score FROM publications WHERE article_id=${id}`)[0].score, 73);
  await sql`INSERT INTO editorial_overrides(article_id,fields,reason,updated_by) VALUES(${id},'{"score":95}'::jsonb,'人工更正','test')`;
  await sql.begin(tx => refreshPublicationScore(tx, id));
  assert.equal((await sql`SELECT score FROM publications WHERE article_id=${id}`)[0].score, 95);
  assert.equal(localCalls, 2);
  const receipts = await sql`SELECT status FROM receipts WHERE id IN ${sql(result.receiptIds!)}`;
  assert.ok(receipts.every(receipt => receipt.status === "completed"));
});

test("changed or unclassified copy cannot receive an old frozen score", async () => {
  const id = await article();
  respond = async n => {
    if (n === 1) await sql`UPDATE publications SET summary='更新后的摘要' WHERE article_id=${id}`;
    return n === 1 ? first : second;
  };
  const result = await scoreClassifiedArticle(id, { model: "default" });
  assert.equal(result.status, "stale");
  const [p] = await sql`SELECT score,score_evidence FROM publications WHERE article_id=${id}`;
  assert.deepEqual([p.score, p.score_evidence], [88, null]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM insurance_reading_scores WHERE article_id=${id}`)[0].n, 1);
  await sql`UPDATE publications SET category=NULL,classification=NULL WHERE article_id=${id}`;
  const held = await scoreClassifiedArticle(id, { model: "default" });
  assert.equal(held.status, "held");
  assert.equal(localCalls, 2);
});

test("resuming a half-finished pair reuses its received first answer", async () => {
  const id = await article();
  respond = async n => n === 2 ? { ...second, total: 1 } : n === 1 ? first : second;
  await assert.rejects(scoreClassifiedArticle(id, { model: "default" }), /total must equal/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM insurance_reading_scores WHERE article_id=${id}`)[0].n, 0);
  const result = await scoreClassifiedArticle(id, { model: "default" });
  assert.deepEqual([result.status, result.score, localCalls], ["scored", 73, 3]);
  const [p] = await sql`SELECT score_evidence FROM publications WHERE article_id=${id}`;
  assert.equal(p.score_evidence.passes[0].reused, true);
});
