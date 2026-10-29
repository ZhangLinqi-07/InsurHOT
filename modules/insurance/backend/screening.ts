// A relevance-only judgement reuses the industry's native prefilter and its paid receipts.
import { createHash } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { runSelectionPrefilter, PROMPT_VERSIONS } from "@aihot/backend/editorial/analyze";
import type { AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { prefilterUser } from "@aihot/backend/editorial/writing";
import { completeReceipt, failedReceiptId, failureKind } from "@aihot/backend/providers/receipts";
import { publishArticleTx } from "@aihot/backend/publication/publish";

export interface ScreeningResult {
  articleId: string;
  revision: number;
  status: "attempted" | "screened" | "failed";
  attemptedAt: string;
  inputHash: string;
  promptVersion: string;
  label?: "PASS" | "BLOCK" | "UNKNOWN";
  reason?: string;
  model?: string;
  receiptId?: number | null;
  receiptReused?: boolean;
  currentRevision?: number | null;
  stale?: boolean;
  error?: string;
  failureKind?: string;
}

export async function screenFrozenArticle(input: AnalyzeInputArticle, runId: string): Promise<ScreeningResult> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw new Error("Invalid screening run ID");
  const key = `insurance.screen-trial.${runId}.${input.id}`;
  const initial: ScreeningResult = { articleId: input.id, revision: input.revision, status: "attempted", attemptedAt: new Date().toISOString(),
    inputHash: createHash("sha256").update(prefilterUser(input)).digest("hex"), promptVersion: PROMPT_VERSIONS.prefilter };
  // Mark before sending. An interrupted or failed sample is never automatically purchased again.
  const claimed = await sql`INSERT INTO settings(key,value,updated_by) VALUES (${key},${sql.json(initial as never)},'insurance.screen-trial')
    ON CONFLICT(key) DO NOTHING RETURNING key`;
  if (!claimed.length) {
    const [saved] = await sql`SELECT value FROM settings WHERE key=${key}`;
    if (saved.value.inputHash !== initial.inputHash || saved.value.promptVersion !== initial.promptVersion) throw new Error("Screening manifest changed for an existing sample");
    return saved.value;
  }
  let receiptId: number | null = null;
  try {
    const judgement = await runSelectionPrefilter(input, {}, id => { receiptId = id; });
    const [current] = await sql`SELECT revision FROM articles WHERE id=${input.id}`;
    const result: ScreeningResult = { ...initial, status: "screened", label: judgement.label, reason: judgement.reason,
      model: judgement.model, receiptId: judgement.receiptId, receiptReused: judgement.reused,
      currentRevision: current?.revision ?? null, stale: current?.revision !== input.revision };
    await sql.begin(async tx => {
      await tx`UPDATE settings SET value=${tx.json(result as never)},updated_at=now() WHERE key=${key}`;
      const judgementKey = `insurance.relevance.${input.id}@${input.revision}.${PROMPT_VERSIONS.prefilter}`;
      await tx`INSERT INTO settings(key,value,updated_by) VALUES (${judgementKey},${tx.json(result as never)},'insurance.screen-trial')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now(),updated_by=excluded.updated_by`;
      await completeReceipt(tx, judgement.receiptId);
      await publishArticleTx(tx, input.id);
    });
    return result;
  } catch (error) {
    const result: ScreeningResult = { ...initial, status: "failed", receiptId: receiptId ?? failedReceiptId(error),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 800), failureKind: failureKind(error) };
    await sql`UPDATE settings SET value=${sql.json(result as never)},updated_at=now() WHERE key=${key}`;
    return result;
  }
}
