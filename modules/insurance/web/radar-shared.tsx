import { useEffect, useState } from "react";
import { Link, useRevalidator, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";
import type { RadarItem, RadarResponse } from "@aihot/contracts/radar";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { IconArrowRight, IconChevronLeft, IconChevronRight } from "@aihot/web/components/icons";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import { buttonClass, Select } from "@aihot/web/components/ui/Controls";
import { reducedMotion } from "@aihot/web/lib/motion";

export function RadarHeader({ title, description, active, query = "" }: { title: string; description: string; active: "overview" | "radar"; query?: string }) {
  const refresh = useRevalidator();
  return <>
    <PhoneBar back={{ to: "/more", label: "我的" }} title={title} large />
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><h1 className="hidden text-[24px] font-semibold leading-tight text-ink lg:block">{title}</h1><p className="mt-1 text-[13px] leading-relaxed text-ink-3">{description}</p></div>
      <button type="button" className={`${buttonClass()} shrink-0`} disabled={refresh.state !== "idle"} onClick={() => refresh.revalidate()}>{refresh.state === "idle" ? "刷新" : "读取中…"}</button>
    </div>
    <nav aria-label="总览与雷达" className="my-5 flex gap-2">
      {([['overview', '总览'], ['radar', '新闻雷达']] as const).map(([key, label]) => <Link key={key} to={`/${key}${query}`} aria-current={active === key ? "page" : undefined}
        className={`inline-flex min-h-10 items-center rounded-full border px-4 text-[13px] ${active === key ? "border-accent/30 bg-accent-soft font-semibold text-accent" : "border-line bg-surface text-ink-3 hover:text-ink"}`}>{label}</Link>)}
    </nav>
  </>;
}

export function RadarScope({ data, shown }: { data: RadarResponse; shown?: number }) {
  return <p className="my-3 text-[12px] leading-relaxed text-ink-4">
    {data.days ? `近 ${data.days} 天` : "全部日期"}共有 {data.total.toLocaleString("en-US")} 条已公开且有发布日期的报道
    {data.truncated ? `，图中展示最近 ${data.items.length} 条` : ""}{shown !== undefined && shown !== data.items.length ? `，筛选后显示 ${shown} 条` : ""}。
    按原文发布日期排列，读取于 {beijingDate(data.to)} {beijingTime(data.to)}。
  </p>;
}

/** A local selection changes the address for a return from reading, while retaining the current data. */
export function radarShouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) {
    const current = new URLSearchParams(currentUrl.search), next = new URLSearchParams(nextUrl.search);
    current.delete("item"); next.delete("item");
    if (current.toString() === next.toString()) return false;
  }
  return defaultShouldRevalidate;
}

export function useRadarSelection(items: RadarItem[], initialId: string | null) {
  const [, setParams] = useSearchParams();
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState("1");
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(false);
  const index = Math.max(0, items.findIndex(item => item.id === initialId));
  const active = items[index] ?? null;
  const choose = (id: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set("item", id); return next; }, { replace: true, preventScrollReset: true });
  useEffect(() => {
    const visibility = () => { setVisible(!document.hidden); setReduced(reducedMotion()); if (reducedMotion()) setPlaying(false); };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!playing || !visible || reduced || items.length < 2) return;
    const timer = setTimeout(() => {
      if (reducedMotion()) { setReduced(true); setPlaying(false); }
      else choose(items[(index + 1) % items.length]!.id);
    }, 8400 / Number(speed));
    return () => clearTimeout(timer);
  }, [playing, visible, reduced, items, index, speed]);
  const select = (id: string) => { choose(id); setPlaying(false); };
  const step = (offset: number) => { const item = items[(index + offset + items.length) % items.length]; if (item) select(item.id); };
  return { active, index, select, controls: <div className="flex flex-wrap items-center gap-2" aria-label="报道回放">
    <button type="button" className={buttonClass()} aria-label="上一篇报道" disabled={items.length < 2} onClick={() => step(-1)}><IconChevronLeft size={15} /></button>
    <button type="button" className={buttonClass()} disabled={items.length < 2 || reduced} onClick={() => { if (reducedMotion()) setReduced(true); else setPlaying(!playing); }}>{playing ? "暂停回放" : "播放报道"}</button>
    <button type="button" className={buttonClass()} aria-label="下一篇报道" disabled={items.length < 2} onClick={() => step(1)}><IconChevronRight size={15} /></button>
    <Select aria-label="回放速度" value={speed} onChange={event => setSpeed(event.target.value)}><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></Select>
    <span className="num text-[12px] text-ink-4">{items.length ? index + 1 : 0} / {items.length}</span>
    {reduced && <span className="text-[12px] text-ink-4">已按减少动态效果设置关闭回放</span>}
  </div> };
}

export function RadarArticle({ item, compact = false }: { item: RadarItem | null; compact?: boolean }) {
  if (!item) return <p className="py-12 text-center text-[14px] text-ink-4">当前范围没有可展示的报道。</p>;
  return <article className="min-w-0 rounded-card border border-line bg-surface p-4 lg:p-5" aria-label="当前报道">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-relaxed text-ink-4">
      <span>{item.category ? CATEGORY_LABELS[item.category] : "未分类"}</span><span aria-hidden="true">·</span>
      <time dateTime={item.publishedAt}>{beijingDate(item.publishedAt)}</time>
      <span className="ml-auto rounded-full bg-accent-soft px-2 py-0.5 text-accent">{item.selected ? "精选" : "动态"}</span>
    </div>
    <h2 className={`mt-3 break-words font-semibold leading-relaxed text-ink ${compact ? "text-[18px]" : "text-[21px]"}`}><Link className="hover:text-accent" to={`/items/${item.id}`}>{item.title}</Link></h2>
    {item.summary && <p className={`mt-3 break-words text-[14px] leading-[1.85] text-ink-3 ${compact ? "line-clamp-4" : ""}`}>{item.prefiltered && <span className="mr-1 text-[12px] text-ink-4">来源摘录</span>}{item.summary}</p>}
    {item.tags.length > 0 && <div className="mt-4 flex flex-wrap gap-1.5">{item.tags.slice(0, 6).map(tag => <span key={tag} className="rounded-full bg-well px-2 py-1 text-[11px] text-ink-3">{tag}</span>)}</div>}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[12px] text-ink-4"><span className="min-w-0 break-words">{item.source.name}</span><Link className="inline-flex shrink-0 items-center gap-1 font-medium text-accent" to={`/items/${item.id}`}>查看报道 <IconArrowRight size={14} /></Link></div>
  </article>;
}
