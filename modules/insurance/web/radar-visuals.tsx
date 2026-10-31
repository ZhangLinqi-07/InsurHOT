import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { RadarItem } from "@aihot/contracts/radar";
import { CATEGORY_KEYS, CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";

interface RadarVisualProps {
  items: RadarItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

function useChartWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(160, Math.round(element.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function activate(event: KeyboardEvent<SVGGElement>, id: string, onSelect: RadarVisualProps["onSelect"]) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelect(id);
}

function reportLabel(item: RadarItem) {
  return `${beijingDate(item.publishedAt)} · ${item.source.name} · ${item.title}`;
}

function pointOffset(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return (Math.abs(hash) % 5 - 2) * 5;
}

/** Dates remain fixed on the horizontal axis; the small vertical spread separates overlapping reports. */
export function NewsRiver({ items, activeId, onSelect, flowing }: RadarVisualProps & { flowing?: boolean }) {
  const { ref, width } = useChartWidth(650);
  const descriptionId = useId();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const rows = useMemo(() => [
    ...CATEGORY_KEYS.map(key => ({ key: key as string | null, label: CATEGORY_LABELS[key] })),
    ...(items.some(item => !item.category) ? [{ key: null, label: "未分类" }] : []),
  ], [items]);
  const plotted = useMemo(() => items.filter(item => Number.isFinite(Date.parse(item.publishedAt))), [items]);
  const active = plotted.find(item => item.id === activeId) ?? null;
  const preview = plotted.find(item => item.id === hoveredId) ?? active;
  const dates = plotted.map(item => Date.parse(item.publishedAt));
  const first = dates.length ? Math.min(...dates) : 0;
  const last = dates.length ? Math.max(...dates) : 0;
  const singleDay = first === last;
  const start = singleDay ? first - 43200000 : first;
  const end = singleDay ? last + 43200000 : last;
  const x = (date: number) => 12 + (date - start) / Math.max(1, end - start) * (width - 24);
  const bandHeight = 45;
  const plotHeight = rows.length * bandHeight;
  const height = plotHeight + 33;
  const ticks = width > 400 && !singleDay ? [first, (first + last) / 2, last] : singleDay ? [first] : [first, last];

  // Dense reports can overlap the active point's larger hit circle. Resolve a pointer click
  // against the nearest actual centre; keyboard activation keeps the focused report.
  const selectNearest = (event: MouseEvent<SVGGElement>, fallbackId: string) => {
    const svg = event.currentTarget.ownerSVGElement;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) { onSelect(fallbackId); return; }
    const screen = svg.createSVGPoint(); screen.x = event.clientX; screen.y = event.clientY;
    const pointer = screen.matrixTransform(matrix.inverse());
    let nearest = fallbackId, distance = Infinity;
    for (const item of plotted) {
      const row = Math.max(0, rows.findIndex(entry => entry.key === item.category));
      const dx = pointer.x - x(Date.parse(item.publishedAt));
      const dy = pointer.y - (row * bandHeight + bandHeight / 2 + pointOffset(item.id));
      const squared = dx * dx + dy * dy;
      if (squared < distance) { nearest = item.id; distance = squared; }
    }
    onSelect(nearest);
  };

  if (!plotted.length) return <p className="py-16 text-center text-[13px] text-ink-4">当前范围没有带发布日期的公开报道。</p>;

  return <div className="min-w-0">
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-4" id={descriptionId}>
      <span>横轴为原始发布日期</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-accent" />报道</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full border border-amber" />精选</span>
      <span>点击圆点切换报道</span>
    </div>
    <div className="grid grid-cols-[68px_minmax(0,1fr)] gap-1">
      <div aria-hidden="true" className="pt-0 text-[11px] text-ink-3">
        {rows.map(row => <div key={row.key ?? "uncategorized"} className="flex items-center pr-1" style={{ height: bandHeight }}>{row.label}</div>)}
      </div>
      <div ref={ref} className="min-w-0">
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="新闻日期与分类分布" aria-describedby={descriptionId} className="overflow-visible">
          {rows.map((row, index) => <g key={row.key ?? "uncategorized"} aria-hidden="true">
            <rect x="0" y={index * bandHeight} width={width} height={bandHeight} rx="5" fill={index % 2 === 0 ? "var(--bg-sunk)" : "transparent"} />
            <line x1="0" x2={width} y1={(index + 1) * bandHeight} y2={(index + 1) * bandHeight} stroke="var(--line)" strokeWidth="0.6" />
          </g>)}
          {flowing !== undefined && rows.map((row, index) => {
            const centres = plotted.filter(item => item.category === row.key).map(item => x(Date.parse(item.publishedAt)));
            const middle = index * bandHeight + bandHeight / 2;
            const samples = Array.from({ length: Math.ceil(width / 10) + 1 }, (_, sample) => {
              const at = Math.min(width, sample * 10);
              const density = centres.reduce((sum, centre) => sum + Math.exp(-(((at - centre) / 23) ** 2)), 0);
              return { x: at, spread: Math.min(14, density * 3.5) };
            });
            const outline = [...samples.map(point => `${point.x},${middle - point.spread}`), ...samples.slice().reverse().map(point => `${point.x},${middle + point.spread}`)].join(" ");
            return <g key={row.key ?? "uncategorized"} aria-hidden="true" pointerEvents="none">
              <polygon points={outline} fill="var(--accent)" opacity={active?.category === row.key ? .11 : .035} />
              <line x1="0" x2={width} y1={middle} y2={middle} stroke="var(--accent)" strokeWidth=".8" opacity={active?.category === row.key ? .4 : .13} strokeDasharray="24 56" className="overview-river-flow" style={{ animationPlayState: flowing ? "running" : "paused" }} />
            </g>;
          })}
          {ticks.map((tick, index) => <g key={tick} aria-hidden="true">
            <line x1={x(tick)} x2={x(tick)} y1="0" y2={plotHeight} stroke="var(--line)" strokeDasharray="2 5" />
            <text x={x(tick)} y={plotHeight + 22} fill="var(--ink-4)" fontSize="10" textAnchor={singleDay ? "middle" : index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"}>{beijingDate(tick)}</text>
          </g>)}
          {active && <line x1={x(Date.parse(active.publishedAt))} x2={x(Date.parse(active.publishedAt))} y1="0" y2={plotHeight} stroke="var(--accent)" strokeWidth="1" opacity="0.6" aria-hidden="true" />}
          {[...plotted.filter(item => item.id !== activeId), ...plotted.filter(item => item.id === activeId)].map(item => {
            const row = Math.max(0, rows.findIndex(entry => entry.key === item.category));
            const selected = item.id === activeId;
            return <g key={item.id} role="button" tabIndex={0} aria-label={reportLabel(item)} aria-pressed={selected}
              transform={`translate(${x(Date.parse(item.publishedAt))},${row * bandHeight + bandHeight / 2 + pointOffset(item.id)})`}
              onClick={event => selectNearest(event, item.id)} onKeyDown={event => activate(event, item.id, onSelect)}
              onMouseEnter={() => setHoveredId(item.id)} onMouseLeave={() => setHoveredId(null)} onFocus={() => setHoveredId(item.id)} onBlur={() => setHoveredId(null)}
              className="cursor-pointer text-accent outline-none [&:focus-visible>circle:last-child]:stroke-ink [&:focus-visible>circle:last-child]:stroke-2">
              <title>{reportLabel(item)}</title>
              <circle r={selected ? 11 : 9} fill="transparent" />
              {item.selected && <circle r={selected ? 8 : 5.5} fill="none" stroke="var(--amber)" strokeWidth="1.2" />}
              <circle r={selected ? 5 : 3} fill="currentColor" stroke={selected ? "var(--surface)" : "none"} strokeWidth="1.5" opacity={selected ? 1 : 0.65} />
            </g>;
          })}
        </svg>
      </div>
    </div>
    <div className="mt-2 min-h-[54px] rounded-control bg-bg-sunk px-3 py-2 text-[12px] leading-relaxed text-ink-3" aria-live="polite">
      {preview ? <><p className="break-words font-medium text-ink-2">{preview.title}</p><p className="mt-0.5 text-[11px] text-ink-4">{beijingDate(preview.publishedAt)} · {preview.source.name}</p></> : "悬停或聚焦圆点查看标题、发布日期与来源。"}
    </div>
  </div>;
}
