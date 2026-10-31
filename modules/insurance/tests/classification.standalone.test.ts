import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyInsurance } from "../backend/classification.ts";

const classify = (title = "", summary: string | null = null, originalTitle: string | null = null) => classifyInsurance({ title, summary, originalTitle });

test("v2 assigns insurance categories using title/summary weights, long phrases and bilingual concept deduplication", () => {
  for (const [text, category] of [
    ["国家医保局在119个统筹地区首批推进医保便捷支付工作", "regulation"],
    ["中国平安上线智能核保系统", "insurtech"], ["推出科技保险产品", "products"],
    ["Swiss Re reports net profit growth", "industry"], ["再保险续约费率下调", "reinsurance"],
  ]) assert.equal(classify(text).category, category, text);
  assert.deepEqual(classify("国家医保局 NHSA 国家医保局", "NHSA").evidence.category_scores, classify("国家医保局").evidence.category_scores);
  assert.equal(classify("国家医保局").evidence.score, Number(classify("", "国家医保局").evidence.score) * 2);
  assert.equal(classify("", null, "National Healthcare Security Administration announces a payment initiative").category, "regulation");
  assert.equal(classify("chair and air").category, "other");
  assert.equal(classify("晴空中的一片云", "今天心情很好。").evidence.score, 0);
  assert.deepEqual(classify().evidence.hits, []);
});

test("v2 preserves code-point spans, tie-breaking and source-version evidence", () => {
  const result = classify("😀国家医保局 NHSA", "医保统筹区推进信用支付。");
  const hits = result.evidence.hits as Array<{ category: string; points: number; span: number[] }>;
  assert.deepEqual(hits[0].span, [1, 6]);
  assert.equal(result.evidence.score, hits.filter(h => h.category === result.evidence.category).reduce((n, h) => n + h.points, 0));
  assert.match(String(result.evidence.version), /^insurance-keywords-v2\.0\.0-/);
  assert.equal(classify("某保险公司发布人工智能理赔研究报告").category, "paper");
});
