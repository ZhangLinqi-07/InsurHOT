// Materialise reviewed free adapters and verify pagination before giving an archive a continuation.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { fetchRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";
import type { ArchivePlan, Pagination } from "../../modules/insurance/backend/archive.ts";
import { archiveSource } from "../../modules/insurance/backend/archive.ts";

const file = "industry/sources.json";
const document = JSON.parse(readFileSync(file, "utf8"));
const sources = document.sources as SourceRow[];
const discovery = JSON.parse(readFileSync(".data/insurance-ingestion/discovery.json", "utf8"));
const reviewed = existsSync("industry/insurance-ingestion.json") ? JSON.parse(readFileSync("industry/insurance-ingestion.json", "utf8")) : null;
const from = "2024-10-28T16:00:00.000Z";
const host = (s: SourceRow) => new URL(s.config.feedUrl ?? s.config.url).hostname.replace(/^www\./, "");
const supplemental: ArchivePlan[] = [];
const added: string[] = [];
const associations: any[] = [];
for (const result of discovery.results) {
  for (const route of result.routes ?? []) {
    // This site's regular WordPress posts have been verified as procurement, outside the requested news.
    if (route.status !== "verified" || /ssf\.gob\.sv/.test(route.url)) continue;
    const candidate = route.source as SourceRow;
    const existing = sources.find(s => s.enabled && ["rss", "web_list", "json_list"].includes(s.kind) && host(s) === host(candidate));
    const primary = existing ?? candidate;
    if (!existing && !sources.some(s => s.id === primary.id)) {
      const { cursor, first_party, fail_count, ...config } = primary;
      sources.push({ ...config, signal_group_id: `insurance-publisher:${host(primary)}` } as SourceRow);
      added.push(primary.id);
    }
    const plan: ArchivePlan = { sourceId: primary.id, listing: { kind: "json_list", config: { ...candidate.config, url: candidate.config.url.replace("per_page=5", "per_page=50") } },
      pagination: { kind: "wordpress", first: 1 }, descending: true,
      evidence: ".data/insurance-ingestion/discovery.json", coverage: `${route.type} public REST archive. The site's other post types, directories and attachments are separate coverage.` };
    const prior = reviewed?.plans.find((p: ArchivePlan) => p.sourceId === primary.id);
    if (prior?.bodyAccess === "metadata-only") {
      plan.bodyAccess = "metadata-only";plan.coverage = prior.coverage;
      plan.listing!.config.summaryIsBody = false;plan.listing!.config.summaryPaths = [];
    }
    if (!supplemental.some(p => p.sourceId === primary.id)) supplemental.push(plan);
    associations.push({ catalogIds: result.evidence.catalogIds, sourceId: primary.id, scope: plan.coverage,
      relation: "publisher-news-channel-only", evidence: route.responseFile });
  }
  if (result.status === "verified_feed" && result.samples?.some((c: any) => c.publishedAt && Date.parse(c.publishedAt) >= Date.parse(from))) {
    const candidate = result.source as SourceRow;
    const existing = sources.find(s => s.enabled && ["rss", "web_list", "json_list"].includes(s.kind) && host(s) === host(candidate));
    if (!existing && !sources.some(s => s.id === candidate.id)) {
      const { cursor, first_party, fail_count, ...config } = candidate;
      sources.push({ ...config, signal_group_id: `insurance-publisher:${host(candidate)}` } as SourceRow);
      added.push(candidate.id);
      associations.push({ catalogIds: result.evidence.catalogIds, sourceId: candidate.id, scope: "Declared feed only; historical coverage not yet established", relation: "publisher-news-channel-only" });
    }
  }
}
const plans: ArchivePlan[] = [];
const checks: any[] = [];
for (const source of sources.filter(s => s.enabled)) {
  if (!["rss", "web_list", "json_list"].includes(source.kind)) continue;
  const wp = supplemental.find(p => p.sourceId === source.id);
  if (wp) { plans.push(wp); continue; }
  const url = new URL(source.config.feedUrl ?? source.config.url);
  let pagination: Pagination = { kind: "single" };
  if (source.id.startsWith("nfra-") || source.id === "eastmoney-insurance") pagination = { kind: "query", key: "pageIndex", first: 1 };
  else if (source.id.startsWith("cbimc-")) pagination = { kind: "json-query", key: "data", pageKey: "page", first: 1 };
  else if (source.id.startsWith("iachina-")) pagination = { kind: "query", key: "startrecord", first: 1, step: 7, companions: { endrecord: 7 } };
  else if (source.id === "osfi-news" || source.id === "eiopa-news") pagination = { kind: "query", key: "page", first: 0 };
  else if (source.id === "picc-news") pagination = { kind: "path", template: url.href + "index_{page}.html", first: 0 };
  const plan: ArchivePlan = { sourceId: source.id, pagination, evidence: ".data/insurance-ingestion/pagination-checks.json",
    coverage: pagination.kind === "single" ? "Current listing only. A two-year archive has not been established." : "This configured editorial channel's verified pagination only." };
  if (pagination.kind !== "single") {
    try {
      const runtime = { cursor: null, fail_count: 0, first_party: false, ...source };
      const fetchPage = async (page: number) => {
        const s = archiveSource(runtime, plan, page, new Date());
        return s.kind === "rss" ? (await fetchRss(s, { force: true })).candidates : s.kind === "json_list" ? fetchJsonList(s) : fetchWebList(s);
      };
      const one = await fetchPage(pagination.first);
      const two = await fetchPage(pagination.first + (pagination.kind === "query" ? pagination.step ?? 1 : 1));
      const newItems = two.filter(c => !one.some(d => d.url === c.url));
      const dated = [...one, ...two].filter(c => c.publishedAt);
      const distinct = newItems.length > 0;
      const sorted = [one, two].every(list => list.every((c, i) => !i || !c.publishedAt || !list[i - 1].publishedAt || c.publishedAt <= list[i - 1].publishedAt!));
      checks.push({ sourceId: source.id, pagination, distinct, sorted, first: one.length, second: two.length, newItems: newItems.length,
        samples: [...one.slice(0, 2), ...two.slice(0, 2)].map(c => ({ title: c.title, url: c.url, publishedAt: c.publishedAt })) });
      if (!distinct || !dated.length) plan.pagination = { kind: "single" };
      else plan.descending = sorted;
    } catch (error) { checks.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) }); plan.pagination = { kind: "single" }; }
  }
  plans.push(plan);
  console.log(JSON.stringify({ sourceId: source.id, pagination: plan.pagination.kind, descending: plan.descending }));
}
document.$comment = "Insurance source channels. The original 470 entries remain in source-catalog.json. Historical imports and limits are tracked separately in insurance-ingestion.json and database settings. Public full text stays disabled.";
writeFileSync(file, JSON.stringify(document, null, 2) + "\n");
writeFileSync("industry/insurance-ingestion.json", JSON.stringify({ schemaVersion: 1, from, timeZone: "Asia/Shanghai", collectionOnly: true, plans, supplementalAssociations: associations }, null, 2) + "\n");
writeFileSync(".data/insurance-ingestion/pagination-checks.json", JSON.stringify({ checkedAt: new Date().toISOString(), added, checks }, null, 2));
console.log(JSON.stringify({ configured: sources.length, enabled: sources.filter(s => s.enabled).length, added, paginated: plans.filter(p => p.pagination.kind !== "single").length }));
