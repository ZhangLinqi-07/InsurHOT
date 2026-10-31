// NFRA publishes its article bodies through the same public JSON endpoint used by its website.
// Keep the original human-readable URL and pass revisions through the shared material entrance.
import { sql } from "@aihot/backend/db";
import { parseHTML } from "linkedom";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { guardedFetch, requireOk } from "@aihot/backend/lib/http-fetch";
import { readPublicationDate } from "@aihot/backend/sources/dates";
import { stripTags } from "@aihot/backend/lib/text";

export interface NfraEnrichmentResult {
  articleId: string;
  url: string;
  status: "ok" | "failed";
  bodyChars?: number;
  error?: string;
}

export function nfraDocId(url: string): string {
  const original = new URL(url);
  if (original.protocol !== "https:" || original.username || original.password || original.port || original.hostname !== "www.nfra.gov.cn" || original.pathname !== "/cn/view/pages/ItemDetail.html") throw new Error("Not an NFRA article URL");
  const docId = original.searchParams.get("docId");
  if (!docId || !/^\d+$/.test(docId)) throw new Error("Missing NFRA docId");
  return docId;
}

/** The response must name this document and contain a readable body, never the page's JS shell. */
export function parseNfraBody(url: string, result: { rptCode?: number; data?: { docId?: number | string; docClob?: unknown; docTitle?: unknown; publishDate?: unknown } }) {
  const docId = nfraDocId(url);
  if (result.rptCode !== 200 || String(result.data?.docId) !== docId || typeof result.data?.docClob !== "string") throw new Error("NFRA response has no matching article body");
  // docClob is the publisher's article container, including short official notices and tables.
  // Page readability can otherwise select a longer copyright footer instead of the real article.
  const { document } = parseHTML(result.data.docClob);
  const article = document.querySelector("body");
  const html = sanitizeBody(article?.innerHTML ?? result.data.docClob, url);
  const text = stripTags(html).trim();
  if (text.length < 40 || text.includes("\uFFFD") || /^版权与免责声明/.test(text)) throw new Error("NFRA article body could not be confirmed");
  const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)].slice(0, 12).map(match => ({ kind: "image" as const, url: match[1]!.replace(/&amp;/g, "&"), width: null, height: null }));
  return { html, text, images, ...readPublicationDate(typeof result.data.publishDate === "string" ? result.data.publishDate : null, "+08:00") };
}

export async function fetchNfraBody(url: string) {
  const docId = nfraDocId(url);
  const apiUrl = `https://www.nfra.gov.cn/cbircweb/DocInfo/SelectByDocId?docId=${docId}`;
  const response = requireOk(await guardedFetch(apiUrl, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 }), "NFRA article JSON");
  return parseNfraBody(url, JSON.parse(response.text()));
}

export async function pendingNfraArticles(limit = 10) {
  if (!Number.isFinite(limit) || limit < 1) throw new Error("limit must be positive");
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  return sql<{ id: string; source_id: string; url: string; title: string }[]>`
    SELECT a.id, a.source_id, a.url, a.title FROM articles a JOIN sources s ON s.id = a.source_id
    LEFT JOIN settings progress ON progress.key = 'insurance.nfra-body.' || a.id
    WHERE s.enabled AND a.source_id LIKE 'nfra-%' AND a.body_status != 'ok'
      AND a.url LIKE 'https://www.nfra.gov.cn/cn/view/pages/ItemDetail.html%'
      AND NOT (coalesce(progress.value->>'status','') = 'failed'
        AND coalesce(progress.value->>'error','') LIKE '%HTTP 403%')
    ORDER BY progress.value->>'attemptedAt' ASC NULLS FIRST, a.discovered_at DESC, a.id LIMIT ${bounded}`;
}

/** Save progress before the request, including a failed/aborted attempt in the fair rotation. */
export async function recordNfraAttempt(articleId: string, status: "attempted" | "ok" | "failed", error?: string) {
  const value = { attemptedAt: new Date().toISOString(), status, ...(error ? { error: error.slice(0, 300) } : {}) };
  await sql`INSERT INTO settings (key, value, updated_by)
    VALUES (${'insurance.nfra-body.' + articleId}, ${sql.json(value)}, 'insurance.nfra')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
}

/** Bounded, idempotent enrichment. It queues normal processing and never calls a model itself. */
export async function enrichNfra(limit = 10): Promise<NfraEnrichmentResult[]> {
  const articles = await pendingNfraArticles(limit);
  const results: NfraEnrichmentResult[] = [];
  for (const article of articles) {
    await recordNfraAttempt(article.id, "attempted");
    try {
      const body = await fetchNfraBody(article.url);
      const material = await upsertMaterial({ sourceId: article.source_id, url: article.url, title: article.title,
        ...body, bodyHtml: body.html, bodyText: body.text, bodyStatus: "ok", media: body.images, via: "insurance-nfra" });
      if (material.created || material.revised || material.processingNeeded) await queueProcessing(material.articleId);
      await recordNfraAttempt(article.id, "ok");
      results.push({ articleId: material.articleId, url: article.url, status: "ok", bodyChars: body.text.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordNfraAttempt(article.id, "failed", message);
      results.push({ articleId: article.id, url: article.url, status: "failed", error: message });
    }
  }
  return results;
}
