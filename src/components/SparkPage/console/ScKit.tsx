/**
 * Shared primitives for the v3 "instrument console" (SparkPage).
 * All markup assumes the scoped styles in src/styles/console.css
 * (.spark-console ancestor). Import console.css once via SparkPage.
 */
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

/** Histogram bar values → deterministic signal bars (ported from the mockup). */
export function ScHist({
  values,
  w = 110,
  h = 22,
  tone = "accent",
  className = "",
}: {
  values: number[];
  w?: number;
  h?: number;
  tone?: "accent" | "success" | "warning" | "neutral";
  className?: string;
}) {
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return <span className={`hist hist--${tone} ${className}`.trim()} style={{ width: w }} />;
  const gap = 2;
  const p = 1;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const r = max - min || 1;
  const n = vals.length;
  const bw = (w - (n - 1) * gap - 2 * p) / n;
  return (
    <span className={`hist hist--${tone} ${className}`.trim()} aria-hidden="true">
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none">
        {vals.map((v, i) => {
          const bh = Math.max(2, 3 + ((v - min) / r) * (h - 5));
          const x = p + i * (bw + gap);
          return (
            <rect
              key={i}
              x={x.toFixed(1)}
              y={(h - bh).toFixed(1)}
              width={bw.toFixed(1)}
              height={bh.toFixed(1)}
              rx="1"
              fill="currentColor"
              opacity={i === n - 1 ? "1" : "0.55"}
            />
          );
        })}
      </svg>
    </span>
  );
}

/** Small (i) icon with a CSS hover/focus tooltip (.info). */
export function ScInfo({ tip, align = "start" }: { tip: string; align?: "start" | "end" }) {
  return (
    <span
      className={`info${align === "end" ? " info--end" : ""}`}
      tabIndex={0}
      role="note"
      aria-label={tip.slice(0, 80)}
      data-tip={tip}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    </span>
  );
}

/** Section heading for a console channel: CH·NN code + title + dashed rule. */
export function ScChHead({
  code,
  title,
  note,
  aside,
}: {
  code: string;
  title: string;
  note?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="ch-head">
      <span className="ch-head__code">{code}</span>
      <h2 className="ch-head__title">{title}</h2>
      <span className="ch-head__rule" aria-hidden="true" />
      {note ? <span className="ch-head__note">{note}</span> : null}
      {aside ? <div className="ch-head__aside">{aside}</div> : null}
    </div>
  );
}

/** Machined instrument panel. */
export function ScModule({
  label,
  className = "",
  style,
  children,
  id,
}: {
  label: string;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={`module ${className}`.trim()} aria-label={label} style={style}>
      {children}
    </section>
  );
}

/** Bordered inset sub-panel inside a module. */
export function ScSubpanel({
  title,
  flash = false,
  right,
  children,
  innerRef,
  id,
}: {
  title: ReactNode;
  flash?: boolean;
  right?: ReactNode;
  children: ReactNode;
  innerRef?: Ref<HTMLDivElement>;
  id?: string;
}) {
  return (
    <div id={id} ref={innerRef} className={`subpanel${flash ? " is-flash" : ""}`}>
      <div className="subpanel__head">
        {title}
        {right}
      </div>
      {children}
    </div>
  );
}

/** Mono silkscreen tag. */
export function ScChip({
  tone = "default",
  children,
  title,
}: {
  tone?: "default" | "accent" | "live" | "warn" | "err";
  children: ReactNode;
  title?: string;
}) {
  const cls =
    tone === "default"
      ? "chip"
      : tone === "accent"
        ? "chip chip--accent"
        : tone === "live"
          ? "chip chip--live"
          : tone === "warn"
            ? "chip chip--warn"
            : "chip chip--err";
  return <span className={cls} title={title}>{children}</span>;
}

export function ScLed({ state = "off" }: { state?: "off" | "live" | "success" | "accent" | "danger" }) {
  return <span className={`led${state === "off" ? "" : ` led--${state}`}`} aria-hidden="true" />;
}

/** Labelled meter row (gauge / dial). */
export function ScSeg({
  pct,
  tone = "neutral",
}: {
  pct: number;
  tone?: "success" | "warning" | "accent" | "neutral";
}) {
  return (
    <div className="seg">
      <div
        className={`seg__fill fill--${tone}`}
        style={{ ["--pct" as string]: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

/** Copy-to-clipboard button with check feedback. */
export function ScCopy({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  async function copy() {
    // Honest feedback: with BOTH mechanisms failing (insecure context +
    // denied execCommand) the checkmark must not lie.
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand("copy");
      ta.remove();
    }
    setCopied(ok);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button
      type="button"
      className={`copy-btn${copied ? " is-copied" : ""}`}
      onClick={copy}
      title={title}
      aria-label={title}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

/**
 * Expert-layer disclosure: the battle-tested legacy panels remain reachable
 * under a dashed strip so v3 loses no functionality (device toggles, storage
 * refresh, api keys, port management, benchmarks, daily chart).
 */
export function ScDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="sc-disclosure">
      <summary>▸ {title}</summary>
      <div className="sc-disclosure__body">{children}</div>
    </details>
  );
}
