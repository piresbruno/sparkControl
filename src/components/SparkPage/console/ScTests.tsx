/**
 * CH·04 Tests — self-runs against the engine in CH·02.
 * Three instrument cards (Showcase / Decode bench / Prefill bench), each with
 * the Analysis source tag it stamps on its traces (traceMeta.source:
 * "showcase" / "bench" / "prefill-bench"). Showcase stays reachable without a
 * live engine (legacy contract: view history / prepare a run); the benches
 * require one. modelId is NOT required client-side — the server resolves it
 * from the engine (index.js ~1514). Markup mirrors mockups/node-detail-v3.html CH·04.
 */
import { useState, type CSSProperties } from "react";
import { ScModule } from "./ScKit";
import { useActivePrefillBench } from "./useActivePrefillBench";
import { BenchmarkDialog } from "../BenchmarkDialog";
import { PrefillBenchDialog } from "../PrefillBenchDialog";
import { formatContextSize, formatTtft } from "../../../shared/prefillBench.js";
import { parseLlmTargetInput } from "../../../shared/llmTarget.js";
import type { LlmBenchTarget, PrefillBenchJob } from "../../../api/types";

interface ScTestsProps {
  sparkId: string;
  /** Unit display name — lands on the benchmark share card. */
  sparkName?: string | null;
  /** null when LLM monitoring is off */
  primaryPort: number | null;
  modelId: string | null;
  contextLength: number | null;
  llmAvailable: boolean;
  /** Settings → Benchmark share image: the copy button also carries the card. */
  shareImage?: boolean;
}

const REMOTE_STORAGE_KEY = "sparkdash.remote-bench-target";

/** Typed on-demand bench target survives reloads (LlmPanel parity). */
function readStoredRemote(): { host: string; port: string; tls: boolean } {
  try {
    const raw = localStorage.getItem(REMOTE_STORAGE_KEY);
    if (!raw) return { host: "", port: "443", tls: true };
    const v = JSON.parse(raw) as { host?: string; port?: number; tls?: boolean };
    return {
      host: typeof v.host === "string" ? v.host : "",
      port: v.port != null ? String(v.port) : "443",
      tls: v.tls !== false,
    };
  } catch {
    return { host: "", port: "443", tls: true };
  }
}

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  background: "var(--color-surface-elevated)",
  color: "var(--color-text)",
  padding: "3px 7px",
  fontSize: "var(--fs-11)",
};

/** Responsive card grid (stacks naturally on narrow viewports). */
const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  gap: "var(--gap, 10px)",
  alignItems: "stretch",
};

const CARD_STYLE: CSSProperties = { gap: "var(--space-2)" };
const OFF_TITLE = "No engine running";
const NO_PORT_TITLE = "No LLM port configured — enable LLM monitoring for this node";

/**
 * Chip line: level progress, the size being measured right now with how long
 * it has been running, and the throughput of the last level that finished.
 * Prefill is not streamed, so elapsed time (not a percentage) is the only
 * intra-level signal that exists — the poll drives the re-render, so the
 * clock ticks once per second while a run is in flight.
 */
function prefillChipLabel(job: PrefillBenchJob): string {
  const parts = [
    "running",
    `${job.progress.completedLevels}/${job.progress.totalLevels}`,
  ];
  if (job.progress.currentContext != null) {
    parts.push(formatContextSize(job.progress.currentContext));
    if (job.progress.levelStartedAt != null) {
      parts.push(formatElapsed(Date.now() - job.progress.levelStartedAt));
    }
  }
  const last = job.results[job.results.length - 1];
  if (last && last.prefillTps > 0) parts.push(`${Math.round(last.prefillTps)} tok/s`);
  return parts.join(" · ");
}

/** Compact duration for the chip: `42s`, `1m 12s`, `36m`. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/** Abort ceilings round up — the cap is an upper bound. */
function formatCap(ms: number): string {
  return `${Math.ceil(ms / 60_000)}m`;
}

/** Hover detail: phase message (with the in-flight timer and its cap) + one line per measured level. */
function prefillChipTitle(job: PrefillBenchJob): string {
  const lines: string[] = [];
  if (job.progress.currentContext != null && job.progress.levelStartedAt != null) {
    const elapsed = formatElapsed(Date.now() - job.progress.levelStartedAt);
    const cap =
      job.progress.timeoutMs != null
        ? `, cap ${formatCap(job.progress.timeoutMs)}`
        : "";
    lines.push(
      `Prefilling ${formatContextSize(job.progress.currentContext)} for ${elapsed}${cap}`
    );
  } else {
    lines.push(job.progress.message || "Prefill benchmark running");
  }
  for (const r of job.results) {
    lines.push(
      `${formatContextSize(r.targetTokens)} · ${r.prefillTps.toFixed(1)} tok/s · TTFT ${formatTtft(r.ttftMs)}`
    );
  }
  return lines.join("\n");
}

export function ScTests({
  sparkId,
  sparkName = null,
  primaryPort,
  modelId,
  contextLength,
  llmAvailable,
  shareImage = false,
}: ScTestsProps) {
  const [benchOpen, setBenchOpen] = useState(false);
  const [prefillOpen, setPrefillOpen] = useState(false);
  // Bench target: null = this Spark's LLM; set = typed on-demand endpoint.
  const [remoteTarget, setRemoteTarget] = useState<LlmBenchTarget | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [hostDraft, setHostDraft] = useState(() => readStoredRemote().host);
  const [portDraft, setPortDraft] = useState(() => readStoredRemote().port);
  const [tls, setTls] = useState(() => readStoredRemote().tls);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const persistRemote = (t: LlmBenchTarget) => {
    try {
      localStorage.setItem(REMOTE_STORAGE_KEY, JSON.stringify(t));
    } catch {
      /* ignore */
    }
  };

  /** Normalise the host field on blur; leave it as typed if it is not yet valid. */
  const applyHostBlur = () => {
    if (!hostDraft.trim()) return;
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
    } catch {
      /* leave as typed until Run */
    }
  };

  const launchRemote = (kind: "decode" | "prefill") => {
    try {
      const p = parseLlmTargetInput(hostDraft, portDraft, tls);
      persistRemote(p);
      setHostDraft(p.host);
      setPortDraft(String(p.port));
      setTls(p.tls);
      setRemoteError(null);
      setRemoteTarget(p);
      if (kind === "decode") setBenchOpen(true);
      else setPrefillOpen(true);
    } catch (err: unknown) {
      setRemoteError(err instanceof Error ? err.message : String(err));
    }
  };
  // Live "prefill bench running" feedback: a run takes minutes and the dialog
  // may be closed, so the channel reports it (poll-based, no server change).
  // The button then opens the dialog attached to the active run — the server
  // rejects a second concurrent bench with 409 anyway.
  const activePrefill = useActivePrefillBench(sparkId, primaryPort);
  const prefillRunning = activePrefill?.status === "running";
  // Showcase: works offline to view history (legacy LlmPanel contract).
  const showcaseUp = primaryPort != null;
  // Benches: need a live endpoint; the server fills in the model id.
  const engineUp = llmAvailable && primaryPort != null;
  const showcaseUrl = `/showcase/${encodeURIComponent(sparkId)}`;

  return (
    <div className="col-full">
      <div style={GRID_STYLE}>
        {/* ── TST·01 Showcase ─────────────────────────────────────────── */}
        <ScModule label="Showcase" className="test-card" style={CARD_STYLE}>
          <div className="test-card__head">
            <span className="test-card__code">TST·01</span>
            <span className="test-card__title">Showcase</span>
          </div>
          <p className="test-card__desc">
            LLM prompt showcase with side-by-side model comparison streaming.
          </p>
          <div className="row">
            {showcaseUp ? (
              <a
                className="key"
                href={showcaseUrl}
                style={{ textDecoration: "none" }}
                title="Open the Showcase view"
              >
                Open Showcase →
              </a>
            ) : (
              <span
                className="key"
                aria-disabled="true"
                title={NO_PORT_TITLE}
                style={{ opacity: 0.5, cursor: "not-allowed" }}
              >
                Open Showcase →
              </span>
            )}
            <span className="empty-note">opens the Showcase view</span>
          </div>
          <div className="test-card__foot">
            <span className="mlabel">Traces tagged</span>
            <span className="chip" style={{ opacity: 0.75 }}>
              showcase
            </span>
          </div>
        </ScModule>

        {/* ── TST·02 Decode benchmark ─────────────────────────────────── */}
        <ScModule label="Decode benchmark" className="test-card" style={CARD_STYLE}>
          <div className="test-card__head">
            <span className="test-card__code">TST·02</span>
            <span className="test-card__title">Decode benchmark</span>
          </div>
          <p className="test-card__desc">
            Concurrency waves with TTFT and tok/s percentiles per level.
          </p>
          <div className="row">
            <button
              type="button"
              className="key key--primary"
              disabled={!engineUp}
              title={engineUp ? undefined : OFF_TITLE}
              style={engineUp ? undefined : { opacity: 0.5 }}
              onClick={() => {
                setRemoteTarget(null);
                setBenchOpen(true);
              }}
            >
              ▶ Run decode bench
            </button>
            <button
              type="button"
              className="key"
              style={remoteOpen ? { borderColor: "var(--color-accent)", color: "var(--color-accent)" } : undefined}
              aria-expanded={remoteOpen}
              title="On-demand bench against a typed host (HTTPS Tailscale, LAN IP, …). Not probed until you run."
              onClick={() => {
                setRemoteOpen((v) => !v);
                setRemoteError(null);
              }}
            >
              Remote
            </button>
          </div>
          <div className="test-card__foot">
            <span className="mlabel">Traces tagged</span>
            <span className="chip" style={{ opacity: 0.75 }}>
              bench
            </span>
          </div>
        </ScModule>

        {/* ── TST·03 Prefill benchmark ────────────────────────────────── */}
        <ScModule label="Prefill benchmark" className="test-card" style={CARD_STYLE}>
          <div className="test-card__head">
            <span className="test-card__code">TST·03</span>
            <span className="test-card__title">Prefill benchmark</span>
          </div>
          <p className="test-card__desc">
            Prompt-size sweeps, cached vs uncached prefill.
          </p>
          <div className="row">
            <button
              type="button"
              className="key key--primary"
              disabled={!engineUp}
              title={engineUp ? undefined : OFF_TITLE}
              style={engineUp ? undefined : { opacity: 0.5 }}
              onClick={() => {
                setRemoteTarget(null);
                setPrefillOpen(true);
              }}
            >
              {prefillRunning ? "Open prefill bench" : "▶ Run prefill bench"}
            </button>
            <button
              type="button"
              className="key"
              style={remoteOpen ? { borderColor: "var(--color-accent)", color: "var(--color-accent)" } : undefined}
              aria-expanded={remoteOpen}
              title="On-demand bench against a typed host (HTTPS Tailscale, LAN IP, …). Not probed until you run."
              onClick={() => {
                setRemoteOpen((v) => !v);
                setRemoteError(null);
              }}
            >
              Remote
            </button>
            {prefillRunning ? (
              <span
                className="bench-status-pill bench-status-pill--running"
                title={prefillChipTitle(activePrefill)}
              >
                {prefillChipLabel(activePrefill)}
              </span>
            ) : contextLength == null && engineUp ? (
              <span className="empty-note">context length unknown — all sizes offered</span>
            ) : null}
          </div>
          <div className="test-card__foot">
            <span className="mlabel">Traces tagged</span>
            <span className="chip" style={{ opacity: 0.75 }}>
              prefill-bench
            </span>
          </div>
        </ScModule>
      </div>

      {/* Remote bench target — typed on-demand endpoint, nothing probed until a run. */}
      {remoteOpen ? (
        <ScModule label="Remote bench target" className="test-card" style={CARD_STYLE}>
          <p className="empty-note" style={{ margin: 0 }}>
            On-demand endpoint. Paste a URL or type host + port — nothing is probed until you run.
          </p>
          <div className="row" style={{ alignItems: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <label className="stack" style={{ gap: 3, flex: "1 1 220px", minWidth: 0 }}>
              <span className="mlabel">Host</span>
              <input
                type="text"
                value={hostDraft}
                onChange={(e) => setHostDraft(e.target.value)}
                onBlur={applyHostBlur}
                placeholder="https://name.tailxxxxx.ts.net/v1/models"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="mono"
                style={INPUT_STYLE}
              />
            </label>
            <label className="stack" style={{ gap: 3, width: 92 }}>
              <span className="mlabel">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                className="mono"
                style={INPUT_STYLE}
              />
            </label>
            <label className="row" style={{ alignItems: "center", gap: 6, paddingBottom: 6 }}>
              <input
                type="checkbox"
                checked={tls}
                onChange={(e) => {
                  const next = e.target.checked;
                  setTls(next);
                  if (next && portDraft === "8888") setPortDraft("443");
                  if (!next && portDraft === "443") setPortDraft("8888");
                }}
                style={{ accentColor: "var(--color-accent)" }}
              />
              <span className="mlabel">HTTPS</span>
            </label>
          </div>
          {remoteError ? (
            <span className="empty-note" style={{ color: "var(--color-danger)" }}>
              {remoteError}
            </span>
          ) : null}
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="key key--primary"
              disabled={primaryPort == null}
              title={primaryPort == null ? NO_PORT_TITLE : undefined}
              style={primaryPort == null ? { opacity: 0.5 } : undefined}
              onClick={() => launchRemote("decode")}
            >
              Decode
            </button>
            <button
              type="button"
              className="key key--primary"
              disabled={primaryPort == null}
              title={primaryPort == null ? NO_PORT_TITLE : undefined}
              style={primaryPort == null ? { opacity: 0.5 } : undefined}
              onClick={() => launchRemote("prefill")}
            >
              Prefill
            </button>
          </div>
        </ScModule>
      ) : null}

      {/* Dialogs mount only while open (guarded so llmPort is concrete). */}
      {benchOpen && primaryPort != null ? (
        <BenchmarkDialog
          open
          onClose={() => setBenchOpen(false)}
          sparkId={sparkId}
          llmPort={primaryPort}
          modelId={remoteTarget ? null : modelId}
          remoteTarget={remoteTarget}
          shareImage={shareImage}
          sparkName={sparkName}
        />
      ) : null}
      {prefillOpen && primaryPort != null ? (
        <PrefillBenchDialog
          open
          onClose={() => setPrefillOpen(false)}
          sparkId={sparkId}
          llmPort={primaryPort}
          modelId={remoteTarget ? null : modelId}
          contextLength={remoteTarget ? null : contextLength}
          remoteTarget={remoteTarget}
          shareImage={shareImage}
          sparkName={sparkName}
        />
      ) : null}
    </div>
  );
}
