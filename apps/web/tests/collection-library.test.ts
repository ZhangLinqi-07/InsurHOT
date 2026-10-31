import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { RadarItem, RadarResponse } from "@aihot/contracts/radar";
import type { SiteStats } from "@aihot/contracts/site";
import { fakeApi, feedItem, itemDetail, startWebServer, visit, type WebServer } from "./web-server.ts";

let web: WebServer;
let browser: Browser;
const radarRequests: string[] = [];
const radarItems: RadarItem[] = [
  { id: "radar-regulation", title: "测试监管规则更新", summary: "监管报道的测试摘要", source: { name: "监管测试信源" },
    publishedAt: "2026-10-29T08:00:00Z", category: "regulation", tags: ["监管规则"], selected: true },
  { id: "radar-tech", title: "测试保险科技进展", summary: "科技报道的来源摘录", source: { name: "科技测试信源" },
    publishedAt: "2026-10-20T08:00:00Z", category: "insurtech", tags: ["智能理赔"], selected: false, prefiltered: true },
  { id: "radar-uncategorized", title: "测试未分类保险材料", summary: null, source: { name: "研究测试信源" },
    publishedAt: "2026-09-01T08:00:00Z", category: null, tags: [], selected: false, prefiltered: true },
];
const radarLabel = (item: RadarItem) => `${item.publishedAt.slice(0, 10)} · ${item.source.name} · ${item.title}`;
const stats: SiteStats = { sources: 12, sourceKinds: { rss: 12 }, items: 123, selected: 8, dailies: 2,
  day: { collected: 3, selected: 1 }, sampleSources: [], latest: [] };
const screened = { id: "screened-pass", title: "Original insurance source title", prefiltered: true as const,
  summary: "Source excerpt about insurance", score: null, category: null, selected: false, reason: null };
const api = fakeApi(url => {
  if (url.pathname === "/api/site/stats") return stats;
  if (url.pathname === "/api/site/insurance/radar") {
    radarRequests.push(url.search);
    const days = url.searchParams.get("days") === "all" ? null : url.searchParams.get("days") === "30" ? 30 : 90;
    const items = days === 30 ? radarItems.slice(0, 2) : radarItems;
    return { items, total: items.length, truncated: false, limit: 600, days,
      from: days === null ? null : days === 30 ? "2026-09-30T16:00:00Z" : "2026-08-01T16:00:00Z", to: "2026-10-30T03:00:00Z" } satisfies RadarResponse;
  }
  if (url.pathname === "/api/site/pool" && url.searchParams.get("q") === "mobile-inventory") {
    const page = Math.min(1212, Math.max(1, Number(url.searchParams.get("page")) || 1));
    const start = (page - 1) * 40;
    return { filters: { channel: "all", category: null, tag: null, market: "all", q: "mobile-inventory", tab: "time" },
      items: Array.from({ length: Math.min(40, 48465 - start) }, (_, index) => feedItem({ id: `mobile-${start + index + 1}`, title: `保险动态 ${start + index + 1}`, score: null, selected: false })),
      page, pageCount: 1212, total: 48465, todayCount: 305, freshness: "2026-10-29T08:00:00Z" };
  }
  if (url.pathname === "/api/site/pool") return { filters: {}, items: [feedItem(screened)], page: 1, pageCount: 1, total: 1, todayCount: 0, freshness: "2026-10-29T08:00:00Z" };
  if (url.pathname === "/api/site/items/screened-pass") return itemDetail({ ...screened, indexable: false, body: null, outline: [], hasTranslation: false, markdownAvailable: false });
  if (url.pathname === "/api/site/items/radar-tech") return itemDetail({ ...radarItems[1], indexable: false, body: null, outline: [], hasTranslation: false, markdownAvailable: false });

});
before(async () => { web = await startWebServer(api);browser = await chromium.launch({ channel: "chromium" }); });
after(async () => { await browser?.close();await web?.stop(); });

test("collected news has one entry on desktop and phone, and existing library bookmarks open All", async () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 393, height: 852 }]) {
    const context = await browser.newContext({ viewport });const page = await context.newPage();
    try {
      await visit(page, web.origin + (viewport.width > 960 ? "/all" : "/more"));
      await expect(page.getByRole("link", { name: "保险资料库", exact: true })).toHaveCount(0);
      await page.goto(web.origin + "/library?view=pending&q=保险");
      await expect(page).toHaveURL(web.origin + "/all?q=" + encodeURIComponent("保险"));
      await expect(page.getByRole("link", { name: screened.title, exact: true })).toBeVisible();
      await page.getByRole("link", { name: screened.title, exact: true }).click();
      await expect(page.getByRole("heading", { name: screened.title, exact: true })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    } finally { await context.close(); }
  }
});

test("the ordinary all-news page labels screened source excerpts and opens a working original-title detail on desktop and phone", async () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 760 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      await visit(page, web.origin + "/all");
      await expect(page.getByText(/初筛/)).toHaveCount(0);
      await expect(page.getByText("原文摘录", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: screened.title, exact: true }).click();
      await expect(page.getByRole("heading", { name: screened.title, exact: true })).toBeVisible();
      await expect(page.getByText("原文摘录", { exact: true })).toBeVisible();
      await expect(page.getByText("AI 导读", { exact: true })).toHaveCount(0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    } finally { await context.close(); }
  }
});

test("desktop and phone show the same inventory and can jump to the last page without losing news", async () => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 760 }]) {
    const context = await browser.newContext({ viewport });const page = await context.newPage();
    try {
      await visit(page, web.origin + "/all?q=mobile-inventory");
      const summary = page.getByRole("region", { name: "动态列表概况" });
      await expect(summary).toContainText("48465");await expect(summary).toContainText("本页 40 条");
      await expect(page.getByRole("article")).toHaveCount(40);
      await expect(page.getByRole("link", { name: "保险动态 1", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "查看下一页", exact: true }).click();
      await expect(page.getByRole("link", { name: "保险动态 41", exact: true })).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(40);
      await page.getByRole("spinbutton", { name: "跳转页码" }).fill("1212");
      await page.getByRole("button", { name: "跳转", exact: true }).click();
      await expect(page).toHaveURL(/page=1212/);
      assert.equal(new URL(page.url()).searchParams.get("q"), "mobile-inventory");
      await expect(page.getByRole("article")).toHaveCount(25);
      await expect(page.getByRole("link", { name: "保险动态 48465", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "下一页", exact: true })).toHaveCount(0);
      await expect(summary).toContainText("本页 25 条");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    } finally { await context.close(); }
  }
});

test("overview and radar render API content before JavaScript and preserve the existing desktop navigation", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(web.origin + "/overview?item=radar-tech");
    await expect(page.getByRole("heading", { name: "总览", exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "当前报道" }).getByRole("heading", { name: radarItems[1].title })).toBeVisible();
    await expect(page.getByRole("article", { name: "当前报道" }).getByText("来源摘录", { exact: true })).toBeVisible();
    const metrics = page.getByRole("region", { name: "站点概况" });
    await expect(metrics).toContainText("123");await expect(metrics).toContainText("启用信源");
    const navigation = page.getByRole("navigation", { name: "主导航" });
    const destinations = await navigation.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href")));
    for (const path of ["/overview", "/radar", "/", "/all", "/hot", "/daily", "/topics", "/starred"])
      assert.ok(destinations.includes(path), `navigation retains ${path}`);
    await expect(navigation.getByRole("link", { name: "总览", exact: true })).toHaveAttribute("aria-current", "page");
    await page.goto(web.origin + "/radar?item=radar-uncategorized");
    await expect(page.getByRole("heading", { name: "新闻雷达", exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "当前报道" }).getByRole("heading", { name: radarItems[2].title })).toBeVisible();
    await expect(page.getByRole("article", { name: "当前报道" })).toContainText("未分类");
  } finally { await context.close(); }
});

test("overview star nodes and date points select the same report and carry it into the radar", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await visit(page, web.origin + "/overview");
    const star = page.getByRole("group", { name: "信源、报道与标签关联星图", exact: true });
    const river = page.getByRole("group", { name: "新闻日期与分类分布", exact: true });
    const article = page.getByRole("article", { name: "当前报道" });
    await star.getByRole("button", { name: "查看来源 科技测试信源 的报道", exact: true }).click();
    await expect(article.getByRole("heading", { name: radarItems[1].title })).toBeVisible();
    await expect(river.getByRole("button", { name: radarLabel(radarItems[1]), exact: true })).toHaveAttribute("aria-pressed", "true");
    await river.getByRole("button", { name: radarLabel(radarItems[2]), exact: true }).click();
    await expect(article.getByRole("heading", { name: radarItems[2].title })).toBeVisible();
    await expect(star.getByRole("button", { name: radarLabel(radarItems[2]), exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("link", { name: "打开新闻雷达", exact: true }).click();
    await expect(page).toHaveURL(web.origin + "/radar?item=radar-uncategorized");
    await expect(article.getByRole("heading", { name: radarItems[2].title })).toBeVisible();
    await expect(page.getByRole("slider", { name: "按顺序选择报道" })).toHaveValue("2");
  } finally { await context.close(); }
});

test("overview plays one coordinated journey and manual report selection pauses it", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.clock.install();
    await visit(page, web.origin + "/overview");
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const observatory = page.getByRole("region", { name: "保险行业联动观测台", exact: true });
    const article = page.getByRole("article", { name: "当前报道" });
    await expect(page.getByRole("button", { name: "暂停回放", exact: true })).toBeVisible();
    await expect(observatory.locator('[aria-current="step"]')).toContainText("材料扫描");
    await page.clock.runFor(2400);
    await expect(observatory.locator('[aria-current="step"]')).toContainText("立体星图");
    await expect(article.getByRole("heading", { name: radarItems[0].title })).toBeVisible();
    await page.clock.runFor(2500);
    await expect(observatory.locator('[aria-current="step"]')).toContainText("新闻流");
    await page.clock.runFor(2500);
    await expect(observatory.locator('[aria-current="step"]')).toContainText("焦点观察");
    await page.clock.runFor(1600);
    await expect(article.getByRole("heading", { name: radarItems[1].title })).toBeVisible();
    const river = page.getByRole("group", { name: "新闻日期与分类分布", exact: true });
    await river.getByRole("button", { name: radarLabel(radarItems[2]), exact: true }).click();
    await expect(page.getByRole("button", { name: "播放报道", exact: true })).toBeVisible();
    await page.clock.runFor(10_000);
    await expect(article.getByRole("heading", { name: radarItems[2].title })).toBeVisible();
    await expect(river.getByRole("button", { name: radarLabel(radarItems[2]), exact: true })).toHaveAttribute("aria-pressed", "true");
    assert.equal(new URL(page.url()).searchParams.get("item"), radarItems[2].id);
  } finally { await context.close(); }
});

test("overview queues newly public reports without interrupting a paused reader and removes unavailable reports", async () => {
  const saved = [...radarItems];
  const arrival: RadarItem = { ...radarItems[0], id: "radar-new-public", title: "新增公开保险报道", publishedAt: "2026-10-29T09:00:00Z" };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.clock.install();
    await visit(page, web.origin + "/overview");
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const article = page.getByRole("article", { name: "当前报道" });
    await page.getByRole("button", { name: "暂停回放", exact: true }).click();
    await expect(page.getByRole("button", { name: "播放报道", exact: true })).toBeVisible();
    radarItems.unshift(arrival);
    await page.clock.fastForward(30_100);
    await expect(page.getByRole("button", { name: "播放新增报道", exact: true })).toBeVisible();
    await expect(article.getByRole("heading", { name: saved[0].title })).toBeVisible();
    await page.getByRole("button", { name: "播放新增报道", exact: true }).click();
    await expect(article.getByRole("heading", { name: arrival.title })).toBeVisible();
    radarItems.splice(radarItems.findIndex(item => item.id === arrival.id), 1);
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(article.getByRole("heading", { name: saved[0].title })).toBeVisible();
    await expect(article.getByRole("heading", { name: arrival.title })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "新闻日期与分类分布", exact: true }).getByRole("button", { name: radarLabel(arrival), exact: true })).toHaveCount(0);
  } finally { radarItems.splice(0, radarItems.length, ...saved); await context.close(); }
});

test("overview repeats a single public report without reloading its data on each journey", async () => {
  const saved = [...radarItems];
  radarItems.splice(1);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.clock.install();
    await visit(page, web.origin + "/overview");
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await expect(page.getByRole("button", { name: "暂停回放", exact: true })).toBeVisible();
    const readsBeforeJourney = radarRequests.length;
    await page.clock.runFor(8800);
    await expect(page.getByRole("article", { name: "当前报道" }).getByRole("heading", { name: saved[0].title })).toBeVisible();
    await expect(page.getByRole("button", { name: "暂停回放", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "保险行业联动观测台", exact: true }).locator('[aria-current="step"]')).toContainText("材料扫描");
    assert.equal(radarRequests.length, readsBeforeJourney);
  } finally { radarItems.splice(0, radarItems.length, ...saved); await context.close(); }
});

test("overview respects reduced motion and keeps the observatory usable at 320 pixels", async () => {
  const context = await browser.newContext({ viewport: { width: 320, height: 760 }, reducedMotion: "reduce", isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await visit(page, web.origin + "/overview");
    await expect(page.getByRole("region", { name: "保险行业联动观测台", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "播放报道", exact: true })).toBeDisabled();
    const article = page.getByRole("article", { name: "当前报道" });
    const star = page.getByRole("group", { name: "信源、报道与标签关联星图", exact: true });
    await star.getByRole("button", { name: "查看来源 科技测试信源 的报道", exact: true }).click();
    await expect(article.getByRole("heading", { name: radarItems[1].title })).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } finally { await context.close(); }
});

test("radar points, range selection, filters and date windows stay coordinated and expose empty results", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await visit(page, web.origin + "/radar");
    const river = page.getByRole("group", { name: "新闻日期与分类分布", exact: true });
    const article = page.getByRole("article", { name: "当前报道" });
    const slider = page.getByRole("slider", { name: "按顺序选择报道" });
    const readsBeforeSelection = radarRequests.length;
    await river.getByRole("button", { name: radarLabel(radarItems[1]), exact: true }).click();
    await expect(article.getByRole("heading", { name: radarItems[1].title })).toBeVisible();
    await expect(slider).toHaveValue("1");
    await expect(page).toHaveURL(web.origin + "/radar?item=radar-tech");
    assert.equal(radarRequests.length, readsBeforeSelection);
    await article.getByRole("link", { name: "查看报道", exact: true }).click();
    await expect(page).toHaveURL(web.origin + "/items/radar-tech");
    await expect(page.getByRole("heading", { name: radarItems[1].title, exact: true })).toBeVisible();
    await page.goBack();
    await expect(article.getByRole("heading", { name: radarItems[1].title })).toBeVisible();
    await expect(slider).toHaveValue("1");
    await slider.press("End");
    await expect(article.getByRole("heading", { name: radarItems[2].title })).toBeVisible();
    await expect(river.getByRole("button", { name: radarLabel(radarItems[2]), exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("筛选新闻分类").selectOption("insurtech");
    await page.getByLabel("搜索雷达报道").fill("科技测试信源");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(river.getByRole("button")).toHaveCount(1);
    await expect(article.getByRole("heading", { name: radarItems[1].title })).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get("category"), "insurtech");
    await page.getByLabel("搜索雷达报道").fill("不存在的测试报道");
    await page.getByRole("button", { name: "筛选", exact: true }).click();
    await expect(page.getByText("当前范围没有可展示的报道。", { exact: true })).toBeVisible();
    await expect(page.getByText("当前范围没有带发布日期的公开报道。", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "清除筛选", exact: true }).click();
    await expect(river.getByRole("button")).toHaveCount(3);
    await page.getByRole("button", { name: "近 30 天", exact: true }).click();
    await expect(page.getByRole("button", { name: "近 30 天", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(river.getByRole("button")).toHaveCount(2);
    await page.getByRole("button", { name: "全部日期", exact: true }).click();
    await expect(river.getByRole("button")).toHaveCount(3);
    assert.ok(radarRequests.some(query => query === "?days=30"));
    assert.ok(radarRequests.some(query => query === "?days=all"));
  } finally { await context.close(); }
});

test("phone readers reach both modules from My tools and retain the four existing bottom tabs and return path", async () => {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    for (const name of ["总览", "新闻雷达"]) {
      await visit(page, web.origin + "/more");
      await page.getByRole("link", { name, exact: true }).click();
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      const tabs = page.getByRole("navigation", { name: "底部导航" });
      assert.deepEqual(await tabs.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href"))), ["/", "/hot", "/daily", "/more"]);
      await expect(tabs.getByRole("link", { name: /^我的/ })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("article", { name: "当前报道" }).getByRole("heading", { name: radarItems[0].title })).toBeVisible();
      await page.getByRole("button", { name: "我的", exact: true }).click();
      await expect(page).toHaveURL(web.origin + "/more");
    }
  } finally { await context.close(); }
});

test("overlapping report points select the nearest centre instead of the active point above it", async () => {
  const saved = radarItems.slice(0, 2).map(item => ({ ...item }));
  Object.assign(radarItems[0], { id: "near-a", category: "regulation", publishedAt: "2026-10-29T08:00:00Z" });
  Object.assign(radarItems[1], { id: "near-b", category: "regulation", publishedAt: "2026-10-29T07:59:59Z" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await visit(page, web.origin + "/radar?item=near-a");
    const river = page.getByRole("group", { name: "新闻日期与分类分布", exact: true });
    const target = river.getByRole("button", { name: radarLabel(radarItems[1]), exact: true });
    // Click the report centre even when the active report is the native SVG event target.
    const position = await target.boundingBox(); assert.ok(position);
    await page.mouse.click(position.x + position.width / 2, position.y + position.height / 2);
    await expect(page.getByRole("article", { name: "当前报道" }).getByRole("heading", { name: radarItems[1].title })).toBeVisible();
    await expect(target).toHaveAttribute("aria-pressed", "true");
  } finally { Object.assign(radarItems[0], saved[0]); Object.assign(radarItems[1], saved[1]); await context.close(); }
});
