import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ModelctlStatus, SparkConfig, SparkSnapshot, MctlJob } from "../../api/types";
import { isLlmMonitoringEnabled, resolveSparkRole } from "../../api/sparkRole";
import {
  updateSpark,
  refreshSparkMetric,
  addLlmPort,
  removeLlmPort,
  fetchSparks,
  modelctlStatus as fetchModelctlStatus,
  listJobs,
  cancelJob,
} from "../../api/client";
import { SparkActions } from "./SparkActions";
import { GpuPanel } from "./GpuPanel";
import { RamPanel } from "./RamPanel";
import { StoragePanel } from "./StoragePanel";
import { NetworkPanel } from "./NetworkPanel";
import { TailscalePanel } from "./TailscalePanel";
import { LlmPanel } from "./LlmPanel";
import { ComfyPanel } from "./ComfyPanel";
import { ScChHead } from "./console/ScKit";
import { ScResources } from "./console/ScResources";
import { ScServing } from "./console/ScServing";
import { ScModels } from "./console/ScModels";
import { ScTests } from "./console/ScTests";
import { fmtUptimeShort } from "./console/consoleUtils";
import "../../styles/console.css";

interface SparkPageProps {
  spark: SparkSnapshot;
  temperatureUnit: "celsius" | "fahrenheit";
  onEdit?: () => void;
  /** Navigate app views: null → overview, string → another spark id. */
  onNavigate?: (id: string | null) => void;
}

const JOBS_POLL_ACTIVE_MS = 1000;
const JOBS_POLL_IDLE_MS = 15000;

function dataField(k: string, v: string | null) {
  if (v == null || v === "" || v === "—") return null;
  return (
    <div className="plate__f">
      <span className="plate__k">{k}</span>
      <span className="plate__v" title={v}>
        {v}
      </span>
    </div>
  );
}

export function SparkPage({ spark, temperatureUnit, onEdit, onNavigate }: SparkPageProps) {
  const { metrics } = spark;
  const [disabledDevices, setDisabledDevices] = useState<string[]>(spark.disabledDevices || []);
  const [disabledInterfaces, setDisabledInterfaces] = useState<string[]>(
    spark.disabledInterfaces || []
  );
  const [llmPorts, setLlmPorts] = useState<number[]>(spark.llmPorts ?? [spark.llmPort ?? 8888]);
  const [storagePollDisabled, setStoragePollDisabled] = useState<boolean>(
    spark.storagePollDisabled ?? false
  );
  // Config-only fields the WS snapshot doesn't carry (modelctl opt-in, head name).
  const [allCfg, setAllCfg] = useState<SparkConfig[] | null>(null);
  const cfg = allCfg?.find((s) => s.id === spark.id) ?? null;
  const [modelctl, setModelctl] = useState<ModelctlStatus | null>(null);
  const [jobs, setJobs] = useState<MctlJob[]>([]);
  // Increments when the Serving CTA asks Models to scroll+flash the launch panel.
  const [launchSignal, setLaunchSignal] = useState(0);
  // Add-port mini form (legacy parity; lives in the Serving disclosure).
  const [showAddPort, setShowAddPort] = useState(false);
  const [newPortDraft, setNewPortDraft] = useState("");

  const llmOn = isLlmMonitoringEnabled(spark);
  const role = resolveSparkRole(spark);
  const modelctlEnabled = Boolean(cfg?.modelctlEnabled);

  // Sync when spark data changes (WS push)
  useEffect(() => {
    setDisabledDevices(spark.disabledDevices || []);
  }, [spark.disabledDevices]);

  useEffect(() => {
    setDisabledInterfaces(spark.disabledInterfaces || []);
  }, [spark.disabledInterfaces]);

  useEffect(() => {
    if (spark.llmPorts) setLlmPorts(spark.llmPorts);
  }, [spark.llmPorts]);

  useEffect(() => {
    setStoragePollDisabled(spark.storagePollDisabled ?? false);
  }, [spark.storagePollDisabled]);

  // Resolve configs (modelctlEnabled flag + names for the worker head link).
  useEffect(() => {
    let dead = false;
    setAllCfg(null);
    fetchSparks()
      .then(({ sparks }) => !dead && setAllCfg(sparks))
      .catch(() => !dead && setAllCfg(null));
    return () => {
      dead = true;
    };
  }, [spark.id]);

  // modelctl version (once per node + explicit refresh after install).
  const refreshModelctl = useCallback(() => {
    return fetchModelctlStatus(spark.id, true)
      .then((st) => {
        setModelctl(st);
        if (st.installed) setCfgInstalled();
        return st;
      })
      .catch((err) => {
        setModelctl({
          installed: false,
          version: null,
          uv: { installed: false, version: null },
          error: String(err instanceof Error ? err.message : err),
        });
      });
    function setCfgInstalled() {
      setAllCfg((list) =>
        list ? list.map((s) => (s.id === spark.id ? { ...s, modelctlEnabled: true } : s)) : list
      );
    }
  }, [spark.id]);

  useEffect(() => {
    if (!modelctlEnabled || !spark.online) return;
    void refreshModelctl();
  }, [modelctlEnabled, spark.online, refreshModelctl]);

  // Jobs poll: 1s while anything runs on this node, 15s otherwise.
  useEffect(() => {
    if (!modelctlEnabled || !spark.online) {
      setJobs([]);
      return;
    }
    let dead = false;
    let timer = 0;
    const tick = () => {
      listJobs()
        .then(({ jobs: all }) => {
          if (dead) return;
          const mine = all.filter((j) => j.sparkId === spark.id);
          setJobs(mine);
          window.clearTimeout(timer);
          const hasRunning = mine.some((j) => j.status === "running");
          timer = window.setTimeout(tick, hasRunning ? JOBS_POLL_ACTIVE_MS : JOBS_POLL_IDLE_MS);
        })
        .catch(() => {
          if (!dead) timer = window.setTimeout(tick, JOBS_POLL_IDLE_MS);
        });
    };
    tick();
    return () => {
      dead = true;
      window.clearTimeout(timer);
    };
  }, [modelctlEnabled, spark.online, spark.id]);

  const handleCancelJob = useCallback(async (jobId: string) => {
    try {
      await cancelJob(jobId);
    } catch {
      /* strip refresh picks up the new state */
    }
  }, []);

  const handleStoragePollModeChange = useCallback(
    async (disabled: boolean) => {
      setStoragePollDisabled(disabled);
      try {
        await updateSpark(spark.id, { storagePollDisabled: disabled });
        // When disabling auto-refresh, do one manual refresh immediately
        if (disabled) {
          refreshSparkMetric(spark.id, "storage").catch((err) =>
            console.error("Failed to refresh storage after disabling auto-refresh:", err)
          );
        }
      } catch (err) {
        console.error("Failed to update storage poll mode:", err);
        setStoragePollDisabled(!disabled); // revert
      }
    },
    [spark.id]
  );

  const handleAddPort = useCallback(
    async (port: number) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      if (llmPorts.includes(port)) return;
      try {
        const result = await addLlmPort(spark.id, port);
        setLlmPorts(result.llmPorts);
      } catch (err) {
        console.error("Failed to add LLM port:", err);
      }
    },
    [spark.id, llmPorts]
  );

  const handleRemovePort = useCallback(
    async (port: number) => {
      try {
        const result = await removeLlmPort(spark.id, port);
        setLlmPorts(result.llmPorts);
      } catch (err) {
        console.error("Failed to remove LLM port:", err);
      }
    },
    [spark.id]
  );

  const commitAddPort = useCallback(() => {
    const port = Number.parseInt(newPortDraft.trim(), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    void handleAddPort(port).then(() => {
      setNewPortDraft("");
      setShowAddPort(false);
    });
  }, [newPortDraft, handleAddPort]);

  const jobsRunning = jobs.some((j) => j.status === "running");
  const anyEngine = llmOn && (metrics.llm ?? []).some((l) => l?.available);
  const comfyOn = Boolean(spark.comfyMonitoring);
  const tailscaleOn = Boolean(spark.tailscaleMonitoring);
  const primaryPort = llmPorts[0] ?? null;
  const primaryLlm = metrics.llm?.[0] ?? null;
  const servingModelIds = llmPorts.map((_, i) => metrics.llm?.[i]?.modelId ?? null);
  const headSparkName =
    spark.workerHeadId != null
      ? allCfg == null
        ? null
        : (allCfg.find((s) => s.id === spark.workerHeadId)?.name ?? spark.workerHeadId)
      : null;

  // ── Legacy affordances (Expert panels disclosures) ──────────────────
  const renderLlmPanel = (port: number, portIndex: number, className?: string) => (
    <LlmPanel
      key={port}
      llm={metrics.llm?.[portIndex] ?? null}
      sparkId={spark.id}
      llmPort={port}
      llmPorts={llmPorts}
      hasApiKey={Boolean(spark.llmApiKeyPorts?.includes(port))}
      onRemovePort={portIndex > 0 ? handleRemovePort : undefined}
      className={className}
    />
  );

  const resourcesLegacy: ReactNode = (
    <div className="grid gap-3 md:grid-cols-2">
      <GpuPanel
        gpu={metrics.gpu}
        cpu={metrics.cpu}
        sparkId={spark.id}
        temperatureUnit={temperatureUnit}
      />
      <RamPanel
        ram={metrics.ram}
        cpu={metrics.cpu}
        sparkId={spark.id}
        temperatureUnit={temperatureUnit}
      />
      <StoragePanel
        storage={metrics.storage}
        sparkId={spark.id}
        disabledDevices={disabledDevices}
        onDisabledChange={setDisabledDevices}
        storagePollDisabled={storagePollDisabled}
        onStoragePollModeChange={handleStoragePollModeChange}
      />
      <NetworkPanel
        network={metrics.network}
        sparkId={spark.id}
        disabledInterfaces={disabledInterfaces}
        onDisabledChange={setDisabledInterfaces}
      />
      {tailscaleOn && <TailscalePanel tailscale={metrics.tailscale ?? null} />}
    </div>
  );

  const servingLegacy: ReactNode = (
    <div className="grid gap-3 md:grid-cols-2">
      {llmOn && renderLlmPanel(primaryPort ?? spark.llmPort ?? 8888, 0)}
      {llmPorts.slice(1).map((port, j) => renderLlmPanel(port, j + 1, "md:col-span-2"))}
      {comfyOn && (
        <ComfyPanel
          comfy={metrics.comfy ?? null}
          comfyPort={spark.comfyPort ?? 8188}
          sparkId={spark.id}
          lanIp={spark.lanIp}
          className="md:col-span-2"
        />
      )}
      {llmOn &&
        (showAddPort ? (
          <div className="rounded-lg border border-dashed border-border bg-surface p-3 md:col-span-2">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                placeholder="Port number"
                value={newPortDraft}
                onChange={(e) => setNewPortDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitAddPort();
                  }
                }}
                className="w-32 rounded-md border border-border bg-surface-elevated px-3 py-1.5 font-tabular text-sm text-text outline-none focus:border-accent"
                autoFocus
              />
              <button
                type="button"
                onClick={() => commitAddPort()}
                disabled={!newPortDraft.trim()}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddPort(false);
                  setNewPortDraft("");
                }}
                className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAddPort(true)}
            className="md:col-span-2 rounded-lg border border-dashed border-border bg-transparent p-3 text-xs text-muted hover:border-accent hover:text-accent transition-colors"
          >
            + Add LLM port
          </button>
        ))}
    </div>
  );

  // Rack plate values
  const hw = spark.hardware;
  const soc = hw.gpuChip ?? (hw.device === "DGX Spark" ? "GB10" : null);
  const pkgs =
    [
      modelctl?.installed ? `modelctl v${modelctl.version ?? "?"}` : null,
      spark.agentEnabled ? `agent v${spark.agentVersion ?? "?"}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  return (
    <div className="spark-console">
      <main className="console">
        {/* ── Node header: rack plate ───────────────────────────────── */}
        <header className="module rack col-full" aria-label="Node identity">
          <div className="rack__back">
            <a
              className="node-back"
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate?.(null);
              }}
            >
              ‹ Overview
            </a>
            <div className="rack__id">
              <span
                className={`led ${spark.online ? "led--live" : ""}`}
                title={spark.online ? "Online" : "Offline"}
                aria-label={spark.online ? "Online" : "Offline"}
              />
              <span className="rack__name">{spark.name}</span>
              {role !== "standalone" ? <span className="chip chip--accent">{role}</span> : null}
              {role === "worker" && spark.workerLabel ? (
                <span className="chip">{spark.workerLabel}</span>
              ) : null}
              {spark.transport === "agent" ? (
                <span
                  className="chip chip--live"
                  title={`sparkdash agent connected (v${spark.agentVersion ?? "?"}) — metrics stream over WebSocket; SSH is the fallback`}
                >
                  Agent
                </span>
              ) : spark.agentEnabled ? (
                <span
                  className="chip"
                  title="sparkdash agent enabled but not connected — metrics come over SSH"
                >
                  SSH
                </span>
              ) : null}
              {spark.hermes?.monitoring && spark.hermes.installed && spark.hermes.version ? (
                <span
                  className="chip"
                  title={`Hermes Agent ${spark.hermes.version} installed on this machine`}
                >
                  Hermes
                </span>
              ) : null}
              {spark.hermes?.monitoring &&
              spark.hermes.installed === false &&
              spark.hermes.checkedAt != null ? (
                <span
                  className="chip chip--err"
                  title="The `hermes` binary was not found on this machine (check the install path or Edit Spark)."
                >
                  Hermes not found
                </span>
              ) : null}
              {spark.hermes?.monitoring && spark.hermes.error && spark.hermes.status === "idle" ? (
                <span
                  className="chip chip--err"
                  style={{ maxWidth: "16rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={`Update check failed — it will retry automatically: ${spark.hermes.error}`}
                >
                  Update check failed
                </span>
              ) : null}
            </div>
          </div>
          <div className="plate" role="group" aria-label="Node data plate">
            {dataField("HW", hw.device ?? null)}
            {dataField("SOC", soc)}
            {dataField("Addr", spark.lanIp ?? cfg?.lanIp ?? null)}
            {dataField("Up", spark.online ? fmtUptimeShort(spark.uptime) : "offline")}
            {dataField("Pkg", pkgs)}
          </div>
          <SparkActions spark={spark} onEdit={onEdit} className="rack__keys" />
        </header>

        {/* ── Sticky channel rail ───────────────────────────────────── */}
        <aside className="rail" aria-label="Console channels">
          <span className="rail__cap">CH</span>
          <RailChannel
            target="sec-resources"
            num="01"
            short="Res"
            title="Resources"
            led={spark.online ? "accent" : "off"}
          />
          <RailChannel
            target="sec-serving"
            num="02"
            short="Srv"
            title="Serving"
            led={anyEngine ? "live" : "off"}
          />
          <RailChannel
            target="sec-models"
            num="03"
            short="Mdl"
            title="Models"
            led={jobsRunning ? "live" : modelctlEnabled ? "success" : "off"}
          />
          <RailChannel target="sec-tests" num="04" short="Tst" title="Tests" led="off" />
          <div className="rail__bus" aria-hidden="true" />
        </aside>

        <div className="console__body">
          {/* ── CH·01 Resources ─────────────────────────────────────── */}
          <div id="sec-resources" />
          <ScChHead
            code="CH·01"
            title="Resources"
            note={
              role === "worker"
                ? "worker telemetry · no local engine"
                : "unified memory · storage · network" + (tailscaleOn ? " · tailnet" : "")
            }
          />
          <ScResources
            spark={spark}
            temperatureUnit={temperatureUnit}
            tailscaleOn={tailscaleOn}
            headSparkName={headSparkName}
            workerHeadId={spark.workerHeadId ?? null}
            onNavigate={onNavigate}
          >
            {resourcesLegacy}
          </ScResources>

          {/* ── CH·02 Serving ───────────────────────────────────────── */}
          <div id="sec-serving" />
          <ScChHead
            code="CH·02"
            title="Serving"
            note={
              role === "worker"
                ? "workers serve through their head"
                : "manage models in CH·03 below"
            }
          />
          <ScServing
            spark={spark}
            llmOn={llmOn}
            role={role}
            llmPorts={llmPorts}
            primaryPort={primaryPort}
            onAddPort={handleAddPort}
            onRemovePort={handleRemovePort}
            onServeNew={() => setLaunchSignal((n) => n + 1)}
            comfyOn={comfyOn}
            workerHeadId={spark.workerHeadId ?? null}
            headSparkName={headSparkName}
            onNavigate={onNavigate}
          >
            {servingLegacy}
          </ScServing>

          {/* ── CH·03 Models ────────────────────────────────────────── */}
          <div id="sec-models" />
          <ScChHead
            code="CH·03"
            title="Models"
            note={modelctlEnabled ? "select a model to manage it on this node" : undefined}
          />
          <ScModels
            spark={spark}
            modelctlEnabled={modelctlEnabled}
            modelctl={modelctl}
            onModelctlInstalled={refreshModelctl}
            jobs={jobs}
            onCancelJob={handleCancelJob}
            servingModelIds={servingModelIds}
            llmPorts={llmPorts}
            primaryPort={primaryPort}
            launchSignal={launchSignal}
            storageFreeGb={
              // Collectors report storage available in MB (SystemCollector statfs/df paths).
              metrics.storage?.length
                ? Math.round(
                    Math.max(
                      ...metrics.storage.filter((s) => !s.disabled).map((s) => s.available ?? 0)
                    ) / 1024
                  )
                : null
            }
            onNavigate={onNavigate}
          />

          {/* ── CH·04 Tests ─────────────────────────────────────────── */}
          <div id="sec-tests" />
          <ScChHead
            code="CH·04"
            title="Tests"
            note="run against the model in CH·02 · tagged so Analysis separates self-runs"
          />
          <ScTests
            sparkId={spark.id}
            primaryPort={llmOn ? primaryPort : null}
            modelId={primaryLlm?.modelId ?? null}
            contextLength={primaryLlm?.contextLength ?? null}
            llmAvailable={Boolean(primaryLlm?.available)}
            hasServingScript={true}
          />
        </div>
      </main>
    </div>
  );
}

function RailChannel({
  target,
  num,
  short,
  title,
  led,
}: {
  target: string;
  num: string;
  short: string;
  title: string;
  led: "off" | "live" | "success" | "accent";
}) {
  return (
    <button
      className="rail__ch"
      type="button"
      title={title}
      onClick={() =>
        document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
    >
      <span className={`led${led === "off" ? "" : ` led--${led}`}`} aria-hidden="true" />
      <span className="rail__num">{num}</span>
      {short}
    </button>
  );
}
