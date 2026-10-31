// A site's stored relevance decisions. No model calls.
import type { Tx } from "../db.ts";
import { serverModules } from "../modules.ts";

export async function storedScreening(tx: Tx, articleId: string): Promise<{
  revision: number; label: string; reviewRequired: boolean; from: Date;
} | null> {
  for (const module of serverModules()) {
    const policy = module.screenedPublication;
    if (!policy) continue;
    const [row] = await tx<{ value: Record<string, unknown> }[]>`
      SELECT value FROM settings WHERE starts_with(key,${policy.screeningPrefix})
        AND value->>'articleId'=${articleId} AND value->>'status'='screened'
      ORDER BY value->>'attemptedAt' DESC,key DESC LIMIT 1`;
    if (row) return {
      revision: Number(row.value.revision), label: String(row.value.label),
      reviewRequired: row.value.reviewRequired === true, from: new Date(policy.from),
    };
  }
  return null;
}
