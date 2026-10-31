import { useMemo } from "react";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import type { RadarResponse } from "@aihot/contracts/radar";
import { CATEGORY_KEYS, CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import type { Screen } from "@aihot/web/components/shell/screens";
import { Select, buttonClass } from "@aihot/web/components/ui/Controls";
import { NewsRiver } from "./radar-visuals.tsx";
import { RadarArticle, RadarHeader, RadarScope, useRadarSelection } from "./radar-shared.tsx";

export const handle: Screen = { tab: "me", name: "新闻雷达" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";
export { radarShouldRevalidate as shouldRevalidate } from "./radar-shared.tsx";

export async function loader({ request }: { request: Request }) {
  const value = new URL(request.url).searchParams.get("days");
  const days = value === "all" || value === "30" ? value : "90";
  const radar = await apiGet<RadarResponse>(`/api/site/insurance/radar?days=${days}`, { signal: request.signal });
  return cachedPage(0, { radar });
}

export function meta() {
  return pageMeta({ title: "新闻雷达", description: "按发布日期和现有分类浏览保险新闻，选择报道查看内容。", path: "/radar" });
}

export default function InsuranceRadar() {
  const { radar } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const category = params.get("category") ?? "";
  const query = params.get("q")?.trim().slice(0, 160) ?? "";
  const items = useMemo(() => radar.items.filter(item => (!category || (category === "uncategorized" ? !item.category : item.category === category))
    && (!query || `${item.title} ${item.summary ?? ""} ${item.source.name} ${item.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()))), [radar.items, category, query]);
  const selection = useRadarSelection(items, params.get("item"));
  const activeId = selection.active?.id ?? null;
  const days = radar.days === null ? "all" : String(radar.days);
  const setWindow = (value: string) => { const next = new URLSearchParams(params); next.set("days", value); next.delete("item"); setParams(next); };
  return <div className="pb-8">
    <RadarHeader title="新闻雷达" description="沿发布日期展开报道，在分类主题带中查看具体变化。" active="radar" query={activeId ? `?item=${encodeURIComponent(activeId)}` : ""} />
    <section aria-label="雷达筛选" className="rounded-card border border-line bg-surface p-4 lg:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" aria-label="日期范围">{([["90", "近 90 天"], ["30", "近 30 天"], ["all", "全部日期"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={days === value} onClick={() => setWindow(value)} className={`${buttonClass(days === value ? "primary" : "secondary")} whitespace-nowrap`}>{label}</button>)}</div>
        {selection.controls}
      </div>
      <Form method="get" key={`${days}:${category}:${query}`} className="mt-4 flex flex-wrap gap-2">
        <input type="hidden" name="days" value={days} />
        <Select name="category" aria-label="筛选新闻分类" defaultValue={category} className="max-w-full"><option value="">全部分类</option>{CATEGORY_KEYS.map(key => <option key={key} value={key}>{CATEGORY_LABELS[key]}</option>)}<option value="uncategorized">未分类</option></Select>
        <input name="q" aria-label="搜索雷达报道" defaultValue={query} maxLength={160} placeholder="搜索标题、摘要、来源或标签" className="h-11 min-w-0 flex-1 basis-48 rounded-full border border-line-strong bg-surface px-4 text-[14px] text-ink outline-none focus:border-accent lg:h-9" />
        <button type="submit" className={buttonClass("primary")}>筛选</button>
        {(category || query) && <Link to={`/radar?days=${days}`} className={buttonClass()}>清除筛选</Link>}
      </Form>
      <RadarScope data={radar} shown={items.length} />
      {radar.truncated && <p className="mb-3 text-[12px] leading-relaxed text-ink-3">分类和关键词筛选仅覆盖图中的最近 {radar.limit} 条报道。<Link to={`/all?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(CATEGORY_KEYS.some(key => key === category) ? { category } : {}) })}`} className="ml-1 text-accent">在全部动态中继续搜索</Link></p>}
      <NewsRiver items={items} activeId={activeId} onSelect={selection.select} />
      {items.length > 0 && <label className="mt-4 flex items-center gap-3 text-[12px] text-ink-4">选择报道<input aria-label="按顺序选择报道" type="range" min={0} max={items.length - 1} value={selection.index} onChange={event => selection.select(items[Number(event.target.value)]!.id)} className="min-w-0 flex-1 accent-accent" /><span className="num">{selection.index + 1} / {items.length}</span></label>}
    </section>
    <div className="mt-5 grid items-start gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <RadarArticle item={selection.active} compact />
      <section aria-label="相邻报道" className="min-w-0 rounded-card border border-line bg-surface p-4 lg:p-5">
        <h2 className="mb-3 text-[14px] font-semibold text-ink">相邻报道</h2>
        {items.length > 0 ? <div className="max-h-80 space-y-1 overflow-y-auto">{items.slice(Math.max(0, selection.index - 2), Math.max(0, selection.index - 2) + 6).map(item => <button key={item.id} type="button" aria-pressed={activeId === item.id} onClick={() => selection.select(item.id)} className={`block w-full rounded-control p-2 text-left ${activeId === item.id ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-well"}`}><span className="block text-[11px] text-ink-4">{beijingDate(item.publishedAt)} · {item.source.name}</span><span className="mt-1 block break-words text-[13px] leading-relaxed">{item.title}</span></button>)}</div> : <p className="text-[13px] text-ink-4">可调整日期范围或清除筛选。</p>}
      </section>
    </div>
  </div>;
}
