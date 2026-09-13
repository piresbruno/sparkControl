import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  listTraces,
  getTrace,
  clearTraces,
  fetchSparks,
  fetchSettings,
  updateSettings,
  listLlmActive,
  listLlmClients,
  cancelInflight,
  stopAllLlm,
  getTraceStats,
  flushLlmClient,
} from "../../api/client";
import type {
  LlmActiveItem,
  LlmClientsResponse,
  SparkConfig,
  TraceEntry,
  TraceStatRow,
  TraceStatsResponse,
} from "../../api/types";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { useModalPresence } from "../../hooks/useModalPresence";
import { ANALYSIS_ID } from "../../constants";

const SOURCE_FILTERS = ["all", "proxy", "bench", "prefill-bench", "showcase"] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];

const FOLLOW_POLL_MS = 1500;

// Live & Clients panel: net-new poll timer (kept separate from the follow poll
// so trace follow semantics stay untouched).
const LIVE_POLL_MS = 2000;
const SEARCH_DEBOUNCE_MS = 300;

const SUMMARY_RANGES = [
  { key: "1h", label: "1h", ms: 3_600_000 },
  { key: "24h", label: "24h", ms: 86_400_000 },
  { key: "7d", label: "7d", ms: 7 * 86_400_000 },
] as const;
type SummaryRange = (typeof SUMMARY_RANGES)[number]["key"];

const SOURCE_BADGE_CLASS: Record<string, string> = {
  proxy: "analysis-live__badge--proxy",
  "decode-bench": "analysis-live__badge--bench",
  "prefill-bench": "analysis-live__badge--bench",
  showcase: "analysis-live__badge--showcase",
};

const CANCEL_LIMITS_HELP =
  "Cancel limits: streaming requests abort server-side generation when cancelled. " +
  "Non-streaming cancel only closes the proxy socket — the engine keeps decoding to completion. " +
  "Cancel before the first response byte → client gets a 502; after → truncated stream.";

interface SparkOption {
  id: string;
  name: string;
  ports: number[];
  keyedPorts: number[];
}

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}

function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

/** 380 → "380ms", 3800 → "3.80s", 75.4s → "1m 15s" (same convention as the bench dialogs' formatTtft). */
function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** Post-first-token decode tok/s: completion tokens over (duration − TTFT). */
function tpsLabel(t: TraceEntry): string {
  if (t.completionTokens == null || !t.durMs) return "—";
  const genMs = t.durMs - (t.ttftMs ?? 0) || t.durMs;
  return ((t.completionTokens / genMs) * 1000).toFixed(1);
}

function statusPillClass(status: number | null): string {
  if (status == null) return "bench-status-pill bench-status-pill--failed";
  if (status < 400) return "bench-status-pill bench-status-pill--completed";
  return "bench-status-pill bench-status-pill--failed";
}

/** Bench/showcase progress label: message first, then streamed-token estimate. */
function progressLabel(it: LlmActiveItem): string {
  const p = it.progress ?? {};
  if (p.message) return p.message;
  if (p.tokensSoFar != null) return `${p.tokensSoFar} tok${p.estimate ? " (est)" : ""}`;
  return "—";
}

/** Trace-table client cell: label when known, else the clientId prefix. */
function clientCell(clientId: string | null, labels: Record<string, string>): string {
  if (!clientId) return "—";
  return labels[clientId] || clientId.slice(0, 8);
}

/** Trace-table tools cell: used tool names, falling back to requested ones. */
function toolsCell(t: TraceEntry): string {
  if (t.toolsUsed && t.toolsUsed.length > 0) return t.toolsUsed.map((x) => x.name).join(", ");
  if (t.toolsReq && t.toolsReq.length > 0) return t.toolsReq.join(", ");
  return "—";
}

function pct(part: number, total: number): string {
  if (!total) return "—";
  return `${Math.round((part / total) * 100)}%`;
}

export function AnalysisPage() {
  const [sparkOptions, setSparkOptions] = useState<SparkOption[]>([]);
  // Init from ?spark=&port= URL params on mount.
  const [sparkId, setSparkId] = useState<string>(() => new URLSearchParams(window.location.search).get("spark") || "");
  const [port, setPort] = useState<string>(() => new URLSearchParams(window.location.search).get("port") || "");
  const [source, setSource] = useState<SourceFilter>("all");
  const [follow, setFollow] = useState(true);
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [captureOn, setCaptureOn] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [view, setView] = useState<"traces" | "summary">("traces");
  // A4 Live & Clients state.
  const [activeItems, setActiveItems] = useState<LlmActiveItem[]>([]);
  const [llmClients, setLlmClients] = useState<LlmClientsResponse | null>(null);
  const [clientLabels, setClientLabels] = useState<Record<string, string>>({});
  /** Mirror for stable reads inside callbacks (label saves merge over it). */
  const clientLabelsRef = useRef<Record<string, string>>({});
  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [flushClientId, setFlushClientId] = useState<string | null>(null);
  // A4 search (debounced) + clientId drill-down filter.
  const [searchInput, setSearchInput] = useState("");
  const [searchQ, setSearchQ] = useState<string | undefined>(undefined);
  const [clientIdFilter, setClientIdFilter] = useState<string | undefined>(undefined);
  // A4 Summary tab state.
  const [summaryRange, setSummaryRange] = useState<SummaryRange>("24h");
  const [stats, setStats] = useState<TraceStatsResponse | null>(null);
  // Tick counter to recompute live elapsed times between polls.
  const [, setTick] = useState(0);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    lastSeqRef.current = lastSeq;
  }, [lastSeq]);

  // Spark list for the pickers (configs carry llmPorts + keyed ports).
  useEffect(() => {
    fetchSparks()
      .then(({ sparks }: { sparks: SparkConfig[] }) => {
        setSparkOptions(
          sparks.map((c) => ({
            id: c.id,
            name: c.name,
            ports: c.llmPorts ?? (c.llmPort ? [c.llmPort] : []),
            keyedPorts: [],
          }))
        );
      })
      .catch((err) => console.error("Analysis: failed to load sparks:", err));
  }, []);

  // Settings (traceCapture + clientLabels) — via client.ts, not a raw fetch.
  useEffect(() => {
    fetchSettings()
      .then((s) => {
        setCaptureOn(s.traceCapture !== false);
        setClientLabels(s.clientLabels ?? {});
        clientLabelsRef.current = s.clientLabels ?? {};
      })
      .catch(() => undefined);
  }, []);

  // Debounce the search box before it hits listTraces (?q=).
  useEffect(() => {
    const t = setTimeout(() => setSearchQ(searchInput.trim() || undefined), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchParams = useMemo(
    () => ({
      sparkId: sparkId || undefined,
      port: port ? Number(port) : undefined,
      source,
      q: searchQ,
      clientId: clientIdFilter,
    }),
    [sparkId, port, source, searchQ, clientIdFilter]
  );

  const loadFull = useCallback(async () => {
    try {
      const res = await listTraces({ ...fetchParams, limit: 200 });
      setTraces(res.traces);
      setLastSeq(res.lastSeq);
    } catch (err) {
      console.error("Analysis: list failed:", err);
    }
  }, [fetchParams]);

  // Initial + filter-change load.
  useEffect(() => {
    void loadFull();
  }, [loadFull]);

  // Live-follow poll (?since=).
  useEffect(() => {
    if (!follow || !captureOn) return;
    const t = setInterval(async () => {
      try {
        const res = await listTraces({ ...fetchParams, since: lastSeqRef.current, limit: 200 });
        if (res.traces.length > 0) {
          setTraces((prev) => [...res.traces, ...prev].slice(0, 500));
          setLastSeq(res.lastSeq);
        } else if (res.lastSeq > lastSeqRef.current) {
          setLastSeq(res.lastSeq);
        }
      } catch {
        /* poll errors non-fatal */
      }
    }, FOLLOW_POLL_MS);
    return () => clearInterval(t);
  }, [follow, captureOn, fetchParams]);

  const handleClear = useCallback(async () => {
    try {
      await clearTraces();
      await loadFull();
    } catch (err) {
      console.error("Analysis: clear failed:", err);
    }
  }, [loadFull]);

  // A4 Live & Clients poll — fetches active LLM work + live clients on one timer.
  // Net-new visibility gate: pause while the tab is hidden, refetch on return.
  useEffect(() => {
    let alive = true;
    const spark = sparkId || undefined;
    const load = async () => {
      if (document.hidden) return;
      try {
        const [active, clients] = await Promise.all([
          listLlmActive({ sparkId: spark }),
          listLlmClients({ sparkId: spark }),
        ]);
        if (!alive) return;
        setActiveItems(active.items);
        setLlmClients(clients);
      } catch (err) {
        console.error("Analysis: live poll failed:", err);
      }
    };
    void load();
    const t = setInterval(load, LIVE_POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sparkId]);

  // Live elapsed times: recompute from startedAt on a 1s tick while rows exist.
  useEffect(() => {
    if (activeItems.length === 0) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [activeItems.length]);

  // A4 Summary tab stats for the selected range.
  useEffect(() => {
    if (view !== "summary") return;
    const range = SUMMARY_RANGES.find((r) => r.key === summaryRange);
    if (!range) return;
    let stale = false;
    getTraceStats({ sparkId: sparkId || undefined, since: Date.now() - range.ms })
      .then((s) => {
        if (!stale) setStats(s);
      })
      .catch((err) => console.error("Analysis: stats failed:", err));
    return () => {
      stale = true;
    };
  }, [view, summaryRange, sparkId]);

  // A4 handlers.
  const handleCancelInflight = useCallback(
    async (id: string) => {
      try {
        await cancelInflight(id);
        // Optimistic removal only — the 2 s poll reconciles both lists.
        // An un-awaited refetch here can still contain the id (the server
        // unregisters on the async terminal path) and would flicker the row.
        setActiveItems((prev) => prev.filter((it) => it.id !== id));
      } catch (err) {
        console.error("Analysis: cancel failed:", err);
      }
    },
    [sparkId]
  );

  const handleStopAll = useCallback(async () => {
    try {
      const res = await stopAllLlm({ sparkId: sparkId || undefined, reason: "stop-all (ui)" });
      setLiveNotice(
        `Stopped: ${res.showcase} showcase, ${res.decodeBench} decode bench, ${res.prefillBench} prefill bench, ${res.proxy} proxy`
      );
    } catch (err) {
      console.error("Analysis: stop-all failed:", err);
      setLiveNotice("Stop-all failed");
    }
  }, [sparkId]);

  const handleFlushClient = useCallback(async (clientId: string) => {
    try {
      const res = await flushLlmClient(clientId);
      setLiveNotice(`Flushed ${res.cancelled} in-flight request(s) for ${clientId}`);
    } catch (err) {
      console.error("Analysis: flush failed:", err);
      setLiveNotice("Flush failed");
    }
  }, []);

  const handleLabelSave = useCallback(
    async (clientId: string, label: string) => {
      try {
        // PUT /api/settings shallow-merges top-level keys, so clientLabels
        // must be sent whole — merge over the current map or the other
        // clients' labels would be wiped.
        const merged = { ...clientLabelsRef.current, [clientId]: label };
        const s = await updateSettings({ clientLabels: merged });
        setClientLabels(s.clientLabels ?? {});
        clientLabelsRef.current = s.clientLabels ?? {};
      } catch (err) {
        console.error("Analysis: label save failed:", err);
      }
    },
    []
  );

  const openTracesForClient = useCallback((clientId: string) => {
    setClientIdFilter(clientId);
    setView("traces");
  }, []);

  const selectedSpark = sparkOptions.find((s) => s.id === sparkId) || null;
  const clientBase = sparkId && port ? `http://${window.location.host}/llm/${sparkId}/${port}` : null;

  return (
    <div className="analysis-page">
      <header className="flex flex-wrap items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-text-strong m-0">Analysis</h2>
        <select
          className="select-inline text-xs rounded border border-border bg-surface px-2 py-1"
          value={sparkId}
          onChange={(e) => setSparkId(e.target.value)}
          aria-label="Spark"
        >
          <option value="">All sparks</option>
          {sparkOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          className="select-inline text-xs rounded border border-border bg-surface px-2 py-1"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          aria-label="Port"
        >
          <option value="">All ports</option>
          {(selectedSpark?.ports ?? []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setSource(f)}
              className={`text-xs rounded-full px-2.5 py-1 border ${
                source === f
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-surface text-muted"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted ml-1">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Live
        </label>
        <button type="button" className="text-xs rounded border border-border bg-surface px-2.5 py-1 text-muted" onClick={() => void handleClear()}>
          Clear
        </button>
        {clientBase && (
          <code
            className="text-xs text-muted cursor-pointer hover:text-text"
            title="Click to copy client base URL (point clients at this base_url)"
            onClick={() => void navigator.clipboard?.writeText(clientBase)}
          >
            {clientBase}
          </code>
        )}
        {view === "traces" && clientIdFilter && (
          <button
            type="button"
            onClick={() => setClientIdFilter(undefined)}
            className="text-xs rounded-full px-2.5 py-1 border border-accent bg-accent-soft text-accent"
            title="Clear client filter"
          >
            client: {clientCell(clientIdFilter, clientLabels)} ×
          </button>
        )}
        {view === "traces" && (
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search bodies…"
            aria-label="Search traces"
            className="text-xs rounded border border-border bg-surface px-2 py-1 w-44"
          />
        )}
        <div className="flex items-center gap-1 ml-auto">
          {(["traces", "summary"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`text-xs rounded-full px-3 py-1 border capitalize ${
                view === v ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </header>

      {!captureOn && (
        <p className="text-xs text-[var(--color-warning)] mb-2">
          Trace capture is off in Settings — requests pass through without recording.
        </p>
      )}

      {view === "traces" && (
        <div className="analysis-live">
          <div className="analysis-live__header">
            <h3 className="analysis-live__title">Live &amp; Clients</h3>
            <span className="analysis-live__help" title={CANCEL_LIMITS_HELP} aria-label="Cancel limits">
              ?
            </span>
            <button
              type="button"
              className="ml-auto text-xs rounded border border-border bg-surface px-2.5 py-1 text-muted"
              onClick={() => setStopAllOpen(true)}
            >
              Stop all
            </button>
          </div>
          {activeItems.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">No active LLM requests.</p>
          ) : (
            activeItems.map((it) => (
              <div key={`${it.source}:${it.id}`} className="analysis-live__row">
                <span className={`analysis-live__badge ${SOURCE_BADGE_CLASS[it.source] ?? ""}`}>{it.source}</span>
                <span className="truncate">
                  {it.sparkId}
                  {it.port != null ? `:${it.port}` : ""}
                </span>
                <span className="truncate">{it.model ?? "—"}</span>
                {it.source === "proxy" ? (
                  <span className="truncate" title={it.path ?? undefined}>
                    {it.path ?? "—"}
                  </span>
                ) : (
                  <span className="truncate text-muted">{progressLabel(it)}</span>
                )}
                <span className="analysis-table__num font-tabular">{fmtMs(Math.max(0, Date.now() - it.startedAt))}</span>
                {it.cancelable && (
                  <button
                    type="button"
                    className="text-xs rounded border border-border bg-surface px-2 py-0.5 text-muted"
                    aria-label={`Cancel ${it.id}`}
                    onClick={() => void handleCancelInflight(it.id)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))
          )}
          {llmClients && (
            <div className="analysis-clients">
              <p className="px-3 pt-2 pb-1 text-xs text-muted">
                {llmClients.dashboardClients} dashboard tab(s) connected
              </p>
              {llmClients.clients.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted">No proxied clients in flight.</p>
              ) : (
                llmClients.clients.map((c) => (
                  <div key={c.clientId} className="analysis-clients__item">
                    <div className="analysis-clients__row">
                      <input
                        className="analysis-clients__label"
                        defaultValue={c.label ?? ""}
                        placeholder={c.clientId.slice(0, 8)}
                        aria-label={`Label for ${c.clientId}`}
                        onBlur={(e) => {
                          if (e.target.value !== (c.label ?? "")) void handleLabelSave(c.clientId, e.target.value);
                        }}
                      />
                      <span className="analysis-table__num font-tabular">{c.inflightCount}</span>
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          type="button"
                          className="text-xs rounded border border-border bg-surface px-2 py-0.5 text-muted"
                          onClick={() => setExpandedClient(expandedClient === c.clientId ? null : c.clientId)}
                        >
                          {expandedClient === c.clientId ? "Hide" : "Requests"}
                        </button>
                        <button
                          type="button"
                          className="text-xs rounded border border-border bg-surface px-2 py-0.5 text-muted"
                          onClick={() => openTracesForClient(c.clientId)}
                        >
                          Traces
                        </button>
                        <button
                          type="button"
                          className="text-xs rounded border border-border bg-surface px-2 py-0.5 text-muted"
                          onClick={() => setFlushClientId(c.clientId)}
                        >
                          Flush
                        </button>
                      </div>
                    </div>
                    {expandedClient === c.clientId &&
                      c.inflight.map((r) => (
                        <div key={r.id} className="analysis-clients__req">
                          <span className="truncate">
                            {r.model ?? "—"} {r.path ?? ""} {r.stream ? "(stream)" : ""}
                          </span>
                          <span className="analysis-table__num font-tabular">
                            {r.tokensEst != null ? `${r.tokensEst} tok` : "—"}
                          </span>
                          <span className="analysis-table__num font-tabular">{fmtMs(Math.max(0, Date.now() - r.startedAt))}</span>
                          <button
                            type="button"
                            className="text-xs rounded border border-border bg-surface px-2 py-0.5 text-muted"
                            aria-label={`Cancel ${r.id}`}
                            onClick={() => void handleCancelInflight(r.id)}
                          >
                            Cancel
                          </button>
                        </div>
                      ))}
                  </div>
                ))
              )}
            </div>
          )}
          {liveNotice && <p className="px-3 py-2 text-xs text-muted">{liveNotice}</p>}
        </div>
      )}

      {view === "summary" && (
        <div className="analysis-summary">
          <div className="flex items-center gap-1 mb-2">
            {SUMMARY_RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setSummaryRange(r.key)}
                className={`text-xs rounded-full px-2.5 py-1 border ${
                  summaryRange === r.key ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          {stats ? (
            <>
              <div className="analysis-summary__cards">
                <div className="analysis-card">
                  <span className="analysis-card__label">Requests</span>
                  <span className="analysis-card__value">{stats.totals.requests}</span>
                </div>
                <div className="analysis-card">
                  <span className="analysis-card__label">Tokens</span>
                  <span className="analysis-card__value">{stats.totals.promptTokens + stats.totals.completionTokens}</span>
                </div>
                <div className="analysis-card">
                  <span className="analysis-card__label">Cache hit</span>
                  <span className="analysis-card__value">{pct(stats.totals.cachedTokens, stats.totals.promptTokens)}</span>
                </div>
                <div className="analysis-card">
                  <span className="analysis-card__label">Errors</span>
                  <span className="analysis-card__value">{pct(stats.totals.errors, stats.totals.requests)}</span>
                </div>
                <div className="analysis-card">
                  <span className="analysis-card__label">Avg TTFT</span>
                  <span className="analysis-card__value">{fmtMs(stats.totals.avgTtftMs)}</span>
                </div>
              </div>
              <div className="analysis-summary__grid">
                <StatTable title="By client" rows={stats.byClient} labels={clientLabels} onRowClick={openTracesForClient} />
                <StatTable title="By model" rows={stats.byModel} />
                <StatTable title="By tool" rows={stats.byTool} />
                <StatTable title="By path" rows={stats.byPath} />
              </div>
              <HourlyHistogram rows={stats.byHour} />
            </>
          ) : (
            <p className="text-xs text-muted">Loading…</p>
          )}
        </div>
      )}

      {view === "traces" && (
        <>
      <div className="bench-results bench-results--analysis">
        <div className="analysis-table__head" aria-hidden="true">
          <span>Time</span>
          <span>Spark:Port</span>
          <span>Client</span>
          <span>Request</span>
          <span>Model</span>
          <span>Tools</span>
          <span>Status</span>
          <span className="analysis-table__num">Tok/s</span>
          <span className="analysis-table__num">TTFT</span>
          <span className="analysis-table__num">Duration</span>
          <span>Source</span>
        </div>
        {traces.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">
            No traces yet. Point an OpenAI-compatible client at the base URL above.
          </div>
        ) : (
          traces.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`analysis-table__row ${t.method === "GET" ? "opacity-60" : ""}`}
              onClick={() => setDetailId(t.id)}
            >
              <span className="text-muted font-tabular">{timeLabel(t.ts)}</span>
              <span className="truncate">
                {t.sparkId ?? "—"}:{t.port ?? "—"}
              </span>
              <span className="truncate" title={t.clientId ?? undefined}>
                {clientCell(t.clientId, clientLabels)}
              </span>
              <span className="truncate" title={`${t.method} ${t.path}${t.query ? `?${t.query}` : ""}`}>
                {t.method} {t.path}
              </span>
              <span className="truncate">{t.model ?? "—"}</span>
              <span className="truncate" title={toolsCell(t)}>
                {toolsCell(t)}
              </span>
              <span className={`analysis-table__pill ${statusPillClass(t.status)}`}>{t.status ?? "ERR"}</span>
              <span className="analysis-table__num font-tabular">{tpsLabel(t)}</span>
              <span className="analysis-table__num font-tabular">{fmtMs(t.ttftMs)}</span>
              <span className="analysis-table__num font-tabular">{fmtMs(t.durMs)}</span>
              <span className="text-muted">{t.source ?? "—"}</span>
            </button>
          ))
        )}
      </div>
        </>
      )}

      <TraceDetailModal id={detailId} onClose={() => setDetailId(null)} keyedPort={Boolean(selectedSpark)} clientLabels={clientLabels} />
      <ConfirmShutdownDialog
        open={stopAllOpen}
        onClose={() => setStopAllOpen(false)}
        onConfirm={handleStopAll}
        title="stop all LLM requests"
        description={
          sparkId
            ? `Cancels every in-flight proxy request and running bench/showcase job on ${sparkId}.`
            : "Cancels every in-flight proxy request and running bench/showcase job across all sparks."
        }
        confirmLabel="Confirm stop-all"
        confirmPhrase="stopall"
        warningNote="In-flight requests are destroyed immediately. Streaming generations abort server-side; non-streaming engines keep decoding."
      />
      <ConfirmShutdownDialog
        open={flushClientId != null}
        onClose={() => setFlushClientId(null)}
        onConfirm={() => handleFlushClient(flushClientId ?? "")}
        title="flush client requests"
        description={`Cancels all in-flight requests from client ${flushClientId ?? ""}.`}
        confirmLabel="Confirm flush"
        confirmPhrase="flush"
        warningNote="Each cancelled request is recorded as cancelled (flush client). The client sees a 502 before the first response byte, a truncated stream after."
      />
    </div>
  );
}

function StatTable({
  title,
  rows,
  labels,
  onRowClick,
}: {
  title: string;
  rows: TraceStatRow[];
  labels?: Record<string, string>;
  onRowClick?: (key: string) => void;
}) {
  return (
    <div className="analysis-stat">
      <h4 className="analysis-stat__title">{title}</h4>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted">No data.</p>
      ) : (
        <>
          <div className="analysis-stat__head" aria-hidden="true">
            <span>Key</span>
            <span className="analysis-table__num">Req</span>
            <span className="analysis-table__num">Tokens</span>
            <span className="analysis-table__num">Err</span>
            <span className="analysis-table__num">Avg TTFT</span>
          </div>
          {rows.map((r) => {
            const cells = (
              <>
                <span className="truncate">{labels?.[r.key] || r.key}</span>
                <span className="analysis-table__num font-tabular">{r.requests}</span>
                <span className="analysis-table__num font-tabular">{r.promptTokens + r.completionTokens}</span>
                <span className="analysis-table__num font-tabular">{r.errors}</span>
                <span className="analysis-table__num font-tabular">{fmtMs(r.avgTtftMs)}</span>
              </>
            );
            return onRowClick ? (
              <button
                key={r.key}
                type="button"
                className="analysis-stat__row"
                aria-label={`Filter traces by client ${r.key}`}
                onClick={() => onRowClick(r.key)}
              >
                {cells}
              </button>
            ) : (
              <div key={r.key} className="analysis-stat__row">
                {cells}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function HourlyHistogram({ rows }: { rows: TraceStatRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.requests));
  return (
    <div className="analysis-histogram">
      <h4 className="analysis-stat__title">Requests by hour</h4>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted">No data.</p>
      ) : (
        <div className="analysis-histogram__bars">
          {rows.map((r) => (
            <div key={r.key} className="analysis-histogram__slot" title={`${r.key}: ${r.requests} requests`}>
              <div
                className="analysis-histogram__bar"
                style={{ height: `${Math.round((r.requests / max) * 100)}%` }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TraceDetailModal({
  id,
  onClose,
  keyedPort,
  clientLabels,
}: {
  id: string | null;
  onClose: () => void;
  keyedPort: boolean;
  clientLabels: Record<string, string>;
}) {
  const [entry, setEntry] = useState<TraceEntry | null>(null);
  const [tab, setTab] = useState<"request" | "response" | "timing">("request");
  const [copied, setCopied] = useState(false);
  const { mounted, visible } = useModalPresence(id != null);
  useEscape(onClose, id != null);
  useBodyScrollLock(id != null);

  useEffect(() => {
    if (!id) {
      setEntry(null);
      return;
    }
    getTrace(id)
      .then(setEntry)
      .catch((err) => console.error("Analysis: detail failed:", err));
  }, [id]);

  if (!mounted) return null;

  const copyAsCurl = () => {
    if (!entry) return;
    const body = entry.reqBody || "";
    const auth = keyedPort ? `-H "Authorization: Bearer $LLM_API_KEY" ` : "";
    const curl = `curl -X POST ${entry.reqBody ? `'http://${window.location.host}/llm/${entry.sparkId}/${entry.port}${entry.path}'` : `http://${window.location.host}/llm/${entry.sparkId}/${entry.port}${entry.path}`} ${auth}-H 'content-type: application/json' -d '${body.replace(/'/g, `'\\''`)}'`;
    void navigator.clipboard?.writeText(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const dialog = (
    <div className={`bench-overlay ${visible ? "is-open" : ""}`} onClick={onClose}>
      <div className="bench-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="bench-sheet__header">
          <h3 className="bench-sheet__title">
            {entry ? `${entry.method} ${entry.path}` : "Trace"}
          </h3>
          <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="bench-sheet__body">
          {entry ? (
            <>
              <div className="flex gap-1 mb-2">
                {(["request", "response", "timing"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`text-xs rounded-full px-3 py-1 border capitalize ${
                      tab === t ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted"
                    }`}
                  >
                    {t}
                  </button>
                ))}
                <button type="button" className="bench-btn bench-btn--ghost ml-auto" onClick={copyAsCurl}>
                  {copied ? "Copied!" : "Copy as curl"}
                </button>
              </div>
              {tab === "request" && (
                <pre className="trace-body__pre">{entry.reqBody ?? "(body not captured)"}</pre>
              )}
              {tab === "response" && (
                <pre className="trace-body__pre">{entry.resText ?? "(body not captured)"}</pre>
              )}
              {tab === "timing" && (
                <dl className="text-xs grid grid-cols-2 gap-1">
                  <dt className="text-muted">Status</dt>
                  <dd>{entry.status ?? `error: ${entry.error ?? "unknown"}`}</dd>
                  <dt className="text-muted">TTFT</dt>
                  <dd>{fmtMs(entry.ttftMs)}</dd>
                  <dt className="text-muted">Duration</dt>
                  <dd>{fmtMs(entry.durMs)}</dd>
                  <dt className="text-muted">Prompt tokens</dt>
                  <dd>{entry.promptTokens ?? "—"}{entry.tokensEstimated ? " (estimated)" : ""}</dd>
                  <dt className="text-muted">Completion tokens</dt>
                  <dd>{entry.completionTokens ?? "—"}{entry.tokensEstimated ? " (estimated)" : ""}</dd>
                  <dt className="text-muted">Finish reason</dt>
                  <dd>{entry.finishReason ?? "—"}</dd>
                  <dt className="text-muted">Model</dt>
                  <dd>{entry.model ?? "—"}</dd>
                  <dt className="text-muted">Client</dt>
                  <dd>{entry.clientId ? clientCell(entry.clientId, clientLabels) : "—"}</dd>
                  <dt className="text-muted">Cached tokens</dt>
                  <dd>{entry.cachedTokens ?? "—"}</dd>
                  <dt className="text-muted">Tools (requested)</dt>
                  <dd>{entry.toolsReq?.length ? entry.toolsReq.join(", ") : "—"}</dd>
                  <dt className="text-muted">Tools (used)</dt>
                  <dd>{entry.toolsUsed?.length ? entry.toolsUsed.map((t) => `${t.name}×${t.count}`).join(", ") : "—"}</dd>
                  <dt className="text-muted">Body truncated</dt>
                  <dd>{entry.bodyTruncated == null ? "—" : entry.bodyTruncated ? "yes" : "no"}</dd>
                </dl>
              )}
            </>
          ) : (
            <p className="text-xs text-muted">Loading…</p>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
