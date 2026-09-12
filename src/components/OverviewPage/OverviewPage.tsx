import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelctlRelease,
  ModelctlStatus,
  MctlJob,
  NasCatalogResponse,
  SparkSnapshot,
} from "../../api/types";
import { resolveSparkRole, isLlmDetectionEnabled } from "../../api/sparkRole";
import {
  fetchModelctlRelease,
  fetchNasCatalog,
  listJobs,
  listNasModels,
  modelctlStatus,
  shutdownAllSparks,
  updateAllHermes,
  wakeAllSparks,
} from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";
import { agoLabel, fmtStore, matchStoreMount, versionIsNewer } from "../NasPage/nasUtils";
import { fmtUptimeShort } from "../SparkPage/console/consoleUtils";
import { ScHist, ScLed, ScSeg } from "../SparkPage/console/ScKit";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import "../../styles/console.css";
import "../../styles/overview.css";

interface OverviewPageProps {
  sparks: SparkSnapshot[];
  hideOffline?: boolean;
  temperatureUnit?: "celsius" | "fahrenheit";
  onSelectSpark?: (id: string) => void;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round(c * 9 / 5 + 32);
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** Format a storage value in MB, stripping trailing ".0" and optionally omitting the unit. */
function fmtStorage(mb: number, unit: boolean): string {
  const val = mb >= 1024 ? mb / 1024 : mb;
  const label = mb >= 1024 ? "GB" : "MB";
  const s = val.toFixed(1).replace(/\.0$/, "");
  return unit ? `${s} ${label}` : s;
}

function OcardStat({
  label,
  value,
  tone = "default",
  title,
  wrap = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  title?: string;
  /** Allow value to wrap (no ellipsis trim) — used for long model ids. */
  wrap?: boolean;
}) {
  const toneClass =
    tone === "danger"
      ? " ocard-stat__v--danger"
      : tone === "warning"
        ? " ocard-stat__v--warning"
        : tone === "accent"
          ? " ocard-stat__v--accent"
          : tone === "success"
            ? " ocard-stat__v--success"
            : "";
  return (
    <div className="ocard-stat">
      <span className="mlabel">{label}</span>
      <span className={`ocard-stat__v${toneClass}${wrap ? " ocard-stat__v--wrap" : ""}`} title={title}>
        {value}
      </span>
    </div>
  );
}

/** Rack data-plate field (same local pattern as SparkPage/NasPage). */
function dataField(k: string, v: string | null) {
  if (v == null) return null;
  return (
    <div className="plate__f">
      <span className="plate__k">{k}</span>
      <span className="plate__v" title={v}>
        {v}
      </span>
    </div>
  );
}

function SparkCard({
  spark,
  headSpark,
  modelctl,
  temperatureUnit,
  onSelect,
}: {
  spark: SparkSnapshot;
  headSpark?: SparkSnapshot | null;
  /** Worker only: modelctl check (undefined = not fetched yet). */
  modelctl?: ModelctlStatus | null;
  temperatureUnit: "celsius" | "fahrenheit";
  onSelect?: (id: string) => void;
}) {
  const gpu = spark.metrics.gpu;
  const um = spark.metrics.unifiedMemory;
  const online = spark.online;

  const usage = gpu?.usage ?? 0;
  const tempRaw = gpu?.temperature ?? 0;
  const displayTemp = temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(tempRaw) : tempRaw;
  const tempUnit = temperatureUnit === "fahrenheit" ? "°F" : "°C";
  const tempLabel = `${displayTemp}${tempUnit}`;
  const vramPct = gpu?.vram?.percentage ?? um?.percentage ?? 0;
  const vramUsed = gpu?.vram?.used ?? um?.used ?? 0;
  const vramTotal = gpu?.vram?.total ?? um?.total ?? 0;
  const vramAvail = gpu?.vram?.available ?? um?.available ?? 0;

  // Sparkline tails for the gauge feet. Hooks run unconditionally — the
  // gauges they feed render conditionally.
  const vramHist = useMetricsHistoryTail(spark.id, "unifiedMemory.percentage");
  const ramHist = useMetricsHistoryTail(spark.id, "ram.percentage");
  const gpuTempHist = useMetricsHistoryTail(spark.id, "gpu.temp");
  const cpuTempHist = useMetricsHistoryTail(spark.id, "cpu.temp");
  const gpuUsageHist = useMetricsHistoryTail(spark.id, "gpu.usage");

  // Gauge tones (same thresholds as the old MetricBar colours):
  // cool → success, warm → warning, hot → danger.
  const vramTone = vramPct > 85 ? "danger" : vramPct > 60 ? "warning" : "accent";
  const tempTone =
    tempRaw > 85 ? "danger" : tempRaw > 65 ? "warning" : tempRaw > 40 ? "accent" : "success";
  const usageTone = usage > 85 ? "danger" : usage > 60 ? "warning" : "accent";
  const gaugeCell = (tone: "danger" | "warning" | "accent" | "success") =>
    tone === "danger" ? " gauge--danger" : tone === "warning" ? " gauge--warn" : "";
  // ScHist has no danger tone — degrade to warning.
  const histTone = (tone: "danger" | "warning" | "accent" | "success") =>
    tone === "danger" ? "warning" : tone;

  return (
    <div className="module" style={online ? undefined : { opacity: 0.6 }}>
      {/* Card header */}
      <div className="spread">
        <div className="row">
          <ScLed state={online ? "live" : "off"} />
          {onSelect ? (
            <button type="button" className="ocard-name" onClick={() => onSelect(spark.id)}>
              {spark.name}
            </button>
          ) : (
            <span className="ocard-name">{spark.name}</span>
          )}
          {(() => {
            const role = resolveSparkRole(spark);
            const text =
              role === "head" ? "Head" : role === "worker" ? "Worker" : "Standalone";
            const title =
              role === "head"
                ? "Cluster head Spark"
                : role === "worker"
                  ? spark.workerLabel?.trim()
                    ? `${spark.workerLabel.trim()} · distributed LLM worker`
                    : "Distributed LLM worker"
                  : spark.llmMonitoring === false
                    ? "Standalone — LLM monitoring off"
                    : "Standalone Spark";
            return (
              <span className="chip chip--accent" title={title}>
                {text}
              </span>
            );
          })()}
        </div>
        <div className="row">
          {spark.comfyMonitoring ? (
            <span
              className={`chip${
                !spark.metrics?.comfy?.available
                  ? ""
                  : (spark.metrics.comfy.queueRunning ?? 0) > 0
                    ? " chip--live"
                    : (spark.metrics.comfy.queuePending ?? 0) > 0
                      ? " chip--warn"
                      : ""
              }`}
              title={
                !spark.metrics?.comfy?.available
                  ? "ComfyUI monitoring on — not reachable"
                  : (spark.metrics.comfy.queueRunning ?? 0) > 0
                    ? spark.metrics.comfy.activeJob?.title
                      ? `ComfyUI running: ${spark.metrics.comfy.activeJob.title}`
                      : "ComfyUI job running"
                    : (spark.metrics.comfy.queuePending ?? 0) > 0
                      ? `ComfyUI queue: ${spark.metrics.comfy.queuePending} pending`
                      : "ComfyUI idle"
              }
            >
              {!spark.metrics?.comfy?.available
                ? "Comfy"
                : (spark.metrics.comfy.queueRunning ?? 0) > 0
                  ? "Comfy · run"
                  : (spark.metrics.comfy.queuePending ?? 0) > 0
                    ? `Comfy · ${spark.metrics.comfy.queuePending}q`
                    : "Comfy · idle"}
            </span>
          ) : null}
          <span className="mlabel">{online ? "online" : "offline"}</span>
        </div>
      </div>

      {!online || !gpu ? (
        <div className="ocard-wait">
          <span className="empty-note">{online ? "Waiting for metrics…" : "Host unreachable"}</span>
        </div>
      ) : (
        <>
          {/* Boxed gauges: VRAM, RAM (host), GPU/Temperature, CPU, Usage */}
          <div className="gauge-grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <div className={`gauge${gaugeCell(vramTone)}`}>
              <div className="gauge__top">
                <span className="mlabel">VRAM</span>
                <span className="gauge__value">
                  {vramTotal > 0 ? fmtStorage(vramUsed, false) : "—"}
                  <small>{vramTotal > 0 ? ` /${fmtStorage(vramTotal, true)}` : ""}</small>
                </span>
              </div>
              <ScSeg pct={vramPct} tone={vramTone} />
              <div className="gauge__foot">
                <span>
                  {vramTotal > 0
                    ? `${fmtStorage(vramUsed, false)} / ${fmtStorage(vramTotal, true)}`
                    : "—"}
                </span>
                <ScHist values={Array.from(vramHist)} w={84} h={14} tone={histTone(vramTone)} />
              </div>
            </div>
            {spark.kind === "host" && (() => {
              // Non-Spark hosts: system RAM is separate from discrete VRAM.
              const ram = spark.metrics.ram;
              const rUsed = ram?.used ?? 0;
              const rTotal = ram?.total ?? 0;
              const rPct = rTotal > 0 ? Math.round((rUsed / rTotal) * 100) : 0;
              const ramTone: "danger" | "warning" | "accent" =
                rPct > 85 ? "danger" : rPct > 60 ? "warning" : "accent";
              return (
                <div className={`gauge${gaugeCell(ramTone)}`}>
                  <div className="gauge__top">
                    <span className="mlabel">RAM</span>
                    <span className="gauge__value">
                      {rTotal > 0 ? fmtStorage(rUsed, false) : "—"}
                      <small>{rTotal > 0 ? ` /${fmtStorage(rTotal, true)}` : ""}</small>
                    </span>
                  </div>
                  <ScSeg pct={rPct} tone={ramTone} />
                  <div className="gauge__foot">
                    <span>
                      {rTotal > 0
                        ? `${fmtStorage(rUsed, false)} / ${fmtStorage(rTotal, true)}`
                        : "—"}
                    </span>
                    <ScHist values={Array.from(ramHist)} w={84} h={14} tone={histTone(ramTone)} />
                  </div>
                </div>
              );
            })()}
            <div className={`gauge${gaugeCell(tempTone)}`}>
              <div className="gauge__top">
                <span className="mlabel">
                  {spark.kind === "host" || (spark.metrics.cpu?.temperature ?? 0) > 0
                    ? "GPU"
                    : "Temperature"}
                </span>
                <span className="gauge__value">
                  {displayTemp}
                  <small>{` ${tempUnit}`}</small>
                </span>
              </div>
              <ScSeg pct={Math.min(100, displayTemp)} tone={tempTone} />
              <div className="gauge__foot">
                <span>{tempLabel}</span>
                <ScHist values={Array.from(gpuTempHist)} w={84} h={14} tone={histTone(tempTone)} />
              </div>
            </div>
            {(spark.metrics.cpu?.temperature ?? 0) > 0 && (() => {
              const cpuRaw = spark.metrics.cpu?.temperature ?? 0;
              const cpuDisplay =
                temperatureUnit === "fahrenheit" ? celsiusToFahrenheit(cpuRaw) : cpuRaw;
              const cpuTone =
                cpuRaw > 95 ? "danger" : cpuRaw > 85 ? "warning" : cpuRaw > 50 ? "accent" : "success";
              return (
                <div className={`gauge${gaugeCell(cpuTone)}`}>
                  <div className="gauge__top">
                    <span className="mlabel">CPU</span>
                    <span className="gauge__value">
                      {cpuDisplay}
                      <small>{` ${tempUnit}`}</small>
                    </span>
                  </div>
                  <ScSeg pct={Math.min(100, cpuDisplay)} tone={cpuTone} />
                  <div className="gauge__foot">
                    <span>{`${cpuDisplay}${tempUnit}`}</span>
                    <ScHist values={Array.from(cpuTempHist)} w={84} h={14} tone={histTone(cpuTone)} />
                  </div>
                </div>
              );
            })()}
            <div className={`gauge${gaugeCell(usageTone)}`}>
              <div className="gauge__top">
                <span className="mlabel">Usage</span>
                <span className="gauge__value">
                  {usage}
                  <small> %</small>
                </span>
              </div>
              <ScSeg pct={usage} tone={usageTone} />
              <div className="gauge__foot">
                <span>{usage}%</span>
                <ScHist values={Array.from(gpuUsageHist)} w={84} h={14} tone={histTone(usageTone)} />
              </div>
            </div>
          </div>
          {gpu?.throttle?.thermal && (
            <span className="chip chip--err" title={gpu.throttle.detail || "GPU thermal slowdown engaged"}>
              Thermal throttle
            </span>
          )}

          {/* Secondary stats */}
          <div className="ocard-stats">
            <OcardStat
              label="GPU Power"
              value={`${gpu?.power?.draw ?? 0}W / ${gpu?.power?.limit ?? 0}W`}
            />
            {vramAvail > 0 && (
              <OcardStat
                label="Available"
                value={formatMb(vramAvail)}
                tone={vramAvail < 4096 ? "danger" : vramAvail < 16384 ? "warning" : "accent"}
              />
            )}
            {(() => {
              // Find the root disk by label "/" (the collector maps the host
              // root mount to that label). Fall back to the GB10 partition name
              // so the overview keeps working where labels aren't populated.
              const rootDisk =
                spark.metrics.storage.find((d) => d.label === "/") ??
                spark.metrics.storage.find((d) => d.device === "nvme0n1p2");
              if (rootDisk) {
                return (
                  <OcardStat
                    label="Storage"
                    value={`${fmtStorage(rootDisk.used, false)} / ${fmtStorage(rootDisk.total, true)}`}
                    tone={rootDisk.percentage > 85 ? "danger" : rootDisk.percentage > 60 ? "warning" : "default"}
                  />
                );
              }
              return null;
            })()}
            {(() => {
              const role = resolveSparkRole(spark);

              // Part D / worker attribution: workers serve as part of a
              // cluster — show who the head is, the model being served
              // (head engine first, own detection probe as fallback), and
              // the node's modelctl version when integration is enabled.
              if (role === "worker") {
                const headLlm =
                  headSpark && Array.isArray(headSpark.metrics.llm)
                    ? headSpark.metrics.llm.find((l) => l.available)
                    : null;
                const ownLlm = Array.isArray(spark.metrics.llm)
                  ? spark.metrics.llm.find((l) => l.available)
                  : null;
                const llm = headLlm ?? ownLlm;
                const backendLabel =
                  llm?.backend === "vllm" ? "vLLM" : llm?.backend ?? "Model";
                return (
                  <>
                    <OcardStat
                      label="Head"
                      value={headSpark?.name ?? spark.workerLabel?.trim() ?? "unassigned"}
                      tone="accent"
                      wrap
                      title={
                        headSpark
                          ? `Worker of ${headSpark.name}`
                          : spark.workerHeadId
                            ? `Head spark "${spark.workerHeadId}" is not registered`
                            : "No head configured for this worker"
                      }
                    />
                    <OcardStat
                      label={backendLabel}
                      value={llm?.modelId ?? (isLlmDetectionEnabled(spark) ? "no model serving" : "not monitored")}
                      tone={llm ? "accent" : "default"}
                      title={
                        llm
                          ? headLlm
                            ? `Model served by head${headSpark ? ` ${headSpark.name}` : ""}`
                            : "Model detected on this worker's LLM ports"
                          : "No engine detected on the head or this worker"
                      }
                      wrap
                    />
                    {spark.modelctlEnabled && (
                      <OcardStat
                        label="modelctl"
                        value={
                          // Card only renders stats when online (see the
                          // "Host unreachable" gate) — no offline arm needed.
                          modelctl === undefined
                            ? "checking…"
                            : modelctl === null || !modelctl.installed
                              ? "not installed"
                              : `v${modelctl.version ?? "?"}`
                        }
                        tone={modelctl?.installed ? "success" : "default"}
                        title={
                          modelctl?.installed
                            ? `modelctl ${modelctl.version ?? "?"} on this node`
                            : modelctl && typeof modelctl.error === "string"
                              ? modelctl.error
                              : undefined
                        }
                      />
                    )}
                  </>
                );
              }

              // Head / Standalone: same as before — live backend + model id.
              const llmArr = spark.metrics.llm;
              const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
              if (!llm) return null;
              return (
                <OcardStat
                  label={
                    llm.backend === "vllm"
                      ? "vLLM"
                      : llm.backend === "ds4"
                        ? "ds4"
                        : llm.backend === "sglang"
                          ? "sgLang"
                          : llm.backend === "exl3"
                            ? "EXL3"
                            : llm.backend ?? "LLM"
                  }
                  value={llm.modelId ?? "unknown"}
                  tone="accent"
                  title={llm.modelId ?? undefined}
                  wrap
                />
              );
            })()}
          </div>

          {(() => {
            const role = resolveSparkRole(spark);
            if (role === "worker") return null;
            const llmArr = spark.metrics.llm;
            const llm = Array.isArray(llmArr) ? llmArr.find((l) => l.available) : null;
            if (!llm) return null;
            return (
              <div className="ocard-tps">
                <div>
                  <span className="dial__value">{llm.generationTps.toFixed(0)}</span>
                  <span className="dial__unit"> tok/s</span>
                </div>
                <div>
                  <span className="dial__value">{llm.prefillTps.toFixed(0)}</span>
                  <span className="dial__unit"> prefill</span>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

/** Lazy-fetched extras for the NAS overview card (all optional, error-tolerant).
 *  The read endpoints resolve to the NAS node server-side, so one shared
 *  snapshot feeds every NAS card; jobs are filtered per node client-side. */
interface NasCardData {
  modelCount: number | null;
  release: ModelctlRelease | null;
  catalog: NasCatalogResponse | null;
  jobs: MctlJob[];
}

/**
 * Overview card for a model-store node (kind "nas"): store capacity instead
 * of VRAM, catalog/model count, modelctl version + update affordance and the
 * running job — no GPU/temperature/usage bars (this node has none).
 */
function NasSparkCard({
  spark,
  data,
  modelctl,
  onSelect,
}: {
  spark: SparkSnapshot;
  data: NasCardData | null;
  modelctl: ModelctlStatus | null | undefined;
  onSelect?: (id: string) => void;
}) {
  const online = spark.online;
  const root = spark.nasRoot || "";
  const mount = matchStoreMount(spark.metrics?.storage ?? [], root);
  const used = mount?.used ?? 0;
  const total = mount?.total ?? 0;
  const installed = modelctl?.version ? `v${modelctl.version}` : null;
  const latest = data?.release?.latest ?? null;
  const updateAvailable = versionIsNewer(latest, modelctl?.version ?? null);
  const runningJob =
    (data?.jobs ?? []).filter((j) => j.sparkId === spark.id).find((j) => j.status === "running") ?? null;
  const modelCount = data?.modelCount ?? null;

  return (
    <div className="module" style={online ? undefined : { opacity: 0.6 }}>
      {/* Card header */}
      <div className="spread">
        <div className="row">
          <ScLed state={online ? "live" : "off"} />
          {onSelect ? (
            <button type="button" className="ocard-name" onClick={() => onSelect(spark.id)}>
              {spark.name}
            </button>
          ) : (
            <span className="ocard-name">{spark.name}</span>
          )}
          <span className="chip chip--accent" title="Model-store node — serves nothing">
            NAS
          </span>
        </div>
        <div className="row">
          <span className="mlabel">{online ? "online" : "offline"}</span>
        </div>
      </div>

      {/* Hero: store capacity, not VRAM */}
      <div className="gauge-grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <div className="gauge">
          <div className="gauge__top">
            <span className="mlabel">Store</span>
            <span className="gauge__value">
              {mount ? `${fmtStore(used)} / ${fmtStore(total)}` : root ? "— / —" : "no store path"}
            </span>
          </div>
          <ScSeg pct={mount?.percentage ?? 0} tone="accent" />
          <div className="gauge__foot">
            <span>{mount ? `${fmtStore(mount.available)} free` : ""}</span>
            <span>{!mount && root ? "—" : ""}</span>
          </div>
        </div>
      </div>

      <div className="row">
        <span className="chip" title="modelctl list — published entries">
          {modelCount == null ? "…" : `${modelCount} model${modelCount === 1 ? "" : "s"}`}
        </span>
        <span
          className="chip"
          style={installed ? { color: "var(--color-success)" } : undefined}
          title="modelctl --version"
        >
          {installed ? `modelctl ${installed}` : modelctl ? "modelctl missing" : "modelctl …"}
        </span>
        {updateAvailable && onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(spark.id)}
            className="chip"
            style={{ color: "var(--color-warning)", cursor: "pointer", textDecoration: "underline" }}
            title="A modelctl update is available — open the node page to run the update job"
          >
            {latest} · update →
          </button>
        ) : null}
      </div>

      <div className="ocard-stats">
        <OcardStat label="Store path" value={root || "—"} title={root || undefined} wrap />
        <OcardStat
          label="Catalog"
          value={
            data?.catalog && !data.catalog.error
              ? `gen ${data.catalog.generation ?? "—"} · ${agoLabel(data.catalog.generatedAt)}`
              : data?.catalog?.error
                ? "unreadable"
                : "…"
          }
          tone={data?.catalog && !data.catalog.error ? "success" : "default"}
          title={data?.catalog?.error ?? undefined}
        />
      </div>

      {runningJob ? (
        <div className="row" title={`${runningJob.name || runningJob.kind}`}>
          <span className="bench-status-pill bench-status-pill--running">running</span>
          <span className="ocard-stat__v" style={{ flex: 1 }}>
            {runningJob.name || runningJob.kind}
          </span>
        </div>
      ) : null}

      <div
        className="bus-hint font-tabular"
        style={{
          marginTop: "auto",
          borderTop: "1px solid var(--color-border)",
          paddingTop: "var(--space-2)",
        }}
      >
        <span>{spark.lanIp || "—"}</span>
        <span> · </span>
        <span>up {online ? fmtUptimeShort(spark.uptime) : "—"}</span>
        {spark.hardware?.device ? (
          <span style={{ marginLeft: "var(--space-3)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {spark.hardware.device}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function OverviewPage({ sparks, hideOffline = false, temperatureUnit = "celsius", onSelectSpark }: OverviewPageProps) {
  const visibleSparks = hideOffline ? sparks.filter((s) => s.online) : sparks;
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchMsg, setBatchMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  /** Spark ids we started a batch Hermes update on; drives the live progress bar. */
  const [batchRun, setBatchRun] = useState<string[] | null>(null);

  // modelctl version per opt-in node (workers + NAS store nodes). The server
  // caches version probes (5 min TTL), so one lazy fetch per node id is cheap.
  const probeIds = useMemo(
    () =>
      sparks
        .filter(
          (s) =>
            s.online && s.modelctlEnabled && (resolveSparkRole(s) === "worker" || s.kind === "nas")
        )
        .map((s) => s.id),
    [sparks]
  );
  const [modelctlChecks, setModelctlChecks] = useState<
    Record<string, ModelctlStatus | null | undefined>
  >({});
  const mctlRequested = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of probeIds) {
      if (mctlRequested.current.has(id)) continue;
      mctlRequested.current.add(id);
      // No cancelled-guard: this effect re-runs on EVERY WS tick (sparks is
      // a fresh array), so a per-run guard would discard every response that
      // lands after the next tick — and the ref blocks a retry, stranding the
      // card at "checking…". Writes are keyed by spark id (functional
      // updater), so a late response can never clobber another node.
      void modelctlStatus(id)
        .then((r) => setModelctlChecks((p) => ({ ...p, [id]: r })))
        .catch(() => {
          // Release the latch so a transient failure retries on the next
          // tick; the server's 5-min cache absorbs the traffic. null keeps
          // showing "not installed" until it succeeds.
          mctlRequested.current.delete(id);
          setModelctlChecks((p) => ({ ...p, [id]: null }));
        });
    }
  }, [probeIds]);

  // NAS overview extras: one shared lazy fetch (the endpoints resolve to the
  // NAS node server-side), refreshed on a slow cadence while a store node is
  // visible. Every failure is tolerated — the card degrades to "…".
  const hasNas = useMemo(
    () => sparks.some((s) => s.kind === "nas" && s.online),
    [sparks]
  );
  const [nasData, setNasData] = useState<NasCardData | null>(null);
  useEffect(() => {
    if (!hasNas) return;
    let cancelled = false;
    const tick = async () => {
      const [inv, jobs, rel, cat] = await Promise.allSettled([
        listNasModels(),
        listJobs(),
        fetchModelctlRelease(),
        fetchNasCatalog(),
      ]);
      if (cancelled) return;
      setNasData({
        modelCount: inv.status === "fulfilled" ? inv.value.models.length : null,
        release: rel.status === "fulfilled" ? rel.value : null,
        catalog: cat.status === "fulfilled" ? cat.value : null,
        jobs: jobs.status === "fulfilled" ? jobs.value.jobs : [],
      });
    };
    void tick();
    const t = window.setInterval(() => void tick(), 60000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [hasNas]);

  const onlineShutdownCount = sparks.filter((s) => s.online).length;
  const hermesMonitoredCount = sparks.filter((s) => s.hermes?.monitoring).length;
  const hermesPendingUpdateCount = sparks.filter((s) => s.hermes?.updateAvailable === true).length;

  // Live batch progress — counted from WS snapshots, not from the one-shot HTTP response.
  const batchProg = (() => {
    if (!batchRun || batchRun.length === 0) return null;
    let done = 0;
    let failed = 0;
    for (const id of batchRun) {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) continue;
      if (h.status === "error") {
        done += 1;
        failed += 1;
      } else if (h.status === "success" || h.finishedAt != null) {
        done += 1;
      }
    }
    return { total: batchRun.length, done, failed };
  })();

  // Once every started update has settled (success/error), dismiss the progress bar.
  useEffect(() => {
    if (!batchRun || batchRun.length === 0) return;
    const settled = batchRun.reduce((n, id) => {
      const h = sparks.find((s) => s.id === id)?.hermes;
      if (!h) return n;
      return n + (h.status === "success" || h.status === "error" || h.finishedAt != null ? 1 : 0);
    }, 0);
    if (settled === batchRun.length) {
      const t = setTimeout(() => setBatchRun(null), 6000);
      return () => clearTimeout(t);
    }
  }, [batchRun, sparks]);

  async function handleUpdateAllHermes() {
    if (hermesMonitoredCount === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await updateAllHermes();
      const started = res.results.filter((r) => r.started);
      const skipped = res.results.filter((r) => r.skipped).length;
      const failed = res.results.filter((r) => !r.ok && !r.skipped).length;
      const parts = [`${started.length} update${started.length === 1 ? "" : "s"} started`];
      if (skipped) parts.push(`${skipped} skipped`);
      if (failed) parts.push(`${failed} failed`);
      setBatchMsg({
        text: parts.join(", "),
        tone: failed === 0 ? "ok" : "err",
      });
      // Merge with any in-flight batch instead of replacing (server may skip
      // already-running jobs, which must not clear a live progress bar).
      setBatchRun((prev) => {
        const ids = started.map((r) => r.id);
        if (ids.length === 0) return prev;
        return [...new Set([...(prev ?? []), ...ids])];
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch hermes update failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleShutdownAll() {
    if (onlineShutdownCount === 0) return;
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await shutdownAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok && !r.skipped).length;
      const skipped = res.results.filter((r) => r.skipped).length;
      const parts = [`${ok} shut down`];
      if (fail) parts.push(`${fail} failed`);
      if (skipped) parts.push(`${skipped} skipped`);
      setBatchMsg({
        text: parts.join(", "),
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch shutdown failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  async function handleWakeAll() {
    setBatchLoading(true);
    setBatchMsg(null);
    try {
      const res = await wakeAllSparks();
      const ok = res.results.filter((r) => r.ok).length;
      const fail = res.results.filter((r) => !r.ok).length;
      setBatchMsg({
        text: fail === 0 ? `${ok} wake packet(s) sent` : `${ok} sent, ${fail} failed`,
        tone: fail === 0 ? "ok" : "err",
      });
    } catch (err: unknown) {
      setBatchMsg({
        text: err instanceof Error ? err.message : "Batch wake failed",
        tone: "err",
      });
    } finally {
      setBatchLoading(false);
      setTimeout(() => setBatchMsg(null), 6000);
    }
  }

  if (visibleSparks.length === 0) {
    const allOffline = hideOffline && sparks.length > 0;
    return (
      <div className="spark-console">
        <div className="module ocard-empty" style={{ maxWidth: 420, margin: "64px auto 0" }}>
          <span className="mlabel">{allOffline ? "All Sparks are offline" : "No Sparks registered"}</span>
          <p className="empty-note">
            {allOffline
              ? "Auto-hide is enabled and no Sparks are currently online."
              : "Click the + tab to add a DGX Spark unit."}
          </p>
        </div>
      </div>
    );
  }

  const onlineCount = visibleSparks.filter((s) => s.online).length;

  return (
    <div
      className="spark-console"
      style={{ display: "flex", flexDirection: "column", gap: "var(--density-overview-rhythm)" }}
    >
      <header className="module rack" aria-label="Overview">
        <div className="rack__id">
          <span className="rack__name">Overview</span>
          <span className="chip" title="Nodes online">
            <ScLed state={onlineCount > 0 ? "success" : "danger"} />
            {onlineCount}/{visibleSparks.length} online
          </span>
        </div>
        <div className="plate" role="group" aria-label="Fleet data plate">
          {dataField("Nodes", String(visibleSparks.length))}
          {dataField("Online", String(onlineCount))}
          {hermesMonitoredCount > 0 && dataField("Hermes", String(hermesMonitoredCount))}
          {hermesPendingUpdateCount > 0 && dataField("Updates", String(hermesPendingUpdateCount))}
        </div>
        <div className="rack__keys">
          {batchMsg && (
            <span className={`obatch-msg ${batchMsg.tone === "ok" ? "obatch-msg--ok" : "obatch-msg--err"}`}>
              {batchMsg.text}
            </span>
          )}
          {batchProg && (
            <div className="obatch">
              <span className="row" style={{ gap: 5 }}>
                <span className="mlabel">Updating Hermes</span>
                <span className="ocard-stat__v">
                  {batchProg.done}/{batchProg.total}
                </span>
                {batchProg.failed > 0 && (
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: "var(--fs-11)",
                      color: "var(--color-danger)",
                    }}
                  >
                    {batchProg.failed} failed
                  </span>
                )}
                <button
                  type="button"
                  className="key obatch__dismiss"
                  onClick={() => setBatchRun(null)}
                  aria-label="Dismiss update progress"
                  title="Dismiss"
                >
                  ✕
                </button>
              </span>
              <div className="job-progress">
                <div
                  className="job-progress__fill"
                  style={{
                    width: `${batchProg.total > 0 ? Math.round((batchProg.done / batchProg.total) * 100) : 0}%`,
                    background:
                      batchProg.failed > 0 ? "var(--color-danger)" : "var(--color-accent)",
                  }}
                />
              </div>
            </div>
          )}
          {sparks.length > 0 && (
            <>
              {hermesMonitoredCount > 0 && (
                <button
                  type="button"
                  onClick={() => void handleUpdateAllHermes()}
                  disabled={batchLoading}
                  title="Run `hermes update` on every Spark with Hermes Agent enabled"
                  className={`key${hermesPendingUpdateCount > 0 ? " key--run" : ""}`}
                >
                  <RotateIcon className="h-3 w-3" />
                  Update Hermes
                  {hermesPendingUpdateCount > 0 && (
                    <span
                      className="chip chip--warn"
                      title={`${hermesPendingUpdateCount} Spark${hermesPendingUpdateCount === 1 ? "" : "s"} with a Hermes update available`}
                    >
                      {hermesPendingUpdateCount}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleWakeAll()}
                disabled={batchLoading}
                title="Wake all Sparks that have a MAC configured (WoL)"
                className="key"
              >
                <PowerOnIcon className="h-3 w-3" />
                Wake All
              </button>
              <button
                type="button"
                onClick={() => setShutdownOpen(true)}
                disabled={batchLoading || onlineShutdownCount === 0}
                title="Shut down all online Sparks"
                className="key key--danger"
              >
                <PowerOffIcon className="h-3 w-3" />
                Shutdown All
              </button>
            </>
          )}
        </div>
      </header>
      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdownAll}
        title="Shutdown All"
        description={`Gracefully shut down all ${onlineShutdownCount} online Spark${onlineShutdownCount === 1 ? "" : "s"}? Offline nodes will be skipped.`}
        confirmLabel="Shut down all"
      />
      <div className="overview-page grid sm:grid-cols-2 lg:grid-cols-3" style={{ gap: "var(--density-page-gap)" }}>
        {visibleSparks.map((spark) =>
          spark.kind === "nas" ? (
            <NasSparkCard
              key={spark.id}
              spark={spark}
              data={nasData}
              modelctl={modelctlChecks[spark.id]}
              onSelect={onSelectSpark}
            />
          ) : (
            <SparkCard
              key={spark.id}
              spark={spark}
              headSpark={
                spark.workerHeadId
                  ? sparks.find((s) => s.id === spark.workerHeadId) ?? null
                  : null
              }
              modelctl={modelctlChecks[spark.id]}
              temperatureUnit={temperatureUnit}
              onSelect={onSelectSpark}
            />
          )
        )}
      </div>
    </div>
  );
}