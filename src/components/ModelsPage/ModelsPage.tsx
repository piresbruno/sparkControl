import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listNasModels,
  listNodeModels,
  modelctlStatus,
  startJob,
  listJobs,
  cancelJob,
  listServingScripts,
  servingStart,
  servingStop,
  servingStatus as fetchServingStatus,
  servingLog,
  fetchSparks,
} from "../../api/client";
import type {
  InventoryResponse,
  ModelctlStatus,
  MctlJob,
  NasModel,
  ServingScript,
  ServingStatus,
  SparkConfig,
} from "../../api/types";

const JOBS_POLL_MS = 1000;
const LOG_POLL_MS = 1000;

function gb(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)}`;
}

function jobStatusClass(status: MctlJob["status"]): string {
  switch (status) {
    case "running":
      return "bench-status-pill bench-status-pill--running";
    case "completed":
      return "bench-status-pill bench-status-pill--completed";
    case "failed":
    case "interrupted":
      return "bench-status-pill bench-status-pill--failed";
    default:
      return "bench-status-pill bench-status-pill--cancelled";
  }
}

interface Toast {
  id: number;
  msg: string;
  kind: "error" | "info";
}

export function ModelsPage() {
  const [nas, setNas] = useState<InventoryResponse | null>(null);
  const [nodeInventories, setNodeInventories] = useState<Record<string, InventoryResponse>>({});
  const [modelctl, setModelctl] = useState<Record<string, ModelctlStatus>>({});
  const [sparks, setSparks] = useState<SparkConfig[]>([]);
  const [jobs, setJobs] = useState<MctlJob[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Download form
  const [dlRepo, setDlRepo] = useState("");
  const [dlName, setDlName] = useState("");
  const [dlQuant, setDlQuant] = useState("");
  const [dlRev, setDlRev] = useState("");
  const [busy, setBusy] = useState(false);
  const [scripts, setScripts] = useState<ServingScript[]>([]);
  const [servingSparkId, setServingSparkId] = useState<string>("");
  const [scriptId, setScriptId] = useState<string>("");
  const [modelName, setModelName] = useState<string>("");
  const [port, setPort] = useState<string>("");
  const [extraArgs, setExtraArgs] = useState<string>("");
  const [servingStatus, setServingStatus] = useState<ServingStatus | null>(null);
  const [serveLog, setServeLog] = useState<string>("");
  const toastSeq = useRef(0);

  const pushToast = useCallback((msg: string, kind: Toast["kind"] = "error") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const { sparks: configs } = await fetchSparks();
      setSparks(configs);
      const enabled = configs.filter((c) => (c as SparkConfig & { modelctlEnabled?: boolean }).modelctlEnabled);
      setNas(await listNasModels().catch((e) => ({ models: [], error: String(e) })));
      const invs: Record<string, InventoryResponse> = {};
      const checks: Record<string, ModelctlStatus> = {};
      for (const s of enabled) {
        invs[s.id] = await listNodeModels(s.id).catch((e) => ({ models: [], error: String(e) }));
        checks[s.id] = await modelctlStatus(s.id).catch((e) => ({ installed: false, version: null, uv: { installed: false, version: null }, error: String(e) }));
      }
      setNodeInventories(invs);
      setModelctl(checks);
    } catch (err) {
      pushToast(String(err));
    }
  }, [pushToast]);

  useEffect(() => {
    void refreshAll();
    listServingScripts()
      .then(({ scripts }) => setScripts(scripts))
      .catch(() => undefined);
  }, [refreshAll]);

  // Active jobs poll (1 s) — also invalidates inventories when a job completes.
  const prevRunning = useRef<string>("");
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const { jobs } = await listJobs();
        setJobs(jobs);
        const runningIds = jobs.filter((j) => j.status === "running").map((j) => j.jobId).sort().join(",");
        if (prevRunning.current && prevRunning.current !== runningIds) {
          void refreshAll(); // something finished → refresh inventories + badges
        }
        prevRunning.current = runningIds;
      } catch {
        /* poll errors non-fatal */
      }
    }, JOBS_POLL_MS);
    return () => clearInterval(t);
  }, [refreshAll]);

  const enabledSparks = useMemo(
    () => sparks.filter((s) => (s as SparkConfig & { modelctlEnabled?: boolean }).modelctlEnabled),
    [sparks]
  );

  const handleDownload = useCallback(async () => {
    if (!dlRepo.trim()) return;
    setBusy(true);
    try {
      await startJob({
        kind: "download",
        repo: dlRepo.trim(),
        name: dlName.trim() || undefined,
        quantization: dlQuant.trim() || undefined,
        revision: dlRev.trim() || undefined,
      });
      pushToast("Download job queued", "info");
      setDlRepo("");
      setDlName("");
      setDlQuant("");
      setDlRev("");
    } catch (err) {
      pushToast(String(err));
    } finally {
      setBusy(false);
    }
  }, [dlRepo, dlName, dlQuant, dlRev, pushToast]);

  const handleCellAction = useCallback(
    async (kind: "sync" | "push" | "delete-local", model: string, cellSparkId: string, sourceSparkId?: string) => {
      setBusy(true);
      try {
        await startJob({
          kind,
          model,
          sparkId: cellSparkId,
          sourceSparkId,
          targetSparkId: kind === "push" ? cellSparkId : undefined,
        });
        pushToast(`${kind} queued for ${model}`, "info");
      } catch (err) {
        pushToast(String(err)); // 409 single-flight surfaces here
      } finally {
        setBusy(false);
      }
    },
    [pushToast]
  );

  const handleInstallModelctl = useCallback(
    async (sparkId: string) => {
      setBusy(true);
      try {
        await startJob({ kind: "install-modelctl", sparkId });
        pushToast(`install-modelctl queued on ${sparkId}`, "info");
      } catch (err) {
        pushToast(String(err));
      } finally {
        setBusy(false);
      }
    },
    [pushToast]
  );

  // Default serving node: first enabled spark (server computes its own default).
  useEffect(() => {
    if (!servingSparkId && enabledSparks.length > 0) setServingSparkId(enabledSparks[0].id);
  }, [enabledSparks, servingSparkId]);

  // Serving status + log poll (1 s).
  useEffect(() => {
    if (!servingSparkId) return;
    let alive = true;
    const tick = async () => {
      try {
        const st: ServingStatus = await fetchServingStatus(servingSparkId, scriptId || undefined);
        if (alive) setServingStatus(st);
        const lg = await servingLog(servingSparkId, scriptId || undefined, 8000);
        if (alive) setServeLog(lg.log || "");
      } catch {
        /* offline surfaces via status */
      }
    };
    void tick();
    const t = setInterval(tick, LOG_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [servingSparkId, scriptId]);

  const handleServeStart = useCallback(async () => {
    if (!scriptId || !port) return;
    setBusy(true);
    try {
      await servingStart({
        sparkId: servingSparkId || undefined,
        scriptId,
        modelName: modelName || undefined,
        port: Number(port),
        extraArgs: extraArgs || undefined,
      });
      pushToast("Serving start issued", "info");
    } catch (err) {
      pushToast(String(err));
    } finally {
      setBusy(false);
    }
  }, [scriptId, port, servingSparkId, modelName, extraArgs, pushToast]);

  const handleServeStop = useCallback(async () => {
    setBusy(true);
    try {
      await servingStop({ sparkId: servingSparkId || undefined, scriptId: scriptId || undefined });
      pushToast("Stop issued", "info");
    } catch (err) {
      pushToast(String(err));
    } finally {
      setBusy(false);
    }
  }, [servingSparkId, scriptId, pushToast]);

  const selectedScript = scripts.find((s) => s.id === scriptId);
  const selectedServingSpark = enabledSparks.find((s) => s.id === servingSparkId);
  const selectedServingInv = nodeInventories[servingSparkId];

  // Matrix rows: union of NAS ∪ node models.
  const matrixModels = useMemo(() => {
    const names = new Set<string>();
    (nas?.models ?? []).forEach((m) => m.name && names.add(m.name));
    Object.values(nodeInventories).forEach((inv) => inv.models.forEach((m) => m.name && names.add(m.name)));
    return [...names].sort();
  }, [nas, nodeInventories]);

  const onScriptChange = useCallback(
    (id: string) => {
      setScriptId(id);
      const s = scripts.find((x) => x.id === id);
      if (s?.defaultPort) setPort(String(s.defaultPort));
    },
    [scripts]
  );

  return (
    <div className="models-page">
      <header className="flex flex-wrap items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-text-strong m-0">Models</h2>
        {toasts.map((t, i) => (
          <span
            key={i}
            className={`text-xs rounded px-2 py-1 ${t.kind === "error" ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent"}`}
          >
            {t.msg}
          </span>
        ))}
      </header>

      {/* 1. NAS catalog + download form */}
      <section className="panel p-3 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted m-0">NAS catalog</h3>
          {nas?.stale && <span className="bench-status-pill bench-status-pill--cancelled">stale</span>}
          {nas?.error && <span className="text-xs text-[var(--color-warning)]">{nas.error}</span>}
        </div>
        {nas && nas.models.length > 0 ? (
          <div className="bench-results">
            <div className="bench-results__head" aria-hidden="true">
              <span>Name</span>
              <span>Runtime</span>
              <span>Repository</span>
              <span>Size GB</span>
            </div>
            {nas.models.map((m: NasModel) => (
              <div key={m.name} className="grid grid-cols-4 gap-2 px-3 py-1.5 text-xs">
                <span>{m.name}</span>
                <span className="text-muted">{m.runtime ?? "—"}</span>
                <span className="text-muted truncate" title={m.repository ?? ""}>{m.repository ?? "—"}</span>
                <span>{gb(m.bytes)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">{nas?.error ? nas.error : "NAS catalog empty."}</p>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <input
            className="text-xs rounded border border-border bg-surface px-2 py-1 w-64"
            placeholder="HF repo (org/model)"
            value={dlRepo}
            onChange={(e) => setDlRepo(e.target.value)}
          />
          <input className="text-xs rounded border border-border bg-surface px-2 py-1 w-40" placeholder="name (optional)" value={dlName} onChange={(e) => setDlName(e.target.value)} />
          <input className="text-xs rounded border border-border bg-surface px-2 py-1 w-32" placeholder="quantization" value={dlQuant} onChange={(e) => setDlQuant(e.target.value)} />
          <input className="text-xs rounded border border-border bg-surface px-2 py-1 w-32" placeholder="revision" value={dlRev} onChange={(e) => setDlRev(e.target.value)} />
          <button type="button" className="bench-btn bench-btn--primary" disabled={busy || !dlRepo.trim()} onClick={() => void handleDownload()}>
            Download from Hugging Face
          </button>
        </div>
      </section>

      {/* 2. Node matrix */}
      <section className="panel p-3 mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Node matrix</h3>
        {enabledSparks.length === 0 ? (
          <p className="text-xs text-muted">No sparks have modelctl enabled (toggle it in Edit Spark).</p>
        ) : (
          <div className="bench-results overflow-x-auto">
            <div className="bench-results__head" aria-hidden="true" style={{ gridTemplateColumns: `minmax(160px, 2fr) repeat(${enabledSparks.length}, 1fr)` }}>
              <span>Model</span>
              {enabledSparks.map((s) => (
                <span key={s.id}>{s.name}</span>
              ))}
            </div>
            {matrixModels.map((name) => (
              <div key={name} className="grid gap-2 px-3 py-1.5 text-xs items-center" style={{ gridTemplateColumns: `minmax(160px, 2fr) repeat(${enabledSparks.length}, 1fr)` }}>
                <span className="font-medium">{name}</span>
                {enabledSparks.map((s) => {
                  const present = nodeInventories[s.id]?.models.some((m) => m.name === name);
                  const stale = nodeInventories[s.id]?.stale;
                  return (
                    <span key={s.id} className="flex items-center gap-1.5">
                      {present ? (
                        <span className="bench-status-pill bench-status-pill--completed">present</span>
                      ) : (
                        <span className="bench-status-pill bench-status-pill--cancelled">absent{stale ? " (stale)" : ""}</span>
                      )}
                      {!present && (
                        <>
                          <button type="button" className="text-[11px] rounded border border-border px-1.5 py-0.5" disabled={busy} onClick={() => void handleCellAction("sync", name, s.id)}>
                            Sync
                          </button>
                          {(() => {
                            const peer = enabledSparks.find((p) => p.id !== s.id && nodeInventories[p.id]?.models.some((m) => m.name === name));
                            if (peer) {
                              return (
                                <button type="button" className="text-[11px] rounded border border-border px-1.5 py-0.5" disabled={busy} onClick={() => void handleCellAction("push", name, s.id, peer.id)}>
                                  Push from {peer.name}
                                </button>
                              );
                            }
                            return null;
                          })()}
                          <button type="button" className="text-[11px] rounded border border-danger/40 text-danger px-1.5 py-0.5" disabled={busy} onClick={() => void handleCellAction("delete-local", name, s.id)}>
                            Remove
                          </button>
                        </>
                      )}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 3. Active jobs */}
      <section className="panel p-3 mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Active jobs</h3>
        {jobs.length === 0 ? (
          <p className="text-xs text-muted">No jobs yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {jobs.slice(0, 8).map((j) => (
              <div key={j.jobId} className="flex items-center gap-3 text-xs flex-wrap">
                <span className={jobStatusClass(j.status)}>{j.status}</span>
                <span className="font-medium">{j.kind}</span>
                <span className="text-muted">{j.sparkId}</span>
                <span>{j.name}</span>
                {j.exitCode != null && <span className="text-muted">exit {j.exitCode}</span>}
                <button type="button" className="text-[11px] rounded border border-border px-1.5 py-0.5" disabled={busy || j.status !== "running"} onClick={() => void cancelJob(j.jobId).catch((e) => pushToast(String(e)))}>
                  Cancel
                </button>
                {j.logTail && (
                  <pre className="trace-body__pre flex-1 min-w-48 max-h-24" style={{ maxHeight: "6rem" }}>
                    {j.logTail.split("\n").slice(-4).join("\n")}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4. modelctl availability */}
      <section className="panel p-3 mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">modelctl availability</h3>
        {enabledSparks.length === 0 ? (
          <p className="text-xs text-muted">Nothing to check.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {enabledSparks.map((s) => {
              const st = modelctl[s.id];
              return (
                <div key={s.id} className="flex items-center gap-2 text-xs">
                  <span className="font-medium">{s.name}</span>
                  {st?.installed ? (
                    <span className="bench-status-pill bench-status-pill--completed">v{st.version ?? "?"}</span>
                  ) : (
                    <span className="bench-status-pill bench-status-pill--failed">not installed</span>
                  )}
                  <button type="button" className="text-[11px] rounded border border-border px-1.5 py-0.5" disabled={busy} onClick={() => void handleInstallModelctl(s.id)}>
                    Install modelctl (uv)
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 5. Serving */}
      <section className="panel p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Serving</h3>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <select className="select-inline text-xs rounded border border-border bg-surface px-2 py-1" value={servingSparkId} onChange={(e) => setServingSparkId(e.target.value)} aria-label="Runs on">
            {enabledSparks.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select className="select-inline text-xs rounded border border-border bg-surface px-2 py-1" value={scriptId} onChange={(e) => onScriptChange(e.target.value)} aria-label="Script">
            <option value="">Select script…</option>
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <select className="select-inline text-xs rounded border border-border bg-surface px-2 py-1" value={modelName} onChange={(e) => setModelName(e.target.value)} aria-label="Model">
            <option value="">No model</option>
            {matrixModels.map((m) => {
              const present = selectedServingInv?.models.some((x) => x.name === m);
              return (
                <option key={m} value={m}>
                  {m}
                  {present ? "" : " (not on node)"}
                </option>
              );
            })}
          </select>
          <input className="text-xs rounded border border-border bg-surface px-2 py-1 w-24" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
          <input className="text-xs rounded border border-border bg-surface px-2 py-1 w-56" placeholder="extra args" value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} />
          <button type="button" className="bench-btn bench-btn--primary" disabled={busy || !scriptId || !port} onClick={() => void handleServeStart()}>
            Start
          </button>
          <button type="button" className="bench-btn bench-btn--ghost" disabled={busy} onClick={() => void handleServeStop()}>
            Stop
          </button>
          {servingStatus && (
            <span className="text-xs text-muted">
              {servingStatus.running === true
                ? `running${servingStatus.startedAt ? ` since ${new Date(servingStatus.startedAt).toLocaleTimeString()}` : ""}`
                : servingStatus.running === "unknown"
                  ? `unknown (offline)`
                  : "stopped"}
            </span>
          )}
        </div>
        {selectedScript?.description && <p className="text-xs text-muted mb-2">{selectedScript.description}</p>}
        {serveLog && <pre className="trace-body__pre">{serveLog || "(no log yet)"}</pre>}
      </section>
    </div>
  );
}
