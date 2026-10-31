import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator, useSearchParams } from "react-router";
import type { RadarItem } from "@aihot/contracts/radar";
import { observeReducedMotion } from "@aihot/web/lib/motion";

/** One clock carries a public report through the card, orbits and date river. */
export function useOverviewPlayback(items: RadarItem[], initialId: string | null) {
  const [, setParams] = useSearchParams();
  const refresh = useRevalidator();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const root = useRef<HTMLElement>(null);
  const clock = useRef({ progress: initialId ? 1 : 0, elapsed: 0 });
  const clockId = useRef(initialId ?? items[0]?.id);
  const previous = useRef(new Set(items.map(item => item.id)));
  const arrivals = useRef<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [playing, setPlaying] = useState(!initialId);
  const [speed, setSpeed] = useState("1");
  const [phase, setPhase] = useState(initialId ? 3 : 0);
  const [visible, setVisible] = useState(true);
  const [inView, setInView] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [held, setHeld] = useState(false);
  const holds = useRef(new Set<string>());
  const hold = useCallback((reason: string, on: boolean) => {
    if (on) holds.current.add(reason); else holds.current.delete(reason);
    setHeld(holds.current.size > 0);
  }, []);
  const index = Math.max(0, items.findIndex(item => item.id === initialId));
  const active = items[index] ?? null;
  const running = playing && visible && inView && !reduced && !held && !!active;

  const progress = useCallback((value: number) => {
    clock.current.progress = value;
    root.current?.style.setProperty("--journey-progress", `${value * 100}%`);
    root.current?.style.setProperty("--scan-position", `${Math.min(1, value / .23) * 100}%`);
    root.current?.style.setProperty("--transfer-position", `${Math.max(0, Math.min(1, (value - .12) / .18)) * 100}%`);
    setPhase(value < .23 ? 0 : value < .53 ? 1 : value < .82 ? 2 : 3);
  }, []);

  const choose = useCallback((id: string, manual: boolean) => {
    clockId.current = id;
    progress(manual ? 1 : 0);
    arrivals.current = arrivals.current.filter(value => value !== id);
    setPending(arrivals.current);
    if (manual) setPlaying(false);
    if (id !== initialId) setParams(previous => { const next = new URLSearchParams(previous); next.set("item", id); return next; }, { replace: true, preventScrollReset: true });
  }, [initialId, progress, setParams]);

  useEffect(() => {
    if (active && initialId !== active.id) {
      setParams(previous => { const next = new URLSearchParams(previous); next.set("item", active.id); return next; }, { replace: true, preventScrollReset: true });
    }
  }, [active?.id, initialId, setParams]);

  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    const stopObservingMotion = observeReducedMotion(value => {
      setReduced(value);
      if (value) { setPlaying(false); progress(1); }
    });
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? false));
    if (root.current) observer.observe(root.current);
    const timer = setInterval(() => {
      if (!document.hidden && refreshRef.current.state === "idle") void refreshRef.current.revalidate();
    }, 30_000);
    return () => {
      clearInterval(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      stopObservingMotion();
    };
  }, [progress]);

  useEffect(() => {
    const ids = new Set(items.map(item => item.id));
    const added = items.filter(item => !previous.current.has(item.id)).map(item => item.id);
    previous.current = ids;
    arrivals.current = [...new Set([...added, ...arrivals.current])].filter(id => ids.has(id) && id !== active?.id);
    setPending(arrivals.current);
  }, [items, active?.id]);

  useEffect(() => {
    if (clockId.current !== active?.id) {
      clockId.current = active?.id;
      progress(playing ? 0 : 1);
    }
  }, [active?.id, playing, progress]);

  useEffect(() => {
    if (!running) return;
    let frame = 0, last = 0;
    const tick = (now: number) => {
      const delta = last ? Math.min(now - last, 120) : 0;
      last = now;
      clock.current.elapsed += delta;
      const value = clock.current.progress + delta / (8400 / Number(speed));
      if (value >= 1) {
        const next = arrivals.current[0] ?? items[(index + 1) % items.length]?.id;
        if (next) choose(next, false);
        frame = requestAnimationFrame(tick);
        return;
      }
      progress(value);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, speed, items, index, choose, progress]);

  const select = (id: string) => choose(id, true);
  const step = (offset: number) => {
    const item = items[(index + offset + items.length) % items.length];
    if (item) select(item.id);
  };
  const toggle = () => {
    if (!playing && clock.current.progress >= 1) progress(0);
    setPlaying(value => !value);
  };
  const playNew = () => {
    const id = arrivals.current[0];
    if (id) choose(id, reduced);
    if (!reduced) setPlaying(true);
  };
  return { root, clock, active, index, phase, playing, running, reduced, speed, pending, select, step, toggle, playNew, setSpeed, hold };
}
