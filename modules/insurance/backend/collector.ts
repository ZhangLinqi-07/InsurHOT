import { sql } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";
import { extractFromUrl } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import type { SourceRow } from "@aihot/backend/sources/types";
import { assertFreeSource, readIngestionPolicy } from "./archive.ts";
import { enrichNfra } from "./nfra.ts";

/** Collect source cards without running analysis, grouping or notification consumers. */
export async function collectFreeDue(limit = 6) {
  const due = await sql<SourceRow[]>`SELECT id,name,kind,config,tier,participation_mode,first_party,interval_minutes,enabled,cursor,fail_count
    FROM sources WHERE enabled AND kind IN ('rss','web_list','json_list') AND next_fetch_at <= now()
    ORDER BY next_fetch_at,id LIMIT ${limit}`;
  const results = [];
  for (const source of due) {
    assertFreeSource(source);
    results.push(await collectSource(source.id));
  }
  return results;
}

/** Free article reads also fill pending bodies while paid processing is stopped. */
export async function enrichFreeBodies(limit = 4) {
  const metadataOnly = readIngestionPolicy().plans.filter(plan => plan.bodyAccess === "metadata-only").map(plan => plan.sourceId);
  const candidates = await sql<{ id: string; source_id: string; url: string; title: string; config: SourceRow["config"] }[]>`
    SELECT a.id,a.source_id,a.url,a.title,s.config FROM articles a JOIN sources s ON s.id=a.source_id
    LEFT JOIN settings p ON p.key='insurance.free-body.' || a.id
    WHERE s.enabled AND s.kind IN ('rss','web_list','json_list') AND a.body_status='pending'
      AND a.source_id NOT LIKE 'nfra-%'
      AND a.source_id <> ALL(${metadataOnly}::text[])
      AND (p.value IS NULL OR (p.value->>'attemptedAt')::timestamptz < now()-interval '1 day')
    ORDER BY a.published_at DESC NULLS LAST,a.id LIMIT ${limit}`;
  const results = [];
  for (const candidate of candidates) {
    let result: { status: string; error?: string; chars?: number } = { status: "unconfirmed" };
    try {
      const body = await extractFromUrl(candidate.url, "insurance.free-body:" + candidate.id,
        { utcOffset: candidate.config.publishedAtUtcOffset }, { paidFallback: false });
      if (body) {
        const material = await upsertMaterial({ sourceId: candidate.source_id, url: candidate.url, title: candidate.title,
          ...body, bodyText: body.text, bodyHtml: body.html, bodyStatus: "ok", via: "insurance.free-body" });
        if (material.revised || material.processingNeeded) await queueProcessing(material.articleId);
        result = { status: "ok", chars: body.text.length };
      }
    } catch (error) { result = { status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }; }
    await sql`INSERT INTO settings(key,value,updated_by) VALUES (${"insurance.free-body." + candidate.id},${sql.json({ ...result, attemptedAt: new Date().toISOString() })},'insurance.collector')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now(),updated_by=excluded.updated_by`;
    results.push({ articleId: candidate.id, ...result });
  }
  return results;
}

export { enrichNfra };
