import { useEffect } from "react";
import { Form, Link, redirect, useLoaderData, useNavigation, useSearchParams } from "react-router";
import type { Route } from "./+types/all";
import type { PoolResponse } from "@aihot/contracts/site";
import { SITE, subjectAfter } from "@aihot/site";
import { beijingTime } from "@aihot/contracts/time";
import { cachedPage, loadOr404 } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { filterParams, hasFeedFilters, itemListLd, listPath, pageMeta, readFilters } from "../lib/seo";
import { ActiveFilters, CategoryTabs, FeedBar, MarketTabs, SearchField } from "../features/feed/Filters";
import { PillTabs } from "../components/ui/Tabs";
import { DayList, Pagination } from "../features/feed/DayList";
import { EmptyState } from "../components/ui/Page";
import { IconSearch } from "../components/icons";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import { buttonClass } from "../components/ui/Controls";
import { isPhone, type Screen } from "../components/shell/screens";
import { openSearch } from "../features/search/SearchOverlay";
import { addRecentSearch } from "../lib/local-state";

export const handle: Screen = { tab: "featured", name: "全部" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

const ALL_TITLE = subjectAfter("全部", "动态");

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim().slice(0, 200) || null;
  const tab = url.searchParams.get("tab") === "relevance" ? "relevance" : null;
  // Older deep-paging parameters (deep, anchorAt) still open a normal page.
  const rawPage = url.searchParams.get("page") ?? "1";
  const requestedPage = /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
  const data = await loadOr404<PoolResponse>(
    listPath("/api/site/pool", { ...filterParams(readFilters(url.searchParams)), q, tab, page: page > 1 ? page : null }),
    // The busy page keeps the search, so it can be tried again as it was.
    { signal: request.signal, busyRedirect: `/all/search-busy${url.search}` },
  );
  // Past the last page of what there is: the last page, with the same search and filters.
  if (data.page !== page) throw redirect(pageHref(url.searchParams, data.page));
  return cachedPage(60, { data });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.data.filters;
  const q = f?.q;
  const page = loaderData?.data.page ?? 1;
  const path = listPath("/all", { ...(f && filterParams(f)), q, tab: q && f?.tab === "relevance" ? "relevance" : null, page: page > 1 ? page : null });
  const title = `${q ? `搜索：${q}` : ALL_TITLE}${page > 1 ? ` · 第 ${page} 页` : ""}`;
  const noindex = !!q || hasFeedFilters(f);
  return pageMeta({
    title,
    description: `${SITE.name} 收录的${subjectAfter("全部", "相关动态")}，可按市场、频道、类别与标签筛选，支持中英文搜索。`,
    path,
    noindex,
    jsonLd: noindex ? undefined : itemListLd(path, title, loaderData?.data.items.map((i) => i.title) ?? []),
  });
}

function pageHref(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  sp.delete("deep");
  sp.delete("anchorAt");
  sp.delete("search");
  if (page <= 1) sp.delete("page");
  else sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/all?${s}` : "/all";
}

export default function AllPage() {
  const { data } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const f = data.filters;
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/all";
  const keep = filterParams(f);
  const searchTabHref = (tab: "time" | "relevance") => {
    const sp = new URLSearchParams(params);
    sp.delete("page");
    if (tab === "relevance") sp.set("tab", "relevance");
    else sp.delete("tab");
    return `/all?${sp}`;
  };
  const title = f.q ? `搜索“${f.q}”` : f.tag ? `#${f.tag}` : null;
  const updated = beijingTime(data.freshness);
  // Searches are remembered in this browser for the phone search (listed in the privacy notice).
  useEffect(() => {
    if (f.q) addRecentSearch(f.q);
  }, [f.q]);
  // Older phone links (/all?search=1) opened the search field; they open the search now.
  useEffect(() => {
    if (params.get("search") === "1" && isPhone()) openSearch(f.q ?? "");
  }, []);

  return (
    <div className="pb-6">
      {/* Phones: the feed bar, or for a search the query (tap to change it) and back to 全部. */}
      {f.q ? (
        <PhoneBar
          back={{ to: listPath("/all", filterParams(f)), label: "全部" }}
          center={
            <button type="button" onClick={(event) => openSearch(f.q ?? "", event.currentTarget)} className="flex h-11 min-w-0 max-w-full items-center gap-2 rounded-full bg-well px-3.5 text-[15px] text-ink ring-1 ring-inset ring-line-soft">
              <IconSearch size={16} className="shrink-0 text-ink-4" />
              <span className="truncate">{f.q}</span>
            </button>
          }
        />
      ) : (
        <FeedBar base="/all" category={f.category} channel={f.channel} />
      )}
      <ActiveFilters base="/all" category={f.category} channel={f.channel} tag={f.tag} />

      {/* Desktop, as on 精选: the title, then one filter row with the search field aligned on the right. */}
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title ?? ALL_TITLE}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base="/all" category={f.category} channel={f.channel} layoutId="all-cat-desk" className="min-w-0" />
          <SearchField defaultValue={f.q ?? ""} keep={keep} />
        </div>
      </div>

      <MarketTabs base="/all" market={f.market} className="mb-4 mt-1" />

      {f.q && (
        <div className="mb-3 mt-1 flex flex-wrap items-center justify-between gap-2 lg:mt-0">
          <PillTabs
            size="xs"
            layoutId="all-search-sort"
            label="搜索排序"
            active={f.tab}
            items={(["time", "relevance"] as const).map((t) => ({ key: t, label: t === "time" ? "按时间（搜标题和摘要）" : "按相关度（含正文）", to: searchTabHref(t) }))}
          />
        </div>
      )}

      <section aria-label="动态列表概况" className="mb-4 space-y-2 text-[12px] leading-relaxed text-ink-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p>{f.q ? "找到" : "共"} <span className="num">{data.total}</span> 条 · 本页 <span className="num">{data.items.length}</span> 条 · 更新于 <span className="num">{updated}</span></p>
          {(hasFeedFilters(f) || f.q) && <Link to="/all" className="inline-flex min-h-11 items-center text-accent lg:min-h-8">清除全部筛选</Link>}
        </div>
        {data.pageCount > 1 && <div className="flex flex-wrap items-center justify-between gap-2">
          <Form method="get" action="/all" className="flex min-w-0 items-center gap-2">
            {Object.entries({ ...keep, q: f.q, tab: f.q ? f.tab : null }).map(([key, value]) => value
              ? <input key={key} type="hidden" name={key} value={value} /> : null)}
            <label className="flex items-center gap-2">第
              <input key={`${data.page}:${params}`} aria-label="跳转页码" name="page" type="number" inputMode="numeric" min={1} max={data.pageCount} defaultValue={data.page}
                className="num h-11 w-[76px] rounded-control border border-line-strong bg-surface px-2 text-center text-[14px] text-ink lg:h-9" />
              / <span className="num">{data.pageCount}</span> 页
            </label>
            <button type="submit" className={buttonClass()}>跳转</button>
          </Form>
          {data.page < data.pageCount && <IntentLink to={pageHref(params, data.page + 1)} aria-label="查看下一页" className={`${buttonClass()} shrink-0`}>下一页</IntentLink>}
        </div>}
      </section>

      <div className={`transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <div className="mt-2 lg:card">
            <EmptyState
              title="没有找到相关内容"
              action={
                f.q && f.tab === "time" ? (
                  <Link to={searchTabHref("relevance")} className="text-[13px] font-medium text-accent hover:underline">
                    试试“按相关度”，连正文一起搜
                  </Link>
                ) : undefined
              }
            >
              {f.q ? "换个说法，或者去掉筛选再试。" : "这个筛选下暂时没有内容。"}
            </EmptyState>
          </div>
        ) : (
          <DayList items={data.items} todayCount={f.q ? null : data.todayCount} />
        )}
      </div>
      <Pagination page={data.page} pageCount={data.pageCount} href={(p) => pageHref(params, p)} />
    </div>
  );
}
