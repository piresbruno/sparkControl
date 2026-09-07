/**
 * CH·03 Models — modelctl enrollment, node/NAS inventory, per-model actions
 * (sync / push / delete), serve-script launcher (flash target for the Serving
 * CTA), serving-log tail, placement hints and recent proxy traces.
 *
 * All markup uses the real v3 vocabulary from src/styles/console.css
 * (.spark-console scope): .model-row/.job-row/.subpanel/.key/.xref/….
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  MctlJob,
  ModelctlStatus,
  NasModel,
  Placement,
  ServingScript,
  SparkSnapshot,
  TraceEntry,
} from "../../../api/types";
import {
  fetchSettings,
  fetchSparks,
  getJob,
  listNasModels,
  listNodeModels,
  listServingScripts,
  listTraces,
  servingLog,
  servingPlacement,
  servingStart,
  startJob,
  updateSpark,
} from "../../../api/client";
import { ScChip, ScModule, ScSubpanel } from "./ScKit";
import { fmtGB, fmtInt, fmtSeconds, shortModelName, tokenizeLogLine } from "./consoleUtils";

interface ScModelsProps {
  spark: SparkSnapshot;
  modelctlEnabled: boolean;
  modelctl: ModelctlStatus | null;
  onModelctlInstalled: () => Promise<unknown> | void;
  jobs: MctlJob[];
  onCancelJob: (jobId: string) => void;
  servingModelIds: (string | null)[];
  llmPorts: number[];
  primaryPort: number | null;
  launchSignal: number;
  storageFreeGb: number | null;
  onNavigate?: (id: string | null) => void;
}

const errText = (err: unknown): string =>
  String(err instanceof Error ? err.message : err).slice(0, 300);

/** Kind → silkscreen label (arrows match server job names). */
const KIND_LABEL: Record<MctlJob["kind"], string> = {
  download: "download",
  sync: "sync →",
  push: "push →",
  "delete-local": "delete",
  "nas-delete": "nas delete",
  "install-modelctl": "install",
  "install-agent": "install agent",
  "update-agent": "update agent",
};

/** Progress % — parsed from the newest `NN%` in logTail (no pct field on MctlJob). */
function jobPct(job: MctlJob): number | null {
  const matches = [...job.logTail.matchAll(/(\d+)%/g)];
  if (!matches.length) return null;
  return Math.min(100, Math.max(0, Number(matches[matches.length - 1][1])));
}

/** "sync unsloth/Llama-3.1-8B → worker-2" → "Llama-3.1-8B → worker-2" */
function jobModelLabel(job: MctlJob): string {
  const prefix = `${job.kind} `;
  let rest = job.name.startsWith(prefix) ? job.name.slice(prefix.length) : job.name;
  if (job.kind === "install-modelctl") rest = "modelctl (uv)";
  const arrowAt = rest.indexOf(" → ");
  if (arrowAt >= 0) return `${shortModelName(rest.slice(0, arrowAt))}${rest.slice(arrowAt)}`;
  return shortModelName(rest);
}

function jobTime(ts: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour12: false }) : "";
}

/** House ms format (shared with the console: 380ms / 3.80s / 1m 4s). */
function fmtMs(ms: number | null | undefined): string {
  return fmtSeconds(ms == null ? null : ms / 1000);
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour12: false }) : "—";
}

const STATUS_TONE: Record<MctlJob["status"], string> = {
  running: "bench-status-pill bench-status-pill--running",
  completed: "bench-status-pill bench-status-pill--completed",
  failed: "bench-status-pill bench-status-pill--failed",
  cancelled: "bench-status-pill bench-status-pill--cancelled",
  interrupted: "bench-status-pill bench-status-pill--interrupted",
};

const LOG_CAP = 200;

export function ScModels({
  spark,
  modelctlEnabled,
  modelctl,
  onModelctlInstalled,
  jobs,
  onCancelJob,
  servingModelIds,
  primaryPort,
  launchSignal,
  storageFreeGb,
  onNavigate,
}: ScModelsProps) {
  /** Local enrollment override: the enable step succeeded but SparkPage's config
   *  list only flips once modelctl is detected installed. */
  const [enrolled, setEnrolled] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [enableErr, setEnableErr] = useState<string | null>(null);
  /** Local install tracking while SparkPage isn't polling jobs yet (enrolled). */
  const [installRunning, setInstallRunning] = useState(false);

  const enabled = modelctlEnabled || enrolled;

  const onInstalledRef = useRef(onModelctlInstalled);
  onInstalledRef.current = onModelctlInstalled;
  const installTimer = useRef<number | undefined>(undefined);

  const trackInstall = useCallback((jobId: string) => {
    window.clearTimeout(installTimer.current);
    setInstallRunning(true);
    const tick = () => {
      getJob(jobId)
        .then((job) => {
          if (job.status === "running") {
            installTimer.current = window.setTimeout(tick, 5000);
            return;
          }
          setInstallRunning(false);
          if (job.status === "completed") void onInstalledRef.current();
          else setEnableErr(`install ${job.status}: ${job.lastError ?? `exit ${job.exitCode ?? "?"}`}`);
        })
        .catch((err) => {
          setInstallRunning(false);
          setEnableErr(errText(err));
        });
    };
    installTimer.current = window.setTimeout(tick, 5000);
  }, []);
  useEffect(() => () => window.clearTimeout(installTimer.current), []);

  /** Enable (server flag) → install job → status refresh. install-modelctl is
   *  gated behind modelctlEnabled server-side (server/index.js ~533), so the
   *  flag MUST be patched first. */
  const handleEnable = useCallback(async () => {
    if (enabling) return;
    setEnabling(true);
    setEnableErr(null);
    try {
      await updateSpark(spark.id, { modelctlEnabled: true });
      setEnrolled(true);
      const { jobId } = await startJob({ kind: "install-modelctl", sparkId: spark.id });
      trackInstall(jobId);
    } catch (err) {
      setEnableErr(errText(err));
    } finally {
      setEnabling(false);
    }
  }, [enabling, spark.id, trackInstall]);

  const handleInstall = useCallback(async () => {
    if (installRunning) return;
    setEnableErr(null);
    try {
      const { jobId } = await startJob({ kind: "install-modelctl", sparkId: spark.id });
      trackInstall(jobId);
    } catch (err) {
      setEnableErr(errText(err));
    }
  }, [installRunning, spark.id, trackInstall]);

  // install-modelctl running→done (jobs polled by SparkPage once enabled).
  const installWasRunning = useRef(false);
  useEffect(() => {
    const mine = jobs.filter((j) => j.kind === "install-modelctl");
    const running = mine.some((j) => j.status === "running");
    if (installWasRunning.current && !running && mine.some((j) => j.status === "completed")) {
      setInstallRunning(false);
      void onInstalledRef.current();
    }
    installWasRunning.current = running;
  }, [jobs]);

  // SparkPage flips modelctlEnabled once refreshModelctl sees an install → drop local tracking.
  useEffect(() => {
    if (!modelctlEnabled || modelctl?.installed) return;
    window.clearTimeout(installTimer.current);
    setInstallRunning(false);
  }, [modelctlEnabled, modelctl?.installed]);

  // ── Inventories + serving scripts ──────────────────────────────────────
  const [nodeModels, setNodeModels] = useState<NasModel[] | null>(null);
  const [nodeModelsErr, setNodeModelsErr] = useState<string | null>(null);
  const [nasModels, setNasModels] = useState<NasModel[] | null>(null);
  const [nasErr, setNasErr] = useState<string | null>(null);
  const [scripts, setScripts] = useState<ServingScript[] | null>(null);
  const [scriptsErr, setScriptsErr] = useState<string | null>(null);
  const [modelsNonce, setModelsNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    listNodeModels(spark.id)
      .then((r) => {
        if (dead) return;
        setNodeModels(r.models ?? []);
        setNodeModelsErr(r.error ?? (r.stale ? "inventory is stale" : null));
      })
      .catch((err) => {
        if (!dead) {
          setNodeModels(null);
          setNodeModelsErr(errText(err));
        }
      });
    listNasModels()
      .then((r) => {
        if (dead) return;
        setNasModels(r.models ?? []);
        setNasErr(r.error ?? null);
      })
      .catch((err) => {
        if (!dead) {
          setNasModels(null);
          setNasErr(errText(err));
        }
      });
    listServingScripts()
      .then((r) => !dead && setScripts(r.scripts ?? []))
      .catch((err) => !dead && setScriptsErr(errText(err)));
    return () => {
      dead = true;
    };
  }, [enabled, spark.id, modelsNonce]);

  // A job that just finished (sync/push/delete/…) may have changed the inventory.
  const runningJobCount = jobs.filter((j) => j.status === "running").length;
  const prevRunningJobs = useRef(runningJobCount);
  useEffect(() => {
    if (prevRunningJobs.current > runningJobCount) setModelsNonce((n) => n + 1);
    prevRunningJobs.current = runningJobCount;
  }, [runningJobCount]);

  // ── Serving state (kept out of destructuring to avoid prop shadowing) ───
  const servingRef = useRef(servingModelIds);
  servingRef.current = servingModelIds;
  const isServing = useCallback(
    (name: string) =>
      servingRef.current.some(
        (id) => id != null && (id === name || shortModelName(id) === shortModelName(name))
      ),
    []
  );

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const armTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    setArmedDelete(false);
    setDetailErr(null);
    return () => window.clearTimeout(armTimer.current);
  }, [selectedName]);

  const nodeNames = nodeModels?.map((m) => m.name) ?? [];
  const merged: NasModel[] = [
    ...(nodeModels ?? []),
    ...(nasModels ?? []).filter((m) => !nodeNames.includes(m.name)),
  ];

  // Default selection: the serving model, else the first node model.
  useEffect(() => {
    if (selectedName || !nodeModels?.length) return;
    const serving = nodeModels.find((m) => isServing(m.name));
    if (serving) setSelectedName(serving.name);
  }, [nodeModels, selectedName, isServing]);

  // Drop the selection once the name exists nowhere (deleted locally, absent on NAS).
  useEffect(() => {
    if (!selectedName || !nodeModels || !nasModels) return;
    const known =
      nodeModels.some((m) => m.name === selectedName) ||
      nasModels.some((m) => m.name === selectedName);
    if (!known) setSelectedName(null);
  }, [nodeModels, nasModels, selectedName]);

  const selectedOnNode = selectedName != null && nodeNames.includes(selectedName);
  const selectedOnNas = selectedName != null && (nasModels?.some((m) => m.name === selectedName) ?? false);
  const selectedModel = merged.find((m) => m.name === selectedName) ?? null;
  // Token-exact match: job names are "sync m" / "push m → spark" /
  // "delete-local m" and model names contain no whitespace — substring
  // matching would disable "Foo-8B" while "Foo-8B-Instruct" runs.
  const modelJobBusy = useCallback(
    (name: string | null) =>
      name != null &&
      jobs.some((j) => j.status === "running" && j.name.split(/\s+/).includes(name)),
    [jobs]
  );
  /** Sync / delete-local / push all key on `model` (server/index.js ~604). */
  const runModelJob = useCallback(
    async (kind: MctlJob["kind"], name: string, extra?: { targetSparkId?: string }) => {
      setDetailErr(null);
      try {
        await startJob({ kind, sparkId: spark.id, model: name, ...extra });
      } catch (err) {
        setDetailErr(errText(err));
      }
    },
    [spark.id]
  );

  const handlePush = useCallback(
    async (name: string) => {
      setDetailErr(null);
      setPushBusy(true);
      try {
        // Resolve the NAS host spark exactly like the server's defaultNasSpark().
        let nasId: string | null = null;
        try {
          const st = await fetchSettings();
          nasId = st.modelctl?.nasHostSparkId ?? null;
        } catch {
          /* fall through to spark-list resolution */
        }
        if (!nasId) {
          const { sparks } = await fetchSparks();
          nasId =
            sparks.find((s) => s.role === "head")?.id ??
            sparks.find((s) => s.isLocal)?.id ??
            sparks[0]?.id ??
            null;
        }
        if (!nasId) throw new Error("no NAS host spark found to push to");
        if (nasId === spark.id) throw new Error("this node is the NAS host — nothing to push");
        await startJob({ kind: "push", sparkId: spark.id, model: name, targetSparkId: nasId });
      } catch (err) {
        setDetailErr(errText(err));
      } finally {
        setPushBusy(false);
      }
    },
    [spark.id]
  );

  const handleDelete = useCallback(
    (name: string) => {
      if (!armedDelete) {
        setArmedDelete(true);
        window.clearTimeout(armTimer.current);
        armTimer.current = window.setTimeout(() => setArmedDelete(false), 3000);
        return;
      }
      window.clearTimeout(armTimer.current);
      setArmedDelete(false);
      void runModelJob("delete-local", name);
    },
    [armedDelete, runModelJob]
  );

  // ── Serve script (launch config) ───────────────────────────────────────
  const [scriptId, setScriptId] = useState("");
  const [modelName, setModelName] = useState<string>("");
  const [port, setPort] = useState<string>(String(primaryPort ?? spark.llmPort ?? 8888));
  const [extraArgs, setExtraArgs] = useState("");
  const [startBusy, setStartBusy] = useState(false);
  const [startMsg, setStartMsg] = useState<string | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);

  useEffect(() => {
    if (primaryPort != null) setPort(String(primaryPort));
  }, [primaryPort]);
  useEffect(() => {
    if (selectedName) setModelName(selectedName);
  }, [selectedName]);

  const [traceNonce, setTraceNonce] = useState(0);
  const handleStart = useCallback(async () => {
    if (!scriptId) {
      setStartErr("Pick a serve script first.");
      return;
    }
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      setStartErr("Port must be an integer 1–65535.");
      return;
    }
    setStartBusy(true);
    setStartErr(null);
    setStartMsg(null);
    try {
      await servingStart({
        sparkId: spark.id,
        scriptId,
        modelName: modelName || undefined,
        port: p,
        extraArgs: extraArgs.trim() ? extraArgs.trim() : undefined,
      });
      setStartMsg("start requested — the Serving card will reflect it shortly.");
      setTraceNonce((n) => n + 1);
    } catch (err) {
      setStartErr(errText(err));
    } finally {
      setStartBusy(false);
    }
  }, [extraArgs, modelName, port, scriptId, spark.id]);

  // Flash + scroll when CH·02 asks to serve a new model (ref/classList — no re-render).
  const launchRef = useRef<HTMLDivElement | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const lastFlash = useRef(0);
  useEffect(() => {
    if (!launchSignal || launchSignal === lastFlash.current || !launchRef.current) return;
    lastFlash.current = launchSignal;
    launchRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    launchRef.current.classList.add("is-flash");
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(
      () => launchRef.current?.classList.remove("is-flash"),
      2400
    );
    return () => window.clearTimeout(flashTimer.current);
  }, [launchSignal, enabled]);

  // ── Serving log tail (5s while a script is selected) ───────────────────
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logErr, setLogErr] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    setLogLines([]);
    setLogErr(null);
    if (!enabled || !scriptId) return;
    let dead = false;
    const tick = () => {
      servingLog(spark.id, scriptId)
        .then((r) => {
          if (dead) return;
          const lines = (r.log ?? "").split("\n");
          while (lines.length && !lines[lines.length - 1]) lines.pop();
          setLogLines(lines.slice(-LOG_CAP));
          setLogErr(null);
        })
        .catch((err) => !dead && setLogErr(errText(err)));
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, [enabled, scriptId, spark.id]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  // ── Placement (selected model) ─────────────────────────────────────────
  const [placement, setPlacement] = useState<Placement | null>(null);
  useEffect(() => {
    if (!enabled || !selectedName) {
      setPlacement(null);
      return;
    }
    let dead = false;
    servingPlacement(selectedName, spark.id)
      .then((p) => !dead && setPlacement(p))
      .catch(() => !dead && setPlacement(null)); // degrade to hidden
    return () => {
      dead = true;
    };
  }, [enabled, selectedName, spark.id, modelsNonce]);

  // ── Recent proxy traces ────────────────────────────────────────────────
  const [traces, setTraces] = useState<TraceEntry[] | null>(null);
  const [traceErr, setTraceErr] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || primaryPort == null) {
      setTraces(null);
      return;
    }
    let dead = false;
    listTraces({ sparkId: spark.id, port: primaryPort, limit: 3 })
      .then((r) => {
        if (dead) return;
        setTraces(r.traces ?? []);
        setTraceErr(null);
      })
      .catch((err) => {
        if (!dead) {
          setTraces(null);
          setTraceErr(errText(err));
        }
      });
    return () => {
      dead = true;
    };
  }, [enabled, primaryPort, spark.id, traceNonce]);

  // ── Jobs ticker ────────────────────────────────────────────────────────
  const sortedJobs = [...jobs].sort((a, b) => {
    const rank = (j: MctlJob) => (j.status === "running" ? 0 : 1);
    return rank(a) - rank(b) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt);
  });

  // ── Not enabled: enrollment card only ──────────────────────────────────
  if (!enabled) {
    return (
      <ScModule label="Models" style={{ opacity: 0.9 }}>
        <span className="mlabel">modelctl</span>
        <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--color-muted)" }}>
          modelctl is not enabled for this node — inventory, sync/push and serving scripts are off.
          Enabling also queues the modelctl install.
        </p>
        <div className="row">
          <button className="key key--primary" type="button" disabled={enabling} onClick={() => void handleEnable()}>
            {enabling ? "enabling…" : installRunning ? "install queued — waiting…" : "Enable + install modelctl"}
          </button>
          {enableErr ? <ScChip tone="err">{enableErr}</ScChip> : null}
        </div>
      </ScModule>
    );
  }


  return (
    <>
      {/* ── Jobs strip ─────────────────────────────────────────────────── */}
      <ScModule label="Jobs">
        <div className="spread">
          <span className="mlabel">Jobs · this node</span>
          <span className="mono" style={{ fontSize: "var(--fs-10)", color: "var(--color-muted)" }}>
            7-day retention on node
          </span>
        </div>
        {sortedJobs.length === 0 ? (
          <p className="empty-note" style={{ margin: 0 }}>
            No recent jobs on this node.
          </p>
        ) : (
          <div className="stack" style={{ gap: 0 }}>
            {sortedJobs.map((job) => {
              const pct = jobPct(job);
              const lastLog = job.logTail.trim().split("\n").slice(-1)[0] ?? "";
              const failure =
                job.status === "failed" || job.status === "interrupted" ? job.lastError ?? lastLog : null;
              return (
                <div key={job.jobId} className="job-row">
                  <span className={STATUS_TONE[job.status]}>{job.status}</span>
                  <span className="job-row__name">{KIND_LABEL[job.kind] ?? job.kind}</span>
                  <span className="job-row__meta">
                    {jobModelLabel(job)}
                    {job.status === "running"
                      ? ` · started ${jobTime(job.startedAt)}`
                      : ` · exit ${job.exitCode ?? "?"} · ${jobTime(job.endedAt ?? job.createdAt)}`}
                  </span>
                  {pct != null ? <span className="job-row__pct">{pct}%</span> : null}
                  {job.status === "running" ? (
                    <button
                      className="key"
                      type="button"
                      title={`Cancel ${job.jobId}`}
                      onClick={() => onCancelJob(job.jobId)}
                    >
                      ✕
                    </button>
                  ) : null}
                  {pct != null && job.status === "running" ? (
                    <div className="job-progress">
                      <div
                        className="job-progress__fill"
                        style={{ "--pct": `${pct}%` } as CSSProperties}
                      />
                    </div>
                  ) : null}
                  {failure ? <pre className="job-row__log">{failure}</pre> : null}
                </div>
              );
            })}
          </div>
        )}
      </ScModule>

      {/* ── modelctl not installed ─────────────────────────────────────── */}
      {modelctl && !modelctl.installed ? (
        <ScModule label="modelctl" style={{ opacity: 0.92 }}>
          <div className="spread">
            <div className="stack" style={{ gap: 2 }}>
              <span className="mlabel">modelctl not installed on this node</span>
              <span style={{ fontSize: "var(--fs-11)", color: "var(--color-muted)" }}>
                Installs uv + modelctl (a background job — watch the strip above).
              </span>
            </div>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <button
                className="key key--primary"
                type="button"
                disabled={installRunning}
                onClick={() => void handleInstall()}
              >
                {installRunning ? "install running…" : "Install modelctl"}
              </button>
            </div>
          </div>
          {modelctl.error ? <ScChip tone="err">probe: {modelctl.error}</ScChip> : null}
          {enableErr ? <ScChip tone="err">{enableErr}</ScChip> : null}
        </ScModule>
      ) : null}

      {/* ── List + detail split ────────────────────────────────────────── */}
      <div className="models-split">
        <ScModule label="Models on node">
          <div className="spread">
            <span className="mlabel">
              {spark.name} · {nodeModels?.length ?? 0} local
            </span>
            {storageFreeGb != null ? (
              <span className="tnum" style={{ fontSize: "var(--fs-11)", color: "var(--color-muted)" }}>
                {storageFreeGb} GB free
              </span>
            ) : null}
          </div>
          {nodeModelsErr ? <ScChip tone="err">{nodeModelsErr}</ScChip> : null}
          {nodeModels == null ? (
            <p className="empty-note" style={{ margin: 0 }}>
              {nodeModelsErr ? "Could not read the node inventory." : "reading inventory…"}
            </p>
          ) : (
            <div className="model-rows">
              {merged.length === 0 && !nodeModelsErr ? (
                <p className="empty-note" style={{ margin: 0 }}>
                  No models on this node{nasModels?.length ? " (NAS catalog listed below)" : ""}.
                </p>
              ) : null}
              {merged.map((m) => {
                const onNode = nodeNames.includes(m.name);
                const serving = onNode && isServing(m.name);
                return (
                  <button
                    key={m.name}
                    type="button"
                    className={`model-row${selectedName === m.name ? " is-selected" : ""}${onNode ? "" : " is-nas"}`}
                    onClick={() => setSelectedName(m.name)}
                  >
                    <span className={`led${serving ? " led--live" : ""}`} aria-hidden="true" />
                    <span className="stack" style={{ gap: 1, minWidth: 0 }}>
                      <span className="model-row__name">{shortModelName(m.name)}</span>
                      <span className="model-row__meta">
                        {onNode ? (
                          <>
                            {m.runtime ?? "runtime ?"}
                            {serving ? " · " : ""}
                            {serving ? <span className="tag-serving">serving</span> : null}
                          </>
                        ) : (
                          "NAS catalog only"
                        )}
                      </span>
                    </span>
                    <span className="model-row__size">{fmtGB(m.bytes)}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="hairline" />
          <p className="legend" style={{ margin: 0 }}>
            <span className="tag-serving">serving</span> live in the Serving card above
            <span style={{ color: "var(--color-border-strong)" }}>·</span>
            <span className="led" aria-hidden="true" style={{ display: "inline-block" }} /> dimmed rows
            exist only on the NAS{nasErr ? ` (nas: ${nasErr})` : ""}
          </p>
        </ScModule>

        <ScModule label="Selected model">
          {selectedModel ? (
            <>
              <div className="spread" style={{ alignItems: "flex-start" }}>
                <div className="stack" style={{ gap: "var(--space-1)", minWidth: 0 }}>
                  <h3 className="detail-head__name">{shortModelName(selectedModel.name)}</h3>
                  <div className="detail-head__repo">
                    {[
                      selectedModel.repository ?? null,
                      selectedModel.runtime ? `${selectedModel.runtime}` : null,
                      fmtGB(selectedModel.bytes),
                      selectedOnNode ? "on this node" : "NAS catalog only",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {isServing(selectedModel.name) && selectedOnNode ? (
                    <a className="xref" href="#sec-serving" style={{ marginTop: 2 }}>
                      ● currently serving — metrics in the Serving card ↑
                    </a>
                  ) : null}
                </div>
                <div className="spread-end" style={{ flexWrap: "wrap", gap: 6 }}>
                  {selectedOnNas ? (
                    <button
                      className="key"
                      type="button"
                      disabled={modelJobBusy(selectedModel.name)}
                      onClick={() => void runModelJob("sync", selectedModel.name)}
                    >
                      Sync from NAS
                    </button>
                  ) : null}
                  {selectedOnNode ? (
                    <>
                      <button
                        className="key"
                        type="button"
                        disabled={modelJobBusy(selectedModel.name) || pushBusy}
                        onClick={() => void handlePush(selectedModel.name)}
                      >
                        {pushBusy ? "resolving NAS…" : "Push to NAS"}
                      </button>
                      <button
                        className={`key${armedDelete ? " key--danger" : ""}`}
                        type="button"
                        disabled={modelJobBusy(selectedModel.name)}
                        onClick={() => handleDelete(selectedModel.name)}
                      >
                        {armedDelete ? "Confirm delete — click again" : "Delete local"}
                      </button>
                    </>
                  ) : (
                    <span className="saved-note">bring it here first — Sync from NAS above</span>
                  )}
                </div>
              </div>
              {detailErr ? <ScChip tone="err">{detailErr}</ScChip> : null}
              {placement ? (
                <div className="row" style={{ flexWrap: "wrap" }}>
                  <span className={`chip${placement.status === "present" ? " chip--live" : ""}`}>
                    placement · {placement.status}
                  </span>
                  {placement.remediations.map((r, i) => (
                    <span key={`${r.kind}-${r.sparkId}-${i}`} className="row" style={{ gap: 4 }}>
                      <span className="chip">
                        {r.kind} · {r.sparkId === spark.id ? "this node" : r.sparkId}
                      </span>
                      {r.sparkId !== spark.id && onNavigate ? (
                        <button className="key" type="button" onClick={() => onNavigate(r.sparkId)}>
                          view
                        </button>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <p className="empty-note" style={{ margin: 0 }}>
              {nodeModels == null && nodeModelsErr
                ? "Node inventory unavailable — model management below still works if the engine is up."
                : "Select a model to manage it on this node."}
            </p>
          )}

          {/* ── Serve script (CH·02 "Serve new model" targets this) ─────── */}
          <ScSubpanel
            id="launch-config"
            title="Serve script"
            innerRef={launchRef}
            right={
              scriptsErr ? <ScChip tone="err">{scriptsErr}</ScChip> : undefined
            }
          >
            {scripts == null && !scriptsErr ? (
              <p className="empty-note" style={{ margin: 0 }}>
                loading serve scripts…
              </p>
            ) : scripts && scripts.length === 0 ? (
              <p className="empty-note" style={{ margin: 0 }}>
                No serve scripts in config/serving/ — add one to launch engines from here.
              </p>
            ) : (
              <div className="launch-grid">
                <label className="field">
                  <span className="field__label">Serve script</span>
                  <select
                    className="select-inline"
                    value={scriptId}
                    onChange={(e) => setScriptId(e.target.value)}
                  >
                    <option value="">— choose —</option>
                    {(scripts ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.id}
                        {s.description ? ` — ${s.description}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">Port</span>
                  <input
                    type="number"
                    className="font-tabular"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Model</span>
                  <select
                    className="select-inline"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                  >
                    <option value="">script default</option>
                    {merged.map((m) => (
                      <option key={m.name} value={m.name}>
                        {shortModelName(m.name)}
                        {nodeNames.includes(m.name) ? "" : " (nas only)"}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  <button
                    className="key key--run"
                    type="button"
                    disabled={startBusy || !scriptId}
                    onClick={() => void handleStart()}
                  >
                    {startBusy ? "starting…" : "▶ Start"}
                  </button>
                </div>
                <label className="field" style={{ gridColumn: "1 / -1" }}>
                  <span className="field__label">Extra args</span>
                  <input
                    type="text"
                    placeholder="--ctx 32768 --mem 0.9"
                    value={extraArgs}
                    onChange={(e) => setExtraArgs(e.target.value)}
                  />
                </label>
              </div>
            )}
            {startMsg ? <span className="saved-note">✓ {startMsg}</span> : null}
            {startErr ? <ScChip tone="err">{startErr}</ScChip> : null}
            <p className="bus-hint" style={{ margin: 0 }}>
              The script runs on {spark.name}; port joins the LLM probe list once the engine answers.
            </p>
          </ScSubpanel>

          {/* ── Serving log tail ────────────────────────────────────────── */}
          <ScSubpanel title="Serving log" right={<span className="chip">5s tail</span>}>
            <div className="logs-head">
              <span className={`chip${logLines.length ? " chip--live" : ""}`}>
                <span className="led" aria-hidden="true" />
                {scriptId ? "tail · serving" : "idle"}
              </span>
              <span className="logs-head__source">
                {spark.name}
                {scriptId ? ` · ${scriptId}` : " · pick a serve script above"}
              </span>
            </div>
            {logErr ? <ScChip tone="err">{logErr}</ScChip> : null}
            {logLines.length > 0 ? (
              <pre className="trace-body__pre" ref={logRef}>
                {logLines.map((line, i) => (
                  <span key={i}>
                    {tokenizeLogLine(line).map((tok, j) => (
                      <span key={j} className={tok.cls ?? undefined}>
                        {tok.text}
                      </span>
                    ))}
                    {i < logLines.length - 1 ? "\n" : null}
                  </span>
                ))}
              </pre>
            ) : !logErr ? (
              <p className="empty-note" style={{ margin: 0 }}>
                {scriptId ? "No log output yet." : "Log tail starts when a serve script is selected."}
              </p>
            ) : null}
          </ScSubpanel>

          {/* ── Recent proxy traces ─────────────────────────────────────── */}
          {primaryPort != null ? (
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              <div className="logs-head">
                <span className="chip">
                  <span className="led" aria-hidden="true" />
                  traces · via proxy
                </span>
                <span className="logs-head__source">
                  /llm/{spark.id}/{primaryPort}
                </span>
              </div>
              {traceErr ? <ScChip tone="err">{traceErr}</ScChip> : null}
              {traces && traces.length > 0 ? (
                <div className="bench-results">
                  <div className="analysis-table__head" aria-hidden="true">
                    <span>Time · status</span>
                    <span>Model · route</span>
                    <span className="analysis-table__num">In tok</span>
                    <span className="analysis-table__num">Out tok</span>
                    <span className="analysis-table__num">TTFT</span>
                    <span className="analysis-table__num">Dur</span>
                  </div>
                  {traces.map((t) => (
                    <div className="analysis-table__row" key={t.id}>
                      <span className="analysis-table__time">
                        <span className="font-tabular">{fmtTs(t.ts)}</span>
                        <span
                          className={`http-st${(t.status ?? 500) >= 400 ? " http-st--err" : ""}`}
                        >
                          {t.status ?? "—"}
                        </span>
                      </span>
                      <span className="font-tabular" style={{ minWidth: 0 }} title={`${t.model ?? ""} ${t.method ?? ""} ${t.path ?? ""}`}>
                        {shortModelName(t.model)} · {t.method ?? "?"} {t.path ?? ""}
                      </span>
                      <span className="analysis-table__num">{fmtInt(t.promptTokens)}</span>
                      <span className="analysis-table__num">{fmtInt(t.completionTokens)}</span>
                      <span className="analysis-table__num">{fmtMs(t.ttftMs)}</span>
                      <span className="analysis-table__num">{fmtMs(t.durMs)}</span>
                    </div>
                  ))}
                </div>
              ) : !traceErr && traces ? (
                <p className="empty-note" style={{ margin: 0 }}>
                  No requests through the proxy yet — call the PROXY endpoint in CH·02 to be traced.
                </p>
              ) : null}
              <p className="empty-note" style={{ margin: 0 }}>
                Last {traces?.length ?? 0} requests on port {primaryPort}.{" "}
                <a
                  className="xref"
                  href={`/analysis?spark=${encodeURIComponent(spark.id)}&port=${primaryPort}`}
                >
                  Open in Analysis →
                </a>
              </p>
            </div>
          ) : null}
        </ScModule>
      </div>
    </>
  );
}
