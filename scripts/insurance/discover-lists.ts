// Verify concrete article pages before adapting an otherwise unconfigured public HTML entry.
import { readFileSync, writeFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { fetchWebList, fetchDetail } from "@aihot/backend/sources/web-list";
import { readPublicationDate } from "@aihot/backend/sources/dates";
import type { SourceRow } from "@aihot/backend/sources/types";

const catalog = JSON.parse(readFileSync("industry/source-catalog.json", "utf8"));
const configured = JSON.parse(readFileSync("industry/sources.json", "utf8")).sources as SourceRow[];
const audit = JSON.parse(readFileSync(".data/source-audit/entry-results.json", "utf8")).results;
const activeHosts = new Set(configured.filter(s => s.enabled).map(s => new URL(s.config.url ?? s.config.feedUrl).hostname.replace(/^www\./, "")));
const tasks: any[] = [];
const hosts = new Set<string>();
for (const entry of catalog.sources) {
  const probe = audit.find((p: any) => p.catalogId === entry.catalogId);
  if (probe?.outcome !== "html_candidates_unverified" || !probe.candidateSamples?.length) continue;
  const host = new URL(probe.finalUrl).hostname.replace(/^www\./, "");
  if (activeHosts.has(host) || hosts.has(host)) continue;
  hosts.add(host);
  tasks.push({ entry, probe });
}
const results: any[] = [];
let index = 0;
async function work(task: any) {
  const { entry, probe } = task;
  const result: any = { catalogId: entry.catalogId, url: probe.finalUrl, name: entry.name, checkedAt: new Date().toISOString(), status: "needs_specific_listing" };
  try {
    const $ = cheerio.load(readFileSync(probe.responseFile, "utf8"));
    const candidates = probe.candidateSamples.filter((c: any) => {
      const url = new URL(c.url);
      return url.hostname.replace(/^www\./, "") === new URL(probe.finalUrl).hostname.replace(/^www\./, "")
        && !/\.(pdf|zip|xlsx?)$|\/default\.aspx|\/index\.(html?|aspx|php)|[?&](category|page|cat)=/i.test(url.href)
        && url.pathname.split("/").filter(Boolean).length >= 2;
    });
    const sampleList = [];
    const source: SourceRow = { id: "catalog-list-" + entry.catalogId.replace("insurance-source-", ""), name: entry.name,
      kind: "web_list", tier: entry.tier, enabled: true, first_party: entry.tier === "T1", fail_count: 0, cursor: null,
      participation_mode: "editorial", interval_minutes: 240,
      config: { url: probe.finalUrl, itemSelector: "a[href]", linkSelector: "a", titleSelector: "a", publishedAtUtcOffset: "+08:00",
        detail: { maxFetches: 6 }, _aihot: { initialBackfillLimit: 100, initialBackfillMonths: 24 }, publishedAfter: "2024-10-28T15:59:59.999Z" } };
    for (const candidate of candidates.slice(0, 4)) {
      try {
        const detail = await fetchDetail(candidate.url, source, { date: true, title: false, summary: false, body: true });
        const sample = { ...candidate, publishedAt: detail.publishedAt, publicationTime: detail.publicationTime,
          bodyChars: detail.body?.text.length ?? 0, bodyExcerpt: detail.body?.text.slice(0, 180) };
        sampleList.push(sample);
        if (sampleList.filter(s => s.publishedAt && s.publishedAt >= new Date("2024-10-28T16:00:00Z") && s.publishedAt <= new Date() && s.bodyChars >= 200).length >= 2) break;
      } catch (error) { sampleList.push({ ...candidate, error: error instanceof Error ? error.message : String(error) }); }
    }
    result.samples = sampleList;
    const verified = sampleList.filter(s => s.publishedAt && s.publishedAt >= new Date("2024-10-28T16:00:00Z") && s.publishedAt <= new Date() && s.bodyChars >= 200);
    if (verified.length >= 2) {
      const prefixes = [...new Set(verified.map(s => {
        const url = new URL(s.url);
        const parts = url.pathname.split("/").filter(Boolean);
        const year = parts.findIndex(p => /^(19|20)\d{2}(?:[-_]\d{2})?$/.test(p));
        const keep = year >= 0 ? parts.slice(0, year) : parts.slice(0, -1);
        return url.origin + "/" + keep.join("/") + "/";
      }))];
      if (prefixes.some(p => new URL(p).pathname === "/")) throw new Error("Verified articles do not establish a specific editorial URL scope");
      source.config.allowUrlPrefixes = prefixes;
      // Reuse a date printed within a link's small enclosing news card when its row structure is clear.
      const anchor = $("a[href]").filter((_, el) => { try { return new URL($(el).attr("href")!, probe.finalUrl).href === verified[0].url; } catch { return false; } }).first();
      const card = anchor.closest("li,article,tr");
      if (card.length && card.find("a[href]").length <= 4) {
        const tag = card.get(0)?.tagName;
        const classes = (card.attr("class") ?? "").split(/\s+/).filter(c => /^[A-Za-z_][\w-]*$/.test(c));
        const selector = tag + classes.slice(0, 2).map(c => "." + c).join("");
        const date = card.find("time,[class*='date'],[class*='time']").first();
        const parsed = readPublicationDate(date.attr("datetime") ?? date.text(), "+08:00");
        if (parsed.publishedAt) { source.config.itemSelector = selector; source.config.publishedAtSelector = "time,[class*='date'],[class*='time']"; }
      }
      const native = await fetchWebList(source);
      result.listed = native.length;
      if (!verified.every(v => native.some(c => c.url === v.url))) throw new Error("Native collector did not reproduce the two verified article identities");
      const { cursor, first_party, fail_count, ...fields } = source;
      result.source = { ...fields, site_fulltext: false, syndicate_fulltext: false };
      result.status = "verified_specific_list";
      result.coverage = "Articles linked from this public page, within verified editorial URL prefixes. Historical pagination remains unverified.";
    }
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  results.push(result);
  writeFileSync(".data/insurance-ingestion/list-discovery.json", JSON.stringify({ checkedAt: new Date().toISOString(), total: tasks.length, checked: results.length, externalModelCalls: 0, results }, null, 2));
  console.log(JSON.stringify({ catalogId: entry.catalogId, status: result.status, listed: result.listed, error: result.error }));
}
await Promise.all(Array.from({ length: 6 }, async () => { while (index < tasks.length) await work(tasks[index++]); }));
