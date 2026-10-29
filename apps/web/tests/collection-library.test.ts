import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { CollectionPage, CollectionView } from "@aihot/contracts/collection";
import { fakeApi, feedItem, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

let web: WebServer;
let browser: Browser;
const requests: string[] = [];
const screened = { id: "screened-pass", title: "Original insurance source title", prefiltered: true as const,
  summary: "Source excerpt about insurance", score: null, category: null, selected: false, reason: null };
const api = fakeApi(url => {
  if (url.pathname === "/api/site/pool") return { filters: {}, items: [feedItem(screened)], page: 1, pageCount: 1, total: 1, todayCount: 0, freshness: "2026-10-29T08:00:00Z" };
  if (url.pathname === "/api/site/items/screened-pass") return itemDetail({ ...screened, indexable: false, body: null, outline: [], hasTranslation: false, markdownAvailable: false });
  if (url.pathname !== "/api/site/insurance/library") return;
  requests.push(url.search);
  const view = url.searchParams.get("view") ?? "related";
  if (view === "sources") return { kind: "sources", data: { page: 1, pageCount: 1, total: 1, query: url.searchParams.get("q") ?? "",
    inventoryTotal: 470, configuredChannels: 112, enabledChannels: 81, connectedEntries: 90, awaitingAuthorization: 23,
    entries: [{ id: "wechat", name: "保险公众号待授权示例", url: null, state: "awaiting-authorization", channels: [] }] } } satisfies CollectionPage;
  const page = Number(url.searchParams.get("page") ?? 1);
  return { kind: "materials", data: { view: view as CollectionView, query: url.searchParams.get("q") ?? "", source: url.searchParams.get("source") ?? "",
    page, pageCount: 2, pageSize: 30, total: 31, totalCollected: 7000, enabledSources: 81, latestCollectionAt: "2026-10-29T15:00:00Z",
    counts: { related: 72, pending: 6900, review: 2, excluded: 26 }, sources: [{ id: "fixture", name: "保险信源", count: 100 }],
    items: [{ id: "fixture-" + page, title: view === "pending" ? "待筛原始材料" : "初筛相关保险材料第 " + page + " 页", url: "https://example.org/original",
      source: { id: "fixture", name: "保险信源" }, publishedAt: "2026-10-29T08:00:00Z", publicationTime: "2026-10-29",
      excerpt: "这是信源提供的摘录。", excerptKind: "source", state: view as CollectionView, processed: false, screeningReason: view === "related" ? "涉及保险责任" : null, reviewNote: null }] } } satisfies CollectionPage;
});
before(async () => { web = await startWebServer(api);browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close();await web?.stop(); });

test("the desktop library reads live API data and preserves filters across pages", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(web.origin + "/library");
    await expect(page.getByRole("heading", { name: "初筛相关保险材料第 1 页" })).toBeVisible();
    await expect(page.getByText("来源摘录", { exact: true })).toBeVisible();
    assert.equal(await page.getByRole("link", { name: "阅读原文" }).getAttribute("href"), "https://example.org/original");
    await page.getByLabel("搜索资料").fill("保险");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByRole("link", { name: "下一页" }).click();
    await expect(page.getByRole("heading", { name: "初筛相关保险材料第 2 页" })).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("q"), "保险");
    await page.getByRole("link", { name: /^待筛材料/ }).click();
    await expect(page.getByRole("heading", { name: "待筛原始材料" })).toBeVisible();
    await page.getByRole("link", { name: "信源进度", exact: true }).click();
    await expect(page.getByText("保险公众号待授权示例", { exact: true })).toBeVisible();
    await expect(page.getByText("待授权", { exact: true })).toBeVisible();
    assert.ok(requests.some(query => query.includes("page=2") && query.includes("q=")));
  } finally { await context.close(); }
});

test("the phone library opens from My tools and keeps a working return path", async () => {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto(web.origin + "/more");
    await page.getByRole("link", { name: "保险资料库" }).click();
    await expect(page.getByRole("heading", { name: "保险资料库", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "初筛相关保险材料第 1 页" })).toBeVisible();
    await page.getByRole("button", { name: "我的", exact: true }).click();
    await expect(page).toHaveURL(web.origin + "/more");
  } finally { await context.close(); }
});

test("the ordinary all-news page labels screened source excerpts and opens a working original-title detail on desktop and phone", async () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 760 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      await visit(page, web.origin + "/all");
      await expect(page.getByText("初筛相关", { exact: true })).toBeVisible();
      await expect(page.getByText("原文摘录", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: screened.title, exact: true }).click();
      await expect(page.getByRole("heading", { name: screened.title, exact: true })).toBeVisible();
      await expect(page.getByText("原文摘录", { exact: true })).toBeVisible();
      await expect(page.getByText("AI 导读", { exact: true })).toHaveCount(0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    } finally { await context.close(); }
  }
});
