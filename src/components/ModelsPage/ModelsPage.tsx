import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listJobs, listNasModels, modelctlStatus, startJob, fetchSparks } from "../../api/client";
import type {
  InventoryResponse,
  ModelctlStatus,
  MctlJob,
  NasModel,
  SparkConfig,
} from "../../api/types";

/**
 * Models tab = NAS catalog only (approved mockup mockups/models-page.html).
 * Per-node model management (sync / push / serve / stop) lives on the node
 * detail page's Models channel. The catalog reads the server's 60 s-cached
 * NAS inventory, refreshes when a job changes state (the server busts the
 * cache on terminal), and re-reads on a 60 s backstop.
 */

const JOBS_POLL_MS = 4000;
const NAS_POLL_MS = 60_000;

interface Toast {
  id: number;
  msg: string;
  kind: "error" | "info";
}

function gb(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "-";
  return `${(bytes / 1024 ** 3).toFixed(1)}`;
}
type MctlJobStatus = MctlJob["status"];

function jobStatusClass(status: MctlJobStatus): string {
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

/** Active job row in the catalog (subset of MctlJob the bar renders). */
type MctlJobLite = Pick<MctlJob, "jobId" | "kind" | "status" | "name">;

/** Database-cylinder icon for the catalog title. */
function DatabaseIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  );
}

export function ModelsPage() {
  const [nas, setNas] = useState<InventoryResponse | null>(null);
  const [modelctl, setModelctl] = useState<ModelctlStatus | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlOpen, setDlOpen] = useState(false);
  const [dlRepo, setDlRepo] = useState("");
  const [dlName, setDlName] = useState("");
  const [dlQuant, setDlQuant] = useState("");
  const [dlRev, setDlRev] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<MctlJobLite[]>([]);
  const toastSeq = useRef(0);

  const pushToast = useCallback((msg: string, kind: Toast["kind"] = "error") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const refreshNas = useCallback(async (force = false) => {
    setNas(await listNasModels({ force }).catch((e) => ({ models: [], error: String(e) })));
  }, []);

  const refreshModelctl = useCallback(async (preferredId?: string | null) => {
    const { sparks } = await fetchSparks().catch(() => ({ sparks: [] as SparkConfig[] }));
    // The inventory response carries the node the server actually used —
    // trust it over the client-side heuristic (registry order can pick the
    // wrong modelctlEnabled spark when several exist).
    const nasHost =
      (preferredId && sparks.find((s) => s.id === preferredId)) ||
      sparks.find((s) => s.modelctlEnabled) ||
      sparks.find((s) => s.role === "head") ||
      sparks.find((s) => s.isLocal);
    if (!nasHost) {
      setModelctl(null);
      return;
    }
    const st = await modelctlStatus(nasHost.id).catch(() => null);
    setModelctl(st);
  }, []);

  useEffect(() => {
    void refreshNas();
    void refreshModelctl();
    // Backstop: re-read on the server's cache TTL so the catalog self-heals
    // even when a job transition was missed between polls.
    const t = setInterval(() => void refreshNas(), NAS_POLL_MS);
    return () => clearInterval(t);
  }, [refreshNas, refreshModelctl]);

  // Once the inventory resolves, the badge must describe THAT node.
  useEffect(() => {
    if (nas?.sparkId) void refreshModelctl(nas.sparkId);
  }, [nas?.sparkId, refreshModelctl]);

  // Job poll: surface the running job; a job reaching a TERMINAL state
  // (anywhere in the list) refreshes the catalog. Keyed on the terminal set,
  // not the running set — a job that starts and finishes between two 4 s
  // polls never appears in runningIds but always grows the terminal set.
  // force=true busts the server's 60 s NAS cache (the completion also busts
  // it server-side via remoteJobs.onJobTerminal).
  const prevTerminal = useRef<string | null>(null);
  const jobsPoll = useCallback(async () => {
    try {
      const { jobs } = await listJobs();
      setJobs(jobs);
      const terminalIds = jobs
        .filter((j) => j.status !== "running")
        .map((j) => j.jobId)
        .sort()
        .join(",");
      if (prevTerminal.current !== null && prevTerminal.current !== terminalIds) {
        void refreshNas(true);
      }
      prevTerminal.current = terminalIds;
    } catch {
      /* poll errors non-fatal */
    }
  }, [refreshNas]);

  useEffect(() => {
    void jobsPoll();
    const t = setInterval(() => void jobsPoll(), JOBS_POLL_MS);
    return () => clearInterval(t);
  }, [jobsPoll]);

  const handleDownload = useCallback(async () => {
    if (busy || !dlRepo.trim()) return;
    setBusy(true);
    try {
      await startJob({
        kind: "download",
        repo: dlRepo.trim(),
        name: dlName.trim() || undefined,
        quantization: dlQuant.trim() || undefined,
        revision: dlRev.trim() || undefined,
      });
      pushToast("Download job queued — jobs appear on the NAS host node", "info");
      setDlRepo("");
      setDlName("");
      setDlQuant("");
      setDlRev("");
      setDlOpen(false);
    } catch (err) {
      pushToast(String(err));
    } finally {
      setBusy(false);
    }
  }, [dlRepo, dlName, dlQuant, dlRev, pushToast]);

  // Destructive NAS-store removal: two-click armed, same pattern as the
  // console's Stop key (ScServing). Arm → label flips to "Confirm delete" →
  // second click posts; auto-disarms after 5 s; one row armed at a time.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);
  const disarmDelete = useCallback(() => {
    if (armTimer.current) window.clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedDelete(null);
  }, []);
  useEffect(() => disarmDelete, [disarmDelete]);

  const handleDelete = useCallback(
    async (model: NasModel) => {
      if (!model.name || busy) return;
      if (armedDelete !== model.name) {
        if (armTimer.current) window.clearTimeout(armTimer.current);
        setArmedDelete(model.name);
        armTimer.current = window.setTimeout(() => setArmedDelete(null), 5000);
        return;
      }
      disarmDelete();
      setBusy(true);
      try {
        await startJob({ kind: "nas-delete", model: model.name });
        pushToast(`NAS delete queued for ${model.name}`, "info");
      } catch (err) {
        pushToast(String(err));
      } finally {
        setBusy(false);
      }
    },
    [armedDelete, busy, disarmDelete, pushToast]
  );

  const models = nas?.models ?? [];
  const error = nas?.error;
  const stale = nas?.stale;
  const totalBytes = useMemo(() => models.reduce((a, m) => a + (m.bytes ?? 0), 0), [models]);
  const storeChip = `nas · ${models.length} model${models.length === 1 ? "" : "s"}${
    totalBytes > 0 ? ` · ${(totalBytes / 1024 ** 3).toFixed(1)} GB store` : ""
  }`;

  const activeJob = jobs.find((j) => j.status === "running");

  return (
    <div className="models-page">
      <section className="panel p-3" aria-label="NAS catalog">
        <div className="models-toolbar">
          <h2 className="panel-title m-0">
            <DatabaseIcon />
            NAS catalog
          </h2>
          <span className="chip">{storeChip}</span>
          {stale && (
            <span className="bench-status-pill bench-status-pill--cancelled" title="inventory older than 5× TTL">
              stale
            </span>
          )}
          {modelctl && !modelctl.installed && (
            <span className="bench-status-pill bench-status-pill--failed">modelctl not installed</span>
          )}
          <div className="models-toolbar__spacer" />
          <button
            type="button"
            className="bench-btn bench-btn--primary bench-btn--sm"
            aria-expanded={dlOpen}
            aria-controls="dl-form"
            onClick={() => setDlOpen((v) => !v)}
          >
            ⤓ Download from Hugging Face
          </button>
        </div>

        {dlOpen && (
          <form
            id="dl-form"
            className="dl-form"
            onSubmit={(e) => {
              e.preventDefault();
              void handleDownload();
            }}
          >
            <label className="field">
              <span className="field__label">HF repo (org/model)</span>
              <input
                type="text"
                value={dlRepo}
                placeholder="org/model"
                onChange={(e) => setDlRepo(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Name (optional)</span>
              <input
                type="text"
                value={dlName}
                placeholder="custom store name"
                onChange={(e) => setDlName(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Quantization</span>
              <input
                type="text"
                value={dlQuant}
                placeholder="e.g. Q4_K_M"
                onChange={(e) => setDlQuant(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Revision</span>
              <input
                type="text"
                value={dlRev}
                placeholder="main"
                onChange={(e) => setDlRev(e.target.value)}
              />
            </label>
            <div className="flex gap-1.5 items-end">
              <button
                type="submit"
                className="bench-btn bench-btn--run bench-btn--sm"
                disabled={busy || !dlRepo.trim()}
              >
                Download
              </button>
              <button
                type="button"
                className="bench-btn bench-btn--ghost bench-btn--sm"
                onClick={() => setDlOpen(false)}
              >
                Cancel
              </button>
            </div>
            <p className="field__hint" style={{ gridColumn: "1 / -1", margin: 0 }}>
              Streams into the NAS model store. Download and delete jobs run on the machine managing the NAS
              (NAS host node) — follow them on that node's detail page → Jobs.
            </p>
          </form>
        )}

        {activeJob && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className={jobStatusClass(activeJob.status)}>running</span>
            <span className="font-medium">{activeJob.kind}</span>
            {activeJob.name && <span className="text-muted">{activeJob.name}</span>}
          </div>
        )}

        <div className="bench-results mt-3">
          <div className="nas-table__head" aria-hidden="true">
            <span>Name</span>
            <span>Runtime</span>
            <span>Repository</span>
            <span className="analysis-table__num">Size GB</span>
            <span />
          </div>
          {models.length === 0 ? (
            <div className="nas-table__empty">
              {error ? error : "NAS catalog empty — download a model from Hugging Face."}
            </div>
          ) : (
            models.map((m) => (
              <div key={m.name ?? m.repository} className="nas-table__row">
                <span className="font-medium" style={{ fontWeight: 600 }}>
                  {m.name ?? "—"}
                </span>
                <span className="chip justify-self-start">{m.runtime ?? "—"}</span>
                <span className="text-muted font-tabular truncate" title={m.repository ?? ""}>
                  {m.repository ?? "—"}
                </span>
                <span className="analysis-table__num">{gb(m.bytes)}</span>
                <span className="nas-table__actions">
                  <button
                    type="button"
                    className="bench-btn bench-btn--sm bench-btn--danger"
                    disabled={busy || !m.name}
                    title={
                      m.name
                        ? armedDelete === m.name
                          ? `Click again to delete ${m.name} from the NAS store NOW — modelctl delete --root … --apply --yes (removes it for every node)`
                          : `Delete ${m.name} from the NAS store — two-step confirm; runs modelctl delete --root … --apply --yes on the NAS host`
                        : "Model has no store name"
                    }
                    onClick={() => void handleDelete(m)}
                  >
                    {armedDelete === m.name ? "Confirm delete" : "Delete"}
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

        <p className="empty-note" style={{ margin: "10px 2px 0" }}>
          To sync, push, serve or stop a model on a specific node, open that node from Overview →{" "}
          <b>Models</b> channel.
        </p>
      </section>

      {toasts.map((t, i) => (
        <span
          key={t.id}
          className={`text-xs rounded px-2 py-1 ${t.kind === "error" ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent"}`}
          style={{ position: "fixed", bottom: 16 + i * 34, right: 16, zIndex: 50 }}
        >
          {t.msg}
        </span>
      ))}
    </div>
  );
}
