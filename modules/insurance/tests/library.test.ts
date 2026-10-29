import "../../../tests/setup.ts";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle, republishScreenedArticles } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { installModules } from "@aihot/backend/modules";
import { loadCollectedLibrary, loadCollectionCoverage } from "@aihot/backend/publication/collection";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { registerInsuranceLibrary } from "../api/library.ts";
import Fastify from "fastify";

const options = { from: "2024-10-28T16:00:00Z", screeningPrefix: "insurance.relevance.", archivePrefix: "insurance.archive." };
const ids: Record<string, string> = {};
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode) VALUES
    ('library-public','Insurance source（channel note）','rss','{}'::jsonb,'T1','editorial'),
    ('library-private','Private source','rss','{}'::jsonb,'T1','isolated')`;
  for (const name of ["related", "excluded", "unknown", "stale", "pending", "undated", "withdrawn", "private", "processed", "future"]) {
    const material = await upsertMaterial({ sourceId: name === "private" ? "library-private" : "library-public", title: "真实保险资料 " + name,
      url: `https://example.org/library/${name}`, excerpt: "来源提供的简短摘要", bodyText: "PRIVATE-BODY-DO-NOT-EXPOSE".repeat(20), bodyStatus: "ok",
      publishedAt: name === "undated" ? null : new Date("2025-02-01T00:00:00Z"), via: "import" });
    ids[name] = material.articleId;
    const label = name === "excluded" ? "BLOCK" : name === "unknown" ? "UNKNOWN" : "PASS";
    if (!["pending", "undated", "processed", "future"].includes(name)) await sql`INSERT INTO settings(key,value)
      VALUES (${"insurance.relevance." + material.articleId},${sql.json({ articleId: material.articleId, revision: name === "stale" ? 0 : 1, status: "screened", label, reason: "模型判断依据", attemptedAt: "2026-10-29T00:00:00Z" })})`;
  }
  await sql`INSERT INTO editorial_overrides(article_id,fields,visibility,reason,updated_by) VALUES (${ids.withdrawn},'{}'::jsonb,'withdrawn','test withdrawal','test')`;
  for (const name of ["processed", "future"]) {
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected) VALUES (${ids[name]},1,'rule','pass','已加工保险新闻','已完成的中文摘要',${name === "future"})`;
    if (name === "future") await sql`UPDATE articles SET grouping_status='complete' WHERE id=${ids[name]}`;
    await publishArticle(ids[name]);
  }
  await sql`UPDATE publications SET visible_after=now()+interval '1 day' WHERE article_id=${ids.future}`;
});
after(async () => { await stopBoss(); await closeDb(); });

test("the collection reader exposes current relevance and original excerpts without publishing unreviewed news or leaking full text", async () => {
  const related = await loadCollectedLibrary(options);
  assert.deepEqual(related.counts, { related: 2, pending: 1, review: 2, excluded: 1 });
  assert.equal(related.totalCollected, 6);
  assert.deepEqual(new Set(related.items.map(item => item.id)), new Set([ids.related, ids.processed]));
  const original = related.items.find(item => item.id === ids.related)!;
  assert.equal(original.excerptKind, "source");assert.equal(original.excerpt, "来源提供的简短摘要");
  assert.equal(original.processed, false);assert.equal(original.source.name, "Insurance source");
  const processed = related.items.find(item => item.id === ids.processed)!;
  assert.equal(processed.title, "已加工保险新闻");assert.equal(processed.excerptKind, "editorial");
  const review = await loadCollectedLibrary(options, { view: "review" });
  assert.deepEqual(new Set(review.items.map(item => item.id)), new Set([ids.unknown, ids.stale]));
  assert.equal(review.items.find(item => item.id === ids.stale)?.screeningReason, null);
  assert.ok(!JSON.stringify(related).includes("PRIVATE-BODY-DO-NOT-EXPOSE"));
  const [calls] = await sql`SELECT count(*)::int AS n FROM receipts`;
  assert.equal(calls.n, 0);
  const [publication] = await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=${ids.related}`;
  assert.equal(publication.n, 0);
});

test("collection search, source filters and numeric pages agree on the selected results", async () => {
  const found = await loadCollectedLibrary(options, { view: "pending", q: "pending", source: "library-public", page: 999 });
  assert.equal(found.total, 1);assert.equal(found.page, 1);assert.equal(found.items[0].id, ids.pending);
  const wildcard = await loadCollectedLibrary(options, { q: "%" });
  assert.equal(wildcard.total, 0);
});

test("source coverage reports channels separately from inventory entries and strips credentials from links", async () => {
  await sql`INSERT INTO settings(key,value) VALUES ('insurance.archive.library-public','{"status":"running","error":"secret-error-not-public"}'::jsonb)`;
  const data = await loadCollectionCoverage(options, [
    { id: "catalog-a", name: "Regulator news", url: "https://example.org/news?api_key=secret", collectorIds: ["library-public"], needsAuthorization: false },
    { id: "catalog-b", name: "WeChat source", url: null, collectorIds: [], needsAuthorization: true },
    { id: "catalog-c", name: "Directory", url: "https://example.org/directory", collectorIds: [], needsAuthorization: false },
  ]);
  assert.equal(data.inventoryTotal, 3);assert.equal(data.connectedEntries, 1);assert.equal(data.awaitingAuthorization, 1);
  assert.equal(data.entries[0].channels[0].history, "running");
  assert.equal(data.entries[1].state, "awaiting-authorization");assert.equal(data.entries[2].state, "not-connected");
  assert.ok(!JSON.stringify(data).includes("secret"));
});

test("the library HTTP endpoint rejects malformed filters and performs only reads", async () => {
  const app = Fastify();registerInsuranceLibrary(app);
  try {
    const response = await app.inject("/api/site/insurance/library?view=related");
    assert.equal(response.statusCode, 200);assert.equal(response.json().kind, "materials");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal((await app.inject("/api/site/insurance/library?page=-1")).statusCode, 400);
    assert.equal((await app.inject("/api/site/insurance/library?view=invalid")).statusCode, 400);
    assert.equal((await app.inject("/api/site/insurance/library?q=a&q=b")).statusCode, 400);
  } finally { await app.close(); }
});

test("a recorded preview limitation appears for review without rewriting the original model label", async () => {
  await sql`UPDATE settings SET value=value || '{"reviewRequired":true,"reviewReason":"仅有公开预览，需核对全文"}'::jsonb WHERE key=${"insurance.relevance." + ids.excluded}`;
  const data = await loadCollectedLibrary(options, { view: "review" });
  const flagged = data.items.find(item => item.id === ids.excluded)!;
  assert.equal(flagged.state, "review");assert.equal(flagged.reviewNote, "仅有公开预览，需核对全文");
  const [saved] = await sql`SELECT value FROM settings WHERE key=${"insurance.relevance." + ids.excluded}`;
  assert.equal(saved.value.label, "BLOCK");
  assert.equal((await loadCollectedLibrary(options, { view: "excluded" })).total, 0);
});

test("current screenings enter the ordinary pool, search and details without analyses, scores or paid requests, and revisions revoke admission", async () => {
  installModules([{ name: "insurance", screenedPublication: options }]);
  const publicIds: string[] = [];
  const held: Record<string, string> = {};
  const [beforeCalls] = await sql`SELECT count(*)::int AS n FROM receipts`;
  const [beforeAnalyses] = await sql`SELECT count(*)::int AS n FROM analyses`;
  try {
    for (const name of [...Array.from({ length: 41 }, (_, i) => String(i)), "stale", "block", "unknown", "review", "private", "withdrawn", "undated", "old", "future"]) {
      const material = await upsertMaterial({ sourceId: name === "private" ? "library-private" : "library-public",
        title: `Insurance screened-exposure ${name}`, url: `https://example.org/screened-exposure/${name}`, language: "en",
        publishedAt: name === "undated" ? null : new Date(name === "old" ? "2020-02-01Z" : name === "future" ? "2099-02-01Z" : "2025-02-01Z"),
        excerpt: "Source-provided excerpt", bodyText: "BODY-SHOULD-NOT-BE-SHOWN".repeat(30), bodyStatus: "ok", via: "import" });
      held[name] = material.articleId;
      if (/^\d+$/.test(name)) publicIds.push(material.articleId);
      await sql`INSERT INTO settings(key,value) VALUES (${"insurance.relevance." + material.articleId},${sql.json({
        articleId: material.articleId, revision: name === "stale" ? 0 : 1, status: "screened", attemptedAt: new Date().toISOString(),
        label: name === "block" ? "BLOCK" : name === "unknown" ? "UNKNOWN" : "PASS", reviewRequired: name === "review",
      })})`;
    }
    await sql`INSERT INTO editorial_overrides(article_id,fields,visibility,reason,updated_by)
      VALUES (${held.withdrawn},'{}','withdrawn','test','test')`;
    await republishScreenedArticles();
    const query = { q: "screened-exposure", channel: "all" as const, category: null, tag: null };
    const first = await loadPool(query);
    const second = await loadPool({ ...query, page: 2 });
    assert.equal(first.total, 41);assert.equal(first.pageCount, 2);
    assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.id)), new Set(publicIds));
    for (const item of [...first.items, ...second.items]) {
      assert.equal(item.prefiltered, true);assert.equal(item.selected, false);assert.equal(item.score, null);
      assert.equal(item.category, null);assert.deepEqual(item.tags, []);assert.equal(item.reason, null);
      assert.equal(item.summary, "Source-provided excerpt");
    }
    const detail = await loadItemDetail(publicIds[0]);
    assert.equal(detail.kind, "found");
    if (detail.kind !== "found") throw new Error("missing detail");
    assert.equal(detail.item.prefiltered, true);assert.equal(detail.item.originalTitle, null);assert.equal(detail.item.indexable, false);
    assert.equal(detail.item.links.original, "https://example.org/screened-exposure/0");
    assert.ok(!JSON.stringify(detail.item).includes("BODY-SHOULD-NOT-BE-SHOWN"));
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses`)[0].n, beforeAnalyses.n);
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, beforeCalls.n);

    // A real material update follows the same publication path as the collector.
    await upsertMaterial({ sourceId: "library-public", title: "Insurance screened-exposure 0 updated",
      url: "https://example.org/screened-exposure/0", excerpt: "Changed excerpt", bodyText: "Changed source body".repeat(20), bodyStatus: "ok",
      publishedAt: new Date("2025-02-01Z"), via: "import" });
    assert.equal((await sql`SELECT eligible FROM publications WHERE article_id=${publicIds[0]}`)[0].eligible, false);
    await sql`UPDATE settings SET value=value || '{"reviewRequired":true}'::jsonb WHERE key=${"insurance.relevance." + publicIds[1]}`;
    await publishArticle(publicIds[1]);
    assert.equal((await sql`SELECT eligible FROM publications WHERE article_id=${publicIds[1]}`)[0].eligible, false);
    // A complete current decision supersedes a PASS screening, without rewriting the screening record.
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance) VALUES (${publicIds[2]},1,'rule','block')`;
    await publishArticle(publicIds[2]);
    assert.equal((await sql`SELECT eligible FROM publications WHERE article_id=${publicIds[2]}`)[0].eligible, false);
  } finally { installModules([]); }
});
