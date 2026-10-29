// Real, bounded collector previews. No model calls and no paid body fallback.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { filterPublicationWindow } from "@aihot/backend/sources/filters";
import { createHash } from "node:crypto";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { extractFromUrl } from "@aihot/backend/content/extract";
import { collectSource, listingEntries, storedDetails, enrichDetails } from "@aihot/backend/sources/collect";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { closeDb } from "@aihot/backend/db";
import type { SourceRow } from "@aihot/backend/sources/types";
import { fetchNfraBody } from "../../modules/insurance/backend/nfra.ts";

const getArg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; };
const ids = getArg("--ids", "").split(",").filter(Boolean);
const all = process.argv.includes("--all");
const collect = process.argv.includes("--collect");
const output = resolve(getArg("--out", ".data/source-validation/latest.json"));
const { sources } = JSON.parse(readFileSync("industry/sources.json", "utf8"));
const selected = sources.filter((source: SourceRow) => ids.length ? ids.includes(source.id) : all || source.enabled !== false);
const results: Record<string, unknown>[] = [];
mkdirSync(resolve(output, ".."), { recursive: true });
try {
  for (const row of selected) {
    const source: SourceRow = { first_party: row.tier === "T1", cursor: null, fail_count: 0, enabled: true, interval_minutes: 180, participation_mode: "editorial", ...row };
    const started = Date.now();
    const result: Record<string, unknown> = { id: source.id, name: source.name, kind: source.kind, enabled: source.enabled, sourceConfigSha256: createHash("sha256").update(JSON.stringify({ kind: source.kind, config: source.config })).digest("hex"), bodyStatus: "none", collectionStatus: "not_run" };
    try {
      assertSupportedConfig(source.kind, source.config);
      if (source.kind === "mp_account" || source.kind === "external") {
        result.status = "not_tested";
        result.reason = source.kind === "mp_account" ? "Requires separately configured authorized WeChat collection service" : "External push source";
      } else {
        const found = source.kind === "rss" ? (await fetchRss(source, { force: true })).candidates
          : source.kind === "web_list" ? await fetchWebList(source) : await fetchJsonList(source);
        const listed = await listingEntries(source, found);
        const known = await storedDetails(listed.map((candidate) => candidate.identityKey!));
        const details = await enrichDetails(listed, source, known, {
          budget: Number(source.config.detail?.maxFetches ?? 0), datedOut: {},
          admits: (candidate) => filterPublicationWindow([candidate], source.config.publishedAfter).length > 0,
        });
        if (details.failures.length && details.failures.length === details.attempts) throw new Error(`All configured detail reads failed: ${details.failures.map((failure) => failure.error).join("; ")}`);
        result.detailReads = { attempts: details.attempts, pending: details.pending, failures: details.failures };
        const candidates = filterPublicationWindow(listed, source.config.publishedAfter);
        result.listed = candidates.length;
        result.dated = candidates.filter((candidate) => candidate.publishedAt).length;
        result.samples = candidates.slice(0, 3).map((candidate) => ({ title: candidate.title, url: candidate.url, publishedAt: candidate.publishedAt, publicationTime: candidate.publicationTime, suppliedBodyChars: candidate.bodyText?.length ?? 0 }));
        const sample = candidates[0];
        if (sample) {
          if (sample.bodyStatus === "ok" && sample.bodyText) result.bodySample = { url: sample.url, chars: sample.bodyText.length, via: "listing" };
          else {
            try {
              const body = source.id.startsWith("nfra-") ? await fetchNfraBody(sample.url)
                : await extractFromUrl(sample.url, `source-validation:${source.id}`, {}, { paidFallback: false });
              result.bodySample = { url: sample.url, chars: body?.text.length ?? 0, via: body?.via ?? "unconfirmed" };
            } catch (error) { result.bodySample = { url: sample.url, chars: 0, error: error instanceof Error ? error.message : String(error) }; }
          }
          result.bodyStatus = Number((result.bodySample as { chars?: number } | undefined)?.chars ?? 0) >= 200 ? "ok" : "unconfirmed";
        }
        result.status = candidates.length > 0 && Number(result.dated) > 0 ? "list_ok" : candidates.length > 0 ? "list_without_dates" : "empty";
        if (collect && result.status === "list_ok") {
          const collection = await collectSource(source.id, { force: true });
          result.collection = collection;
          result.collectionStatus = collection.status;
        }
      }
    } catch (error) {
      result.status = "failed";
      result.error = error instanceof Error ? error.message : String(error);
    }
    result.elapsedMs = Date.now() - started;
    results.push(result);
    writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(), mode: collect ? "preview-and-collect" : "preview", results }, null, 2));
    console.log(JSON.stringify(result));
  }
} finally {
  await stopBoss();
  await closeDb();
}
if (results.some((result) => !["list_ok", "not_tested"].includes(String(result.status))
  || collect && result.status === "list_ok" && result.collectionStatus !== "ok")) process.exitCode = 1;
