import assert from "node:assert/strict";
import { test } from "node:test";
import { RUBRIC_WEIGHTS, RUBRIC_AXES } from "@aihot/industry/rubric";
import { rubricMaterial, validateRubric, rubricReview, rubricDecision, RubricSchema } from "@aihot/backend/editorial/rubric";

const input: any = { id: "test", revision: 1, title: "保险新规则", url: "https://example.com/rule", bodyText: "监管发布新规则。\n适用于本市场保险机构，明年生效。", xPost: null, source: {} };
const material = rubricMaterial(input);
function judgement(score = 6) { return RubricSchema.parse({ event: { type: "industry_event", subject: "监管", action: "发布", jurisdiction: "本市场", stage: "published", date: null, claim: "发布新规则" },
  axes: Object.fromEntries(RUBRIC_AXES.map(axis => [axis, { score, reason: "按原文所界定的范围评价", benchmark: { description: "相对本文提供的新规则基准", source: "P1" }, evidence: [{ paragraphId: "P1", quote: "监管发布新规则。" }] }])), caps: [], uncertainties: [] }); }
function pass(raw = judgement()) { return { ...validateRubric(raw, material), model: "stub", promptVersion: "v01", receiptId: 1 }; }

test("all seven fixed weight rows compute totals without a model total", () => {
  for (const [type, weights] of Object.entries(RUBRIC_WEIGHTS)) {
    const raw = judgement(); raw.event.type = type as any;
    assert.equal(weights.reduce<number>((a, b) => a + b, 0), 10);
    assert.equal(validateRubric(raw, material).score, 60);
  }
});
test("all caps retain before/after receipts; cap3 floors to2 and total cap30 is separate", () => {
  const raw = judgement(10);
  raw.caps = [{ rule: "routine", reason: "例行", evidence: raw.axes.sig.evidence }, { rule: "unsupported_promotion", reason: "宣传缺参数", evidence: raw.axes.sig.evidence },
    { rule: "conflicting_or_incomplete", reason: "材料冲突", evidence: raw.axes.sig.evidence }];
  const result = validateRubric(raw, material);
  assert.deepEqual(result.finalAxes, { sig: 2, nov: 2, cred: 4, reson: 10, act: 10 });
  assert.equal(result.weightedSum, 56); assert.equal(result.totalCap, 30); assert.equal(result.score, 30);
  assert.equal(result.capReceipts[0]!.before.sig, 10); assert.equal(result.capReceipts[0]!.after.sig, 2);
});
test("missing, invented, title-only or invalid-anchor evidence cannot receive a score", () => {
  for (const change of [
    (raw: any) => { raw.axes.sig.evidence = []; },
    (raw: any) => { raw.axes.sig.evidence[0].quote = "编造"; },
    (raw: any) => { raw.axes.sig.evidence = [{ paragraphId: "T", quote: input.title }]; },
    (raw: any) => { raw.axes.sig.score = 3; },
    (raw: any) => { raw.axes.sig.score = null; },
  ]) { const raw = judgement(); change(raw); assert.equal(validateRubric(raw, material).score, null); }
});
test("two-pass diagnostics retain type, stage, raw-axis disagreement and threshold crossing", () => {
  const first = pass(); const second = pass(); assert.deepEqual(rubricReview([first, second], 60), []);
  second.raw.event.type = "research_paper"; second.raw.event.stage = "effective"; second.raw.axes.sig.score = 10; second.score = 58;
  const reasons = rubricReview([first, second], 60);
  assert.ok(reasons.includes("event type conflict")); assert.ok(reasons.includes("event stage conflict"));
  assert.ok(reasons.some(reason => reason.includes("differ"))); assert.ok(reasons.includes("scores cross source-tier threshold"));
});

test("verified scores decide by their mean despite disagreements; incomplete evidence is rejected", () => {
  const first = pass(); const second = pass();
  first.score = 74; second.score = 78;
  second.raw.event.type = "research_paper"; second.raw.event.stage = "effective"; second.raw.axes.sig.score = 10;
  const decision = rubricDecision([first, second], 76);
  assert.equal(decision.decision, "selected"); assert.equal(decision.reviewRequired, false);
  assert.ok(decision.reviewReasons.includes("event type conflict"));
  assert.ok(decision.reviewReasons.includes("scores cross source-tier threshold"));
  second.score = 76;
  assert.equal(rubricDecision([first, second], 76).decision, "below-threshold");
  second.score = null;
  assert.equal(rubricDecision([first, second], 76).decision, "insufficient-evidence");
  assert.equal(rubricDecision([first], 60).decision, "insufficient-evidence");
  assert.equal(rubricDecision([first, second], 76).reviewRequired, false);
});
test("original snapshot hash changes with material and does not fabricate fetch times", () => {
  assert.equal(material.fetchedAt, null); assert.equal(material.originalText, input.bodyText);
  assert.notEqual(rubricMaterial({ ...input, bodyText: input.bodyText + "更正" }).sourceHash, material.sourceHash);
});
