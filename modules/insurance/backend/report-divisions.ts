import { sql } from "@aihot/backend/db";
import { eventMarketCondition } from "@aihot/backend/publication/market";

export const insuranceReportDivisions = {
  divisions: [
    { key: "domestic", label: "国内动态", keepEmpty: true },
    { key: "foreign", label: "国际动态", keepEmpty: true },
    { key: "global", label: "全球与地域待明确" },
  ],
  async assign(articleIds: string[]): Promise<Map<string, string>> {
    if (!articleIds.length) return new Map();
    const assigned = new Map<string, string>();
    // Cross-border events have one home. Explicit Chinese market evidence takes precedence.
    for (const market of ["domestic", "foreign"] as const) {
      const rows = await sql<{ id: string }[]>`SELECT p.article_id AS id FROM publications p
        WHERE p.article_id = ANY(${articleIds}::text[]) ${eventMarketCondition(market)}`;
      for (const { id } of rows) if (!assigned.has(id)) assigned.set(id, market);
    }
    for (const id of articleIds) if (!assigned.has(id)) assigned.set(id, "global");
    return assigned;
  },
};
