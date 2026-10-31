// Publishing: derive the public projection of one article from its material, the latest judgement,
// manual overrides and grouping, then record selected-set changes in the sync ledger.
// Rebuilding only re-reads stored results; it never calls a model.
import { toPublicApiCategory } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/site";
import { one, sql, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { collapseWhitespace, isChineseText } from "../lib/text.ts";
import type { XPostData } from "../content/materials.ts";
import { originalPostCopy } from "../content/posts.ts";
import { itemUrl } from "./links.ts";
import { pickRepresentative, REPRESENTATIVE_COLUMNS, type RepresentativeIdentity } from "./representative.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { classifyArticle, emit, serverModules, storedPublicationScore } from "../modules.ts";
import { storedScreening } from "./screening.ts";
import { sourcePreview } from "../lib/source-preview.ts";
import {
  bodyModeOf, channelOf, displayTags, isIndexable, isPoolEligible, isSelectable, isIndependentSelectedSource, mayRedistribute, publicSourceName, type SourceFacts,
} from "./rules.ts";
import { foldableSelectionCondition, latestCompositeCondition, ownFactEvidenceCondition } from "./scope.ts";

interface ArticleRow {
  id: string;
  source_id: string;
  url: string;
  title: string;
  revision: number;
  excerpt: string | null;
  language: string | null;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  backfill: boolean;
  body_status: string;
  body_text: string | null;
  x_post: XPostData | null;
  x_article: { text?: string } | null;
  grouped_at: Date | null;
  grouping_status: "pending" | "complete" | "failed";
  selection_adds_value: boolean | null;
}

interface AnalysisRow {
  id: number;
  input_revision: number;
  relevance: string | null;
  category: string | null;
  tags: string[];
  subjects: string[];
  title_zh: string | null;
  summary_zh: string | null;
  reason_zh: string | null;
  score: number | null;
  selected: boolean | null;
}

interface OverrideRow {
  fields: Record<string, unknown>;
  visibility: string | null;
}

interface PublicationRow {
  article_id: string;
  analysis_id: number | null;
  source_id: string;
  first_party: boolean;
  revision: number;
  visibility: string;
  eligible: boolean;
  selected: boolean;
  selection_candidate: boolean;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  classification: Record<string, unknown> | null;
  score_evidence: Record<string, unknown> | null;
  tags: string[];
  score: number | null;
  body_mode: string;
  syndicate: boolean;
  url: string;
  channel: string;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  sort_at: Date;
  backfill: boolean;
  story_id: number | null;
  fact_id: number | null;
  selected_ready_at: Date | null;
  visible_after: Date | null;
  indexable: boolean;
  seo_indexed_at: Date | null;
  seo_excluded_at: Date | null;
}

export interface V1ItemPayload {
  id: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  source: { name: string };
  links: { aihot: string; original: string };
  publishedAt: string | null;
  discoveredAt: string;
  category: string | null;
  score: number | null;
  selected: boolean;
  reason: string | null;
  attribution: { name: string; url: string };
}

export interface PublishOptions {
  /** This run may update relevance without nominating new selected items. */
  allowNewSelection?: boolean;
  /** Reuse complete existing copy; otherwise show the original excerpt after a current PASS. */
  relevanceOnly?: boolean;
  now?: Date;
  /** Historical import: the item was already public, so it is released at its discovery time. */
  releasedAt?: Date | null;
}

export interface PublishResult {
  articleId: string;
  changed: boolean;
  /** First prepared content or selection only adds to its detail; corrections also change what lists show. */
  changeKind: "detail" | "content";
  selected: boolean;
  visibility: string;
  ledger: "upsert" | "remove" | null;
  /** Something that was public is now shown less (withdrawn, out of the pool or selection, full text revoked). */
  reduced: boolean;
}

function pickString(override: unknown, fallback: string | null): string | null {
  return typeof override === "string" && override.trim() !== "" ? override.trim() : fallback;
}

function round1(n: number | null): number | null {
  return n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10;
}

export function v1Payload(p: {
  articleId: string; title: string; originalTitle: string | null; summary: string | null; sourceName: string; url: string;
  publishedAt: Date | null; discoveredAt: Date; category: string | null; score: number | null; selected: boolean; reason: string | null;
}): V1ItemPayload {
  const aihot = itemUrl(p.articleId);
  return {
    id: p.articleId,
    title: p.title,
    originalTitle: p.originalTitle,
    summary: p.summary,
    source: { name: p.sourceName },
    links: { aihot, original: p.url },
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    discoveredAt: p.discoveredAt.toISOString(),
    category: toPublicApiCategory(p.category),
    score: p.score === null ? null : Math.round(p.score),
    selected: p.selected,
    reason: p.selected ? p.reason : null,
    attribution: { name: SITE.name, url: aihot },
  };
}

/** Allocates the next ledger sequence under a transaction lock so sequence order equals commit order. */
async function appendLedger(tx: Tx, articleId: string, op: "upsert" | "remove", payload: V1ItemPayload | null, now: Date): Promise<number> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('selected_ledger'))`;
  const { next } = one(await tx<{ next: number }[]>`SELECT coalesce(max(seq), 0) + 1 AS next FROM selected_ledger`);
  await tx`INSERT INTO selected_ledger (seq, article_id, op, changed_at, visible_at, payload)
           VALUES (${next}, ${articleId}, ${op}, ${now}, ${now}, ${payload ? tx.json(payload as never) : null})`;
  return next;
}

/**
 * Ordinary reports share one selected seat per fact: among the fact's selected public reports,
 * the representative (first-party, full text, higher score, earliest) takes it, and a
 * change of representative removes the old one and adds the new one.
 * The website folds the same reports into reading groups instead. An article outside any fact keeps
 * its own seat, as does each selected article from an independent source. Returns the ledger change
 * of `self` when this settling made one. Fact membership is unaffected.
 */
async function settleSeats(tx: Tx, factId: number | null, self: string | null, now: Date): Promise<"upsert" | "remove" | null> {
  if (factId === null) {
    if (self) await tx`UPDATE publications SET seat = true WHERE article_id = ${self} AND NOT seat`;
    return null;
  }
  const members = await tx<Array<Pick<PublicationRow, "article_id" | "score" | "source_id"> & RepresentativeIdentity & { body_mode: "full" | "summary"; timeline_at: Date; seat: boolean; holds: boolean }>>`
    SELECT p.article_id, p.source_id, p.body_mode, p.score, p.timeline_at, p.seat, ${REPRESENTATIVE_COLUMNS},
      (p.selected AND p.visibility = 'public' AND ${ownFactEvidenceCondition()}) AS holds
    FROM publications p JOIN sources s ON s.id = p.source_id JOIN facts f ON f.id = p.fact_id WHERE p.fact_id = ${factId}`;
  const candidates = members.filter((m) => m.holds && !isIndependentSelectedSource(m.source_id)).map((m) => ({ ...m, score: m.score === null ? null : Number(m.score) }));
  const rep = candidates.length ? pickRepresentative(candidates) : null;
  let own: "upsert" | "remove" | null = null;
  for (const m of members) {
    const seat = !m.holds || isIndependentSelectedSource(m.source_id) || m.article_id === rep?.article_id;
    if (seat === m.seat) continue;
    await tx`UPDATE publications SET seat = ${seat} WHERE article_id = ${m.article_id}`;
    const change = await syncLedger(tx, m.article_id, now);
    if (m.article_id === self) own = change;
  }
  return own;
}

/** Brings one article's place in the selected sync ledger in line with its publication. */
async function syncLedger(tx: Tx, articleId: string, now: Date): Promise<"upsert" | "remove" | null> {
  const [p] = await tx<Array<{ selected: boolean; visibility: string; seat: boolean; title: string; original_title: string | null; summary: string | null;
    url: string; published_at: Date | null; discovered_at: Date; category: string | null; score: string | number | null; reason: string | null;
    source_name: string }>>`
    SELECT p.selected, p.visibility, p.seat, p.title, p.original_title, p.summary, p.url, p.published_at, p.discovered_at, p.category,
           p.score, p.reason, s.name AS source_name
    FROM publications p JOIN sources s ON s.id = p.source_id WHERE p.article_id = ${articleId}`;
  if (!p) return null;
  const [state] = await tx<{ in_set: boolean; payload_hash: string | null }[]>`SELECT in_set, payload_hash FROM selected_state WHERE article_id = ${articleId}`;
  if (p.selected && p.visibility === "public" && p.seat) {
    const payload = v1Payload({
      articleId, title: p.title, originalTitle: p.original_title, summary: p.summary, sourceName: p.source_name, url: p.url,
      publishedAt: p.published_at, discoveredAt: p.discovered_at, category: p.category, score: p.score === null ? null : Number(p.score), selected: true, reason: p.reason,
    });
    const payloadHash = sha256(stableJson(payload));
    if (state?.in_set && state.payload_hash === payloadHash) return null;
    const seq = await appendLedger(tx, articleId, "upsert", payload, now);
    await tx`INSERT INTO selected_state (article_id, in_set, payload_hash, last_seq) VALUES (${articleId}, true, ${payloadHash}, ${seq})
             ON CONFLICT (article_id) DO UPDATE SET in_set = true, payload_hash = EXCLUDED.payload_hash, last_seq = EXCLUDED.last_seq`;
    return "upsert";
  }
  if (!state?.in_set) return null;
  const seq = await appendLedger(tx, articleId, "remove", null, now);
  await tx`UPDATE selected_state SET in_set = false, payload_hash = NULL, last_seq = ${seq} WHERE article_id = ${articleId}`;
  return "remove";
}

export async function publishArticle(articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  return sql.begin(async (tx) => {
    await tx`SELECT 1 FROM articles WHERE id = ${articleId} FOR UPDATE`;
    const [previous] = await tx<{ story_id: number | null }[]>`SELECT story_id FROM publications WHERE article_id = ${articleId}`;
    const result = await publishArticleTx(tx, articleId, options);
    // Body and translation writes announce their own changes; an unchanged projection needs no purge.
    if (previous && result?.changed) await emit("articleChanged", {
      id: articleId, reason: "republication", kind: result.changeKind, reduced: result.reduced, previousStoryIds: previous.story_id === null ? [] : [previous.story_id],
    }, tx);
    return result;
  });
}

export async function publishArticleTx(tx: Tx, articleId: string, options: PublishOptions = {}): Promise<PublishResult | null> {
  const [article] = await tx<ArticleRow[]>`
    SELECT id, source_id, url, title, revision, excerpt, language, published_at, discovered_at, timeline_at, backfill, body_status,
           body_text, x_post, x_article, grouped_at, grouping_status, selection_adds_value
    FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!article) return null;
  // Explicit imports carry an already-public editorial decision, not a new pending judgement.
  if (options.releasedAt && article.grouping_status === "pending") {
    await tx`UPDATE articles SET grouping_status = 'complete', grouped_at = coalesce(grouped_at, ${options.releasedAt}) WHERE id = ${articleId}`;
    article.grouping_status = "complete";
  }
  const [source] = await tx<SourceFacts[]>`
    SELECT id, name, kind, tier, participation_mode, first_party, site_fulltext, syndicate_fulltext FROM sources WHERE id = ${article.source_id}`;
  if (!source) return null;
  const analyses = await tx<AnalysisRow[]>`
    SELECT id, input_revision, relevance, category, tags, subjects, title_zh, summary_zh, reason_zh, score, selected
    FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC, id DESC LIMIT 1`;
  let analysis: AnalysisRow | undefined = analyses[0];
  const materialPublication = serverModules().some(module => module.materialPublication);
  const screening = materialPublication ? null : await storedScreening(tx, articleId);
  // A changed screened article cannot retain an older completed judgement.
  if ((screening || materialPublication) && analysis?.input_revision !== article.revision) analysis = undefined;
  // Earlier relevance judgements and unfinished writing never hold collected source cards back.
  if (materialPublication && analysis && (analysis.relevance !== "pass" || !analysis.title_zh?.trim() || !analysis.summary_zh?.trim())) analysis = undefined;
  if (options.relevanceOnly && screening?.revision === article.revision && screening.label === "PASS" && !screening.reviewRequired
    && analysis && (analysis.relevance !== "pass" || !analysis.title_zh?.trim() || !analysis.summary_zh?.trim())) analysis = undefined;
  const [override] = await tx<OverrideRow[]>`SELECT fields, visibility FROM editorial_overrides WHERE article_id = ${articleId}`;
  const [membership] = await tx<{ fact_id: number; story_id: number | null }[]>`
    SELECT fa.fact_id, f.story_id FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id
    LEFT JOIN stories s ON s.id = f.story_id
    WHERE fa.article_id = ${articleId} AND NOT ${latestCompositeCondition(sql`${articleId}`)} AND fa.role IN ('primary', 'report') AND (s.id IS NULL OR s.merged_into IS NULL)
    ORDER BY (fa.role = 'primary') DESC, fa.created_at LIMIT 1`;
  const [previous] = await tx<PublicationRow[]>`SELECT * FROM publications WHERE article_id = ${articleId}`;
  // The seats of this article's facts (before and after) are settled in this transaction: take the
  // facts' locks first, in a fixed order, so two reports of one fact never settle it at once.
  const seatFacts = [...new Set([previous?.fact_id, membership?.fact_id].filter((x): x is number => typeof x === "number"))].sort((a, b) => a - b);
  for (const fact of seatFacts) await tx`SELECT pg_advisory_xact_lock(hashtext(${`seat:${fact}`}))`;
  // Reports wait for in-flight publication transactions before taking their candidate snapshot.
  // Stamp releases after all lock waits, which can cross an edition's cutoff.
  await tx`SELECT pg_advisory_xact_lock_shared(hashtext('report_candidates'))`;
  const now = options.now ?? new Date();
  const heldForReview = screening?.revision === article.revision && screening.reviewRequired;
  const prefiltered = !analysis && (materialPublication || screening?.revision === article.revision && screening.label === "PASS"
    && !heldForReview && !!article.published_at && article.published_at >= screening.from && article.published_at <= now);
  const [preview] = await tx`SELECT title_zh,excerpt_zh FROM preview_translations WHERE article_id=${articleId} AND revision=${article.revision} AND original_title=${article.title} AND original_excerpt IS NOT DISTINCT FROM ${sourcePreview(article.excerpt,article.body_text)}`;
  const sourceExcerpt = prefiltered ? collapseWhitespace(article.excerpt || article.body_text || "") : "";
  const excerpt = sourceExcerpt ? sourceExcerpt.slice(0, 240) + (sourceExcerpt.length > 240 ? "…" : "") : null;

  const f = override?.fields ?? {};
  const isChineseTitle = isChineseText(article.title, article.language);
  // An X post carries its Chinese in the summary and translation; without a Chinese title its own
  // text is the title, where an article would still be a half-finished card.
  const zhTitle = analysis?.title_zh?.trim() ? analysis.title_zh : null;
  const original = originalPostCopy(article.x_post, article.url, article.x_article);
  const title = pickString(f.title, original?.title ?? zhTitle ?? preview?.title_zh ?? (isChineseTitle || article.x_post || prefiltered ? collapseWhitespace(article.title) : null));
  const summary = pickString(f.summary, prefiltered ? preview?.excerpt_zh ?? excerpt : original ? original.summary : analysis?.summary_zh ?? null);
  const classification = classifyArticle({ title: title ?? collapseWhitespace(article.title), originalTitle: article.title, summary });
  const category = pickString(f.category, classification?.category ?? analysis?.category ?? null);
  const tags = Array.isArray(f.tags) ? (f.tags as string[]) : [...new Set([...(analysis?.tags ?? []), ...(analysis?.subjects ?? []).map((s) => `entity:${s}`)])];
  const readingScore = await storedPublicationScore({ articleId, title: title ?? collapseWhitespace(article.title), summary, category }, tx);
  const score = f.score === null || typeof f.score === "number" ? f.score : readingScore?.score ?? analysis?.score ?? null;
  const screenedRelevance = options.relevanceOnly && screening?.revision === article.revision
    ? screening.label === "PASS" ? "pass" : screening.label === "BLOCK" ? "block" : "unknown" : null;
  const relevance = materialPublication ? "pass" : typeof f.relevance === "string" ? (f.relevance as string) : screenedRelevance ?? analysis?.relevance ?? (prefiltered ? "pass" : null);
  const judgedSelected = prefiltered ? false : typeof f.selected === "boolean" ? (f.selected as boolean) : analysis?.selected ?? null;
  // Material from an isolated source reaches no public surface at all: not even a detail page.
  const visibility = source.participation_mode === "isolated" ? "withdrawn" : (override?.visibility ?? "public");

  // An undated archive has a readable detail page, but its discovery is not a news timestamp.
  // Explicit imports can retain an editorial decision already published elsewhere.
  const eligible = (materialPublication ? source.participation_mode === "editorial" && !!title
    : isPoolEligible({ participationMode: source.participation_mode, relevance, title, summary, originalPost: !!original }))
    && !heldForReview && (materialPublication || !article.backfill || article.published_at !== null || !!options.releasedAt);
  const selectionCandidate = isSelectable(eligible, judgedSelected, source.tier);
  // Scoring nominates a report; a completed identity/value decision admits it to selection.
  // A historical import already has its public decision. Preserve that confirmed state on rebuild.
  const selected = selectionCandidate && (options.allowNewSelection !== false || previous?.selected === true) && article.grouping_status === "complete"
    && (f.selected === true || article.selection_adds_value !== false);
  const reason = selected ? pickString(f.reason, original ? null : analysis?.reason_zh ?? null) : null;
  const hasXPost = !!article.x_post;
  const channel = channelOf(source.kind, hasXPost);
  const hasBody = !!article.body_text || !!article.x_post?.text || !!article.x_post?.media?.length || !!article.x_post?.quoted?.text;
  const bodyMode = bodyModeOf(source, article.body_status, hasBody);
  const syndicate = mayRedistribute(source, bodyMode);
  const originalTitle = title === collapseWhitespace(article.title) && (isChineseTitle || prefiltered) ? null : collapseWhitespace(article.title);

  // Waiting candidates are readable in the pool, with no selected seat, sync entry or push.
  // Completion stamps the actual release after lock waits, including across report cutoffs.
  const selectedReadyAt = previous?.selected_ready_at ?? (selectionCandidate ? options.releasedAt ?? now : null);
  const visibleAfter = selected ? (previous?.selected && previous.visible_after ? previous.visible_after : options.releasedAt ?? now) : null;

  const indexable = !prefiltered && isIndexable({
    visibility, sourceMode: source.participation_mode, hasSummary: !!summary, selected, seoIndexedAt: previous?.seo_indexed_at ?? null, seoExcludedAt: previous?.seo_excluded_at ?? null,
  });
  const searchText = collapseWhitespace(
    [title, originalTitle, summary, publicSourceName(source.name), ...displayTags(tags), ...(analysis?.subjects ?? [])].filter(Boolean).join(" "),
  ).toLowerCase();

  // Ordinary selected reports share their reading group's first arrival; independent articles keep
  // their own arrival and never date the ordinary group.
  let sortAt: Date = article.timeline_at;
  if (selected && membership?.fact_id && !isIndependentSelectedSource(source.id)) {
    const [anchor] = await tx<{ t: Date | null }[]>`
      SELECT min(p.timeline_at) AS t FROM publications p
      WHERE p.fact_id = ${membership.fact_id} AND p.eligible AND p.visibility = 'public' AND p.article_id <> ${articleId}
        AND ${foldableSelectionCondition()}`;
    if (anchor?.t && anchor.t < sortAt) sortAt = anchor.t;
  }

  const next = {
    analysis_id: analysis?.id ?? null,
    source_id: source.id, first_party: source.tier === "T1",
    visibility, eligible, selected, selection_candidate: selectionCandidate, title: title ?? collapseWhitespace(article.title), original_title: originalTitle, summary, reason,
    category, classification: classification?.evidence ?? null, tags, score: round1(score), score_evidence: readingScore?.evidence ?? null, body_mode: bodyMode, story_id: membership?.story_id ?? null, fact_id: membership?.fact_id ?? null,
    indexable, url: article.url, channel, syndicate, published_at: article.published_at, discovered_at: article.discovered_at,
    timeline_at: article.timeline_at, backfill: article.backfill, sort_at: sortAt, visible_after: visibleAfter,
  };
  const before = previous ? { ...previous, tags: [...previous.tags].sort(), score: previous.score === null ? null : Number(previous.score) } : null;
  const after = { ...next, tags: [...next.tags].sort() };
  const changedFields = (Object.keys(after) as Array<keyof typeof after>).filter((key) => !before || stableJson(after[key]) !== stableJson(before[key]));
  const changed = changedFields.length > 0;
  const admissionFields = new Set<keyof typeof after>(["selected", "reason", "indexable", "story_id", "fact_id", "sort_at", "visible_after"]);
  const admission = previous && !previous.selected && selected
    && (previous.story_id === null || previous.story_id === next.story_id)
    && (previous.fact_id === null || previous.fact_id === next.fact_id)
    && changedFields.every((key) => admissionFields.has(key));
  const firstAnalysisFields = new Set<keyof typeof after>([...admissionFields, "analysis_id", "eligible", "selection_candidate", "title", "original_title", "summary", "category", "classification", "tags", "score", "score_evidence"]);
  const firstAnalysis = previous && !previous.eligible && !previous.summary && previous.visibility === "public" && visibility === "public" && eligible
    && (previous.story_id === null || previous.story_id === next.story_id)
    && (previous.fact_id === null || previous.fact_id === next.fact_id)
    && changedFields.every((key) => firstAnalysisFields.has(key));
  // A first event link is new metadata, like the first judgement or selection: a detail change.
  // Established identities and corrected text change what lists show.
  const firstIdentity = previous && !previous.selected && previous.fact_id === null && previous.story_id === null
    && previous.visibility === "public" && visibility === "public" && eligible && next.story_id !== null
    && changedFields.every((key) => admissionFields.has(key));
  const initial = (admission || firstAnalysis || firstIdentity) && !(await tx`SELECT 1 FROM selected_state WHERE article_id = ${articleId}`).length;
  const changeKind = initial ? "detail" : "content";
  const revision = previous ? previous.revision + (changed ? 1 : 0) : 1;

  await tx`
    INSERT INTO publications (article_id, analysis_id, revision, visibility, eligible, selected, selection_candidate, title, original_title, summary,
      reason, category, classification, tags, score, score_evidence, source_id, channel, first_party, url, published_at, discovered_at, timeline_at, backfill,
      selected_ready_at, visible_after, body_mode, syndicate, indexable, story_id, fact_id, search_text, sort_at, updated_at)
    VALUES (${articleId}, ${analysis?.id ?? null}, ${revision}, ${visibility}, ${eligible}, ${selected}, ${selectionCandidate}, ${next.title},
      ${originalTitle}, ${summary}, ${reason}, ${category}, ${next.classification ? tx.json(next.classification as never) : null}, ${tags}, ${next.score}, ${next.score_evidence ? tx.json(next.score_evidence as never) : null}, ${source.id}, ${channel}, ${source.tier === "T1"},
      ${article.url}, ${article.published_at}, ${article.discovered_at}, ${article.timeline_at}, ${article.backfill},
      ${selectedReadyAt}, ${visibleAfter}, ${bodyMode}, ${syndicate}, ${indexable}, ${next.story_id}, ${next.fact_id}, ${searchText}, ${sortAt}, now())
    ON CONFLICT (article_id) DO UPDATE SET
      analysis_id = EXCLUDED.analysis_id, revision = EXCLUDED.revision, visibility = EXCLUDED.visibility,
      eligible = EXCLUDED.eligible, selected = EXCLUDED.selected, selection_candidate = EXCLUDED.selection_candidate, title = EXCLUDED.title, original_title = EXCLUDED.original_title,
      summary = EXCLUDED.summary, reason = EXCLUDED.reason, category = EXCLUDED.category, classification = EXCLUDED.classification, tags = EXCLUDED.tags,
      score = EXCLUDED.score, score_evidence = EXCLUDED.score_evidence, source_id = EXCLUDED.source_id, channel = EXCLUDED.channel, first_party = EXCLUDED.first_party,
      url = EXCLUDED.url, published_at = EXCLUDED.published_at, discovered_at = EXCLUDED.discovered_at,
      timeline_at = EXCLUDED.timeline_at, backfill = EXCLUDED.backfill, selected_ready_at = EXCLUDED.selected_ready_at,
      visible_after = EXCLUDED.visible_after, body_mode = EXCLUDED.body_mode, syndicate = EXCLUDED.syndicate,
      indexable = EXCLUDED.indexable, story_id = EXCLUDED.story_id, fact_id = EXCLUDED.fact_id,
      search_text = EXCLUDED.search_text, sort_at = EXCLUDED.sort_at, updated_at = now()
    WHERE (publications.analysis_id, publications.revision, publications.visibility, publications.eligible,
        publications.selected, publications.selection_candidate, publications.title, publications.original_title, publications.summary,
        publications.reason, publications.category, publications.classification, publications.tags, publications.score, publications.score_evidence,
        publications.source_id, publications.channel, publications.first_party, publications.url,
        publications.published_at, publications.discovered_at, publications.timeline_at, publications.backfill,
        publications.selected_ready_at, publications.visible_after, publications.body_mode, publications.syndicate,
        publications.indexable, publications.story_id, publications.fact_id, publications.search_text,
        publications.sort_at)
      IS DISTINCT FROM (EXCLUDED.analysis_id, EXCLUDED.revision, EXCLUDED.visibility, EXCLUDED.eligible,
        EXCLUDED.selected, EXCLUDED.selection_candidate, EXCLUDED.title, EXCLUDED.original_title, EXCLUDED.summary,
        EXCLUDED.reason, EXCLUDED.category, EXCLUDED.classification, EXCLUDED.tags, EXCLUDED.score, EXCLUDED.score_evidence,
        EXCLUDED.source_id, EXCLUDED.channel, EXCLUDED.first_party, EXCLUDED.url,
        EXCLUDED.published_at, EXCLUDED.discovered_at, EXCLUDED.timeline_at, EXCLUDED.backfill,
        EXCLUDED.selected_ready_at, EXCLUDED.visible_after, EXCLUDED.body_mode, EXCLUDED.syndicate,
        EXCLUDED.indexable, EXCLUDED.story_id, EXCLUDED.fact_id, EXCLUDED.search_text,
        EXCLUDED.sort_at)`;

  // The pool search row follows eligibility; its body part only covers full text the site may show.
  if (eligible) {
    const body = bodyMode === "full" ? (article.body_text ?? "").slice(0, 12000).toLowerCase() : "";
    await tx`INSERT INTO pool_search (article_id, direct, body) VALUES (${articleId}, ${searchText}, ${body})
             ON CONFLICT (article_id) DO UPDATE SET direct = EXCLUDED.direct, body = EXCLUDED.body
             WHERE pool_search.direct IS DISTINCT FROM EXCLUDED.direct OR pool_search.body IS DISTINCT FROM EXCLUDED.body`;
  } else {
    await tx`DELETE FROM pool_search WHERE article_id = ${articleId}`;
  }

  // Content-group push: once, for an item that arrives live and becomes selected (never for imports,
  // backfill or stale-on-discovery material).
  if (selected && !previous?.selected && !options.releasedAt && !article.backfill && visibility === "public") {
    await enqueue(QUEUES.notifySelected, { articleId }, { singletonKey: `selected:${articleId}`, startAfter: new Date(now.getTime() + 5_000) }, tx);
    // Prepare its images alongside the newly confirmed selection.
    await enqueue(QUEUES.prepareMedia, { articleId }, { singletonKey: `media:${articleId}` }, tx);
  }

  // Seats of the fact this article reports (and of the one it left), then its place in the sync ledger.
  let ledger = await settleSeats(tx, membership?.fact_id ?? null, articleId, now);
  if (previous?.fact_id && previous.fact_id !== membership?.fact_id) await settleSeats(tx, previous.fact_id, null, now);
  ledger = (await syncLedger(tx, articleId, now)) ?? ledger;

  const wasPublic = !!previous && previous.visibility !== "withdrawn" && previous.eligible;
  const reduced =
    wasPublic &&
    (visibility === "withdrawn" || !eligible ||
      (previous!.visibility === "public" && visibility !== "public") ||
      (previous!.selected && !selected) ||
      (previous!.body_mode === "full" && bodyMode !== "full"));
  return { articleId, changed, changeKind, selected, visibility, ledger, reduced };
}

/**
 * An editor's search-index decision: marking indexes the page; unmarking excludes it, so a
 * selected page is not indexed again automatically. The decision and projection commit with the audit.
 */
export async function setSeoDecision(tx: Tx, articleId: string, indexed: boolean): Promise<PublishResult | null> {
  await tx`UPDATE publications SET seo_indexed_at = CASE WHEN ${indexed} THEN coalesce(seo_indexed_at, now()) ELSE NULL END,
              seo_excluded_at = CASE WHEN ${indexed} THEN NULL ELSE now() END WHERE article_id = ${articleId}`;
  return publishArticleTx(tx, articleId);
}

/** Refresh only classification on stored public copy; admission, scores, facts and release dates stay frozen. */
export async function refreshPublicationClassification(tx: Tx, articleId: string): Promise<{ changed: boolean; categoryChanged: boolean }> {
  await tx`SELECT 1 FROM articles WHERE id=${articleId} FOR UPDATE`;
  const [p] = await tx<PublicationRow[]>`SELECT * FROM publications WHERE article_id=${articleId} FOR UPDATE`;
  if (!p) return { changed: false, categoryChanged: false };
  const decision = classifyArticle({ title: p.title, originalTitle: p.original_title, summary: p.summary });
  if (!decision) return { changed: false, categoryChanged: false };
  const [override] = await tx<OverrideRow[]>`SELECT fields,visibility FROM editorial_overrides WHERE article_id=${articleId}`;
  const category = pickString(override?.fields.category, decision.category);
  const categoryChanged = p.category !== category;
  const changed = categoryChanged || stableJson(p.classification) !== stableJson(decision.evidence);
  if (changed) {
    await tx`UPDATE publications SET category=${category},classification=${tx.json(decision.evidence as never)},
      revision=revision+1,updated_at=now() WHERE article_id=${articleId}`;
    if (categoryChanged) await syncLedger(tx, articleId, new Date());
    await emit("articleChanged", { id: articleId, kind: "content", reason: "keyword classification refreshed" }, tx);
  }
  return { changed, categoryChanged };
}

/** Applies a stored score without rerunning classification, structure, admission or event grouping. */
export async function refreshPublicationScore(tx: Tx, articleId: string): Promise<boolean> {
  await tx`SELECT 1 FROM articles WHERE id=${articleId} FOR UPDATE`;
  const [p] = await tx<PublicationRow[]>`SELECT * FROM publications WHERE article_id=${articleId} FOR UPDATE`;
  if (!p) return false;
  const result = await storedPublicationScore({ articleId, title: p.title, summary: p.summary, category: p.category }, tx);
  if (!result) return false;
  const [override] = await tx<OverrideRow[]>`SELECT fields,visibility FROM editorial_overrides WHERE article_id=${articleId}`;
  const manual = override?.fields.score;
  const score = manual === null || typeof manual === "number" ? manual : result.score;
  if (p.score === score && stableJson(p.score_evidence) === stableJson(result.evidence)) return false;
  await tx`UPDATE publications SET score=${score},score_evidence=${tx.json(result.evidence as never)},revision=revision+1,updated_at=now()
    WHERE article_id=${articleId}`;
  await syncLedger(tx, articleId, new Date());
  await emit("articleChanged", { id: articleId, kind: "content", reason: "reading score updated" }, tx);
  return true;
}

/**
 * Re-derives every published article of one source (after its participation, licences, tier or name
 * changed) without calling models. Runs in the worker; progress goes to the callback.
 */
export async function republishSource(sourceId: string, onProgress?: (done: number, total: number) => Promise<void>): Promise<{ total: number; changed: number; reduced: number }> {
  const { total } = one(await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM publications WHERE source_id = ${sourceId}`);
  let after = "";
  let done = 0;
  let changed = 0;
  let reduced = 0;
  for (;;) {
    const batch = await sql<{ article_id: string }[]>`
      SELECT article_id FROM publications WHERE source_id = ${sourceId} AND article_id > ${after} ORDER BY article_id LIMIT 500`;
    if (batch.length === 0) break;
    for (const { article_id } of batch) {
      // Stopping mid-way is safe: the job is retried after the restart and re-derives from the start.
      if (shutdownSignal.signal.aborted) throw new Error("worker is stopping; republish resumes after restart");
      // The source job refreshes all its exits once when the batch is complete.
      const r = await sql.begin(tx => publishArticleTx(tx, article_id));
      if (r?.changed) changed += 1;
      if (r?.reduced) reduced += 1;
    }
    done += batch.length;
    after = batch[batch.length - 1]!.article_id;
    await onProgress?.(done, total);
  }
  return { total, changed, reduced };
}

/** Rebuild stored screenings after enabling this publication policy. No analysis rows or paid jobs are created. */
export async function republishScreenedArticles(): Promise<{ total: number; changed: number }> {
  const ids = new Set<string>();
  for (const module of serverModules()) {
    if (!module.screenedPublication) continue;
    const rows = await sql<{ id: string }[]>`SELECT DISTINCT sf.value->>'articleId' AS id FROM settings sf
      LEFT JOIN publications p ON p.article_id=sf.value->>'articleId'
      WHERE starts_with(sf.key,${module.screenedPublication.screeningPrefix}) AND sf.value->>'status'='screened'
        AND (sf.value->>'label'='PASS' OR p.article_id IS NOT NULL)`;
    for (const row of rows) if (row.id) ids.add(row.id);
  }
  let changed = 0;
  for (const id of ids) if ((await publishArticle(id))?.changed) changed++;
  return { total: ids.size, changed };
}

/** Move existing collected material into the same projection as new arrivals. No paid work is queued. */
export async function republishCollectedArticles(): Promise<{ total: number; changed: number }> {
  if (!serverModules().some(module => module.materialPublication)) return { total: 0, changed: 0 };
  let after = "", total = 0, changed = 0;
  for (;;) {
    const rows = await sql<{ id: string }[]>`SELECT a.id FROM articles a JOIN sources s ON s.id=a.source_id
      WHERE s.participation_mode='editorial' AND a.id>${after} ORDER BY a.id LIMIT 500`;
    if (!rows.length) break;
    for (let start = 0; start < rows.length; start += 8) {
      if (shutdownSignal.signal.aborted) throw new Error("worker is stopping; republish resumes after restart");
      const results = await Promise.all(rows.slice(start, start + 8).map(row => publishArticle(row.id, { allowNewSelection: false })));
      changed += results.filter(result => result?.changed).length;
      total += results.length;
    }
    after = rows.at(-1)!.id;
  }
  return { total, changed };
}
