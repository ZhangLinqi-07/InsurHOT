// 站点的字标和圆环标记：页面用 Wordmark 画站名（size 是高度，单位像素），RingMark 是小标记，转起来就是加载动画。
// 站名旁的复旦保险图标与字标一起缩放，供侧栏、手机顶栏和登录页共用。
import { SITE } from "../site.ts";
import fudanInsuranceLogo from "./fudan-ins-logo.png?url&no-inline";

export function Wordmark({ size = 24, className = "", title = SITE.name }: { size?: number; className?: string; title?: string }) {
  return (
    <span className={`inline-flex items-center font-black leading-none tracking-[-0.03em] ${className}`} style={{ fontSize: Math.round(size * 0.92) }} aria-label={title} role="img">
      <img src={fudanInsuranceLogo} alt="" width={Math.round(size * 1.2)} height={Math.round(size * 1.2)} className="mr-[0.25em] inline-block shrink-0 rounded-full" />
      <span aria-hidden="true">{SITE.name}</span>
    </span>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
