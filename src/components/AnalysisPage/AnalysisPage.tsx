import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  listTraces,
  getTrace,
  clearTraces,
  fetchSparks,
} from "../../api/client";
import type { SparkConfig, TraceEntry } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { ANALYSIS_ID } from "../../constants";

const SOURCE_FILTERS = ["all", "proxy", "bench", "prefill-bench", "showcase"] as const;
type SourceFilter = (typeof SOURCE_FILTERS)[number];

const FOLLOW_POLL_MS = 1500;

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

function fmtNum(n: number | null | undefined, unit = ""): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k${unit}`;
  return `${n}${unit}`;
}

function statusPillClass(status: number | null): string {
  if (status == null) return "bench-status-pill bench-status-pill--failed";
  if (status < 400) return "bench-status-pill bench-status-pill--completed";
  return "bench-status-pill bench-status-pill--failed";
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

  // traceCapture setting (for the capture-off banner).
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setCaptureOn(s.traceCapture !== false))
      .catch(() => undefined);
  }, []);

  const fetchParams = useMemo(
    () => ({
      sparkId: sparkId || undefined,
      port: port ? Number(port) : undefined,
      source,
    }),
    [sparkId, port, source]
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

  const selectedSpark = sparkOptions.find((s) => s.id === sparkId) || null;
  const clientBase = sparkId && port ? `http://${window.location.host}/llm/${sparkId}/${port}` : null;

  return (
    <div className="analysis-page">
      <header className="flex flex-wrap items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-text-strong m-0">Analysis</h2>
        <select
          className="text-xs rounded border border-border bg-surface px-2 py-1"
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
          className="text-xs rounded border border-border bg-surface px-2 py-1"
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
      </header>

      {!captureOn && (
        <p className="text-xs text-[var(--color-warning)] mb-2">
          Trace capture is off in Settings — requests pass through without recording.
        </p>
      )}

      <div className="bench-results">
        <div className="bench-results__head" aria-hidden="true">
          <span>Time</span>
          <span>Spark:Port</span>
          <span>Request</span>
          <span>Model</span>
          <span>Status</span>
          <span>Tok/s</span>
          <span>TTFT</span>
          <span>Duration</span>
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
              className={`bench-result-row text-left w-full ${t.method === "GET" ? "opacity-60" : ""}`}
              onClick={() => setDetailId(t.id)}
            >
              <div className="grid grid-cols-9 gap-2 px-3 py-2 text-xs items-center">
                <span className="text-muted">{timeLabel(t.ts)}</span>
                <span>
                  {t.sparkId ?? "—"}:{t.port ?? "—"}
                </span>
                <span className="truncate" title={`${t.method} ${t.path}${t.query ? `?${t.query}` : ""}`}>
                  {t.method} {t.path}
                </span>
                <span className="truncate">{t.model ?? "—"}</span>
                <span className={statusPillClass(t.status)}>{t.status ?? "ERR"}</span>
                <span>
                  {t.completionTokens != null && t.durMs
                    ? ((t.completionTokens / (t.durMs - (t.ttftMs ?? 0) || t.durMs)) * 1000).toFixed(1)
                    : "—"}
                </span>
                <span>{t.ttftMs != null ? fmtNum(t.ttftMs, "ms") : "—"}</span>
                <span>{t.durMs != null ? fmtNum(t.durMs, "ms") : "—"}</span>
                <span className="text-muted">{t.source ?? "—"}</span>
              </div>
            </button>
          ))
        )}
      </div>

      <TraceDetailModal id={detailId} onClose={() => setDetailId(null)} keyedPort={Boolean(selectedSpark)} />
    </div>
  );
}

function TraceDetailModal({
  id,
  onClose,
  keyedPort,
}: {
  id: string | null;
  onClose: () => void;
  keyedPort: boolean;
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
                  <dd>{entry.ttftMs != null ? `${entry.ttftMs} ms` : "—"}</dd>
                  <dt className="text-muted">Duration</dt>
                  <dd>{entry.durMs != null ? `${entry.durMs} ms` : "—"}</dd>
                  <dt className="text-muted">Prompt tokens</dt>
                  <dd>{entry.promptTokens ?? "—"}{entry.tokensEstimated ? " (estimated)" : ""}</dd>
                  <dt className="text-muted">Completion tokens</dt>
                  <dd>{entry.completionTokens ?? "—"}{entry.tokensEstimated ? " (estimated)" : ""}</dd>
                  <dt className="text-muted">Finish reason</dt>
                  <dd>{entry.finishReason ?? "—"}</dd>
                  <dt className="text-muted">Model</dt>
                  <dd>{entry.model ?? "—"}</dd>
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
