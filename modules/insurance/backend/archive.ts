// Historical imports have their own progress; the engine's live-source cursor must keep moving forward.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { listingEntries, storedDetails, enrichDetails, loadSource } from "@aihot/backend/sources/collect";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { guardedFetch, requireOk } from "@aihot/backend/lib/http-fetch";
import { readPublicationDate } from "@aihot/backend/sources/dates";
import { stripTags, collapseWhitespace } from "@aihot/backend/lib/text";
import { readable } from "@aihot/backend/content/extract";
import type { Candidate, SourceRow } from "@aihot/backend/sources/types";

export type Pagination = { kind: "single" }
  | { kind: "query"; key: string; first: number; step?: number; companions?: Record<string, number> }
  | { kind: "json-query"; key: string; pageKey: string; first: number }
  | { kind: "path"; template: string; first: number }
  | { kind: "wordpress"; first: number };

export interface ArchivePlan {
  sourceId: string;
  listing?: { kind: SourceRow["kind"]; config: SourceRow["config"] };
  pagination: Pagination;
  evidence: string;
  /** Only enabled after observing descending publication order on distinct real pages. */
  descending?: boolean;
  coverage: string;
  bodyAccess?: "metadata-only";
}
export interface IngestionPolicy {
  schemaVersion: number;
  from: string;
  plans: ArchivePlan[];
}
export interface ArchiveProgress {
  signature: string;
  page: number;
  status: "running" | "exhausted" | "limited" | "failed";
  reason?: string;
  pages: number;
  found: number;
  accepted: number;
  undated: number;
  created: number;
  fingerprints: string[];
  attemptedAt: string;
  error?: string;
  earliest?: string;
  latest?: string;
  through?: string;
  pageDates?: Record<string, { publishedAt: string | null; publicationTime: string | null }>;
  detailFailures?: Array<{ url: string; error: string }>;
  unmappedPosts?: Array<{ page: number; id?: number; url?: string; publishedAt?: string; error: string }>;
}

export function readIngestionPolicy(): IngestionPolicy {
  const policy = JSON.parse(readFileSync(resolve(REPO_ROOT, "industry/insurance-ingestion.json"), "utf8")) as IngestionPolicy;
  if (policy.schemaVersion !== 1 || !Number.isFinite(Date.parse(policy.from)) || !Array.isArray(policy.plans)) throw new Error("Invalid insurance ingestion policy");
  return policy;
}

/** Collection-only code refuses indirect paid readers too, regardless of machine-wide credentials. */
export function assertFreeSource(source: SourceRow) {
  if (!["rss", "web_list", "json_list"].includes(source.kind)) throw new Error("This source requires a separate collection provider");
  const url = new URL(String(source.config.feedUrl ?? source.config.url));
  if (url.username || url.password || url.hostname === "r.jina.ai" || source.config.apiKeyEnv || source.config.bearerTokenEnv || source.config.bearerEnv) throw new Error("Paid or credentialed source is outside free collection");
}

export function archiveSource(source: SourceRow, plan: ArchivePlan, page: number, through: Date): SourceRow {
  assertFreeSource(source);
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("Invalid archive page");
  const config = structuredClone(source.config);
  const field = source.kind === "rss" ? "feedUrl" : "url";
  const url = new URL(String(config[field]));
  const p = plan.pagination;
  if (p.kind === "query") {
    url.searchParams.set(p.key, String(page));
    for (const [key, value] of Object.entries(p.companions ?? {})) url.searchParams.set(key, String(Number(value) + (page - p.first)));
  } else if (p.kind === "json-query") {
    const data = JSON.parse(url.searchParams.get(p.key) ?? "{}");
    data[p.pageKey] = page;
    url.searchParams.set(p.key, JSON.stringify(data));
  } else if (p.kind === "wordpress") {
    url.searchParams.set("page", String(page));
    url.searchParams.set("before", through.toISOString().replace(/\.\d{3}Z$/, "Z"));
  } else if (p.kind === "path") {
    const target = new URL(p.template.replace("{page}", String(page)), url);
    if (target.origin !== url.origin) throw new Error("Archive pagination changed origin");
    config[field] = target.href;
    return { ...source, config, cursor: null };
  }
  config[field] = url.href;
  return { ...source, config, cursor: null };
}

export function windowCandidates<C extends Candidate>(candidates: C[], from: Date, through: Date): C[] {
  return candidates.filter(c => c.publishedAt && c.publishedAt.getTime() >= from.getTime() && c.publishedAt.getTime() <= through.getTime());
}

export function pageDecision(candidates: Candidate[], plan: ArchivePlan, from: Date, repeated: boolean) {
  if (repeated) return { status: "limited" as const, reason: "pagination-repeated-page" };
  if (!candidates.length) return { status: "exhausted" as const, reason: "endpoint-empty-page" };
  if (plan.pagination.kind === "single") return { status: "limited" as const, reason: "current-list-only-no-verified-archive" };
  if (plan.descending && candidates.every(c => c.publishedAt && c.publishedAt.getTime() < from.getTime())) return { status: "exhausted" as const, reason: "publication-boundary-reached" };
  return { status: "running" as const };
}

export async function readArchiveProgress(sourceId: string): Promise<ArchiveProgress | null> {
  const [row] = await sql`SELECT value FROM settings WHERE key=${"insurance.archive." + sourceId}`;
  return row?.value ?? null;
}
function signatureFor(source: SourceRow, plan: ArchivePlan, from: Date) {
  return createHash("sha256").update(JSON.stringify({ kind: source.kind, config: source.config, plan, from,
    ...(plan.pagination.kind === "wordpress" ? { boundary: "utc-before" } : {}) })).digest("hex");
}
async function saveProgress(sourceId: string, progress: ArchiveProgress) {
  await sql`INSERT INTO settings(key,value,updated_by) VALUES (${"insurance.archive." + sourceId},${sql.json(progress as never)},'insurance.archive')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now(),updated_by=excluded.updated_by`;
}

export async function archivePage(sourceId: string, plan: ArchivePlan, from: Date, through = new Date()) {
  const liveSource = await loadSource(sourceId);
  if (!liveSource?.enabled) return { sourceId, status: "skipped", reason: "paused-or-missing" };
  const source = plan.listing ? { ...liveSource, ...plan.listing } : liveSource;
  assertFreeSource(source);
  const signature = signatureFor(source, plan, from);
  const saved = await readArchiveProgress(sourceId);
  const progress: ArchiveProgress = saved?.signature === signature ? saved : {
    signature, page: plan.pagination.kind === "single" ? 1 : plan.pagination.first, status: "running",
    pages: 0, found: 0, accepted: 0, undated: 0, created: 0, fingerprints: [], attemptedAt: new Date().toISOString(), through: through.toISOString(),
  };
  if (["exhausted", "limited"].includes(progress.status)) return { sourceId, ...progress };
  progress.attemptedAt = new Date().toISOString();
  try {
    const upper = new Date(progress.through ?? through);
    const pageSource = archiveSource(source, plan, progress.page, upper);
    let raw: Candidate[];
    const unmapped: NonNullable<ArchiveProgress["unmappedPosts"]> = [];
    if (plan.pagination.kind === "wordpress") {
      const response = await guardedFetch(String(pageSource.config.url), { timeoutMs: 25_000, maxBytes: 6_000_000 });
      const data = JSON.parse(response.text());
      if (response.status === 400 && data.code === "rest_post_invalid_page_number") raw = [];
      else {
        requireOk(response);
        if (!Array.isArray(data)) throw new Error("WordPress archive did not return posts");
        raw = data.flatMap(post => {
          if (!post.link || !post.title?.rendered || !post.id) {
            unmapped.push({ page: progress.page, id: post.id, url: post.link, publishedAt: post.date_gmt, error: "WordPress post lacks identity or title" });
            return [];
          }
          const html = typeof post.content?.rendered === "string" ? post.content.rendered : "";
          const body = html && plan.bodyAccess !== "metadata-only" ? readable(`<html><head><title>${post.title.rendered}</title></head><body><article>${html}</article></body></html>`, post.link) : null;
          return [{ url: post.link, title: collapseWhitespace(stripTags(post.title.rendered)),
            ...readPublicationDate(post.date_gmt, "+00:00"), excerpt: plan.bodyAccess === "metadata-only" ? null : stripTags(post.excerpt?.rendered ?? "").slice(0, 2000),
            ...(body ? { bodyText: body.text, bodyHtml: body.html, bodyStatus: "ok" as const, media: body.images } : {}), raw: { externalId: post.id } }];
        });
      }
    } else raw = source.kind === "rss" ? (await fetchRss(pageSource, { force: true })).candidates
      : source.kind === "json_list" ? await fetchJsonList(pageSource) : await fetchWebList(pageSource);
    const listed = await listingEntries(pageSource, raw);
    const fingerprint = createHash("sha256").update(listed.map(c => c.identityKey).sort().join("\n")).digest("hex");
    const repeated = listed.length > 0 && progress.fingerprints.includes(fingerprint);
    const remembered = progress.pageDates ?? {};
    for (const candidate of listed) {
      const date = remembered[candidate.identityKey!];
      if (date) { candidate.publishedAt = date.publishedAt ? new Date(date.publishedAt) : null; candidate.publicationTime = date.publicationTime; }
    }
    const known = await storedDetails(listed.map(c => c.identityKey!));
    const details = await enrichDetails(listed.filter(c => !remembered[c.identityKey!]), pageSource, known,
      { budget: 4, datedOut: {}, admits: c => !c.publishedAt || c.publishedAt >= from });
    for (const candidate of listed) {
      if (candidate.detailRules || details.failures.some(f => f.url === candidate.url)) remembered[candidate.identityKey!] = {
        publishedAt: candidate.publishedAt?.toISOString() ?? null, publicationTime: candidate.publicationTime ?? null,
      };
    }
    const pendingDetails = details.pending > 0;
    const accepted = repeated ? [] : windowCandidates(listed, from, upper);
    // Save the page atomically with its continuation and queue writes. A restart cannot skip half a page.
    const next: ArchiveProgress = structuredClone(progress);
    const decision = pendingDetails || !listed.length && unmapped.length ? { status: "running" as const } : pageDecision(listed, plan, from, repeated);
    Object.assign(next, decision, { error: undefined });
    next.pages += pendingDetails ? 0 : 1;
    next.found += pendingDetails ? 0 : listed.length;
    next.accepted += accepted.length;
    next.undated += pendingDetails ? 0 : listed.filter(c => !c.publishedAt).length;
    if (details.failures.length) next.detailFailures = [...(next.detailFailures ?? []), ...details.failures];
    if (unmapped.length) next.unmappedPosts = [...(next.unmappedPosts ?? []), ...unmapped];
    const dates = accepted.map(c => c.publishedAt!.toISOString());
    if (dates.length) {
      next.earliest = [...dates, ...(next.earliest ? [next.earliest] : [])].sort()[0];
      next.latest = [...dates, ...(next.latest ? [next.latest] : [])].sort().at(-1);
    }
    // Missing dates remain visible as a coverage limitation even after all reachable pages are read.
    if (next.status === "exhausted" && next.undated) { next.status = "limited"; next.reason = "archive-read-with-undated-items"; }
    if (next.status === "exhausted" && next.unmappedPosts?.length) { next.status = "limited"; next.reason = "archive-read-with-unmapped-posts"; }
    if (!pendingDetails && !repeated && listed.length) next.fingerprints.push(fingerprint);
    if (pendingDetails) next.pageDates = remembered;
    else {
      delete next.pageDates;
      next.page += plan.pagination.kind === "query" ? plan.pagination.step ?? 1 : 1;
    }
    await sql.begin(async tx => {
      for (const candidate of [...accepted].sort((a, b) => a.identityKey!.localeCompare(b.identityKey!))) {
        const material = await upsertMaterial({ ...candidate, sourceId, via: "insurance.archive", backfill: "insurance-two-year-import" }, tx);
        if (candidate.detailRules) await tx`UPDATE articles SET raw=jsonb_set(
          CASE WHEN jsonb_typeof(raw)='object' THEN raw ELSE '{}'::jsonb END,'{collectionDetail}',${tx.json({ rules: candidate.detailRules })})
          WHERE id=${material.articleId} AND source_id=${sourceId}`;
        if (material.created) next.created += 1;
        if (material.created || material.revised || material.processingNeeded) await queueProcessing(material.articleId, { db: tx });
      }
      await tx`INSERT INTO settings(key,value,updated_by) VALUES (${"insurance.archive." + sourceId},${tx.json(next as never)},'insurance.archive')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now(),updated_by=excluded.updated_by`;
    });
    return { sourceId, ...next };
  } catch (error) {
    progress.status = "failed";
    progress.error = (error instanceof Error ? error.message : String(error)).slice(0, 600);
    await saveProgress(sourceId, progress);
    return { sourceId, ...progress };
  }
}

/** Fair rotation gives each source one page before returning to a source's next page. */
export async function archiveSlice(limit = 4) {
  const policy = readIngestionPolicy();
  const pending = await Promise.all(policy.plans.map(async plan => {
    const live = await loadSource(plan.sourceId);
    if (!live?.enabled) return { plan, progress: null, enabled: false, host: "" };
    const source = plan.listing ? { ...live, ...plan.listing } : live;
    const progress = await readArchiveProgress(plan.sourceId);
    return { plan, progress: progress?.signature === signatureFor(source, plan, new Date(policy.from)) ? progress : null,
      enabled: true, host: new URL(source.config.url ?? source.config.feedUrl).hostname };
  }));
  const due = pending.filter(({ progress, enabled }) => enabled && (!progress || progress.status === "running" || progress.status === "failed" && Date.now() - Date.parse(progress.attemptedAt) > 3_600_000))
    .sort((a, b) => (a.progress?.attemptedAt ?? "").localeCompare(b.progress?.attemptedAt ?? ""));
  const selected: typeof due = [];
  const hosts = new Set<string>();
  for (const item of due) {
    if (hosts.has(item.host)) continue;
    hosts.add(item.host);selected.push(item);
    if (selected.length >= limit) break;
  }
  return Promise.all(selected.map(({ plan }) => archivePage(plan.sourceId, plan, new Date(policy.from))));
}
