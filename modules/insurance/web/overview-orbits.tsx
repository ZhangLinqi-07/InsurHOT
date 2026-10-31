import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, RefObject } from "react";
import type { RadarItem } from "@aihot/contracts/radar";
import { CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";

interface OverviewOrbitsProps {
  items: RadarItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  clock: RefObject<{ progress: number; elapsed: number }>;
  running: boolean;
  reduced: boolean;
  onHold?: (held: boolean) => void;
}

interface OrbitNode {
  id: string;
  label: string;
  articleId: string;
  kind: number;
  count: number;
  color: string;
  x: number;
  z: number;
  lift: number;
  radius: number;
  sx: number;
  sy: number;
  depth: number;
}

interface Point { x: number; y: number }

const COLORS = ["#7d86ad", "#b18a54", "#528e87", "#7193ae", "#7aa18e", "#b17e79", "#9482ac", "#6d9b84", "#529ba0", "#a28c69", "#8c9b9b"];
const COLOR_KEYS = Object.keys(CATEGORY_LABELS);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const categoryName = (item: RadarItem) => item.category ? CATEGORY_LABELS[item.category] : "未分类";
const reportLabel = (item: RadarItem) => `${beijingDate(item.publishedAt)} · ${item.source.name} · ${item.title}`;
function hash(value: string) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return (result >>> 0) / 4294967295;
}
function rgba(color: string, alpha: number) {
  return `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${alpha})`;
}
function spiral(arm: number, fraction: number, jitter = 0) {
  const angle = -Math.PI / 2 + arm * Math.PI * 2 / 3 + fraction * 3.45;
  const radius = .13 + .88 * Math.pow(fraction, .9) + jitter;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}
function dot(context: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  context.beginPath(); context.arc(x, y, Math.max(.2, radius), 0, Math.PI * 2);
  context.fillStyle = color; context.fill();
}
function line(context: CanvasRenderingContext2D, a: Point, b: Point, color: string, width = 1) {
  context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y);
  context.strokeStyle = color; context.lineWidth = width; context.stroke();
}
function curve(a: Point, b: Point, c: Point, fraction: number) {
  return { x: (1 - fraction) ** 2 * a.x + 2 * (1 - fraction) * fraction * b.x + fraction ** 2 * c.x,
    y: (1 - fraction) ** 2 * a.y + 2 * (1 - fraction) * fraction * b.y + fraction ** 2 * c.y };
}

function orbitModel(items: RadarItem[]) {
  const categoryKeys = [...new Set(items.map(item => item.category ?? "uncategorized"))];
  const colorOf = (item: RadarItem) => COLORS[(item.category ? Math.max(0, COLOR_KEYS.indexOf(item.category)) : COLORS.length - 1) % COLORS.length]!;
  const sources = [...new Set(items.map(item => item.source.name))].map(name => {
    const reports = items.filter(item => item.source.name === name);
    return { id: `s:${name}`, label: name, articleId: reports[0]!.id, kind: 0, count: reports.length, color: colorOf(reports[0]!) };
  }).sort((a, b) => b.count - a.count);
  const reports = items.map(item => ({ id: `n:${item.id}`, label: item.title, articleId: item.id, kind: 1, count: 1, color: colorOf(item) }));
  const categories = categoryKeys.map(key => {
    const reports = items.filter(item => (item.category ?? "uncategorized") === key);
    return { id: `c:${key}`, label: categoryName(reports[0]!), articleId: reports[0]!.id, kind: 2, count: reports.length, color: colorOf(reports[0]!) };
  });
  const groups = [sources, reports, categories];
  const nodes: OrbitNode[] = groups.flatMap((group, arm) => {
    const maximum = Math.max(1, ...group.map(node => node.count));
    return group.map((node, index) => {
      const fraction = (index + .65) / (group.length + .8);
      return { ...node, ...spiral(arm, fraction, (hash(node.id) - .5) * (.02 + fraction * .05)),
        lift: arm === 1 ? .025 + hash(`${node.id}lift`) * .025 : .035 + Math.sqrt(node.count / maximum) * .21,
        radius: arm === 1 ? 1.6 : 1.2 + Math.sqrt(node.count / maximum) * 3.3, sx: 0, sy: 0, depth: 0 };
    });
  });
  return { nodes, groups, colorOf, map: new Map(nodes.map(node => [node.id, node])) };
}

/** Three spiral arms connect only the source, report and classification already in the public data. */
export function OverviewOrbits({ items, activeId, onSelect, clock, running, reduced, onHold }: OverviewOrbitsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const model = useMemo(() => orbitModel(items), [items]);
  const active = items.find(item => item.id === activeId) ?? items[0] ?? null;
  const current = useRef({ active, model, running, reduced, onSelect, onHold });
  current.current = { active, model, running, reduced, onSelect, onHold };
  const view = useRef({ rotation: -.4, tilt: .56, zoom: 1, auto: true, drag: null as { x: number; y: number; moved: number } | null });
  const requestPaint = useRef<() => void>(() => {});
  const [rotating, setRotating] = useState(true);
  const [tooltip, setTooltip] = useState<{ label: string; x: number; y: number } | null>(null);
  const accessible = useMemo(() => {
    const recent = items.slice(0, 8);
    return active && !recent.some(item => item.id === active.id) ? [...recent, active] : recent;
  }, [items, active]);
  const visibleSources = [...new Set(accessible.map(item => item.source.name))];

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let width = 0, height = 0, dpr = 1, inView = true, frame = 0, lastPaint = 0, lastElapsed = clock.current.elapsed;
    let texture: HTMLCanvasElement | null = null;
    let font = "", ink = "#77746b", muted = "#a5a094", surface = "#fbfaf7";
    const readTheme = () => {
      const style = getComputedStyle(canvas);
      font = style.fontFamily;
      ink = style.getPropertyValue("--ink-3").trim() || "#77746b";
      muted = style.getPropertyValue("--ink-4").trim() || "#a5a094";
      surface = style.getPropertyValue("--surface").trim() || "#fbfaf7";
    };
    readTheme();
    const geometry = () => {
      const reserve = width >= 640 ? 145 : 0;
      const space = width - reserve;
      return { reserve, cx: reserve + space * .5, cy: height * .53, scale: Math.min(space * .41, height * .7) * view.current.zoom };
    };
    const project = (x: number, z: number, lift = 0) => {
      const rotation = view.current.rotation;
      const rx = x * Math.cos(rotation) - z * Math.sin(rotation), rz = x * Math.sin(rotation) + z * Math.cos(rotation);
      const perspective = 1 / (1 + rz * .18), g = geometry();
      return { x: g.cx + rx * g.scale * perspective, y: g.cy + (rz * view.current.tilt - lift) * g.scale * perspective, depth: rz, scale: perspective };
    };
    const textCut = (text: string, maximum: number) => {
      let result = text;
      while (result.length > 1 && context.measureText(`${result}…`).width > maximum) result = result.slice(0, -1);
      return result === text ? result : `${result}…`;
    };
    const buildTexture = () => {
      texture = document.createElement("canvas"); texture.width = texture.height = 1000;
      const dust = texture.getContext("2d");
      if (!dust) return;
      let seed = 6217;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const normal = () => Math.sqrt(-2 * Math.log(Math.max(.00001, random()))) * Math.cos(random() * Math.PI * 2);
      const halo = dust.createRadialGradient(500, 500, 0, 500, 500, 170);
      halo.addColorStop(0, "#d5b36f25"); halo.addColorStop(1, "#d5b36f00"); dust.fillStyle = halo; dust.fillRect(0, 0, 1000, 1000);
      for (let arm = 0; arm < 3; arm++) for (let index = 0; index < 1800; index++) {
        const fraction = Math.pow(random(), .8), point = spiral(arm, fraction, normal() * (.018 + .075 * fraction));
        const group = model.groups[arm]!, node = group[Math.min(group.length - 1, Math.floor(fraction * group.length))];
        const size = random() < .08 ? 2.6 : .8 + random() * 1.3;
        dust.fillStyle = rgba(node?.color || COLORS[arm]!, .22 + random() * .48);
        dust.fillRect(500 + point.x * 500 / 1.2, 500 + point.z * 500 / 1.2, size, size);
      }
      for (let index = 0; index < 1200; index++) {
        const angle = random() * Math.PI * 2, radius = Math.min(1.13, -Math.log(1 - random() * .97) * .32);
        dust.fillStyle = rgba("#8e8579", .08 + random() * .15);
        dust.fillRect(500 + Math.cos(angle) * radius * 500 / 1.2, 500 + Math.sin(angle) * radius * 500 / 1.2, 1, 1);
      }
    };
    buildTexture();
    const paint = () => {
      if (!width || !height) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
      const { active: selected, model: currentModel, running: isRunning, reduced: isReduced } = current.current;
      if (!selected) return;
      const motionTime = clock.current.elapsed, elapsed = clamp(motionTime - lastElapsed, 0, 100);
      lastElapsed = motionTime;
      if (isRunning && !isReduced && !document.hidden && inView && !view.current.drag && view.current.auto) view.current.rotation += elapsed * .000037;
      const g = geometry(), color = currentModel.colorOf(selected), pulse = isReduced ? 0 : .5 + .5 * Math.sin(clock.current.elapsed / 430);
      const ids = [`s:${selected.source.name}`, `n:${selected.id}`, `c:${selected.category ?? "uncategorized"}`];
      const activeNodes = new Set(ids);
      if (texture) {
        const cosine = Math.cos(view.current.rotation), sine = Math.sin(view.current.rotation), unit = 1.2 / 500;
        for (let slice = 0; slice < 20; slice++) {
          const z0 = -1.2 + 2.4 * slice / 20, z1 = z0 + 2.4 / 20;
          const scale = 1 / (1 + (z0 + z1) * .09), p0 = 1 / (1 + z0 * .18), p1 = 1 / (1 + z1 * .18);
          context.save(); context.beginPath();
          context.moveTo(g.cx - 1.2 * g.scale * p0, g.cy + z0 * g.scale * view.current.tilt * p0 - .5);
          context.lineTo(g.cx + 1.2 * g.scale * p0, g.cy + z0 * g.scale * view.current.tilt * p0 - .5);
          context.lineTo(g.cx + 1.2 * g.scale * p1, g.cy + z1 * g.scale * view.current.tilt * p1 + .5);
          context.lineTo(g.cx - 1.2 * g.scale * p1, g.cy + z1 * g.scale * view.current.tilt * p1 + .5); context.closePath(); context.clip();
          const a = g.scale * scale * cosine * unit, b = g.scale * scale * sine * view.current.tilt * unit;
          const c = -g.scale * scale * sine * unit, d = g.scale * scale * cosine * view.current.tilt * unit;
          context.transform(a, b, c, d, g.cx - 500 * a - 500 * c, g.cy - 500 * b - 500 * d);
          context.drawImage(texture, 0, 0); context.restore();
        }
      }
      for (const radius of [.50, .83, 1.055]) {
        context.beginPath();
        for (let index = 0; index <= 120; index++) {
          const angle = index / 120 * Math.PI * 2, point = project(Math.cos(angle) * radius, Math.sin(angle) * radius);
          if (index) context.lineTo(point.x, point.y); else context.moveTo(point.x, point.y);
        }
        context.strokeStyle = rgba(muted, .26); context.lineWidth = .75; context.stroke();
      }
      for (let index = 0; index < 72; index++) {
        const angle = index / 72 * Math.PI * 2;
        line(context, project(Math.cos(angle) * 1.09, Math.sin(angle) * 1.09), project(Math.cos(angle) * (index % 6 ? 1.11 : 1.14), Math.sin(angle) * (index % 6 ? 1.11 : 1.14)), rgba(muted, .35), .7);
      }
      for (const node of currentModel.nodes) {
        const chosen = activeNodes.has(node.id), breathing = isReduced ? 1 : .9 + .12 * Math.sin(motionTime / 1700 + hash(node.id) * 7);
        const point = project(node.x, node.z, node.lift * breathing + (chosen ? .035 : 0));
        node.sx = point.x; node.sy = point.y; node.depth = point.depth;
      }
      const route = ids.map(id => currentModel.map.get(id)).filter((node): node is OrbitNode => !!node);
      for (let index = 0; index < route.length - 1; index++) {
        const from = route[index]!, to = route[index + 1]!, middle = { x: (from.sx + to.sx) / 2, y: (from.sy + to.sy) / 2 - 32 };
        context.save(); context.shadowColor = rgba(to.color, .35); context.shadowBlur = 7;
        context.strokeStyle = rgba(to.color, .8); context.lineWidth = 1.4 + pulse * .5;
        context.beginPath(); context.moveTo(from.sx, from.sy); context.quadraticCurveTo(middle.x, middle.y, to.sx, to.sy); context.stroke();
        if (!isReduced && isRunning) for (let packet = 0; packet < 2; packet++) {
          const fraction = (clock.current.elapsed / 2300 + packet * .5) % 1;
          const position = curve({ x: from.sx, y: from.sy }, middle, { x: to.sx, y: to.sy }, fraction);
          dot(context, position.x, position.y, 2.4, to.color);
        }
        context.restore();
      }
      for (const node of [...currentModel.nodes].sort((a, b) => b.depth - a.depth)) {
        const chosen = activeNodes.has(node.id), base = project(node.x, node.z), radius = node.radius * base.scale;
        line(context, base, { x: node.sx, y: node.sy }, rgba(node.color, chosen ? .8 : .5), chosen ? 1.3 : .6);
        dot(context, base.x, base.y, 1, rgba(node.color, .3));
        dot(context, node.sx, node.sy, radius, rgba(node.color, chosen ? 1 : .68));
        if (node.kind !== 1) {
          context.beginPath(); context.arc(node.sx, node.sy, radius + 2, 0, Math.PI * 2);
          context.strokeStyle = rgba(node.color, .4); context.lineWidth = .7; context.stroke();
        }
      }
      for (const node of route) {
        const story = node.kind === 1, radius = story ? 5.5 : Math.max(4, node.radius * 1.3);
        const halo = context.createRadialGradient(node.sx, node.sy, 0, node.sx, node.sy, 26 + pulse * 5);
        halo.addColorStop(0, rgba(node.color, .33)); halo.addColorStop(1, rgba(node.color, 0));
        context.fillStyle = halo; context.fillRect(node.sx - 32, node.sy - 32, 64, 64);
        dot(context, node.sx, node.sy, radius, node.color);
        for (const offset of [4, 10]) {
          context.beginPath(); context.arc(node.sx, node.sy, radius + offset + pulse * 3, 0, Math.PI * 2);
          context.strokeStyle = rgba(node.color, offset === 4 ? .7 : .23); context.lineWidth = offset === 4 ? 1.4 : .9; context.stroke();
        }
        if (story) {
          context.font = `600 10px ${font}`;
          const labelX = clamp(node.sx - 29, g.reserve + 4, width - 65), labelY = clamp(node.sy - 28, 34, height - 25);
          context.fillStyle = surface; context.fillRect(labelX - 3, labelY - 12, 64, 19);
          context.fillStyle = color; context.fillText("当前报道", labelX + 5, labelY + 1);
        }
      }
      context.font = `600 10px ${font}`;
      const labels = ["信源机构", "新闻报道", "分类主题"];
      labels.forEach((label, arm) => {
        const position = spiral(arm, 1.02), point = project(position.x, position.z);
        context.fillStyle = COLORS[arm === 0 ? 2 : arm === 1 ? 1 : 6]!;
        context.fillText(label, clamp(point.x + 8, g.reserve + 4, width - 65), clamp(point.y, 32, height - 18));
      });
      if (g.reserve) {
        const titles = [selected.source.name, selected.title, categoryName(selected)];
        route.forEach((node, index) => {
          const x = 8, y = height * .5 - 100 + index * 70, cardWidth = g.reserve - 22;
          context.fillStyle = surface; context.strokeStyle = rgba(node.color, .25); context.lineWidth = .8;
          context.beginPath(); context.roundRect(x, y, cardWidth, 56, 6); context.fill(); context.stroke();
          line(context, { x: x + cardWidth, y: y + 28 }, { x: node.sx, y: node.sy }, rgba(node.color, .35), .7);
          context.fillStyle = node.color; context.font = `600 9px ${font}`; context.fillText(labels[index]!, x + 9, y + 17);
          context.fillStyle = ink; context.font = `10px ${font}`; context.fillText(textCut(titles[index]!, cardWidth - 18), x + 9, y + 35);
        });
      }
      context.font = `9px ${font}`; context.fillStyle = muted;
      context.fillText(`${model.groups[0]!.length} 个信源 · ${items.length} 篇报道 · ${model.groups[2]!.length} 类主题`, 10, height - 9);
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect(); width = bounds.width; height = bounds.height;
      dpr = Math.min(1.75, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); paint();
    };
    const needsAnimation = () => current.current.running && !current.current.reduced && !document.hidden && inView;
    const tick = (now: number) => {
      frame = 0;
      if (!needsAnimation()) return;
      if (now - lastPaint >= 1000 / 30) { lastPaint = now; paint(); }
      frame = requestAnimationFrame(tick);
    };
    const requestDraw = () => {
      paint();
      if (needsAnimation() && !frame) frame = requestAnimationFrame(tick);
      else if (!needsAnimation() && frame) { cancelAnimationFrame(frame); frame = 0; }
    };
    requestPaint.current = requestDraw;
    const observer = new ResizeObserver(resize); observer.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => { inView = entry?.isIntersecting ?? true; requestDraw(); }); intersection.observe(canvas);
    const appearance = new MutationObserver(() => { readTheme(); requestDraw(); });
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font"] });
    document.addEventListener("visibilitychange", requestDraw);
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault(); view.current.zoom = clamp(view.current.zoom - event.deltaY * .001, .78, 1.3); paint();
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    resize(); requestDraw();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); intersection.disconnect(); appearance.disconnect(); canvas.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", requestDraw);
      if (view.current.drag) { view.current.drag = null; current.current.onHold?.(false); }
      requestPaint.current = () => {}; texture = null;
    };
  }, [model, items, clock]);

  useEffect(() => { requestPaint.current(); }, [activeId, running, reduced]);

  const hit = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    let nearest: OrbitNode | null = null, distance = 12;
    for (const node of model.nodes) {
      const next = Math.hypot(node.sx - x, node.sy - y);
      if (next < distance) { nearest = node; distance = next; }
    }
    return nearest;
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = view.current.drag;
    if (drag) {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = event.clientX; drag.y = event.clientY;
      view.current.rotation += dx * .005; view.current.tilt = clamp(view.current.tilt + dy * .002, .3, .8);
      requestPaint.current(); return;
    }
    const node = hit(event), bounds = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.cursor = node ? "pointer" : "grab";
    setTooltip(node ? { label: `${node.label} · ${node.kind === 1 ? "报道" : `${node.count} 篇关联报道`}`, x: clamp(event.clientX - bounds.left + 10, 8, Math.max(8, bounds.width - 220)), y: clamp(event.clientY - bounds.top - 55, 5, bounds.height - 50) } : null);
  };
  const releaseDrag = () => {
    if (!view.current.drag) return;
    view.current.drag = null;
    current.current.onHold?.(false);
  };

  if (!active) return <div role="group" aria-label="信源、报道与标签关联星图" className="flex min-h-[320px] items-center justify-center px-5 text-[13px] text-ink-4">有公开报道后，这里会呈现信源、报道与分类的关联。</div>;

  return <div role="group" aria-label="信源、报道与标签关联星图" className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
      <p className="text-[12px] font-medium text-ink-2">信源与主题星图</p>
      <div className="flex items-center gap-2 text-[10px] text-ink-4">
        <button type="button" className="rounded-control border border-line px-2 py-1 hover:text-ink" aria-pressed={!rotating} onClick={() => { view.current.auto = !view.current.auto; setRotating(view.current.auto); }}>{rotating ? "暂停旋转" : "继续旋转"}</button>
        <button type="button" className="rounded-control border border-line px-2 py-1 hover:text-ink" onClick={() => { view.current.rotation = -.4; view.current.tilt = .56; view.current.zoom = 1; requestPaint.current(); }}>复位</button>
      </div>
    </div>
    <div className="relative min-w-0">
      <canvas ref={canvasRef} aria-hidden="true" className="block w-full cursor-grab" style={{ height: "clamp(330px, 33vw, 380px)", touchAction: "pan-y" }}
        onPointerDown={event => { if (event.button !== 0) return; view.current.drag = { x: event.clientX, y: event.clientY, moved: 0 }; event.currentTarget.setPointerCapture(event.pointerId); current.current.onHold?.(true); setTooltip(null); }}
        onPointerMove={onPointerMove} onPointerUp={event => {
          const drag = view.current.drag;
          if (drag && drag.moved < 6) { const node = hit(event); if (node) onSelect(node.articleId); }
          releaseDrag(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }} onPointerCancel={releaseDrag} onLostPointerCapture={releaseDrag} onPointerLeave={() => setTooltip(null)} />
      {tooltip && <div role="tooltip" className="pointer-events-none absolute z-10 max-w-[220px] rounded-control border border-line bg-surface px-2.5 py-2 text-[11px] leading-relaxed text-ink-2 shadow-md" style={{ left: tooltip.x, top: tooltip.y }}>{tooltip.label}</div>}
    </div>
    <div className="space-y-2 border-t border-line/70 px-4 py-3 text-[10px] text-ink-4">
      <p>拖动旋转 · Ctrl + 滚轮缩放 · 点击节点切换报道。背景星尘为装饰。</p>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="星图中的信源">
        <span className="mr-1">信源</span>{visibleSources.map(name => {
          const item = active.source.name === name ? active : accessible.find(item => item.source.name === name)!;
          return <button key={name} type="button" aria-label={`查看来源 ${name} 的报道`} aria-pressed={active.source.name === name} onClick={() => onSelect(item.id)} className={`max-w-full truncate rounded-control border px-2 py-1 ${active.source.name === name ? "border-accent/35 bg-accent-soft text-accent" : "border-line text-ink-3 hover:text-ink"}`}>{name}</button>;
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label="星图中的报道">
        <span className="mr-1">报道</span>{accessible.map(item => <button key={item.id} type="button" aria-label={reportLabel(item)} aria-pressed={active.id === item.id} title={item.title} onClick={() => onSelect(item.id)} className={`flex size-7 items-center justify-center rounded-control border num ${active.id === item.id ? "border-accent/35 bg-accent-soft font-semibold text-accent" : "border-line text-ink-3 hover:text-ink"}`}>{items.indexOf(item) + 1}</button>)}
        <span className="ml-1">当前分类 {categoryName(active)}</span>
      </div>
      {active.tags.some(tag => tag.trim() && !/^[\w.-]+:/.test(tag)) && <p className="break-words">关联标签 {active.tags.filter(tag => tag.trim() && !/^[\w.-]+:/.test(tag)).slice(0, 5).join(" · ")}</p>}
    </div>
  </div>;
}
