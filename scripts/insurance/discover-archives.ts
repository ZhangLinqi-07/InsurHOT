// Discover only endpoints declared by the source's saved HTML, then verify the native collector.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { guardedFetch, requireOk } from "@aihot/backend/lib/http-fetch";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";

const catalog = JSON.parse(readFileSync("industry/source-catalog.json", "utf8"));
const configured = JSON.parse(readFileSync("industry/sources.json", "utf8")).sources as SourceRow[];
const endpoints = new Map<string, { catalogIds: string[]; name: string; tier: string; declarationFile: string }>();
const feeds = new Map<string, { catalogIds: string[]; name: string; tier: string; declarationFile: string }>();
for (const entry of catalog.sources) {
  // The news API documentation's own blog is outside the requested insurance source's scope.
  if (/newsapi\.org|gdeltproject\.org/.test(entry.url ?? "")) continue;
  const file = entry.entryProbe?.responseFile;
  if (!file) continue;
  let html: string;
  try { html = readFileSync(file, "utf8"); } catch { continue; }
  const $ = cheerio.load(html);
  $("link[href]").each((_, el) => {
    const link = $(el);
    const api = link.attr("rel") === "https://api.w.org/";
    if (!api && !/rss|atom/.test(link.attr("type") ?? "")) return;
    const url = new URL(link.attr("href")!, entry.entryProbe.finalUrl ?? entry.url).href;
    if (!/^https?:/.test(url) || /comments|comment-/.test(url)) return;
    const map = api ? endpoints : feeds;
    const existing = map.get(url);
    if (existing) existing.catalogIds.push(entry.catalogId);
    else map.set(url, { catalogIds: [entry.catalogId], name: entry.name, tier: entry.tier, declarationFile: file });
  });
}
mkdirSync(".data/insurance-ingestion/discovery", { recursive: true });
const results: any[] = [];
const tasks = [...endpoints].map(([url, evidence]) => ({ url, evidence, kind: "wordpress" }))
  .concat([...feeds].filter(([url]) => !configured.some(s => s.config.feedUrl === url))
    .map(([url, evidence]) => ({ url, evidence, kind: "feed" })));
let index = 0;
const hosts = new Map<string, Promise<void>>();
async function inspect(task: typeof tasks[number]) {
  const host = new URL(task.url).hostname;
  const previous = hosts.get(host) ?? Promise.resolve();
  let release!: () => void;
  hosts.set(host, new Promise<void>(resolve => { release = resolve; }));
  await previous;
  const result: any = { ...task, at: new Date().toISOString(), status: "failed" };
  try {
    const slug = host.replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-");
    const base = { id: `archive-${task.kind === "wordpress" ? "wp" : "rss"}-${slug}`, name: task.evidence.name,
      tier: task.evidence.tier, participation_mode: "editorial", first_party: task.evidence.tier === "T1",
      interval_minutes: 180, enabled: true, cursor: null, fail_count: 0, site_fulltext: false, syndicate_fulltext: false };
    if (task.kind === "feed") {
      const source = { ...base, kind: "rss", config: { feedUrl: task.url, sortByPublishedAt: true, _aihot: { initialBackfillLimit: 100, initialBackfillMonths: 24 } } } as SourceRow;
      const list = (await fetchRss(source, { force: true })).candidates;
      result.listed = list.length;
      result.dated = list.filter(c => c.publishedAt).length;
      result.samples = list.slice(0, 3);
      if (!list.length || !result.dated || list.some(c => /^(hello world|sample post|test post|wordpress resources)/i.test(c.title))) throw new Error("No dated news, or template content");
      result.source = source;
      result.status = "verified_feed";
    } else {
      // WordPress exposes public post-type REST routes. A site may publish news as a custom type.
      const typesUrl = new URL("wp/v2/types", task.url.endsWith("/") ? task.url : task.url + "/").href;
      const typesResponse = requireOk(await guardedFetch(typesUrl, { timeoutMs: 18_000, maxBytes: 2_000_000 }));
      const types = JSON.parse(typesResponse.text());
      const routes = Object.entries(types).filter(([key, value]: [string, any]) => !["page", "attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part"].includes(key)
        && (key === "post" || /news|press|publication|insight|article|research/i.test(key + " " + value.name)))
        .slice(0, 5);
      result.routes = [];
      for (const [type, raw] of routes) {
        const value = raw as any;
        const namespace = value.rest_namespace ?? "wp/v2";
        if (!value.rest_base || namespace !== "wp/v2") continue;
        const url = new URL(`${namespace}/${value.rest_base}`, task.url).href;
        const api = new URL(url);
        api.search = new URLSearchParams({ per_page: "5", page: "1", order: "desc", orderby: "date" }).toString();
        const one = requireOk(await guardedFetch(api.href, { timeoutMs: 18_000, maxBytes: 5_000_000 }));
        const posts = JSON.parse(one.text());
        const route: any = { type, url: api.href, total: Number(one.headers.get("x-wp-total")), totalPages: Number(one.headers.get("x-wp-totalpages")) };
        if (!Array.isArray(posts) || !posts.length) { result.routes.push({ ...route, status: "empty" }); continue; }
        const responseFile = `.data/insurance-ingestion/discovery/${slug}-${type}.json`;
        writeFileSync(responseFile, one.body);
        route.responseFile = responseFile;
        route.sha256 = createHash("sha256").update(one.body).digest("hex");
        const source = { ...base, id: `${base.id}-${type}`, kind: "json_list", config: { url: api.href,
          mode: "json_api", titlePaths: ["title.rendered"], urlTemplate: "{raw:link}", summaryPaths: ["content.rendered"],
          summaryIsBody: true, publishedAtPath: "date_gmt", publishedAtUtcOffset: "+00:00", externalIdPath: "id",
          sortByPublishedAt: true, _aihot: { initialBackfillLimit: 100, initialBackfillMonths: 24 } } } as SourceRow;
        const list = await fetchJsonList(source);
        route.samples = list.slice(0, 3).map(c => ({ title: c.title, url: c.url, publishedAt: c.publishedAt, bodyChars: c.bodyText?.length ?? 0 }));
        route.listed = list.length;
        if (list.some(c => /^(hello world|sample post|test post|wordpress resources)/i.test(c.title)) || !list.some(c => c.publishedAt && c.publishedAt.getTime() >= Date.parse("2024-10-28T16:00:00Z"))) {
          result.routes.push({ ...route, status: "no_recent_news_or_template" }); continue;
        }
        api.searchParams.set("page", "2");
        const two = await guardedFetch(api.href, { timeoutMs: 18_000, maxBytes: 5_000_000 });
        const next = JSON.parse(two.text());
        route.paginationVerified = two.status === 200 && Array.isArray(next) && next.length > 0 && next.every(p => !posts.some(q => q.id === p.id))
          || posts.length < 5 && two.status === 400 && next.code === "rest_post_invalid_page_number";
        route.secondPageStatus = two.status;
        route.source = source;
        route.status = route.paginationVerified ? "verified" : "listing_only";
        result.routes.push(route);
      }
      result.status = result.routes.some((r: any) => r.status === "verified") ? "verified_wordpress" : "needs_review";
    }
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  finally { release(); }
  results.push(result);
  writeFileSync(".data/insurance-ingestion/discovery.json", JSON.stringify({ checkedAt: new Date().toISOString(), total: tasks.length, checked: results.length, externalModelCalls: 0, results }, null, 2));
  console.log(JSON.stringify({ url: task.url, status: result.status, routes: result.routes?.map((r: any) => ({ type: r.type, status: r.status, total: r.total })), error: result.error }));
}
await Promise.all(Array.from({ length: 5 }, async () => { while (index < tasks.length) await inspect(tasks[index++]); }));
