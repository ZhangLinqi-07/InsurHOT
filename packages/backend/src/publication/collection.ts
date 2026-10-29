// Collection metadata and screening progress, including material still waiting for the public pool.
// Relevance-only cards keep their source excerpts separate from completed editorial copy.
import type { CollectionCoverage, CollectionLibrary, CollectionView, CollectedItem } from "@aihot/contracts/collection";
import { sql } from "../db.ts";
import { publicSourceName } from "./rules.ts";
import { releasedCondition } from "./scope.ts";

export interface CollectionReadOptions {
  screeningPrefix: string;
  archivePrefix: string;
  from: string;
}
export interface CollectionCatalogEntry {
  id: string;
  name: string;
  url: string | null;
  needsAuthorization: boolean;
  collectorIds: string[];
}
const PAGE_SIZE = 30;
const pattern = (q: string) => "%" + q.replace(/[\\%_]/g, value => "\\" + value) + "%";
const iso = (value: Date | null) => value?.toISOString() ?? null;

function collectionRows(options: CollectionReadOptions) {
  return sql`WITH screened AS MATERIALIZED (
      SELECT DISTINCT ON (value->>'articleId') value->>'articleId' AS article_id,(value->>'revision')::int AS revision,value
      FROM settings WHERE starts_with(key,${options.screeningPrefix}) AND value->>'status'='screened'
      ORDER BY value->>'articleId',value->>'attemptedAt' DESC,key DESC
    ), judged AS MATERIALIZED (
      SELECT DISTINCT ON (article_id) article_id,input_revision,relevance FROM analyses ORDER BY article_id,input_revision DESC,id DESC
    ), collected AS (
      SELECT a.id,a.title AS original_title,a.url,a.source_id,s.name AS source_name,a.published_at,a.publication_time,
        p.title AS prepared_title,p.summary AS prepared_summary,a.excerpt,
        (j.input_revision=a.revision AND j.relevance='pass' AND coalesce(p.eligible,false)) AS processed,
        CASE WHEN sf.revision=a.revision AND sf.value->>'reviewRequired'='true' THEN 'review'
          WHEN j.input_revision=a.revision AND j.relevance='pass' THEN 'related'
          WHEN j.input_revision=a.revision AND j.relevance='block' THEN 'excluded'
          WHEN sf.revision=a.revision AND sf.value->>'label'='PASS' THEN 'related'
          WHEN sf.revision=a.revision AND sf.value->>'label'='BLOCK' THEN 'excluded'
          WHEN sf.article_id IS NOT NULL OR j.article_id IS NOT NULL THEN 'review' ELSE 'pending' END AS state,
        CASE WHEN sf.revision=a.revision THEN sf.value->>'reason' END AS screening_reason,
        CASE WHEN sf.revision=a.revision AND sf.value->>'reviewRequired'='true' THEN sf.value->>'reviewReason' END AS review_note
      FROM articles a JOIN sources s ON s.id=a.source_id
      LEFT JOIN publications p ON p.article_id=a.id LEFT JOIN editorial_overrides eo ON eo.article_id=a.id
      LEFT JOIN screened sf ON sf.article_id=a.id LEFT JOIN judged j ON j.article_id=a.id
      WHERE s.participation_mode='editorial' AND a.published_at>=${new Date(options.from)} AND a.published_at<=now()
        AND coalesce(p.visibility,'public')<>'withdrawn' AND coalesce(eo.visibility,'public')<>'withdrawn'
        AND (p.article_id IS NULL OR ${releasedCondition(new Date())})
    )`;
}

export async function loadCollectedLibrary(options: CollectionReadOptions, query: { view?: string; q?: string; source?: string; page?: number } = {}): Promise<CollectionLibrary> {
  const view: CollectionView = ["related", "pending", "review", "excluded"].includes(query.view ?? "") ? query.view as CollectionView : "related";
  const q = (query.q ?? "").trim().slice(0, 160);
  const source = (query.source ?? "").slice(0, 80);
  const cte = collectionRows(options);
  const filtered = sql`${q ? sql`AND (original_title ILIKE ${pattern(q)} OR source_name ILIKE ${pattern(q)})` : sql``}
    ${source ? sql`AND source_id=${source}` : sql``}`;
  const [countsRows, available, health] = await Promise.all([
    sql`${cte} SELECT state,count(*)::int AS n FROM collected WHERE true ${filtered} GROUP BY state`,
    sql`${cte} SELECT source_id AS id,source_name AS name,count(*)::int AS count FROM collected GROUP BY source_id,source_name ORDER BY source_name`,
    sql`SELECT count(*) FILTER(WHERE enabled)::int AS enabled,max(last_ok_at) AS latest FROM sources WHERE participation_mode='editorial'`,
  ]);
  const counts: Record<CollectionView, number> = { related: 0, pending: 0, review: 0, excluded: 0 };
  for (const row of countsRows) counts[row.state as CollectionView] = row.n;
  const total = counts[view];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Math.min(1000, Math.floor(query.page ?? 1) || 1)));
  const rows = await sql`${cte} SELECT * FROM collected WHERE state=${view} ${filtered}
    ORDER BY published_at DESC,id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  const items: CollectedItem[] = rows.map(row => {
    const processed = row.processed === true;
    const excerpt = String((processed ? row.prepared_summary : row.excerpt) ?? "").replace(/\s+/g, " ").trim();
    return { id: row.id, title: processed && row.prepared_title ? row.prepared_title : row.original_title, url: row.url,
      source: { id: row.source_id, name: publicSourceName(row.source_name) }, publishedAt: row.published_at.toISOString(),
      publicationTime: row.publication_time ?? null,
      excerpt: excerpt ? excerpt.slice(0, 240) + (excerpt.length > 240 ? "…" : "") : null,
      excerptKind: excerpt ? processed ? "editorial" : "source" : null, state: row.state, processed, screeningReason: row.screening_reason ?? null, reviewNote: row.review_note ?? null };
  });
  return { view, query: q, source, page, pageCount, total, pageSize: PAGE_SIZE, counts,
    totalCollected: available.reduce((total, row) => total + row.count, 0), enabledSources: health[0].enabled,
    latestCollectionAt: iso(health[0].latest), sources: available.map(row => ({ id: row.id, name: publicSourceName(row.name), count: row.count })), items };
}

export async function loadCollectionCoverage(options: CollectionReadOptions, catalog: CollectionCatalogEntry[], query: { q?: string; page?: number } = {}): Promise<CollectionCoverage> {
  const [sources, progress] = await Promise.all([
    sql`SELECT id,name,enabled,last_ok_at FROM sources WHERE participation_mode='editorial'`,
    sql`SELECT substring(key from ${options.archivePrefix.length + 1}::int) AS source_id,value->>'status' AS status FROM settings WHERE starts_with(key,${options.archivePrefix})`,
  ]);
  const rows = catalog.map(entry => {
    const channels = [...new Set(entry.collectorIds)].flatMap(id => {
      const source = sources.find(s => s.id === id);
      if (!source) return [];
      const status = progress.find(p => p.source_id === id)?.status;
      const history = ["running", "exhausted", "limited", "failed"].includes(status ?? "") ? status : "not-started";
      return [{ name: publicSourceName(source.name), enabled: source.enabled, lastCollectedAt: iso(source.last_ok_at), history }];
    });
    return { id: entry.id, name: entry.name, url: publicCatalogUrl(entry.url),
      state: entry.needsAuthorization ? "awaiting-authorization" : channels.some(s => s.enabled) ? "channel-connected" : "not-connected", channels } as CollectionCoverage["entries"][number];
  });
  const q = (query.q ?? "").trim().slice(0, 160);
  const matching = q ? rows.filter(row => `${row.name} ${row.url ?? ""}`.toLowerCase().includes(q.toLowerCase())) : rows;
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Math.floor(query.page ?? 1) || 1));
  return { page, pageCount, total: matching.length, query: q, inventoryTotal: rows.length, configuredChannels: sources.length,
    enabledChannels: sources.filter(s => s.enabled).length, connectedEntries: rows.filter(r => r.state === "channel-connected").length,
    awaitingAuthorization: rows.filter(r => r.state === "awaiting-authorization").length, entries: matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
}

function publicCatalogUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) if (/token|secret|password|api.?key|authorization/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}
