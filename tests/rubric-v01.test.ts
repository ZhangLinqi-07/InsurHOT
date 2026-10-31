import { pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, runSelectionScores, scoresSelect, shownScore, SCORE_SYSTEM } from "@aihot/backend/editorial/analyze";
import { translatePreview } from "@aihot/backend/editorial/preview-translate";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { publishArticle } from "@aihot/backend/publication/publish";
import { installModules } from "@aihot/backend/modules";
import { activeRubric, RUBRIC_AXES } from "@aihot/industry/rubric";
import { isChineseSource } from "../modules/insurance/backend/source-scope.ts";

const source = `test-rubric-${tag()}`;
let scoreHits = 0, translationHits = 0, automaticHits = 0;
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body); const system = body.messages[0]?.content ?? "";
  const user = body.messages.at(-1)?.content ?? "";
  let answer: unknown;
  if (system === SCORE_SYSTEM) {
    scoreHits++;
    const p = JSON.parse(user).paragraphs.find((p: any) => p.id === "P1");
    answer = { event: { type: "industry_event", subject: "监管", action: "发布", jurisdiction: "中国", stage: "published", date: null, claim: "发布保险规则" },
      axes: Object.fromEntries(RUBRIC_AXES.map(axis => [axis, { score: 6, reason: "材料明确支持本档", benchmark: { description: "相对本文的资本要求变化", source: "P1" }, evidence: [{ paragraphId: "P1", quote: p.text.slice(0, 25) }] }])), caps: [], uncertainties: [] };
    if (p.text.includes("自动判断")) {
      const raw = answer as any; const second = ++automaticHits % 2 === 0;
      raw.event.type = second ? "research_paper" : "industry_event";
      raw.event.stage = second ? "effective" : "published";
      for (const axis of RUBRIC_AXES) raw.axes[axis].score = second ? 8 : 4;
    }
    if (p.text.includes("证据不足")) (answer as any).axes.sig.evidence[0].quote = "原文没有这句话";
  } else if (system.includes("excerpt为null")) {
    translationHits++; const original = JSON.parse(user); answer = { titleZh: "保险规则发布", excerptZh: original.excerpt ? "规则适用于保险机构。" : null };
  } else if (system.includes("保险相关性") || system.includes("PASS") && system.includes("BLOCK")) answer = { label: "PASS", reason: "保险监管规则" };
  else if (system.includes("editorialJudgment")) answer = { itemType: "industry_event", authorRole: "principal", tags: [], editorialJudgment: "规则发布", titleZh: "监管发布保险规则", summaryZh: "规则适用于保险机构。" };
  else answer = { scope: "single", category: "regulation", tags: [], subjects: [], fact: null };
  return { id: "test", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
pointModels(provider.url, ["qwen3.7-flash", "qwen3.8-flash", "glm-5.3-flash", "glm-5.3-flash-selection", "deepseek-flash"]);
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

test("China origin uses explicit source scope, independent of content language and relevance", () => {
  assert.equal(isChineseSource("nfra-917"), true); assert.equal(isChineseSource("mp-gh_example"), true);
  assert.equal(isChineseSource("rss-reinsurance-news"), false); assert.equal(isChineseSource("unknown-chinese-title"), false);
});
test("V0.1 analysis persists two independent evidence passes and source snapshot", { skip: !activeRubric() }, async () => {
  await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${source},'测试保险信源','rss','T1')`;
  const article = await upsertMaterial({ sourceId: source, url: `https://example.com/${source}`, title: "监管发布保险规则", bodyText: "监管今日发布保险规则，适用于本市场保险机构。新规则明确资本要求，保留过渡安排。", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  const result = await analyzeArticle(article.articleId);
  const [saved] = await sql`SELECT output,selected FROM analyses WHERE id=${result!.analysisId}`;
  assert.equal(scoreHits, 2); assert.equal(saved.output.rubric.passes.length, 2); assert.equal(saved.output.rubric.reviewRequired, false);
  assert.equal(saved.output.rubric.passes[0].weightedSum, 60); assert.equal(saved.selected, true);
  assert.equal(saved.output.rubric.material.originalText.includes("资本要求"), true);
  assert.notEqual(saved.output.rubric.passes[0].receiptId, saved.output.rubric.passes[1].receiptId);
});
test("V0.1 automatically selects a verified mean despite disagreements", { skip: !activeRubric() }, async () => {
  const sid = source + "-automatic";
  await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${sid},'自动精选测试源','rss','T1')`;
  const article = await upsertMaterial({ sourceId: sid, url: `https://example.com/${sid}`, title: "保险规则自动判断",
    bodyText: "自动判断测试，监管发布保险规则并明确资本要求及过渡安排。", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  const result = await analyzeArticle(article.articleId);
  const [saved] = await sql`SELECT output,score,selected FROM analyses WHERE id=${result!.analysisId}`;
  assert.deepEqual(saved.output.scores, [40, 80]); assert.equal(saved.score, 60); assert.equal(saved.selected, true);
  assert.equal(saved.output.rubric.reviewRequired, false); assert.equal(saved.output.rubric.decision, "selected");
  assert.ok(saved.output.rubric.reviewReasons.includes("event type conflict"));
  assert.ok(saved.output.rubric.reviewReasons.includes("scores cross source-tier threshold"));
  assert.equal(automaticHits, 2);

  const missing = await upsertMaterial({ sourceId: sid, url: `https://example.com/${sid}-missing`, title: "保险证据不足",
    bodyText: "证据不足测试，监管发布保险规则并明确资本要求及过渡安排。", bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  const scores = await runSelectionScores((await loadAnalyzeInput(missing.articleId))!);
  assert.equal(shownScore(scores), null); assert.equal(scoresSelect(scores), false);
  assert.equal(scores?.rubric?.decision, "insufficient-evidence"); assert.equal(scores?.rubric?.reviewRequired, false);
});

test("preview translations preserve originals, deduplicate, and keep absent excerpts absent", async () => {
  installModules([{ name: "insurance", materialPublication: true }]);
  const sid = source + "-translation";
  await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${sid},'Foreign source','rss','T1')`;
  const article = await upsertMaterial({ sourceId: sid, url: `https://example.com/${sid}`, title: "Insurance rule published", bodyStatus: "none", via: "fetch", publishedAt: new Date() });
  const original = (await sql`SELECT title,excerpt,body_text FROM articles WHERE id=${article.articleId}`)[0];
  assert.equal((await translatePreview(article.articleId)).status, "translated");
  assert.equal((await translatePreview(article.articleId)).reused, true);
  const [translation] = await sql`SELECT * FROM preview_translations WHERE article_id=${article.articleId}`;
  assert.equal(translation.original_title, original.title); assert.equal(translation.original_excerpt, null); assert.equal(translation.excerpt_zh, null);
  assert.deepEqual((await sql`SELECT title,excerpt,body_text FROM articles WHERE id=${article.articleId}`)[0], original);
  assert.equal(translationHits, 1);
  const read = async (id: string) => {
    await publishArticle(id);
    const detail = await loadItemDetail(id);
    if (detail.kind !== "found") throw new Error("missing collected source card");
    return detail.item;
  };
  const translated = await read(article.articleId);
  assert.equal(translated.title, "保险规则发布"); assert.equal(translated.originalTitle, original.title);
  await sql`UPDATE articles SET excerpt='A revised original excerpt.' WHERE id=${article.articleId}`;
  const stale = await read(article.articleId);
  assert.equal(stale.title, original.title); assert.equal(stale.originalTitle, null);
  const edge = await upsertMaterial({ sourceId: sid, url: `https://example.com/${sid}-edge`, title: "Boundary excerpt", excerpt: "a".repeat(240) + " and more text", bodyStatus: "none", via: "fetch", publishedAt: new Date() });
  await translatePreview(edge.articleId);
  const edgeRow = await read(edge.articleId);
  assert.equal(edgeRow.title, "保险规则发布");
  assert.equal((await sql`SELECT original_excerpt FROM preview_translations WHERE article_id=${edge.articleId}`)[0]!.original_excerpt, "a".repeat(240) + "…");
  assert.equal(edgeRow.sourceExcerptTranslated, true);
  await assert.rejects(sql.begin(async tx => { await tx`DELETE FROM preview_translations WHERE article_id=${article.articleId}`; throw Error("rollback"); }), /rollback/);
  assert.equal((await sql`SELECT count(*)::int n FROM preview_translations WHERE article_id=${article.articleId}`)[0]!.n, 1);
  installModules([]);
});
