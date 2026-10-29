import { readFileSync, writeFileSync } from "node:fs";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { guardedFetch, requireOk } from "@aihot/backend/lib/http-fetch";
import type { SourceRow } from "@aihot/backend/sources/types";
import type { ArchivePlan } from "../../modules/insurance/backend/archive.ts";

const path = "industry/insurance-ingestion.json";
const policy = JSON.parse(readFileSync(path, "utf8"));
const manifest = JSON.parse(readFileSync("industry/sources.json", "utf8"));
const sources = manifest.sources as SourceRow[];
const discovery = JSON.parse(readFileSync(".data/insurance-ingestion/list-discovery.json", "utf8"));
const checks: any[] = [];
// These two regulator samples have concrete publication metadata and substantive public article text.
// Other automatic candidates included menu text, signup forms, static features or paid previews.
for (const entry of discovery.results.filter((r: any) => ["insurance-source-0365", "insurance-source-0369"].includes(r.catalogId) && r.status === "verified_specific_list")) {
  const source = entry.source;
  source.config.publishedAtUtcOffset = "+01:00";
  if (!sources.some(s => s.id === source.id)) sources.push(source);
  if (!policy.plans.some((p: ArchivePlan) => p.sourceId === source.id)) policy.plans.push({ sourceId: source.id, pagination: { kind: "single" }, evidence: ".data/insurance-ingestion/list-discovery.json",
    coverage: entry.coverage });
  if (!policy.supplementalAssociations.some((a: any) => a.sourceId === source.id)) policy.supplementalAssociations.push({ catalogIds: [entry.catalogId], sourceId: source.id, relation: "publisher-news-channel-only", scope: entry.coverage });
}
const runtime = (source: SourceRow) => ({ first_party: false, fail_count: 0, cursor: null, ...source });
const eastmoney = sources.find(s => s.id === "eastmoney-insurance")!;
try {
  const url = new URL(eastmoney.config.url);
  url.searchParams.delete("pageIndex");url.searchParams.delete("pageSize");
  url.searchParams.set("page_index", "1");url.searchParams.set("page_size", "50");
  const one = await fetchJsonList(runtime({ ...eastmoney, config: { ...eastmoney.config, url: url.href } }));
  const firstUrl = url.href;
  url.searchParams.set("page_index", "2");
  const two = await fetchJsonList(runtime({ ...eastmoney, config: { ...eastmoney.config, url: url.href } }));
  const distinct = two.some(c => !one.some(d => c.url === d.url));
  const ordered = [...one, ...two].every((c, i, list) => !!c.publishedAt && (!i || !!list[i - 1].publishedAt && c.publishedAt <= list[i - 1].publishedAt!));
  checks.push({ sourceId: eastmoney.id, kind: "eastmoney-pagination", first: one.length, second: two.length, distinct, ordered,
    samples: [...one.slice(0, 2), ...two.slice(0, 2)].map(c => ({ url: c.url, title: c.title, publishedAt: c.publishedAt })) });
  if (distinct) {
    const plan = policy.plans.find((p: ArchivePlan) => p.sourceId === eastmoney.id);
    plan.listing = { kind: eastmoney.kind, config: { ...eastmoney.config, url: firstUrl } };
    plan.pagination = { kind: "query", key: "page_index", first: 1 };
    plan.descending = ordered;
    plan.evidence = ".data/insurance-ingestion/extended-checks.json";
    plan.coverage = "Insurance news column 214 with verified snake-case page_index pagination.";
  }
} catch (error) { checks.push({ sourceId: eastmoney.id, error: String(error) }); }

for (const source of sources.filter(s => s.enabled && s.kind === "web_list" && !s.id.startsWith("catalog-list-"))) {
  const result: any = { sourceId: source.id };
  try {
    const response = requireOk(await guardedFetch(source.config.url, { timeoutMs: 12_000, maxBytes: 3_000_000 }));
    // Record links from the actual source; inferred URL shapes are never enabled on their own.
    const matches = [...response.text().matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)].filter(m => /^(?:下一页|next(?:\s+page)?|older(?:\s+posts)?)[\s›»>]*$/i.test(m[2].replace(/<[^>]*>/g, "").trim()) || /\brel=["']next["']/i.test(m[1]));
    result.nextLinks = matches.flatMap(m => {
      const href = /\bhref=["']([^"']+)["']/i.exec(m[1])?.[1];
      if (!href || /javascript:|^#/.test(href)) return [];
      const next = new URL(href.replace(/&amp;/g, "&"), response.url);
      return next.origin === new URL(response.url).origin ? [{ url: next.href, text: m[2].replace(/<[^>]*>/g, "").trim() }] : [];
    });
    for (const next of result.nextLinks.slice(0, 1)) {
      const current = new URL(source.config.url), target = new URL(next.url);
      const differing = [...target.searchParams.keys()].filter(k => target.searchParams.get(k) !== current.searchParams.get(k));
      if (current.pathname !== target.pathname || differing.length !== 1) continue;
      const key = differing[0];
      const value = Number(target.searchParams.get(key));
      if (!Number.isInteger(value) || value < 1) continue;
      const first = await fetchWebList(runtime(source));
      const second = await fetchWebList(runtime({ ...source, config: { ...source.config, url: next.url } }));
      const distinct = second.some(c => !first.some(d => d.url === c.url));
      result.distinct = distinct;result.first = first.length;result.second = second.length;
      if (!distinct) continue;
      const plan = policy.plans.find((p: ArchivePlan) => p.sourceId === source.id);
      if (plan.pagination.kind !== "single") continue;
      plan.pagination = { kind: "query", key, first: value - 1 };
      plan.evidence = ".data/insurance-ingestion/extended-checks.json";
      plan.coverage = "Editorial list with a source-declared next-page link and distinct native collector results.";
    }
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  checks.push(result);
  writeFileSync(".data/insurance-ingestion/extended-checks.json", JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2));
}
writeFileSync("industry/sources.json", JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(path, JSON.stringify(policy, null, 2) + "\n");
console.log(JSON.stringify({ configured: sources.length, enabled: sources.filter(s => s.enabled).length,
  paginated: policy.plans.filter((p: ArchivePlan) => p.pagination.kind !== "single").length, checks }));
