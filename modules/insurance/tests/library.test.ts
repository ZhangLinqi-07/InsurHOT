import "../../../tests/setup.ts";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle, republishScreenedArticles, republishCollectedArticles } from "@aihot/backend/publication/publish";
import { loadPool } from "@aihot/backend/publication/pool";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { loadRadar } from "@aihot/backend/publication/radar";
import { installModules } from "@aihot/backend/modules";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { registerInsuranceRadar } from "../api/radar.ts";
import Fastify from "fastify";
import { classifyInsurance } from "../backend/classification.ts";

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

test("all collected material migrates into the ordinary feed regardless of old labels, missing text or dates", async () => {
  const publicIds: string[] = [];
  const allIds: string[] = [];
  const [beforeCalls] = await sql`SELECT count(*)::int AS n FROM receipts`;
  const [beforeAnalyses] = await sql`SELECT count(*)::int AS n FROM analyses`;
  try {
    for (const name of [...Array.from({ length: 41 }, (_, i) => String(i)), "block", "unknown", "stale", "title-only", "undated", "old", "withdrawn", "private"]) {
      const material = await upsertMaterial({ sourceId: name === "private" ? "library-private" : "library-public",
        title: `中国平安上线智能核保系统 collected-migration ${name}`, url: `https://example.org/collected-migration/${name}`,
        excerpt: name === "title-only" ? null : "Source-provided excerpt", bodyStatus: "pending", via: "import",
        publishedAt: name === "undated" ? null : new Date(name === "old" ? "2020-02-01Z" : "2025-02-01Z") });
      allIds.push(material.articleId);
      if (!["withdrawn", "private"].includes(name)) publicIds.push(material.articleId);
      if (["block", "unknown", "stale"].includes(name)) await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance)
        VALUES (${material.articleId},${name === "stale" ? 0 : 1},'rule',${name === "block" ? "block" : "unknown"})`;
      await sql`INSERT INTO settings(key,value) VALUES (${"insurance.relevance." + material.articleId},
        ${sql.json({ articleId: material.articleId, revision: 1, status: "screened", label: "BLOCK", reviewRequired: true })})`;
      if (name === "withdrawn") await sql`INSERT INTO editorial_overrides(article_id,fields,visibility,reason,updated_by)
        VALUES (${material.articleId},'{}','withdrawn','test','test')`;
    }
    installModules([{ name: "insurance", materialPublication: true, classifyArticle: classifyInsurance }]);
    await republishCollectedArticles();
    const query = { q: "collected-migration", channel: "all" as const, category: null, tag: null };
    const first = await loadPool(query), second = await loadPool({ ...query, page: 2 });
    assert.equal(first.total, publicIds.length);assert.equal(first.pageCount, 2);
    assert.deepEqual(new Set([...first.items, ...second.items].map(item => item.id)), new Set(publicIds));
    for (const item of [...first.items, ...second.items]) {
      assert.equal(item.prefiltered, true);assert.equal(item.selected, false);assert.equal(item.score, null);
      assert.equal(item.category, "insurtech");
      const detail = await loadItemDetail(item.id);assert.equal(detail.kind, "found");
    }
    const fresh = await upsertMaterial({ sourceId: "library-public", title: "保险监管即时入库 fresh-collected", language: "en",
      url: "https://example.org/fresh-collected", bodyStatus: "pending", publishedAt: null, via: "fetch" });
    allIds.push(fresh.articleId);
    assert.equal((await sql`SELECT eligible,summary FROM publications WHERE article_id=${fresh.articleId}`)[0].eligible, true);
    await upsertMaterial({ sourceId: "library-public", title: "保险监管更新 fresh-collected", url: "https://example.org/fresh-collected",
      excerpt: "补齐后的原文摘录", bodyStatus: "pending", via: "fetch" });
    const [updated] = await sql`SELECT eligible,summary,title FROM publications WHERE article_id=${fresh.articleId}`;
    assert.equal(updated.eligible, true);assert.equal(updated.summary, "补齐后的原文摘录");
    assert.equal(updated.title, "保险监管更新 fresh-collected");
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, beforeCalls.n);
    assert.equal((await sql`SELECT count(*)::int AS n FROM analyses`)[0].n, beforeAnalyses.n + 3);
    assert.equal((await republishCollectedArticles()).changed, 0);
  } finally { installModules([]); await sql`DELETE FROM articles WHERE id=ANY(${allIds}::text[])`; }
});

test("radar uses Beijing publication dates, public scope and source excerpts without exposing body or internal tags", async () => {
  const now = new Date("2026-10-30T03:00:00Z");
  const fixtures = [
    ["start", "2026-09-30T16:00:00Z"], ["before", "2026-09-30T15:59:59Z"],
    ["current", "2026-10-30T02:00:00Z"], ["future-date", "2026-10-30T03:00:01Z"],
    ["held", "2026-10-29T00:00:00Z"], ["withdrawn", "2026-10-29T00:00:00Z"],
    ["ineligible", "2026-10-29T00:00:00Z"], ["summary-only", "2026-10-29T00:00:00Z"], ["undated", null],
  ];
  const [beforeCalls] = await sql`SELECT count(*)::int AS n FROM receipts`;
  try {
    for (const [name, at] of fixtures) {
      const id = "radar-boundary-" + name;
      const published = at ? new Date(at) : null;
      await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,body_text)
        VALUES (${id},'library-public',${id},${"https://example.org/" + id},${id},${published},${now},${now},'RADAR-PRIVATE-BODY')`;
      await sql`INSERT INTO publications(article_id,source_id,title,summary,url,channel,published_at,discovered_at,timeline_at,sort_at,
          eligible,selected,visible_after,visibility,tags,category)
        VALUES (${id},'library-public',${id},'Source excerpt',${"https://example.org/" + id},'news',${published},${now},${now},${now},
          ${name !== "ineligible"},${name === "held"},${new Date("2026-10-31T00:00:00Z")},
          ${name === "withdrawn" ? "withdrawn" : name === "summary-only" ? "summary-only" : "public"},${["保险监管", "entity:internal"]},'regulation')`;
    }
    const data = await loadRadar(30, now);
    assert.equal(data.from, "2026-09-30T16:00:00.000Z");assert.equal(data.to, now.toISOString());
    assert.deepEqual(data.items.map(item => item.id), ["radar-boundary-current", "radar-boundary-start"]);
    assert.equal(data.total, 2);assert.equal(data.truncated, false);
    assert.equal(data.items[0].source.name, "Insurance source");assert.equal(data.items[0].summary, "Source excerpt");
    assert.equal(data.items[0].category, "regulation");assert.deepEqual(data.items[0].tags, ["保险监管"]);
    assert.equal(data.items[0].prefiltered, true);
    assert.ok(!JSON.stringify(data).includes("RADAR-PRIVATE-BODY"));
    const longer = await loadRadar(90, now);
    assert.ok(longer.items.some(item => item.id === "radar-boundary-before"));
    const all = await loadRadar(null, now);
    assert.equal(all.from, null);assert.ok(all.items.some(item => item.id === ids.processed));
    assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, beforeCalls.n);
    const empty = await loadRadar(30, new Date("2010-01-01T00:00:00Z"));
    assert.deepEqual(empty.items, []);assert.equal(empty.total, 0);assert.equal(empty.truncated, false);
  } finally { await sql`DELETE FROM articles WHERE starts_with(id,'radar-boundary-')`; }
});

test("radar discloses bounded coverage and accepts only supported HTTP date windows", async () => {
  const now = new Date("2026-10-30T03:00:00Z");
  const app = Fastify();registerInsuranceRadar(app);
  try {
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at)
      SELECT 'radar-cap-' || n, 'library-public', 'radar-cap-' || n, 'https://example.org/radar-cap/' || n,
        'Radar news ' || n, ${now}, ${now}, ${now} FROM generate_series(1,601) n`;
    await sql`INSERT INTO publications(article_id,source_id,title,summary,url,channel,published_at,discovered_at,timeline_at,sort_at,eligible)
      SELECT id,source_id,title,'Public excerpt',url,'news',published_at,discovered_at,timeline_at,timeline_at,true
      FROM articles WHERE starts_with(id,'radar-cap-')`;
    const data = await loadRadar(30, now);
    assert.equal(data.items.length, 600);assert.equal(data.total, 601);assert.equal(data.truncated, true);
    assert.equal(data.items[0].id, "radar-cap-99");
    assert.equal((await app.inject("/api/site/insurance/radar?days=all")).statusCode, 200);
    const response = await app.inject("/api/site/insurance/radar");
    assert.equal(response.statusCode, 200);assert.equal(response.json().days, 90);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal((await app.inject("/api/site/insurance/radar?days=7")).statusCode, 400);
    assert.equal((await app.inject("/api/site/insurance/radar?days=30&days=90")).statusCode, 400);
  } finally { await app.close(); await sql`DELETE FROM articles WHERE starts_with(id,'radar-cap-')`; }
});
