import { Form, Link, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "react-router";
import type { CollectionPage, CollectionView, CollectedItem } from "@aihot/contracts/collection";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { Pagination } from "@aihot/web/features/feed/DayList";
import { Select, buttonClass } from "@aihot/web/components/ui/Controls";
import { IconArrowRight } from "@aihot/web/components/icons";

export const handle: Screen = { tab: "me", name: "资料库" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";

export async function loader({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  const view = params.get("view") ?? "";
  if (["pending", "review", "excluded", "sources"].includes(view)) query.set("view", view);
  for (const [key, limit] of [["q", 160], ["source", 80]] as const) if (params.get(key)?.trim()) query.set(key, params.get(key)!.trim().slice(0, limit));
  const page = Math.min(1000, Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1));
  if (page > 1) query.set("page", String(page));
  const response = await apiGet<CollectionPage>(`/api/site/insurance/library?${query}`, { signal: request.signal });
  return cachedPage(0, { response });
}

export function meta() {
  return pageMeta({ title: "保险资料库", description: "浏览已初筛的保险相关资料、待筛材料和信源接入进度。", path: "/library", noindex: true });
}

const views: Array<{ key: CollectionView | "sources"; name: string }> = [
  { key: "related", name: "相关资料" }, { key: "pending", name: "待筛材料" },
  { key: "review", name: "待复核" }, { key: "excluded", name: "初筛排除" }, { key: "sources", name: "信源进度" },
];

function href(params: URLSearchParams, changes: Record<string, string | number | null>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) if (value === null || value === "") next.delete(key); else next.set(key, String(value));
  return `/library${next.size ? "?" + next : ""}`;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="min-w-0"><p className="text-[12px] text-ink-4">{label}</p><p className="num mt-1 text-[26px] font-bold leading-tight text-ink lg:text-[30px]">{value.toLocaleString("en-US")}</p></div>;
}

function DateLabel({ item }: { item: CollectedItem }) {
  return <time dateTime={item.publicationTime ?? item.publishedAt}>{beijingDate(item.publishedAt)}{item.publicationTime?.includes("T") ? ` ${beijingTime(item.publishedAt)}` : ""}</time>;
}

export default function InsuranceLibrary() {
  const { response } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const sources = response.kind === "sources";
  const view = sources ? "sources" : response.data.view;
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const data = response.data;
  return <div className="pb-8">
    <PhoneBar back={{ to: "/more", label: "我的" }} title="保险资料库" large />
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0"><h1 className="hidden text-[24px] font-semibold leading-tight text-ink lg:block">保险资料库</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3">跟踪保险信源，浏览原始材料与相关性初筛结果。</p></div>
      <button type="button" onClick={() => revalidator.revalidate()} disabled={busy} className={`${buttonClass()} shrink-0 whitespace-nowrap`}>刷新</button>
    </div>

    <section aria-label="资料概况" className="my-5 grid grid-cols-2 gap-x-6 gap-y-4 rounded-card border border-line bg-surface p-4 lg:grid-cols-4 lg:p-5">
      {response.kind === "materials" ? <>
        <Metric label="可浏览资料" value={response.data.totalCollected} /><Metric label="当前相关资料" value={response.data.counts.related} />
        <Metric label="当前待筛材料" value={response.data.counts.pending} /><Metric label="启用采集渠道" value={response.data.enabledSources} />
      </> : <>
        <Metric label="清单入口" value={response.data.inventoryTotal} /><Metric label="已关联采集渠道的入口" value={response.data.connectedEntries} />
        <Metric label="启用采集渠道" value={response.data.enabledChannels} /><Metric label="公众号待授权" value={response.data.awaitingAuthorization} />
      </>}
    </section>

    <nav aria-label="资料视图" className="mb-4 flex flex-wrap gap-1.5">
      {views.map(tab => <Link key={tab.key} to={href(params, { view: tab.key === "related" ? null : tab.key, page: null, ...(tab.key === "sources" ? { source: null } : {}) })}
        aria-current={view === tab.key ? "page" : undefined}
        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors lg:min-h-9 ${view === tab.key ? "border-accent/30 bg-accent-soft font-semibold text-accent" : "border-line bg-surface text-ink-3 hover:text-ink"}`}>
        {tab.name}{response.kind === "materials" && tab.key !== "sources" && <span className="num text-[11px] opacity-75">{response.data.counts[tab.key]}</span>}
      </Link>)}
    </nav>

    <Form method="get" action="/library" key={`${view}:${data.query}:${response.kind === "materials" ? response.data.source : ""}`} className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 lg:flex lg:flex-wrap">
      {view !== "related" && <input type="hidden" name="view" value={view} />}
      <input aria-label={sources ? "搜索信源" : "搜索资料"} name="q" defaultValue={data.query} maxLength={160}
        placeholder={sources ? "搜索机构、地区或域名" : "搜索原文标题或来源"}
        className={`${response.kind === "materials" ? "col-span-2" : ""} h-11 min-w-0 flex-1 rounded-full border border-line-strong bg-surface px-4 text-[15px] text-ink outline-none focus:border-accent lg:h-9 lg:text-[13px]`} />
      {response.kind === "materials" && <Select aria-label="筛选来源" name="source" defaultValue={response.data.source} className="min-w-0 max-w-full lg:w-[240px]">
        <option value="">全部来源</option>{response.data.sources.map(source => <option key={source.id} value={source.id}>{source.name} · {source.count}</option>)}
      </Select>}
      <button type="submit" className={buttonClass("primary")}>查询</button>
      {(data.query || response.kind === "materials" && response.data.source) && <Link className={`${buttonClass()} col-span-2 justify-self-start`} to={href(params, { q: null, source: null, page: null })}>清除筛选</Link>}
    </Form>

    <p className="mb-4 text-[12px] leading-relaxed text-ink-4" aria-live="polite">
      {busy ? "正在读取最新资料…" : `共 ${data.total.toLocaleString("en-US")} ${sources ? "个入口" : "条"} · 第 ${data.page} / ${data.pageCount} 页`}
      {response.kind === "materials" && response.data.latestCollectionAt && <span className="ml-2">信源最近采集 {beijingDate(response.data.latestCollectionAt)} {beijingTime(response.data.latestCollectionAt)}</span>}
    </p>
    <p className="mb-5 text-[12.5px] leading-relaxed text-ink-3">{sources
      ? "主页、栏目和历史档案的覆盖范围分别核验。关联到一个采集渠道，并不表示该站全部历史内容已经接齐。"
      : view === "related" ? "这里包含已加工内容和通过保险相关性初筛的原始资料。初筛相关不代表事实已核实，外文资料保留原文标题。"
        : view === "pending" ? "这些材料尚未完成保险相关性判断，包含综合监管与财经信源内容。" : view === "excluded" ? "这些材料被当前版本的筛选判为无关，原始记录仍保留，便于复核漏筛。"
          : "材料不足、判断不明或正文版本发生变化的记录需要重新核对。"}</p>

    {response.kind === "materials" ? <div className="space-y-3">
      {response.data.items.map(item => <article key={item.id} className="rounded-card border border-line bg-surface px-4 py-4 lg:px-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-relaxed text-ink-4">
          <Link className="min-w-0 break-words hover:text-accent" to={href(params, { source: item.source.id, page: null })}>{item.source.name}</Link>
          <span aria-hidden="true">·</span><DateLabel item={item} />
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] ${item.state === "related" ? "bg-accent-soft text-accent" : "bg-well text-ink-3"}`}>{item.processed ? "已加工" : item.state === "related" ? "初筛相关" : item.state === "review" ? "待复核" : item.state === "excluded" ? "初筛排除" : "待筛"}</span>
        </div>
        <h2 className="mt-2 break-words text-[17px] font-semibold leading-relaxed text-ink"><a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{item.title}</a></h2>
        {item.excerpt && <p className="mt-2 break-words text-[14px] leading-[1.8] text-ink-3">{item.excerptKind === "source" && <span className="mr-1 text-[12px] text-ink-4">来源摘录</span>}{item.excerpt}</p>}
        {item.screeningReason && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-4">初筛依据 · {item.screeningReason}</p>}
        {item.reviewNote && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">复核提醒 · {item.reviewNote}</p>}
        <div className="mt-3 flex items-center justify-end gap-4 text-[12.5px]">
          {item.processed && <Link to={`/items/${item.id}`} className="text-ink-3 hover:text-accent">站内阅读</Link>}
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent">阅读原文 <IconArrowRight size={13} /></a>
        </div>
      </article>)}
    </div> : <div className="space-y-3">
      {response.data.entries.map(entry => <article key={entry.id} className="rounded-card border border-line bg-surface p-4 lg:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="min-w-0 flex-1 break-words text-[15px] font-semibold leading-relaxed text-ink">{entry.name}</h2>
          <span className={`rounded-full px-2 py-1 text-[11px] ${entry.state === "channel-connected" ? "bg-accent-soft text-accent" : "bg-well text-ink-3"}`}>{entry.state === "channel-connected" ? "已关联栏目" : entry.state === "awaiting-authorization" ? "待授权" : "待接入"}</span></div>
        {entry.channels.map((channel, index) => <p key={index} className="mt-2 break-words text-[12.5px] leading-relaxed text-ink-3">{channel.name} · {channel.enabled ? "已启用" : "已暂停"} · {({ running: "历史回补中", exhausted: "栏目分页已读至边界", limited: "历史覆盖有限", failed: "最近回补未成功", "not-started": "历史尚未开始" })[channel.history]}{channel.lastCollectedAt ? ` · 最近成功采集 ${beijingDate(channel.lastCollectedAt)}` : ""}</p>)}
        {entry.url && <a href={entry.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12px] text-accent">访问来源 <IconArrowRight size={13} /></a>}
      </article>)}
    </div>}
    {data.total === 0 && <p className="py-16 text-center text-[14px] text-ink-4">当前筛选下没有资料，可清除筛选后重试。</p>}
    <Pagination page={data.page} pageCount={data.pageCount} href={page => href(params, { page: page > 1 ? page : null })} />
  </div>;
}
