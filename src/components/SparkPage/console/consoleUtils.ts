/** Formatting helpers for the v3 console — house conventions from LlmPanel. */
import type { LlmMetrics } from "../../../api/types";

/** Bytes → "18.4 GB" (mockup voice). */
export function fmtGB(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Bytes → "3.8 TB" when ≥ 1 TB else GB. */
export function fmtTBorGB(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const tb = bytes / 1024 ** 4;
  if (tb >= 1) return `${tb.toFixed(1)} TB`;
  return `${(bytes / 1024 ** 3).toFixed(0)} GB`;
}

/** Thousands with a thin space: 204 403 (mockup voice). */
export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
}

/** tok/s with one decimal: 62.4. */
export function fmtTps(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return fmtInt(n);
  return n.toFixed(1);
}

/**
 * Milliseconds the house way (NEVER "3.8kms"): <1000 → "84ms",
 * <60s → "3.80s", else "1m 4s". Takes seconds input.
 */
export function fmtSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Fraction 0–1 → "72%" (— when null). */
export function fmtPct(frac: number | null | undefined): string {
  if (frac == null || !Number.isFinite(frac)) return "—";
  return `${Math.round(frac * 100)}%`;
}

/** uptime seconds → "6d 4h" / "3h 12m" / "45m". */
export function fmtUptimeShort(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${Math.max(0, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** ISO/HF model id → short console name (last path segment). */
export function shortModelName(id: string | null | undefined): string {
  if (!id) return "—";
  const parts = id.split("/");
  return parts[parts.length - 1] || id;
}

// ── Derived engine activity (accepted state machine) ──────────────────────
// queued      → requestsWaiting > 0
// decoding    → running > 0 && generationTps > 0
// prefilling  → running > 0 && prefillTps > 0
// processing  → running > 0, both rates 0 (poll gap / cached-only) — hold last
// gpu-silent  → running == 0 but GPU busy while engine silent
export type EngineActivity = "waiting" | "queued" | "decoding" | "prefilling" | "processing" | "gpu-silent";

export const ACTIVITY_LABEL: Record<EngineActivity, string> = {
  waiting: "waiting",
  queued: "queued",
  decoding: "decoding",
  prefilling: "prefilling",
  processing: "processing",
  "gpu-silent": "gpu busy · engine silent",
};

export const ACTIVITY_TIP =
  "Derived activity — queued: requests waiting > 0 · decoding: running + gen tok/s > 0 · prefilling: running + prefill tok/s > 0 · processing: running but both 0 (poll gap / cached-only). GPU busy while engine silent = weight loading, CUDA-graph capture, warmup or a foreign process → follow the live log.";

/**
 * Pure per-tick classification. `gpuUsage` is 0–100 (metrics.gpu.usage).
 * Returns null when the engine is down (caller shows its own state).
 */
export function classifyActivity(
  llm: LlmMetrics | null,
  gpuUsage: number | null | undefined
): EngineActivity | null {
  if (!llm || !llm.available) return null;
  const running = llm.requestsRunning ?? llm.slotsActive ?? 0;
  const waiting = llm.requestsWaiting ?? 0;
  if (running === 0 && waiting === 0) {
    // Blind spot: GPU clearly busy but engine reports nothing running.
    if (gpuUsage != null && gpuUsage >= 85) return "gpu-silent";
    return "waiting";
  }
  if (waiting > 0 && running === 0) return "queued";
  if (running > 0 && llm.generationTps > 0) return "decoding";
  if (running > 0 && llm.prefillTps > 0) return "prefilling";
  return "processing";
}

/**
 * Log-line tokenizer for the serving console: [tag]-ish brackets and levels
 * get console colours; timestamps go dim. Returns React-ready spans per line.
 */
export function tokenizeLogLine(line: string): Array<{ text: string; cls: string | null }> {
  const out: Array<{ text: string; cls: string | null }> = [];
  const lower = line.toLowerCase();
  const level: string | null = /warn|deprecat/.test(lower)
    ? "log-warn"
    : /error|fail|exception|traceback/.test(lower)
      ? "log-err"
      : /ok|ready|done|listening/.test(lower)
        ? "log-ok"
        : null;
  // leading timestamp (HH:MM:SS or ISO)
  const ts = line.match(/^\s*(\d{2}:\d{2}(?::\d{2})?|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\s*/);
  let rest = line;
  if (ts) {
    out.push({ text: ts[0], cls: "log-dim" });
    rest = line.slice(ts[0].length);
  }
  // [tag]
  const tag = rest.match(/^\[[^\]]{1,12}\]\s*/);
  if (tag) {
    const tagLevel = /serve|ready|launch/i.test(tag[0]) ? "log-accent" : level ?? "log-dim";
    out.push({ text: tag[0], cls: tagLevel });
    rest = rest.slice(tag[0].length);
  }
  out.push({ text: rest, cls: level });
  return out;
}
