/**
 * CH·02 Serving — v3 instrument console.
 * One hero bay per configured LLM port (activity chip, dials, endpoint rows,
 * 12-stat readout matrix), worker passthrough, and the Expert-panels
 * disclosure carrying the legacy LlmPanel/ComfyPanel UI.
 *
 * Markup mirrors mockups/node-detail-v3.html (.hero / .dials / .bay /
 * .readouts) and src/styles/console.css; stat semantics mirror LlmPanel.tsx.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LlmMetrics, ServingStatus, SparkSnapshot } from "../../../api/types";
import { useMetricsHistoryTail } from "../../../hooks/metricsStore";
import { VLLM_METRIC_INFO } from "../LlmPanel";
import {
  ScChip,
  ScCopy,
  ScDisclosure,
  ScHist,
  ScInfo,
  ScLed,
  ScModule,
  ScSeg,
} from "./ScKit";
import {
  ACTIVITY_LABEL,
  ACTIVITY_TIP,
  fmtInt,
  fmtPct,
  fmtSeconds,
  fmtTps,
  shortModelName,
} from "./consoleUtils";
import { useEngineActivity } from "./useEngineActivity";
import { servingSince, useServingLifecycle } from "./useServingLifecycle";

/** Named contract of `useServingLifecycle` (hooks file is frozen; consumer-side alias). */
interface ServingLifecycle {
  status: ServingStatus | null;
  busy: boolean;
  stop: () => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

interface ScServingProps {
  spark: SparkSnapshot;
  /** isLlmMonitoringEnabled(spark) */
  llmOn: boolean;
  role: "head" | "worker" | "standalone";
  llmPorts: number[];
  /** llmPorts[0] */
  primaryPort: number | null;
  onAddPort: (port: number) => Promise<void> | void;
  onRemovePort: (port: number) => void;
  /** Scroll + flash the CH·03 launch panel. */
  onServeNew: () => void;
  comfyOn: boolean;
  workerHeadId: string | null;
  /** null = head config not resolved yet; string = head spark id (xref target). */
  headSparkName: string | null;
  onNavigate?: (id: string | null) => void;
  /** Legacy LlmPanel(s) + ComfyPanel + add-port UI, composed by SparkPage. */
  children?: ReactNode;
}

/** Backend label map — copied from LlmPanel.tsx BackendBadge. */
const BACKEND_LABELS: Record<string, string> = {
  vllm: "vLLM",
  "llama.cpp": "llama.cpp",
  sglang: "sgLang",
  ds4: "ds4",
  exl3: "EXL3",
};

const ENGINE_TIP =
  "Active = processing or ready for requests. Sleeping = idle, GPU memory freed until next request.";

const PREFILL_TIP =
  "Tokens/sec while the engine is reading the prompt and building KV cache — before the first output token. Prefix-cache hits do little compute, so this can stay ~0.";

/** "loaded 12 min ago" from the supervised server's startedAt; null when unknown. */
function loadedAgo(status: ServingStatus | null): string | null {
  if (!status || status.running !== true || status.startedAt == null) return null;
  const t = new Date(status.startedAt).getTime();
  if (!Number.isFinite(t)) return null;
  const min = Math.round((Date.now() - t) / 60000);
  if (!Number.isFinite(min) || min < 0) return null;
  return min < 1 ? "loaded <1 min ago" : `loaded ${min} min ago`;
}

function HeadLink({
  workerHeadId,
  headSparkName,
  onNavigate,
}: {
  workerHeadId: string | null;
  headSparkName: string | null;
  onNavigate?: (id: string | null) => void;
}) {
  if (workerHeadId == null) return null;
  return (
    <a
      className="xref"
      href={`/spark/${encodeURIComponent(workerHeadId)}`}
      title={headSparkName ?? "Open head node"}
      onClick={(e) => {
        e.preventDefault();
        onNavigate?.(workerHeadId);
      }}
    >
      ● {headSparkName ?? "resolving…"}
    </a>
  );
}

/** One endpoint row (label + URL + copy) as in the mockup `.bay`. */
function EndpointRow({
  label,
  hint,
  url,
  copyTitle,
}: {
  label: ReactNode;
  hint?: ReactNode;
  url: string;
  copyTitle: string;
}) {
  return (
    <div className="endpoint">
      <span className="mlabel">{label}</span>
      <div className="endpoint__box">
        <span className="endpoint__url" title={url}>
          {url}
        </span>
        <ScCopy text={url} title={copyTitle} />
      </div>
      {hint ? (
        <span style={{ fontSize: "var(--fs-10)", color: "var(--color-muted)" }}>{hint}</span>
      ) : null}
    </div>
  );
}

interface HeroProps {
  spark: SparkSnapshot;
  port: number;
  index: number;
  isPrimary: boolean;
  llmPorts: number[];
  llm: LlmMetrics | null;
  gpuUsage: number | null;
  lifecycle: ServingLifecycle;
  onServeNew: () => void;
  onAddPort: (port: number) => Promise<void> | void;
  onRemovePort: (port: number) => void;
}

/** Hero bay for one configured LLM port. Owns per-port hooks. */
function ServingHero({
  spark,
  port,
  index,
  isPrimary,
  llmPorts,
  llm,
  gpuUsage,
  lifecycle,
  onServeNew,
  onAddPort,
  onRemovePort,
}: HeroProps) {
  const available = Boolean(llm?.available);
  const activity = useEngineActivity(llm, gpuUsage);
  const genHistory = useMetricsHistoryTail(spark.id, `llm:${port}.tps`);
  const prefillHistory = useMetricsHistoryTail(spark.id, `llm:${port}.prefill`);

  // Two-click armed stop (per bay).
  const [armed, setArmed] = useState(false);
  const [stopResult, setStopResult] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);
  useEffect(() => () => { if (armTimer.current) window.clearTimeout(armTimer.current); }, []);

  // Inline add-port mini form (primary bay only).
  const [addingPort, setAddingPort] = useState(false);
  const [portDraft, setPortDraft] = useState("");

  const running = llm?.requestsRunning ?? llm?.slotsActive ?? 0;
  const showPrefillSplit = llm?.cachedPrefillTps != null || llm?.uncachedPrefillTps != null;

  const backendLabel = llm?.backend
    ? BACKEND_LABELS[llm.backend] ?? llm.backend
    : null;
  const title = llm?.modelId ? shortModelName(llm.modelId) : "No engine detected";
  const loaded = loadedAgo(lifecycle.status);
  const since = servingSince(lifecycle.status);

  // GPU busy while engine is down — the blind-spot pill (contract CH·02).
  const gpuSilent = !available && (gpuUsage ?? 0) >= 85;

  function handleStopClick() {
    if (lifecycle.busy) return;
    if (!armed) {
      setArmed(true);
      setStopResult(null);
      if (armTimer.current) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(false), 3000);
      return;
    }
    if (armTimer.current) window.clearTimeout(armTimer.current);
    setArmed(false);
    void lifecycle.stop().then((res) => {
      setStopResult(res.ok ? "stop requested" : `stop failed: ${res.error ?? "unknown"}`);
    });
  }

  function commitPort() {
    const n = Number.parseInt(portDraft.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return;
    setAddingPort(false);
    setPortDraft("");
    void Promise.resolve(onAddPort(n)).catch(() => {
      /* SparkPage logs; ports list refresh reflects the outcome */
    });
  }

  const directUrl = spark.lanIp ? `http://${spark.lanIp}:${port}/v1` : null;
  const proxyUrl = `${window.location.protocol}//${window.location.host}/llm/${encodeURIComponent(spark.id)}/${port}/v1`;

  // ── Activity pill ───────────────────────────────────────────────────────
  const pill = available ? (
    <span
      className={`chip${activity && activity !== "waiting" ? " chip--live" : ""}`}
      style={{ padding: "3px 11px", fontSize: "var(--fs-12)" }}
      title={ACTIVITY_TIP}
    >
      <ScLed state={activity && activity !== "waiting" ? "live" : "off"} />
      {activity
        ? `${ACTIVITY_LABEL[activity]} · ${fmtInt(running)} req · ${fmtTps(llm?.generationTps)} tok/s`
        : "—"}
    </span>
  ) : gpuSilent ? (
    <span
      className="chip"
      style={{
        padding: "3px 11px",
        fontSize: "var(--fs-12)",
        color: "var(--color-warning)",
        background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
      }}
      title="Weights loading, CUDA-graph capture, or a foreign process — see serving log"
    >
      <ScLed state="off" />
      {ACTIVITY_LABEL["gpu-silent"]}
    </span>
  ) : null;

  // ── Dials ───────────────────────────────────────────────────────────────
  const genVal = llm?.generationTps ?? 0;
  const preVal = llm?.prefillTps ?? 0;
  const genScale = Math.max(genVal, ...genHistory, 1);
  const preScale = Math.max(preVal, ...prefillHistory, 1);

  const dials = (
    <div className="dials" aria-label="Throughput">
      <div className="dial">
        <span className="mlabel">Generation</span>
        <div className="dial__main">
          <span className="dial__value">{available ? fmtTps(genVal) : "—"}</span>
          <span className="dial__unit">tok/s</span>
        </div>
        <span className="dial__split">total {fmtInt(llm?.totalOutputTokens ?? 0)} out tok</span>
        <ScSeg pct={available ? Math.min(100, (genVal / genScale) * 100) : 0} tone="accent" />
        <ScHist values={Array.from(genHistory)} w={196} h={26} tone="accent" />
      </div>
      <div className="dial">
        <span className="mlabel" title={PREFILL_TIP}>Prefill</span>
        <div className="dial__main">
          <span className="dial__value">{available ? fmtTps(preVal) : "—"}</span>
          <span className="dial__unit">tok/s</span>
        </div>
        <span className="dial__split">
          {showPrefillSplit
            ? `uncached ${fmtTps(llm?.uncachedPrefillTps ?? 0)} · cached ${fmtTps(llm?.cachedPrefillTps ?? 0)}`
            : llm?.contextLength
              ? `ctx ${fmtInt(llm.contextLength)}`
              : "no split reported"}
        </span>
        <ScSeg pct={available ? Math.min(100, (preVal / preScale) * 100) : 0} tone="neutral" />
        <ScHist values={Array.from(prefillHistory)} w={196} h={26} tone="neutral" />
      </div>
    </div>
  );

  // ── 12-stat readout matrix (LlmPanel semantics) ─────────────────────────
  type Cell = {
    label: string;
    value: string;
    tip?: string;
    align?: "end";
    tone?: "success" | "warning" | "danger";
  };
  const kv = llm?.kvCacheUsage ?? null;
  const cells: Cell[] = [
    {
      label: "Slots",
      value:
        (llm?.slotsTotal ?? 0) > 0
          ? `${fmtInt(llm?.slotsActive ?? 0)} / ${fmtInt(llm?.slotsTotal ?? 0)}`
          : (llm?.slotsActive ?? 0) > 0
            ? `${fmtInt(llm?.slotsActive)} running`
            : "—",
    },
    { label: "Context", value: llm?.contextLength ? fmtInt(llm.contextLength) : "—" },
    {
      label: "Engine",
      value:
        llm?.gpuMemoryUtilization != null
          ? llm.gpuMemoryUtilization === 0
            ? "Sleeping"
            : "Active"
          : "—",
      tip: ENGINE_TIP,
      tone: llm?.gpuMemoryUtilization != null && llm.gpuMemoryUtilization !== 0 ? "success" : undefined,
    },
    {
      label: "Total generated",
      value: llm && llm.totalOutputTokens > 0 ? fmtInt(llm.totalOutputTokens) : "—",
    },
    {
      label: "KV cache",
      value: kv != null ? `${(kv * 100).toFixed(1)}%` : "—",
      tip: VLLM_METRIC_INFO.kvCache,
      tone: kv == null ? undefined : kv >= 0.8 ? "danger" : kv >= 0.5 ? "warning" : "success",
    },
    {
      label: "Requests",
      value:
        llm?.requestsRunning != null && llm?.requestsWaiting != null
          ? `${Math.round(llm.requestsRunning)} run / ${Math.round(llm.requestsWaiting)} wait`
          : "—",
      tip: VLLM_METRIC_INFO.requests,
    },
    { label: "TTFT p95", value: fmtSeconds(llm?.ttftP95Seconds), tip: VLLM_METRIC_INFO.ttftP95 },
    {
      label: "Preempts",
      value: llm?.preemptionsTotal != null ? fmtInt(llm.preemptionsTotal) : "—",
      tip: VLLM_METRIC_INFO.preempts,
      align: "end",
    },
    {
      label: "Prefix cache",
      value: fmtPct(llm?.prefixCacheHitRate),
      tip: VLLM_METRIC_INFO.prefixCache,
    },
    { label: "E2E p95", value: fmtSeconds(llm?.e2eP95Seconds), tip: VLLM_METRIC_INFO.e2eP95 },
    { label: "ITL p95", value: fmtSeconds(llm?.itlP95Seconds), tip: VLLM_METRIC_INFO.itlP95 },
    {
      label: "MTP Accept",
      value: fmtPct(llm?.mtpAcceptanceRate),
      tip: VLLM_METRIC_INFO.mtpAccept,
      align: "end",
    },
  ];

  return (
    <ScModule
      label={`LLM engine :${port}`}
      className="hero"
      style={isPrimary ? undefined : { opacity: 0.92 }}
    >
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="hero__eyebrow">
            CH·Live
            <ScLed state={available ? "live" : "off"} />
            Engine :{port}
          </span>
          <h3 className="serving-identity__name">
            <span title={llm?.modelId ?? undefined}>{title}</span>
            {pill}
          </h3>
          <div className="detail-head__repo">
            Served by modelctl
            {backendLabel ? ` · ${backendLabel}` : ""}
            {index === 0 && spark.llmPort === port ? " · primary" : ""}
          </div>
          <div className="hero__meta">
            {backendLabel ? <ScChip>{backendLabel}</ScChip> : null}
            {llm?.modelPath && llm.modelPath !== llm.modelId && !llm.modelPath.includes("models--") ? (
              <ScChip>
                <span style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={llm.modelPath}>
                  {llm.modelPath}
                </span>
              </ScChip>
            ) : null}
            {loaded ? (
              <ScChip>
                <span title={since ? `running since ${since}` : undefined}>{loaded}</span>
              </ScChip>
            ) : null}
            {llm?.posture ? (
              <ScChip tone={llm.posture.level === "ok" ? "live" : "err"}>
                <ScLed state={llm.posture.level === "ok" ? "success" : "danger"} />
                <span title={llm.posture.detail}>{llm.posture.label}</span>
              </ScChip>
            ) : null}
            {!available && llm?.error ? <ScChip tone="err">{llm.error}</ScChip> : null}
            {!available && !llm?.error ? <ScChip>no engine on :{port}</ScChip> : null}
          </div>
        </div>
      </div>

      <div className="hero-grid">
        {dials}
        <aside className="bay" aria-label="Endpoints and controls">
          {directUrl ? (
            <EndpointRow
              label={<>Direct <span style={{ fontWeight: 500, letterSpacing: 0, textTransform: "none" }}>· same LAN only</span></>}
              url={directUrl}
              copyTitle="Copy direct endpoint"
            />
          ) : (
            <div className="endpoint">
              <span className="mlabel">Direct</span>
              <span className="empty-note">LAN IP unknown</span>
            </div>
          )}
          <EndpointRow
            label={<>Proxy <span className="chip" style={{ fontSize: 9, padding: "0 6px" }}>traces</span></>}
            url={proxyUrl}
            copyTitle="Copy proxy endpoint"
            hint="Analysis traces are captured through the proxy only."
          />
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <ScChip tone={spark.llmApiKeyPorts?.includes(port) ? "accent" : "default"}>
              key {spark.llmApiKeyPorts?.includes(port) ? "on" : "off"}
            </ScChip>
            <ScChip>
              port {port}
              {llmPorts.length > 1 ? (
                <button
                  type="button"
                  title={`Remove port ${port}`}
                  onClick={() => onRemovePort(port)}
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    fontWeight: 800,
                    color: "var(--color-danger)",
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              ) : null}
            </ScChip>
            {isPrimary ? (
              addingPort ? (
                <input
                  type="number"
                  min={1}
                  max={65535}
                  inputMode="numeric"
                  placeholder="Port"
                  autoFocus
                  value={portDraft}
                  onChange={(e) => setPortDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitPort();
                    } else if (e.key === "Escape") {
                      setAddingPort(false);
                      setPortDraft("");
                    }
                  }}
                  onBlur={() => {
                    if (!portDraft.trim()) setAddingPort(false);
                  }}
                  className="mono"
                  style={{
                    width: 74,
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: "var(--color-surface-elevated)",
                    color: "var(--color-text)",
                    padding: "2px 6px",
                    fontSize: "var(--fs-11)",
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="key"
                  title="Add another LLM port to monitor"
                  onClick={() => setAddingPort(true)}
                  style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
                >
                  + port
                </button>
              )
            ) : null}
          </div>
          <div className="bay__keys">
            {available ? (
              <button
                type="button"
                className="key key--danger key--block"
                disabled={lifecycle.busy}
                onClick={handleStopClick}
                style={armed ? { background: "color-mix(in srgb, var(--color-danger) 18%, transparent)" } : undefined}
              >
                {lifecycle.busy ? "Stopping…" : armed ? "Confirm stop — press again" : "■ Stop"}
              </button>
            ) : null}
            <button type="button" className="key key--primary key--block" onClick={onServeNew}>
              ▶ Serve new model…
            </button>
            {stopResult ? (
              <span
                className="empty-note"
                style={{
                  textAlign: "center",
                  color: stopResult.startsWith("stop failed")
                    ? "var(--color-danger)"
                    : "var(--color-success)",
                }}
              >
                {stopResult}
              </span>
            ) : null}
          </div>
        </aside>
      </div>

      <div className="readouts" aria-label="Engine statistics">
        {cells.map((c, i) => (
          <div className="readout" key={c.label}>
            <span className="readout__code">{`R${String(i + 1).padStart(2, "0")}`}</span>
            <span className="readout__label">
              {c.label}
              {c.tip ? <ScInfo tip={c.tip} align={c.align ?? "start"} /> : null}
            </span>
            <span
              className={`readout__value${c.tone ? ` readout__value--${c.tone}` : ""}`}
              title={c.value === "—" ? undefined : c.value}
            >
              {c.value}
            </span>
          </div>
        ))}
      </div>
    </ScModule>
  );
}

export function ScServing({
  spark,
  llmOn,
  role,
  llmPorts,
  primaryPort,
  onAddPort,
  onRemovePort,
  onServeNew,
  headSparkName,
  workerHeadId,
  onNavigate,
  children,
}: ScServingProps) {
  const lifecycle = useServingLifecycle(spark.id, llmOn && role !== "worker");
  const gpuUsage = spark.metrics.gpu?.usage ?? null;
  let body: ReactNode;

  if (role === "worker") {
    // Workers accelerate an engine served by their head — passthrough only.
    body = (
      <ScModule label="Serving (worker passthrough)">
        <div className="stack" style={{ gap: "var(--space-2)" }}>
          <span className="hero__eyebrow">
            CH·Live
            <ScLed state="off" />
            Worker
          </span>
          <p className="empty-note" style={{ margin: 0 }}>
            This node is a worker — the engine it accelerates is served by its head.{" "}
            <HeadLink
              workerHeadId={workerHeadId}
              headSparkName={headSparkName}
              onNavigate={onNavigate}
            />
          </p>
        </div>
      </ScModule>
    );
  } else if (!llmOn) {
    body = (
      <ScModule label="Serving disabled" style={{ opacity: 0.85 }}>
        <div className="stack" style={{ gap: "var(--space-2)" }}>
          <span className="hero__eyebrow">
            CH·Live
            <ScLed state="off" />
            Engine
          </span>
          <p className="empty-note" style={{ margin: 0 }}>
            LLM monitoring is disabled in settings for this node — enable it to see the serving
            bay.
          </p>
        </div>
      </ScModule>
    );
  } else if (llmPorts.length === 0) {
    body = (
      <ScModule label="No LLM ports" style={{ opacity: 0.85 }}>
        <div className="stack" style={{ gap: "var(--space-2)" }}>
          <span className="hero__eyebrow">
            CH·Live
            <ScLed state="off" />
            Engine
          </span>
          <p className="empty-note" style={{ margin: 0 }}>
            No LLM ports configured on this node.{" "}
            <button
              type="button"
              className="key"
              style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
              onClick={() => {
                const n = primaryPort ?? spark.llmPort ?? 8888;
                void Promise.resolve(onAddPort(n)).catch(() => {
                  /* SparkPage state reflects the outcome */
                });
              }}
            >
              + add port {primaryPort ?? spark.llmPort ?? 8888}
            </button>
          </p>
          <div className="bay__keys">
            <button type="button" className="key key--primary key--block" onClick={onServeNew}>
              ▶ Serve new model…
            </button>
          </div>
        </div>
      </ScModule>
    );
  } else {
    body = (
      <div className="stack">
        {llmPorts.map((port, i) => (
          <ServingHero
            key={port}
            spark={spark}
            port={port}
            index={i}
            isPrimary={port === primaryPort}
            llmPorts={llmPorts}
            llm={spark.metrics.llm?.[i] ?? null}
            gpuUsage={gpuUsage}
            lifecycle={lifecycle}
            onServeNew={onServeNew}
            onAddPort={onAddPort}
            onRemovePort={onRemovePort}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      {body}
      {children ? (
        <ScDisclosure title="Expert panels: LLM engines + ComfyUI">{children}</ScDisclosure>
      ) : null}
    </>
  );
}
