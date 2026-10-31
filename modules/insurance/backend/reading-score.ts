import { createHash } from "node:crypto";
import { z } from "zod";
import { sql, type Db } from "@aihot/backend/db";
import type { PublicationScoreInput, StoredPublicationScore } from "@aihot/backend/modules";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { modelFor } from "@aihot/backend/editorial/models";
import { chatJson, MODELS } from "@aihot/backend/providers/llm";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { refreshPublicationScore } from "@aihot/backend/publication/publish";

export const READING_SCORE_VERSION = promptVersion("reading-score");
export const READING_SCORE_SYSTEM = promptText("reading-score", { title: "（见待评新闻的 title 字段）", summary: "（见待评新闻的 summary 字段）" });
export const ReadingScoreSchema = z.object({
  impact: z.number().int().min(0).max(40),
  information: z.number().int().min(0).max(30),
  usefulness: z.number().int().min(0).max(30),
  total: z.number().int().min(0).max(100),
}).strict().refine(value => value.total === value.impact + value.information + value.usefulness, "total must equal the sum of the three dimensions");

export function readingInputHash(input: Pick<PublicationScoreInput, "title" | "summary" | "category">): string {
  return createHash("sha256").update(JSON.stringify([input.title, input.summary, input.category])).digest("hex");
}

/** Reads a saved result for this exact classified copy; used by every republication. */
export async function storedReadingScore(input: PublicationScoreInput, db: Db): Promise<StoredPublicationScore | null> {
  if (!input.category || !input.summary?.trim()) return null;
  const [row] = await db`SELECT score,passes,model,model_key,receipt_ids,created_at FROM insurance_reading_scores
    WHERE article_id=${input.articleId} AND input_hash=${readingInputHash(input)} AND prompt_version=${READING_SCORE_VERSION}
    ORDER BY created_at DESC LIMIT 1`;
  return row ? { score: Number(row.score), evidence: { version: READING_SCORE_VERSION, inputHash: readingInputHash(input),
    input: { title: input.title, summary: input.summary, category: input.category }, model: row.model, modelKey: row.model_key,
    passes: row.passes, receiptIds: row.receipt_ids, score: Number(row.score), aggregation: "floor(mean(two independent totals))", at: row.created_at } } : null;
}

/** A separate worker step. Classification and structure are read as stored data and are never rerun. */
export async function scoreClassifiedArticle(articleId: string, opts: { model?: string; expectedHash?: string } = {}) {
  const [p] = await sql`SELECT article_id,title,summary,category,classification,eligible,visibility FROM publications WHERE article_id=${articleId}`;
  if (!p || !p.eligible || p.visibility !== "public" || !p.classification || !p.category || !p.summary?.trim())
    return { status: "held" as const, reason: "A public, already classified title and summary are required" };
  const input = { articleId, title: String(p.title), summary: String(p.summary), category: String(p.category) };
  const inputHash = readingInputHash(input);
  if (opts.expectedHash && opts.expectedHash !== inputHash) return { status: "stale" as const, reason: "Classified copy changed since the batch was frozen" };
  const model = opts.model ?? await modelFor("score");
  const actualModel = MODELS[model]?.model;
  if (!actualModel) throw new Error("The scoring model is not configured");
  const [saved] = await sql`SELECT 1 FROM insurance_reading_scores WHERE article_id=${articleId} AND input_hash=${inputHash}
    AND prompt_version=${READING_SCORE_VERSION} AND model=${actualModel}`;
  if (saved) {
    await sql.begin(tx => refreshPublicationScore(tx, articleId));
    return { status: "scored" as const, reused: true, score: (await storedReadingScore(input, sql))!.score };
  }
  const passes: Array<z.infer<typeof ReadingScoreSchema> & { receiptId: number; model: string; reused: boolean }> = [];
  for (let pass = 1; pass <= 2; pass++) {
    const answer = await chatJson({ model, purpose: "score_article", subject: `article:${articleId}:reading:${inputHash}`,
      promptVersion: READING_SCORE_VERSION, system: READING_SCORE_SYSTEM,
      user: JSON.stringify({ title: input.title, summary: input.summary }), schema: ReadingScoreSchema,
      temperature: 0.2, maxTokens: 1024, timeoutMs: 120_000, attemptTag: `reading-score-${pass}` });
    passes.push({ ...answer.data, receiptId: answer.receiptId, model: MODELS[answer.model]?.model ?? answer.model, reused: answer.reused });
  }
  const score = Math.floor((passes[0]!.total + passes[1]!.total) / 2);
  const receiptIds = passes.map(pass => pass.receiptId);
  const status = await sql.begin(async tx => {
    await tx`SELECT 1 FROM articles WHERE id=${articleId} FOR UPDATE`;
    const [current] = await tx<Array<{ title: string; summary: string | null; category: string | null; eligible: boolean; visibility: string }>>`
      SELECT title,summary,category,eligible,visibility FROM publications WHERE article_id=${articleId} FOR UPDATE`;
    await tx`INSERT INTO insurance_reading_scores(article_id,input_hash,prompt_version,model,model_key,title,summary,category,score,passes,receipt_ids)
      VALUES(${articleId},${inputHash},${READING_SCORE_VERSION},${actualModel},${model},${input.title},${input.summary},${input.category},${score},${tx.json(passes)},${receiptIds})
      ON CONFLICT(article_id,input_hash,prompt_version,model) DO NOTHING`;
    for (const receiptId of receiptIds) await completeReceipt(tx, receiptId);
    if (!current || !current.eligible || current.visibility !== "public" || readingInputHash(current) !== inputHash) return "stale" as const;
    await refreshPublicationScore(tx, articleId);
    return "scored" as const;
  });
  return { status, score, reused: passes.every(pass => pass.reused), receiptIds };
}
