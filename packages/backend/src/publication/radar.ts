import type { RadarItem, RadarResponse } from "@aihot/contracts/radar";
import { addDays, beijingDate, beijingMidnight } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { displayTags, publicSourceName } from "./rules.ts";
import { listedCondition } from "./scope.ts";

/** A bounded, date-based view of the same publications the ordinary pool can show. */
export async function loadRadar(days: 30 | 90 | null = 90, now = new Date()): Promise<RadarResponse> {
  const limit = 600;
  const from = days === null ? null : beijingMidnight(addDays(beijingDate(now), 1 - days));
  type Row = Omit<RadarItem, "id" | "source" | "publishedAt" | "prefiltered"> & {
    id: string | null; source_name: string; published_at: Date; prefiltered: boolean; total: number;
  };
  const rows = await sql<Row[]>`
    WITH candidates AS MATERIALIZED (
      SELECT p.article_id AS id, p.title, p.summary, s.name AS source_name, p.published_at,
        p.category, p.tags, p.selected, (p.analysis_id IS NULL AND p.eligible) AS prefiltered
      FROM publications p JOIN sources s ON s.id = p.source_id
      WHERE ${listedCondition(now)} AND p.published_at IS NOT NULL AND p.published_at <= ${now}
        ${from ? sql`AND p.published_at >= ${from}` : sql``}
    ), total AS (SELECT count(*)::int AS total FROM candidates)
    SELECT page.*, total.total FROM total LEFT JOIN LATERAL (
      SELECT * FROM candidates ORDER BY published_at DESC, id DESC LIMIT ${limit}
    ) page ON true ORDER BY page.published_at DESC, page.id DESC`;
  const total = rows[0]!.total;
  const items = rows.filter(row => row.id !== null).map(row => ({
    id: row.id!, title: row.title, summary: row.summary,
    source: { name: publicSourceName(row.source_name) }, publishedAt: row.published_at.toISOString(),
    category: row.category, tags: displayTags(row.tags), selected: row.selected,
    ...(row.prefiltered ? { prefiltered: true as const } : {}),
  }));
  return { items, total, truncated: total > items.length, limit, from: from?.toISOString() ?? null, to: now.toISOString(), days };
}
