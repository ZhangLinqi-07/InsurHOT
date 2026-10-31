import { pointModels, stub, tag } from "../../../tests/setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { analysisStep, SELECTING_SCORE } from "../../../tests/analysis-steps.ts";
import { sql, closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { analyzeArticle, runAnalysis, loadAnalyzeInput, runSelectionPrefilter } from "@aihot/backend/editorial/analyze";
import { capabilities } from "@aihot/backend/editorial/models";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { overrideFields } from "@aihot/backend/admin/content";
import { classifyInsurance } from "../backend/classification.ts";
import { reclassifyInsuranceArticle } from "../backend/reclassify.ts";
import { activeRubric, RUBRIC_AXES } from "@aihot/industry/rubric";
import { READING_SCORE_SYSTEM, storedReadingScore } from "../backend/reading-score.ts";
import { processNewsWorkflow, setWorkflowEnabled, sweepNewsWorkflow, workflowPolicy } from "../backend/workflow.ts";
import { BATCH_SYSTEM } from "@aihot/backend/events/relate";

const calls: string[] = [];
const text = "中国平安上线智能核保系统，支持核保人员审核投保材料。";
const expectedScore = activeRubric() ? 80 : SELECTING_SCORE;
const provider = await stub((_n, req) => {
  if (req.url.endsWith("/embeddings")) return { data: JSON.parse(req.body).input.map((_text: string, index: number) => ({ index, embedding: Array(1024).fill(0.1) })) };
  if (JSON.parse(req.body).messages[0]?.content === BATCH_SYSTEM) {
    calls.push("group");
    const candidates = [...new Set([...String(JSON.parse(req.body).messages.at(-1).content).matchAll(/候选 (C\d+)/g)].map(match => match[1]))];
    return { choices: [{ message: { content: JSON.stringify({ decisions: candidates.map(id => ({ id, relation: "UNRELATED", confidence: 1 })), selection: { addsValue: true, reason: "新增核保系统进展" } }) } }] };
  }
  if (JSON.parse(req.body).messages[0]?.content === READING_SCORE_SYSTEM) {
    calls.push("reading-score");
    return { choices: [{ message: { content: JSON.stringify({ impact: 20, information: 20, usefulness: 20, total: 60 }) } }] };
  }
  const step = analysisStep(req.body); calls.push(step);
  const paragraph = step === "score" && activeRubric() ? JSON.parse(JSON.parse(req.body).messages.at(-1).content).paragraphs.find((p: { id: string }) => p.id === "P1") : null;
  const score = paragraph ? { event: { type: "industry_event", subject: "中国平安", action: "上线", jurisdiction: "中国", stage: "published", date: null, claim: "上线智能核保系统" },
    axes: Object.fromEntries(RUBRIC_AXES.map(axis => [axis, { score: 8, reason: "原文支持测试分值", benchmark: { description: "材料所述系统上线", source: paragraph.id },
      evidence: [{ paragraphId: paragraph.id, quote: paragraph.text.slice(0, 25) }] }])), caps: [], uncertainties: [] } : { attentionScore: SELECTING_SCORE };
  const data = step === "prefilter" ? { label: req.body.includes("irrelevant-workflow") ? "BLOCK" : "PASS", reason: "保险系统上线" }
    : step === "score" ? score
      : step === "structure" ? { tags: ["保险科技", "AI/智能体"], subjects: ["pingan"], scope: "single",
        fact: { title: "智能核保系统上线", subject: "中国平安", action: "上线", object: "智能核保系统", occurredAt: null, evidence: text, conditions: [] } }
        : { itemType: "industry_event", authorRole: "principal", tags: [], editorialJudgment: "系统上线", titleZh: "中国平安上线智能核保系统", summaryZh: text };
  return { choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
pointModels(provider.url);
installModules([{ name: "insurance", articlePrefilter: false, classifyArticle: classifyInsurance,
  materialPublication: true }]);
after(async () => { installModules([]); await provider.close(); await stopBoss(); await closeDb(); });

test("keyword classification retains the paid structure step, grounded facts, subjects, tags and news score", async () => {
  const source = `classification-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},'保险分类测试','rss','T1','editorial')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`, title: "中国平安上线智能核保系统", bodyText: text,
    bodyStatus: "ok", via: "import", publishedAt: new Date() });
  const result = (await analyzeArticle(articleId))!;
  assert.equal(result.output!.category, "insurtech");
  assert.equal(result.output!.score, expectedScore);
  assert.deepEqual(result.output!.subjects, ["pingan"]);
  assert.ok(result.output!.tags.includes("保险科技"));
  assert.equal(result.output!.scope, "single");
  assert.equal(result.output!.fact!.evidence, text);
  assert.equal(calls.filter(c => c === "structure").length, 1);
  assert.equal(result.receiptIds.length, 4);
  assert.equal(capabilities().prefilter, undefined);
  await assert.rejects(runSelectionPrefilter((await loadAnalyzeInput(articleId))!), /LLM relevance screening is disabled/);
  const [analysis] = await sql`SELECT output FROM analyses WHERE id=${result.analysisId}`;
  assert.equal(analysis.output.classification.category, "technology");
  await sql`UPDATE articles SET grouping_status='complete' WHERE id=${articleId}`;
  await publishArticle(articleId, { releasedAt: new Date() });
  const [before] = await sql`SELECT * FROM publications WHERE article_id=${articleId}`;
  assert.equal(before.category, "insurtech");
  assert.equal(before.classification.category, "technology");
  // A historical row is updated without rerunning its judgement or changing admission.
  await sql`UPDATE publications SET category='regulation',classification=NULL WHERE article_id=${articleId}`;
  const entry = { itemId: articleId, title: before.title, summary: before.summary };
  const [report] = await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
    VALUES('daily','2098-01-01',now(),now(),${sql.json({ sections: [{ label: "监管与规则", items: [entry] }], leadItemId: articleId })},now(),'imported') RETURNING id`;
  assert.deepEqual(await reclassifyInsuranceArticle(articleId), { changed: true, categoryChanged: true });
  const [updated] = await sql`SELECT * FROM publications WHERE article_id=${articleId}`;
  for (const field of ["score", "selected", "eligible", "seat", "visible_after", "selected_ready_at", "analysis_id", "story_id", "fact_id", "tags", "title", "summary"])
    assert.deepEqual(updated[field], before[field], field);
  const [moved] = await sql`SELECT content FROM reports WHERE id=${report.id}`;
  assert.deepEqual(moved.content.sections, [{ label: "科技", items: [entry] }]);
  assert.equal(moved.content.leadItemId, articleId);
  assert.deepEqual(await reclassifyInsuranceArticle(articleId), { changed: false, categoryChanged: false });
  assert.equal(calls.filter(c => c === "structure").length, 1);
  const [receipts] = await sql`SELECT count(*)::int AS n FROM receipts`;
  assert.equal(receipts.n, 4);
  await overrideFields(articleId, { fields: { title: "法院判决理赔纠纷", summary: "保险诉讼引发理赔纠纷。" }, reason: "更正标题摘要", version: 0 }, "classification-test");
  const [retitled] = await sql`SELECT category FROM publications WHERE article_id=${articleId}`;
  assert.equal(retitled.category, "claims");
  const [retitledReport] = await sql`SELECT content FROM reports WHERE id=${report.id}`;
  assert.equal(retitledReport.content.sections[0].label, "理赔");
  await overrideFields(articleId, { fields: { category: "risk" }, reason: "人工确认栏目", version: 1 }, "classification-test");
  await reclassifyInsuranceArticle(articleId);
  const [manual] = await sql`SELECT category,classification FROM publications WHERE article_id=${articleId}`;
  assert.equal(manual.category, "risk");
  assert.equal(manual.classification.category, "claims");
});

test("collected source material receives a rule category without LLM screening, scoring or selection", async () => {
  const [source] = await sql`SELECT id FROM sources WHERE name='保险分类测试'`;
  const { articleId } = await upsertMaterial({ sourceId: source.id, url: `https://example.org/screened-${tag()}`, title: "国家医保局推进医保便捷支付",
    excerpt: "首批地区推进医保便捷支付工作。", via: "import", publishedAt: new Date() });
  const beforeCalls = calls.length;
  await publishArticle(articleId);
  const [p] = await sql`SELECT category,classification,selected,score,analysis_id FROM publications WHERE article_id=${articleId}`;
  assert.equal(p.category, "regulation");
  assert.equal(p.classification.label, "监管");
  assert.deepEqual([p.selected, p.score, p.analysis_id], [false, null, null]);
  assert.equal(calls.length, beforeCalls);
});

test("new-news workflow excludes existing material, archives and disabled sources and preserves its boundary on resume", async () => {
  const source = `workflow-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${source},'保险工作流测试','rss','T1','editorial')`;
  const make = (suffix: string, backfill = false) => upsertMaterial({ sourceId: source, url: `https://example.org/${source}/${suffix}`,
    title: "中国平安上线智能核保系统", bodyText: text, bodyStatus: "ok", backfill: backfill ? "test archive" : null, via: "import", publishedAt: new Date() });
  const old = await make("old");
  const policy = await setWorkflowEnabled(true);
  const live = await make("live");
  const archive = await make("archive", true);
  assert.equal((await sweepNewsWorkflow()).enqueued, 1);
  assert.equal((await sweepNewsWorkflow()).enqueued, 0, "an existing queued job is not duplicated");
  const rows = await sql`SELECT article_id FROM insurance_news_workflow`;
  assert.deepEqual(rows.map(r => r.article_id), [live.articleId]);
  const beforeCalls = calls.length;
  assert.equal((await processNewsWorkflow({ articleId: old.articleId, revision: 1 })).status, "outside-scope");
  assert.equal((await processNewsWorkflow({ articleId: archive.articleId, revision: 1 })).status, "outside-scope");
  await setWorkflowEnabled(false);
  assert.equal((await sweepNewsWorkflow()).enqueued, 0);
  assert.equal((await processNewsWorkflow({ articleId: live.articleId, revision: 1 })).status, "outside-scope");
  const resumed = await setWorkflowEnabled(true);
  assert.equal(resumed.startedAt, policy.startedAt);
  assert.equal(calls.length, beforeCalls);
  await sql`UPDATE sources SET enabled=false WHERE id=${source}`;
  assert.equal((await processNewsWorkflow({ articleId: live.articleId, revision: 1 })).status, "outside-scope");
  await sql`UPDATE sources SET enabled=true WHERE id=${source}`;
});

test("workflow classifies before scoring and completes without any relevance-model request", async () => {
  installModules([{ name: "insurance", articlePrefilter: false, classifyArticle: classifyInsurance, publicationScore: storedReadingScore,
    materialPublication: true }]);
  const [row] = await sql`SELECT article_id,input_revision FROM insurance_news_workflow`;
  const beforeCalls = calls.length;
  assert.equal((await processNewsWorkflow({ articleId: row.article_id, revision: row.input_revision })).status, "complete");
  const [p] = await sql`SELECT category,classification,score,score_evidence,selected FROM publications WHERE article_id=${row.article_id}`;
  assert.equal(p.category, "insurtech");
  assert.ok(p.classification.version);
  assert.equal(p.score, 60);
  assert.equal(p.score_evidence.passes.length, 2);
  assert.equal(p.selected, true);
  const steps = calls.slice(beforeCalls);
  assert.equal(steps.filter(s => s === "prefilter").length, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM settings WHERE key LIKE 'insurance.relevance.%' AND value->>'articleId'=${row.article_id}`)[0]!.n, 0);
  const [classified] = await sql`SELECT classification FROM insurance_news_workflow WHERE article_id=${row.article_id}`;
  assert.ok(classified.classification.version);
  assert.equal(steps.filter(s => s === "reading-score").length, 2);
  assert.ok(steps.indexOf("reading-score") > steps.indexOf("structure"));
  const [state] = await sql`SELECT status,stage FROM insurance_news_workflow WHERE article_id=${row.article_id}`;
  assert.deepEqual({ ...state }, { status: "complete", stage: "done" });
  assert.equal((await processNewsWorkflow({ articleId: row.article_id, revision: row.input_revision })).status, "complete");
  assert.equal(calls.length, beforeCalls + steps.length, "completed stages never buy another request");
  await publishArticle(row.article_id);
  const [republished] = await sql`SELECT score FROM publications WHERE article_id=${row.article_id}`;
  assert.equal(republished.score, 60);
  assert.equal(calls.length, beforeCalls + steps.length, "publication reads saved scores without model calls");
});

test("historical model relevance labels cannot block new scoring, and unknown score receipts are held", async () => {
  const [source] = await sql`SELECT id FROM sources WHERE name='保险工作流测试'`;
  const { articleId } = await upsertMaterial({ sourceId: source.id, url: `https://example.org/irrelevant-workflow-${tag()}`,
    title: "irrelevant-workflow", bodyText: text, bodyStatus: "ok", via: "import", publishedAt: new Date() });
  await sql`INSERT INTO settings(key,value) VALUES(${'insurance.relevance.' + articleId},
    ${sql.json({ articleId, revision: 1, status: "screened", label: "BLOCK", reviewRequired: true })})`;
  await sweepNewsWorkflow();
  const beforeCalls = calls.length;
  assert.equal((await processNewsWorkflow({ articleId, revision: 1 })).status, "complete");
  assert.equal(calls.slice(beforeCalls).filter(step => step === "prefilter").length, 0);
  assert.equal((await sql`SELECT relevance FROM analyses WHERE article_id=${articleId}`)[0]!.relevance, "pass");
  const unknown = await upsertMaterial({ sourceId: source.id, url: `https://example.org/unknown-workflow-${tag()}`,
    title: "中国平安上线智能核保系统", bodyText: text, bodyStatus: "ok", via: "import", publishedAt: new Date() });
  await sweepNewsWorkflow();
  const partial = await runAnalysis((await loadAnalyzeInput(unknown.articleId))!);
  await sql`UPDATE receipts SET status='unknown' WHERE id=${partial.scores!.receiptIds[0]!}`;
  const beforeUnknown = calls.length;
  assert.equal((await processNewsWorkflow({ articleId: unknown.articleId, revision: 1 })).status, "held");
  assert.equal(calls.length, beforeUnknown);
  const [held] = await sql`SELECT error_kind FROM insurance_news_workflow WHERE article_id=${unknown.articleId}`;
  assert.equal(held.error_kind, "unknown");
  assert.ok((await workflowPolicy())!.enabled);
});

test("workflow waits for budget without sending and rejects superseded jobs before any paid step", async () => {
  const [source] = await sql`SELECT id FROM sources WHERE name='保险工作流测试'`;
  const material = { sourceId: source.id, url: `https://example.org/budget-workflow-${tag()}`, title: "中国平安上线智能核保系统",
    bodyText: text, bodyStatus: "ok" as const, via: "import", publishedAt: new Date() };
  const { articleId } = await upsertMaterial(material);
  await sweepNewsWorkflow();
  const budgets = await sql`SELECT service,per_minute FROM budgets WHERE service IN ('dashscope','zhipu')`;
  const beforeCalls = calls.length;
  try {
    await sql`UPDATE budgets SET per_minute=0 WHERE service IN ('dashscope','zhipu')`;
    const result = await processNewsWorkflow({ articleId, revision: 1 });
    assert.equal(result.status, "waiting");
    assert.equal("failureKind" in result && result.failureKind, "budget");
    assert.equal(calls.length, beforeCalls);
  } finally { for (const budget of budgets) await sql`UPDATE budgets SET per_minute=${budget.per_minute} WHERE service=${budget.service}`; }
  const [state] = await sql`SELECT attempts,next_attempt_at FROM insurance_news_workflow WHERE article_id=${articleId}`;
  assert.equal(state.attempts, 0);
  assert.ok(state.next_attempt_at > new Date());
  await upsertMaterial({ ...material, bodyText: text + " 新版本补充了适用条件。" });
  assert.equal((await processNewsWorkflow({ articleId, revision: 1 })).status, "outside-scope");
  assert.equal(calls.length, beforeCalls);
  await sweepNewsWorkflow();
  const [revised] = await sql`SELECT input_revision,stage FROM insurance_news_workflow WHERE article_id=${articleId}`;
  assert.deepEqual({ ...revised }, { input_revision: 2, stage: "classify" });
});

test("program checks keep title-only material waiting without any model request", async () => {
  const [source] = await sql`SELECT id FROM sources WHERE name='保险工作流测试'`;
  const { articleId } = await upsertMaterial({ sourceId: source.id, url: `https://example.org/title-only-${tag()}`,
    title: "只有标题的材料", bodyStatus: "pending", via: "import", publishedAt: new Date() });
  await sql`INSERT INTO insurance_news_workflow(article_id,input_revision) VALUES(${articleId},1)`;
  const callsBefore = calls.length;
  assert.equal((await processNewsWorkflow({ articleId, revision: 1 })).status, "waiting-material");
  assert.equal(calls.length, callsBefore);
});
