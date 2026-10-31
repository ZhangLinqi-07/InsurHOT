import { Link, useLoaderData, useSearchParams } from "react-router";
import type { RadarResponse } from "@aihot/contracts/radar";
import type { SiteStats } from "@aihot/contracts/site";
import { CATEGORY_KEYS, CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import type { Screen } from "@aihot/web/components/shell/screens";
import { IconChevronLeft, IconChevronRight } from "@aihot/web/components/icons";
import { Select, buttonClass } from "@aihot/web/components/ui/Controls";
import { NewsRiver } from "./radar-visuals.tsx";
import { RadarArticle, RadarHeader, RadarScope } from "./radar-shared.tsx";
import { OverviewOrbits } from "./overview-orbits.tsx";
import { useOverviewPlayback } from "./overview-playback.ts";
import "./overview.css";

export const handle: Screen = { tab: "me", name: "总览" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";
export { radarShouldRevalidate as shouldRevalidate } from "./radar-shared.tsx";

export async function loader({ request }: { request: Request }) {
  const [radar, stats] = await Promise.all([
    apiGet<RadarResponse>("/api/site/insurance/radar?days=90", { signal: request.signal }),
    apiGet<SiteStats>("/api/site/stats", { signal: request.signal }),
  ]);
  return cachedPage(0, { radar, stats });
}

export function meta() {
  return pageMeta({ title: "总览", description: "浏览保险动态概况，联动查看信源、报道与主题。", path: "/overview" });
}

export default function InsuranceOverview() {
  const { radar, stats } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const selection = useOverviewPlayback(radar.items, params.get("item"));
  const activeId = selection.active?.id ?? null;
  const active = selection.active;
  const phases = ["材料扫描", "立体星图", "新闻流", "焦点观察"];
  const queue = [...radar.items.slice(selection.index + 1), ...radar.items.slice(0, selection.index)].slice(0, 3);
  const spectrum = CATEGORY_KEYS.map(key => ({ key, count: radar.items.filter(item => item.category === key).length }));
  const largest = Math.max(1, ...spectrum.map(entry => entry.count));
  const related = active ? radar.items.filter(item => item.id !== active.id && item.category === active.category).slice(0, 3) : [];
  return <div className="overview-page pb-8">
    <RadarHeader title="总览" description="从可信来源读懂保险行业的变化，联动查看报道与主题。" active="overview" query={activeId ? `?item=${encodeURIComponent(activeId)}` : ""} />
    <section aria-label="站点概况" className="overview-metrics">
      {([["启用信源", stats.sources], ["收录动态", stats.items], ["精选报道", stats.selected], ["已出日报", stats.dailies]] as const).map(([label, value]) => <div key={label}><p className="text-[12px] text-ink-4">{label}</p><p className="num mt-1 text-[28px] font-bold leading-tight text-ink">{value.toLocaleString("en-US")}</p></div>)}
    </section>
    <section ref={selection.root} aria-label="保险行业联动观测台" className="overview-observatory" data-running={selection.running} data-phase={selection.phase} data-reduced={selection.reduced}>
      <div className="overview-instrument">
        <h2 className="overview-instrument-title"><span className="overview-diamond" />保险行业观测台</h2>
        <div className="overview-sequence" aria-label="新闻联动阶段">{phases.map((label, index) => <span key={label} aria-current={selection.phase === index ? "step" : undefined}><small className="num">{String(index + 1).padStart(2, "0")}</small>{label}</span>)}</div>
        <span className="overview-live"><i />公开报道联动</span>
      </div>
      <div className="overview-transport" aria-label="报道回放">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button type="button" className={buttonClass()} aria-label="上一篇报道" disabled={radar.items.length < 2} onClick={() => selection.step(-1)}><IconChevronLeft size={14} /></button>
          <button type="button" className={buttonClass()} disabled={!active || selection.reduced} onClick={selection.toggle}>{selection.playing ? "暂停回放" : "播放报道"}</button>
          <button type="button" className={buttonClass()} aria-label="下一篇报道" disabled={radar.items.length < 2} onClick={() => selection.step(1)}><IconChevronRight size={14} /></button>
          <Select aria-label="回放速度" value={selection.speed} onChange={event => selection.setSpeed(event.target.value)}><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></Select>
          <span className="num text-[11px] text-ink-4">{active ? selection.index + 1 : 0} / {radar.items.length}</span>
        </div>
        <p className="overview-update" role="status">{selection.pending.length ? <><span>新增 {selection.pending.length} 条公开报道</span><button type="button" onClick={selection.playNew}>播放新增报道</button></> : <>每 30 秒更新<span className="num">{beijingTime(radar.to)}</span></>}</p>
      </div>
      {selection.reduced && <p className="px-4 py-2 text-[12px] text-ink-4">已按减少动态效果设置关闭回放</p>}
      <div className="overview-focus-strip" aria-label="当前新闻的同步关联">
        <span className="overview-route-label">当前联动</span><span className="overview-source-label">{active?.source.name ?? "等待公开报道"}</span><span aria-hidden="true">→</span><span className="overview-focus-title">{active?.title ?? "有公开内容后开始呈现"}</span><span aria-hidden="true">→</span><span className="overview-category-label">{active?.category ? CATEGORY_LABELS[active.category] : "未分类"}</span>
      </div>
      <div className="overview-deck">
        <section className="overview-scan" aria-label="报道扫描">
          <div className="overview-panel-label"><h3><span className="num">01</span>材料扫描</h3><span>READ THE SIGNAL</span></div>
          <div className="overview-paper-stage" onMouseEnter={() => selection.hold("card-hover", true)} onMouseLeave={() => selection.hold("card-hover", false)} onFocusCapture={() => selection.hold("card-focus", true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) selection.hold("card-focus", false); }}>
            <div key={activeId} className="overview-scan-paper"><RadarArticle item={active} /><div className="overview-scan-beam" aria-hidden="true" /></div>
          </div>
          <div className="overview-scan-caption"><span className="num">{String(active ? selection.index + 1 : 0).padStart(3, "0")} / {String(radar.items.length).padStart(3, "0")}</span><span>{selection.playing ? phases[selection.phase] : "已定位当前报道"}</span></div>
          <div className="overview-progress" aria-hidden="true"><i /></div>
          <div className="overview-queue-heading">接下来<span>点击报道可暂停并定位</span></div>
          <div className="overview-queue">{queue.map(item => <button key={item.id} type="button" onClick={() => selection.select(item.id)}><span className="overview-queue-dot" /><span className="min-w-0"><span className="block truncate text-[11px] text-ink-4">{item.source.name}</span><span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed text-ink-2">{item.title}</span></span><IconChevronRight size={12} className="shrink-0 text-ink-4" /></button>)}</div>
        </section>
        <section className="overview-sky" aria-label="立体关联星图">
          <div className="overview-panel-label"><h3><span className="num">02</span>立体星图</h3><span>信源 · 报道 · 分类</span></div>
          <OverviewOrbits items={radar.items} activeId={activeId} onSelect={selection.select} clock={selection.clock} running={selection.running} reduced={selection.reduced} onHold={held => selection.hold("orbit-drag", held)} />
          <div className="overview-arrival"><span className="overview-arrival-dot" /><span>{active ? active.source.name : "等待信源"}</span><span aria-hidden="true">→</span><b>{active?.category ? CATEGORY_LABELS[active.category] : "未分类"}</b><span className="overview-arrival-state">{selection.phase >= 2 ? "已定位新闻流" : "关联当前报道"}</span></div>
        </section>
        <div className="overview-transfer" aria-hidden="true"><i /><span>汇入星图</span></div>
      </div>
      <section className="overview-spectrum" aria-label="保险业务频谱">
        <div className="overview-section-heading"><div><span>BUSINESS SPECTRUM</span><h3>保险业务频谱</h3></div><p>当前窗口的 {radar.items.length} 条报道<span>随当前报道点亮分类</span></p></div>
        <div className="overview-spectrum-bars">{spectrum.map(({ key, count }) => <button key={key} type="button" aria-label={`${CATEGORY_LABELS[key]} ${count} 条报道`} aria-pressed={active?.category === key} disabled={!count} onClick={() => { const item = radar.items.find(item => item.category === key); if (item) selection.select(item.id); }}><span className="num overview-spectrum-count">{count}</span><span className="overview-spectrum-track"><i style={{ height: `${count ? Math.max(6, count / largest * 100) : 0}%` }} /></span><span className="overview-spectrum-name">{CATEGORY_LABELS[key]}</span></button>)}</div>
        <p className="mt-3 text-[10px] leading-relaxed text-ink-4">分类来自已公开的报道记录，频谱统计覆盖当前日期窗口内的展示数据。{radar.items.some(item => !item.category) ? `另有 ${radar.items.filter(item => !item.category).length} 条尚未分类。` : ""}</p>
      </section>
      <section aria-label="新闻流" className="overview-river">
        <div className="overview-section-heading"><div><span>03 / NEWS RIVER</span><h2>新闻流</h2></div><Link className="text-[12px] font-medium text-accent" to={`/radar${activeId ? `?item=${encodeURIComponent(activeId)}` : ""}`}>打开新闻雷达</Link></div>
        <RadarScope data={radar} />
        {radar.truncated && <p className="mb-3 text-[12px] text-ink-4">图表与频谱仅覆盖最近 {radar.limit} 条。<Link to="/all" className="ml-1 text-accent">查看全部动态</Link></p>}
        <NewsRiver items={radar.items} activeId={activeId} onSelect={selection.select} flowing={selection.running} />
        <div className="overview-linked-story"><span className="overview-linked-marker" /><div className="min-w-0"><p className="text-[10px] text-ink-4">当前报道落点 {active ? `· ${beijingDate(active.publishedAt)}` : ""}</p><p className="mt-1 break-words text-[13px] font-medium leading-relaxed text-ink-2">{active?.title ?? "等待公开报道"}</p></div>{active && <Link to={`/items/${active.id}`} className="shrink-0 text-[12px] text-accent">阅读 ↗</Link>}</div>
        {active && <label className="mt-4 flex items-center gap-3 text-[12px] text-ink-4">选择报道<input aria-label="按顺序选择报道" type="range" min={0} max={Math.max(0, radar.items.length - 1)} value={selection.index} onChange={event => { const item = radar.items[Number(event.target.value)]; if (item) selection.select(item.id); }} className="min-w-0 flex-1 accent-accent" /><span className="num">{selection.index + 1} / {radar.items.length}</span></label>}
      </section>
      <section className="overview-focus" aria-label="焦点观察">
        <div className="overview-section-heading"><div><span>04 / IN FOCUS</span><h2>焦点观察</h2></div><p>一条报道，看见同类信息</p></div>
        <div className="overview-focus-grid"><div className="min-w-0"><p className="text-[11px] text-accent">{active?.category ? CATEGORY_LABELS[active.category] : "当前报道"}</p><h3 className="mt-2 break-words text-[19px] font-semibold leading-relaxed text-ink">{active?.title ?? "有公开报道后呈现焦点"}</h3><p className="mt-2 text-[12px] text-ink-4">{active ? `${beijingDate(active.publishedAt)} · ${active.source.name}` : ""}</p>{active?.summary && <p className="mt-3 line-clamp-3 text-[13px] leading-[1.8] text-ink-3">{active.summary}</p>}</div><div className="overview-related"><p className="mb-2 text-[11px] text-ink-4">同类报道</p>{related.length ? related.map(item => <button key={item.id} type="button" onClick={() => selection.select(item.id)}><span>{item.title}</span><small>{item.source.name}</small></button>) : <p className="py-4 text-[12px] text-ink-4">当前窗口暂无其他同类报道。</p>}</div></div>
      </section>
      <p className="overview-footnote">动画联动展示已公开的报道与现有分类 · 新公开的内容优先进入回放 · 保留原始发布日期与出处</p>
    </section>
  </div>;
}
