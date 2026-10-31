import { createHash } from "node:crypto";
import { z } from "zod";
import { RUBRIC_AXES, RUBRIC_ANCHORS, RUBRIC_CAPS, RUBRIC_VERSION, RUBRIC_WEIGHTS } from "@aihot/industry/rubric";
import type { AnalyzeInputArticle } from "./input.ts";
import { MAX_BODY_CHARS } from "./writing.ts";

const types = Object.keys(RUBRIC_WEIGHTS) as [keyof typeof RUBRIC_WEIGHTS, ...Array<keyof typeof RUBRIC_WEIGHTS>];
const capNames = Object.keys(RUBRIC_CAPS) as [keyof typeof RUBRIC_CAPS, ...Array<keyof typeof RUBRIC_CAPS>];
const Evidence = z.object({ paragraphId: z.string().min(1).max(20), quote: z.string().trim().min(1).max(600) });
const Axis = z.object({ score: z.number().int().nullable(), reason: z.string().trim().min(1).max(500), evidence: z.array(Evidence).max(5),
  benchmark: z.object({ description: z.string().trim().min(1).max(500), source: z.string().min(1).max(20) }).optional() });
export const RubricSchema = z.object({
  event: z.object({ type: z.enum(types), subject: z.string().max(200), action: z.string().max(200), jurisdiction: z.string().max(200),
    stage: z.enum(["consultation", "published", "effective", "licensed", "executed", "disclosed", "estimated", "proposed", "review", "unknown"]), date: z.string().nullable(), claim: z.string().max(600) }),
  axes: z.object({ sig: Axis, nov: Axis, cred: Axis, reson: Axis, act: Axis }),
  caps: z.array(z.object({ rule: z.enum(capNames), reason: z.string().min(1).max(500), evidence: z.array(Evidence).min(1).max(5) })).max(9),
  uncertainties: z.array(z.string().max(500)).max(15),
});
type Judgement = z.infer<typeof RubricSchema>;
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function rubricMaterial(a: AnalyzeInputArticle) {
  const originalText = a.xPost ? [String(a.xPost.text ?? ""), String(a.xPost.quoted?.text ?? "")].filter(Boolean).join("\n\n") : (a.bodyText || a.excerpt || "");
  const modelText = originalText.slice(0, MAX_BODY_CHARS);
  const paragraphs = [{ id: "T", text: a.title }, ...modelText.split(/\n+/).map(text => text.trim()).filter(Boolean).map((text, i) => ({ id: `P${i + 1}`, text }))];
  return { version: RUBRIC_VERSION, sourceUrl: a.url, source: { name: a.source.name, tier: a.source.tier, kind: a.source.kind }, articleId: a.id, revision: a.revision, originalTitle: a.title, originalText,
    sourceHash: hash(JSON.stringify([a.title, originalText])), modelTextHash: hash(modelText),
    capturedAt: new Date().toISOString(), fetchedAt: a.materialStoredAt ?? null,
    fetchTimeBasis: a.materialStoredAt ? "stored material revision timestamp" : "not recorded by earlier collector", truncated: originalText.length > modelText.length,
    paragraphs };
}
export type RubricMaterial = ReturnType<typeof rubricMaterial>;

export function rubricInput(a: AnalyzeInputArticle, material: RubricMaterial) {
  return JSON.stringify({ instruction: "按系统量表输出事件、五轴档位、每轴原文短摘及段落ID、压分规则和不确定项。不能判断的轴 score 为 null。不要输出总分或精选结论。",
    publishedAt: a.publishedAt?.toISOString() ?? null, publicationTime: a.publicationTime ?? null, materialVersion: material.sourceHash,
    truncated: material.truncated, paragraphs: material.paragraphs });
}

/** Verify quotations and anchors, then compute totals outside the model. */
export function validateRubric(raw: Judgement, material: RubricMaterial) {
  const problems: string[] = [];
  if (!raw.event.subject.trim() || !raw.event.action.trim() || !raw.event.claim.trim() || raw.event.stage === "unknown") problems.push("event identity or stage is unresolved");
  if (!raw.axes.nov.benchmark || !material.paragraphs.some(p => p.id === raw.axes.nov.benchmark!.source)) problems.push("nov: comparison benchmark or its source is missing");
  const grounded = (e: z.infer<typeof Evidence>) => {
    const paragraph = material.paragraphs.find(p => p.id === e.paragraphId);
    return !!paragraph && normalize(paragraph.text).includes(normalize(e.quote));
  };
  const finalAxes = {} as Record<typeof RUBRIC_AXES[number], number | null>;
  for (const axis of RUBRIC_AXES) {
    const judgement = raw.axes[axis];
    finalAxes[axis] = judgement.score;
    if (judgement.score === null) problems.push(`${axis}: unable to judge: ${judgement.reason}`);
    else if (![0, 2, 4, 6, 8, 10].includes(judgement.score)) problems.push(`${axis}: invalid anchor`);
    // A title alone never verifies an axis about the unseen article.
    if (!judgement.evidence.length || !judgement.evidence.some(e => e.paragraphId !== "T") || judgement.evidence.some(e => !grounded(e))) problems.push(`${axis}: missing or unverified evidence`);
  }
  const capReceipts: Array<{ rule: string; reason: string; before: Record<string, number | null>; after: Record<string, number | null>; totalCap?: number }> = [];
  let totalCap: number | null = null;
  for (const cap of raw.caps) {
    if (!cap.evidence.length || cap.evidence.some(e => !grounded(e))) problems.push(`${cap.rule}: unverified cap evidence`);
    const before = { ...finalAxes };
    const limits = RUBRIC_CAPS[cap.rule] as Partial<Record<typeof RUBRIC_AXES[number] | "total", number>>;
    for (const axis of RUBRIC_AXES) {
      const value = finalAxes[axis], limit = limits[axis];
      if (value !== null && limit !== undefined) finalAxes[axis] = Math.min(value, Math.floor(limit / 2) * 2);
    }
    if (limits.total !== undefined) totalCap = Math.min(totalCap ?? 100, limits.total);
    capReceipts.push({ rule: cap.rule, reason: cap.reason, before, after: { ...finalAxes }, ...(limits.total !== undefined ? { totalCap: limits.total } : {}) });
  }
  const weights = RUBRIC_WEIGHTS[raw.event.type];
  const weightedSum = problems.length ? null : RUBRIC_AXES.reduce((sum, axis, i) => sum + finalAxes[axis]! * weights[i]!, 0);
  const score = weightedSum === null ? null : Math.min(weightedSum, totalCap ?? 100);
  const anchors = Object.fromEntries(RUBRIC_AXES.map(axis => [axis, raw.axes[axis].score === null ? null : RUBRIC_ANCHORS[axis][raw.axes[axis].score! / 2] ?? null]));
  return { raw, anchors, finalAxes, weights, weightedSum, totalCap, score, capReceipts, holdReasons: problems };
}
export type RubricPass = ReturnType<typeof validateRubric> & { receiptId: number; model: string; promptVersion: string };

export function rubricReview(passes: RubricPass[], threshold: number) {
  const reasons: string[] = [];
  if (passes.length !== 2 || passes.some(p => p.score === null)) reasons.push("missing evidence or incomplete passes");
  const [a, b] = passes;
  if (a && b) {
    if (a.raw.event.type !== b.raw.event.type) reasons.push("event type conflict");
    if (normalize(a.raw.event.stage) !== normalize(b.raw.event.stage)) reasons.push("event stage conflict");
    for (const axis of RUBRIC_AXES) {
      const first = a.raw.axes[axis].score, second = b.raw.axes[axis].score;
      if (first !== null && second !== null && Math.abs(first - second) >= 4) reasons.push(`${axis}: passes differ by at least 4`);
    }
    if (a.score !== null && b.score !== null && (a.score >= threshold) !== (b.score >= threshold)) reasons.push("scores cross source-tier threshold");
  }
  return reasons;
}

/** Disagreements remain evidence; two verified scores and their mean decide automatically. */
export function rubricDecision(passes: RubricPass[], threshold: number) {
  const complete = passes.length === 2 && passes.every(pass => pass.score !== null);
  const sum = complete ? passes.reduce((total, pass) => total + pass.score!, 0) : null;
  return {
    decisionPolicy: "verified-mean-v1" as const,
    decision: sum === null ? "insufficient-evidence" as const : sum >= threshold * 2 ? "selected" as const : "below-threshold" as const,
    reviewReasons: rubricReview(passes, threshold),
    reviewRequired: false,
  };
}
