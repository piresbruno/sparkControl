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
import { formatContextSize } from "../../../shared/prefillBench.js";

interface ScTestsProps {
  sparkId: string;
  /** null when LLM monitoring is off */
  primaryPort: number | null;
  modelId: string | null;
  contextLength: number | null;
  llmAvailable: boolean;
}

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

export function ScTests({
  sparkId,
  primaryPort,
  modelId,
  contextLength,
  llmAvailable,
}: ScTestsProps) {
  const [benchOpen, setBenchOpen] = useState(false);
  const [prefillOpen, setPrefillOpen] = useState(false);
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
              onClick={() => setBenchOpen(true)}
            >
              ▶ Run decode bench
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
              onClick={() => setPrefillOpen(true)}
            >
              {prefillRunning ? "Open prefill bench" : "▶ Run prefill bench"}
            </button>
            {prefillRunning ? (
              <span
                className="bench-status-pill bench-status-pill--running"
                title={activePrefill.progress.message || "Prefill benchmark running"}
              >
                running · {activePrefill.progress.completedLevels}/
                {activePrefill.progress.totalLevels}
                {activePrefill.progress.currentContext != null
                  ? ` · ${formatContextSize(activePrefill.progress.currentContext)}`
                  : ""}
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

      {/* Dialogs mount only while open (guarded so llmPort is concrete). */}
      {benchOpen && primaryPort != null ? (
        <BenchmarkDialog
          open
          onClose={() => setBenchOpen(false)}
          sparkId={sparkId}
          llmPort={primaryPort}
          modelId={modelId}
        />
      ) : null}
      {prefillOpen && primaryPort != null ? (
        <PrefillBenchDialog
          open
          onClose={() => setPrefillOpen(false)}
          sparkId={sparkId}
          llmPort={primaryPort}
          modelId={modelId}
          contextLength={contextLength}
        />
      ) : null}
    </div>
  );
}
