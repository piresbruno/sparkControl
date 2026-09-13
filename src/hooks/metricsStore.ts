import { useSyncExternalStore } from "react";
import type { SparkSnapshot } from "../api/types";

/**
 * Central metrics history store (idea #8b).
 *
 * Fed once per WebSocket snapshot by useSnapshot. Components read time-series
 * via `useMetricsHistory` / `useMetricsHistoryTail` — a single source of truth that:
 *   - survives Spark tab switches (history is no longer per-panel useState),
 *   - keeps wall-clock timestamps per sample ({ at, value }) so charts plot
 *     real time even when poll cadence varies (duplicate frames collapse,
 *     out-of-order frames never rewind chart time),
 *   - caps each series at HISTORY_MAX samples and prunes anything older than
 *     RETENTION_MS before the newest sample (≈1 h at the default 2 s poll),
 *   - keeps sparklines on a short tail (SPARKLINE_TAIL) so 84px charts stay readable.
 *
 * Also keeps the latest snapshot per spark (`getSpark` / `useSpark`) as the
 * selective-subscription seam (#8a).
 *
 * Reference-stability contract (required by useSyncExternalStore):
 * getSnapshot returns a *cached* value that only changes when that slice
 * actually changed. On each ingest we replace the per-key arrays with a new
 * ref, so subscribers to that key re-render and all others skip. All
 * listeners are woken on notify; unchanged keys keep the same ref → no render.
 */

/** One history sample: `at` is the source frame's wall-clock epoch ms. */
export interface MetricSample {
  at: number;
  value: number;
}

const HISTORY_MAX = 1800; // 1 h at 2 s poll — the WS interval, not wall-clock guarantees
/** Retention window: samples older than this before the newest sample are pruned. */
const RETENTION_MS = HISTORY_MAX * 2000;
/** Samples shown in inline sparklines (≈1 min at 2 s poll). Full series stays in HISTORY_MAX. */
export const SPARKLINE_TAIL = 30;

const history = new Map<string, MetricSample[]>(); // key: `${sparkId}:${metric}`
/** Cached values-only view of each series — stable ref per key for useMetricsHistory. */
const historyValues = new Map<string, readonly number[]>();
/** Cached last-N views — refreshed whenever the full series is replaced. */
const historyTails = new Map<string, readonly number[]>();
const sparkMap = new Map<string, SparkSnapshot>();
const listeners = new Set<() => void>();

const EMPTY: readonly number[] = Object.freeze([] as number[]);
const EMPTY_SAMPLES: readonly MetricSample[] = Object.freeze([] as MetricSample[]);

function notify() {
  for (const l of listeners) l();
}

export function subscribeMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setHistoryTail(key: string, samples: readonly MetricSample[]) {
  if (samples.length === 0) {
    historyTails.delete(key);
    return;
  }
  const tail = samples.length <= SPARKLINE_TAIL ? samples : samples.slice(-SPARKLINE_TAIL);
  historyTails.set(key, tail.map((s) => s.value));
}

/**
 * Append one timestamped sample. Duplicate timestamps replace (a repeated
 * frame is not two samples); older timestamps are ignored (never rewind
 * chart time); the series is capped at HISTORY_MAX and pruned to RETENTION_MS.
 */
function pushHistory(key: string, value: number, at: number) {
  const prev = history.get(key);
  let next: MetricSample[];
  if (!prev || prev.length === 0) {
    next = [{ at, value }];
  } else {
    const last = prev[prev.length - 1];
    if (at < last.at) return;
    if (at === last.at) {
      next = prev.slice();
      next[next.length - 1] = { at, value };
    } else if (prev.length >= HISTORY_MAX) {
      next = prev.slice(prev.length - HISTORY_MAX + 1);
      next.push({ at, value });
    } else {
      next = prev.slice();
      next.push({ at, value });
    }
    const floor = next[next.length - 1].at - RETENTION_MS;
    let drop = 0;
    while (drop < next.length && next[drop].at < floor) drop += 1;
    if (drop > 0) next = next.slice(drop);
  }
  history.set(key, next);
  historyValues.set(key, next.map((s) => s.value));
  setHistoryTail(key, next);
}

function removeHistoryForSpark(sparkId: string) {
  const prefix = `${sparkId}:`;
  for (const key of history.keys()) {
    if (key.startsWith(prefix)) {
      history.delete(key);
      historyValues.delete(key);
      historyTails.delete(key);
    }
  }
}

/** Ingest a full WS snapshot at wall-clock `at`: update latest-per-spark + append history series. */
export function ingestSnapshots(sparks: SparkSnapshot[], at: number = Date.now()): void {
  const alive = new Set<string>();

  for (const s of sparks) {
    alive.add(s.id);
    sparkMap.set(s.id, s);
    if (!s.online) continue; // don't record zero-samples for offline hosts
    const m = s.metrics;
    if (m.gpu) {
      pushHistory(`${s.id}:gpu.usage`, m.gpu.usage, at);
      pushHistory(`${s.id}:gpu.temp`, m.gpu.temperature, at);
    }
    if (m.cpu) {
      pushHistory(`${s.id}:cpu.usage`, m.cpu.usage, at);
      // Skip 0°C so a missing sensor does not draw a fake floor on the sparkline.
      if (m.cpu.temperature > 0) {
        pushHistory(`${s.id}:cpu.temp`, m.cpu.temperature, at);
      }
    }
    if (m.ram) {
      pushHistory(`${s.id}:ram.percentage`, m.ram.percentage, at);
    }
    if (m.unifiedMemory) {
      // DGX Spark gauges render the unified pool — trend it as its own series
      // so the Mem sparkline never plots a different metric than the number.
      pushHistory(`${s.id}:unifiedMemory.percentage`, m.unifiedMemory.percentage, at);
    }
    if (Array.isArray(m.llm)) {
      // Zip with snapshot.llmPorts so multi-port LLM series key distinctly.
      const ports = s.llmPorts ?? [];
      for (let i = 0; i < m.llm.length; i++) {
        const llm = m.llm[i];
        const port = ports[i];
        const portKey = port != null ? `:${port}` : `:${i}`;
        pushHistory(`${s.id}:llm${portKey}.tps`, llm.generationTps, at);
        pushHistory(`${s.id}:llm${portKey}.prefill`, llm.prefillTps, at);
        if (llm.cachedPrefillTps != null) {
          pushHistory(`${s.id}:llm${portKey}.prefillCached`, llm.cachedPrefillTps, at);
        }
        if (llm.uncachedPrefillTps != null) {
          pushHistory(`${s.id}:llm${portKey}.prefillUncached`, llm.uncachedPrefillTps, at);
        }
      }
    }
    if (m.comfy?.available) {
      pushHistory(`${s.id}:comfy.queue`, (m.comfy.queueRunning ?? 0) + (m.comfy.queuePending ?? 0), at);
    }
  }

  // Drop series for Sparks no longer in the registry (deleted / removed from WS).
  for (const id of [...sparkMap.keys()]) {
    if (!alive.has(id)) {
      sparkMap.delete(id);
      removeHistoryForSpark(id);
    }
  }

  // Always notify: sparkMap refs refresh every frame (online flips included),
  // even when no history sample was appended.
  notify();
}

/** Read the latest cached snapshot for a spark (subscribe via useSpark). */
export function getSpark(id: string): SparkSnapshot | undefined {
  return sparkMap.get(id);
}

/** Timestamped series for one spark metric — the chart-time source of truth. */
export function getMetricHistorySamples(sparkId: string, metric: string): readonly MetricSample[] {
  return history.get(`${sparkId}:${metric}`) ?? EMPTY_SAMPLES;
}

/** @internal getSnapshot for useMetricsHistory — stable ref per key. */
function getHistory(key: string): readonly number[] {
  return historyValues.get(key) ?? EMPTY;
}

function getHistoryTail(key: string): readonly number[] {
  return historyTails.get(key) ?? EMPTY;
}

/**
 * Subscribe to one metric's full history series for one spark (up to HISTORY_MAX).
 * Re-renders only when that specific (sparkId, metric) array ref changes.
 */
export function useMetricsHistory(sparkId: string, metric: string): readonly number[] {
  const key = `${sparkId}:${metric}`;
  return useSyncExternalStore(
    subscribeMetrics,
    () => getHistory(key),
    () => EMPTY
  );
}

/**
 * Last SPARKLINE_TAIL samples for inline sparklines. Prefer this over slicing
 * the full series in render — the tail ref is maintained at ingest time.
 */
export function useMetricsHistoryTail(sparkId: string, metric: string): readonly number[] {
  const key = `${sparkId}:${metric}`;
  return useSyncExternalStore(
    subscribeMetrics,
    () => getHistoryTail(key),
    () => EMPTY
  );
}

/**
 * Subscribe to one spark's latest snapshot. Re-renders when that spark's
 * cached object is replaced (every WS frame that includes it).
 */
export function useSpark(id: string): SparkSnapshot | undefined {
  return useSyncExternalStore(
    subscribeMetrics,
    () => sparkMap.get(id),
    () => undefined
  );
}

/** Clear all cached state — used on hard reload paths / tests. */
export function _resetStore(): void {
  history.clear();
  historyValues.clear();
  historyTails.clear();
  sparkMap.clear();
}
