import "../../../tests/setup.ts";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Reply, stub } from "../../../tests/setup.ts";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";
import { archivePage, archiveSource, assertFreeSource, pageDecision, readArchiveProgress, windowCandidates, type ArchivePlan } from "../backend/archive.ts";
import type { SourceRow, Candidate } from "@aihot/backend/sources/types";

after(async () => { await stopBoss(); await closeDb(); });
const from = new Date("2024-10-28T16:00:00Z");
const through = new Date("2026-10-29T10:00:00Z");
const row = (url: string): SourceRow => ({ id: "archive-test", name: "Test insurance source", kind: "json_list", tier: "T1", enabled: true,
  first_party: true, participation_mode: "editorial", interval_minutes: 60, cursor: { initializedAt: "2026-10-28T00:00:00Z" }, fail_count: 0,
  config: { url, mode: "json_api", titlePaths: ["title"], urlTemplate: "{raw:url}", publishedAtPath: "date" } });
const candidate = (date: string | null): Candidate => ({ url: "https://example.org/news/test", title: "Insurance rules", publishedAt: date ? new Date(date) : null });

test("the two-year window includes the Beijing starting day and rejects unknown and future publication dates", () => {
  const found = [candidate("2024-10-28T15:59:59Z"), candidate(from.toISOString()), candidate(through.toISOString()), candidate("2026-10-30T00:00:00Z"), candidate(null)];
  assert.deepEqual(windowCandidates(found, from, through), [found[1], found[2]]);
});

test("pagination preserves the live cursor and all unrelated channel parameters", () => {
  const source = row("https://example.org/api?channel=insurance&page=1");
  const plan: ArchivePlan = { sourceId: source.id, pagination: { kind: "query", key: "page", first: 1 }, evidence: "fixture", coverage: "test" };
  const archive = archiveSource(source, plan, 5, through);
  assert.equal(new URL(archive.config.url).searchParams.get("page"), "5");
  assert.equal(new URL(archive.config.url).searchParams.get("channel"), "insurance");
  assert.equal(source.cursor?.initializedAt, "2026-10-28T00:00:00Z");
  assert.equal(source.config.url, "https://example.org/api?channel=insurance&page=1");
  assert.equal(archive.cursor, null);
  const wordpress = archiveSource(source, { ...plan, pagination: { kind: "wordpress", first: 1 } }, 2, through);
  assert.equal(new URL(wordpress.config.url).searchParams.get("before"), "2026-10-29T10:00:00Z");
  assert.throws(() => assertFreeSource({ ...source, kind: "mp_account" }));
  assert.throws(() => assertFreeSource(row("https://r.jina.ai/https://example.org")));
});

test("mixed or unknown dates and repeated pages cannot claim a complete archive", () => {
  const plan: ArchivePlan = { sourceId: "test", pagination: { kind: "query", key: "page", first: 1 }, descending: true, evidence: "fixture", coverage: "test" };
  assert.equal(pageDecision([candidate("2024-01-01"), candidate("2025-01-01")], plan, from, false).status, "running");
  assert.equal(pageDecision([candidate("2024-01-01"), candidate(null)], plan, from, false).status, "running");
  assert.equal(pageDecision([candidate("2024-01-01")], plan, from, false).status, "exhausted");
  assert.equal(pageDecision([candidate("2025-01-01")], plan, from, true).status, "limited");
  assert.equal(pageDecision([candidate("2025-01-01")], { ...plan, pagination: { kind: "single" } }, from, false).status, "limited");
});

test("a failed page resumes in place, deduplicates material, queues without model calls, and leaves the live cursor intact", async () => {
  const previousPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  let failPageTwo = true;
  const provider = await stub((_hit, request) => {
    const page = new URL(request.url, "http://localhost").searchParams.get("page");
    if (page === "2" && failPageTwo) return new Reply(400, { message: "source temporarily rejects this page" });
    return page === "1" ? [{ title: "保险政策历史回补", url: "https://example.org/archive/regulation-a", date: "2025-01-01T00:00:00Z" }]
      : page === "2" ? [{ title: "保险政策历史回补", url: "https://example.org/archive/regulation-a", date: "2025-01-01T00:00:00Z" },
        { title: "保险信息披露规则", url: "https://example.org/archive/regulation-b", date: "2025-02-01T00:00:00Z" }] : [];
  });
  try {
    const source = row(provider.url + "/api?page=1");
    await sql`INSERT INTO sources(id,name,kind,config,tier,enabled,cursor) VALUES (${source.id},${source.name},${source.kind},${sql.json(source.config)},'T1',true,${sql.json(source.cursor!)})`;
    const plan: ArchivePlan = { sourceId: source.id, pagination: { kind: "query", key: "page", first: 1 }, evidence: "local stub", coverage: "test" };
    assert.equal((await archivePage(source.id, plan, from, through)).status, "running");
    assert.equal((await readArchiveProgress(source.id))?.page, 2);
    assert.equal((await archivePage(source.id, plan, from, through)).status, "failed");
    assert.equal((await readArchiveProgress(source.id))?.page, 2);
    failPageTwo = false;
    assert.equal((await archivePage(source.id, plan, from, through)).status, "running");
    assert.equal((await archivePage(source.id, plan, from, through)).status, "exhausted");
    const [articles] = await sql`SELECT count(*)::int AS n,bool_and(backfill) AS historical,bool_and(processing_state='new') AS pending FROM articles WHERE source_id=${source.id}`;
    assert.equal(articles.n, 2);
    assert.equal(articles.historical, true);
    assert.equal(articles.pending, true);
    const [saved] = await sql`SELECT cursor FROM sources WHERE id=${source.id}`;
    assert.deepEqual(saved.cursor, source.cursor);
    const [receipts] = await sql`SELECT count(*)::int AS n FROM receipts`;
    assert.equal(receipts.n, 0);
  } finally { config.allowPrivateNetworkFetch = previousPrivate; await provider.close(); }
});

test("article metadata reads are bounded and continue within a page without a broken link stranding later items", async () => {
  const previousPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  const readIds: number[] = [];
  let origin = "";
  const server = http.createServer((request, response) => {
    if (request.url === "/list") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ title: "保险监管公告 " + (i + 1), url: origin + "/article/" + (i + 1) }))));
    } else {
      const id = Number(request.url?.split("/").at(-1));
      readIds.push(id);
      response.writeHead(id === 5 ? 404 : 200, { "content-type": "text/html" });
      response.end(id === 5 ? "missing" : `<html><head><title>保险监管公告 ${id}</title><meta property="article:published_time" content="2025-01-01T12:00:00Z"></head><body><article><h1>保险监管公告 ${id}</h1><p>${"保险公司信息披露规定明确保险责任及消费者权益保障要求。".repeat(25)}</p></article></body></html>`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    const source = row(origin + "/list");source.id = "archive-bounded-test";source.config.detail = { maxFetches: 4 };
    await sql`INSERT INTO sources(id,name,kind,config,tier,enabled) VALUES (${source.id},${source.name},${source.kind},${sql.json(source.config)},'T1',true)`;
    const plan: ArchivePlan = { sourceId: source.id, pagination: { kind: "single" }, evidence: "local stub", coverage: "test" };
    await archivePage(source.id, plan, from, through);
    assert.equal(readIds.length, 4);
    assert.equal((await readArchiveProgress(source.id))?.page, 1);
    await archivePage(source.id, plan, from, through);
    await archivePage(source.id, plan, from, through);
    assert.deepEqual(readIds, [1, 2, 3, 4, 5, 6, 7]);
    const progress = await readArchiveProgress(source.id);
    assert.equal(progress?.status, "limited");
    assert.equal(progress?.undated, 1);
    assert.equal(progress?.detailFailures?.length, 1);
    const [stored] = await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${source.id}`;
    assert.equal(stored.n, 6);
  } finally {
    config.allowPrivateNetworkFetch = previousPrivate;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("a metadata-only WordPress route never promotes its cookie notice to confirmed article text", async () => {
  const previousPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  const provider = await stub(() => [{ id: 12345, title: { rendered: "Insurance regulator press release" },
    link: "https://example.org/regulator/metadata-only", date_gmt: "2025-01-01T12:00:00",
    content: { rendered: `<p>${"We use cookies on our website. Accept All cookies. Cookie Settings. ".repeat(10)}</p>` }, excerpt: { rendered: "Cookie Notice" } }]);
  try {
    const source = row(provider.url + "/posts");source.id = "archive-metadata-test";
    await sql`INSERT INTO sources(id,name,kind,config,tier,enabled) VALUES (${source.id},${source.name},${source.kind},${sql.json(source.config)},'T1',true)`;
    const plan: ArchivePlan = { sourceId: source.id, pagination: { kind: "wordpress", first: 1 }, bodyAccess: "metadata-only", evidence: "local cookie-only response", coverage: "title and date only" };
    await archivePage(source.id, plan, from, through);
    const [stored] = await sql`SELECT title,published_at,body_text,body_status,excerpt FROM articles WHERE source_id=${source.id}`;
    assert.equal(stored.title, "Insurance regulator press release");
    assert.equal(stored.published_at.toISOString(), "2025-01-01T12:00:00.000Z");
    assert.equal(stored.body_text, null);assert.notEqual(stored.body_status, "ok");assert.equal(stored.excerpt, null);
  } finally { config.allowPrivateNetworkFetch = previousPrivate; await provider.close(); }
});

test("one untitled WordPress entry is retained as a coverage gap while other pages continue", async () => {
  const previousPrivate = config.allowPrivateNetworkFetch;config.allowPrivateNetworkFetch = true;
  const provider = await stub((_hit, request) => new URL(request.url, "http://localhost").searchParams.get("page") === "1" ? [
    { id: 67890, title: { rendered: "" }, link: "https://example.org/untitled", date_gmt: "2025-01-01T12:00:00" },
    { id: 67891, title: { rendered: "Insurance supervision update" }, link: "https://example.org/valid-article", date_gmt: "2025-01-01T12:00:00" },
  ] : []);
  try {
    const source = row(provider.url + "/posts");source.id = "archive-unmapped-test";
    await sql`INSERT INTO sources(id,name,kind,config,tier,enabled) VALUES (${source.id},${source.name},${source.kind},${sql.json(source.config)},'T1',true)`;
    const plan: ArchivePlan = { sourceId: source.id, pagination: { kind: "wordpress", first: 1 }, evidence: "local untitled entry", coverage: "test" };
    assert.equal((await archivePage(source.id, plan, from, through)).status, "running");
    const final = await archivePage(source.id, plan, from, through);
    assert.equal(final.status, "limited");
    assert.equal((await readArchiveProgress(source.id))?.unmappedPosts?.length, 1);
    const [stored] = await sql`SELECT count(*)::int AS n FROM articles WHERE source_id=${source.id}`;
    assert.equal(stored.n, 1);
  } finally { config.allowPrivateNetworkFetch = previousPrivate;await provider.close(); }
});
