/** Formatting helpers for the v3 console — house conventions from LlmPanel. */
import type { LlmMetrics } from "../../../api/types";

/** Hover info for the vLLM-derived readout cells (Serving readout matrix). */
export const VLLM_METRIC_INFO = {
  kvCache:
    "Fraction of the engine’s KV cache memory currently in use (0–100%). High values (≥80%) mean little room for new or long contexts and often lead to queuing or preemptions.",
  requests:
    "Run = requests actively generating on the GPU. Wait = accepted but not yet scheduled (capacity or constraints). Growing wait with high KV cache usually means the server is overloaded.",
  ttftP95:
    "95th percentile time-to-first-token from vLLM’s history of requests: how long “slow” requests wait until the first output token. Spikes mean queueing, long prefills, or cold paths—not average decode speed.",
  preempts:
    "Cumulative times the engine paused a running request to free KV cache for others. Rising under load signals memory pressure; zero is normal when the server is comfortable.",
  prefixCache:
    "Lifetime fraction of prefix-cache lookups that hit (hits ÷ queries). Higher means more prompt reuse and less prefill work; — when the series is missing or unused.",
  e2eP95:
    "95th percentile end-to-end request latency from vLLM’s history: arrival until the request finishes. Includes queue wait, prefill, and decode—not just token generation speed.",
  itlP95:
    "95th percentile inter-token latency (time between successive output tokens) from vLLM’s history. Spikes mean decode stalls or contention; lower is smoother streaming.",
  mtpAccept:
    "Lifetime speculative / MTP acceptance rate (accepted draft tokens ÷ drafted tokens). Higher means speculative decoding is paying off; — when speculation is off or unused.",
} as const;

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

/** Elapsed ms → "12s" / "2m 14s" / "1h 3m" (console chip voice). */
export function fmtElapsedMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total - h * 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
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
  "Derived activity — queued: requests waiting > 0 · decoding: running + gen tok/s > 0 · prefilling: running + prefill tok/s > 0 · processing: running but both 0 (poll gap / cached-only). A long prefill on a big context also reads as processing with 0 tok/s: the engine reports prompt tokens only when the request finishes, so use the busy/output clocks. GPU busy while engine silent = weight loading, CUDA-graph capture, warmup or a foreign process → follow the live log.";

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
  // Word boundaries: unanchored /ok/ matched "token…" lines (the dominant
  // vLLM/sgLang log voice) and tinted them green as successes.
  const level: string | null = /\b(warn|warning|deprecat\w*)\b/.test(lower)
    ? "log-warn"
    : /\b(error|failed|failure|exception|traceback)\b/.test(lower)
      ? "log-err"
      : /\b(ok|ready|done|listening)\b/.test(lower)
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
