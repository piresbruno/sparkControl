/**
 * NAS node page (spark kind "nas") — replaces the instrument console for
 * model-store nodes. Ported from mockups/nas-node.html §B: STORE (capacity,
 * catalog.json health, doctor), MODELS (NAS catalog + master–detail card),
 * DOWNLOAD (single pull or validated queue), MODELCTL (package vs release),
 * JOBS (this node only) and a SYSTEM hairline footer.
 *
 * Reuses the console kit (.spark-console tokens from console.css) plus the
 * scoped additions in src/styles/nas.css (.nas-page). GPU/serving/benchmarks
 * are intentionally absent — this node has none.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  InventoryResponse,
  MctlJob,
  ModelctlRelease,
  ModelctlStatus,
  NasCatalogResponse,
  NasDeletePlan,
  NasDoctorResponse,
  NasModel,
  NasModelDetail,
  NasQueueEntry,
  SparkSnapshot,
} from "../../api/types";
import {
  fetchModelctlRelease,
  fetchNasCatalog,
  fetchNasDeletePlan,
  fetchNasModelDetail,
  listJobs,
  listNasModels,
  modelctlStatus,
  runNasDoctor,
  startJob,
} from "../../api/client";
import { OVERVIEW_ID } from "../../constants";
import {
  ScChHead,
  ScChip,
  ScCopy,
  ScLed,
  ScModule,
  ScSeg,
} from "../SparkPage/console/ScKit";
import { fmtTBorGB, fmtUptimeShort } from "../SparkPage/console/consoleUtils";
import {
  agoLabel,
  buildQueuePreview,
  doctorSummary,
  fmtStore,
  isModelBusyDownloading,
  matchStoreMount,
  modelDownloadState,
  versionIsNewer,
} from "./nasUtils";
import "../../styles/console.css";
import "../../styles/nas.css";

const JOBS_POLL_MS = 4000;
const BACKSTOP_POLL_MS = 60000;

interface NasPageProps {
  spark: SparkSnapshot;
  /** settings.modelctl.nasRoot — fallback when this node has no own path. */
  defaultNasRoot?: string;
  onEdit: () => void;
  onNavigate: (id: string | null) => void;
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

interface Toast {
  id: number;
  msg: string;
  kind: "error" | "info";
}

/** One editable queue-builder row ("" = unset; trimmed before submit). */
interface QueueRow {
  source: string;
  name: string;
  quantization: string;
  runtime: "" | "auto" | "vllm" | "llama.cpp";
}

const emptyRow = (): QueueRow => ({ source: "", name: "", quantization: "", runtime: "" });

/** Queue rows → validated entries (drops nameless sources, trims). */
function toEntries(rows: QueueRow[]): NasQueueEntry[] {
  return rows
    .filter((r) => r.source.trim())
    .map((r) => ({
      source: r.source.trim(),
      ...(r.name.trim() ? { name: r.name.trim() } : {}),
      ...(r.quantization.trim() ? { quantization: r.quantization.trim() } : {}),
      ...(r.runtime && r.runtime !== "auto" ? { runtime: r.runtime } : {}),
    }));
}

export function NasPage({ spark, defaultNasRoot, onEdit, onNavigate }: NasPageProps) {
  const root = (spark.nasRoot || defaultNasRoot || "").trim();

  const [inv, setInv] = useState<InventoryResponse | null>(null);
  const [catalog, setCatalog] = useState<NasCatalogResponse | null>(null);
  const [doctor, setDoctor] = useState<NasDoctorResponse | null>(null);
  const [release, setRelease] = useState<ModelctlRelease | null>(null);
  const [status, setStatus] = useState<ModelctlStatus | null>(null);
  const [jobs, setJobs] = useState<MctlJob[]>([]);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((msg: string, kind: Toast["kind"] = "error") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Pull every NAS read endpoint; all tolerate failure (never reject). */
  const refreshAll = useCallback(
    async (force = false) => {
      const [i, c, d, r, s] = await Promise.allSettled([
        listNasModels({ force }),
        fetchNasCatalog(),
        runNasDoctor(force),
        fetchModelctlRelease(),
        modelctlStatus(spark.id),
      ]);
      if (!alive.current) return;
      if (i.status === "fulfilled") setInv(i.value);
      if (c.status === "fulfilled") setCatalog(c.value);
      if (d.status === "fulfilled") setDoctor(d.value);
      if (r.status === "fulfilled") setRelease(r.value);
      if (s.status === "fulfilled") setStatus(s.value);
    },
    [spark.id]
  );

  useEffect(() => {
    void refreshAll(false);
  }, [refreshAll]);

  // Jobs poll: the strip is live, and terminal transitions bust the server's
  // NAS/catalog/doctor caches — refetch immediately when a job finishes here.
  const runningRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await listJobs();
        if (stopped) return;
        const mine = res.jobs.filter((j) => j.sparkId === spark.id);
        setJobs(mine);
        const nowRunning = new Set(mine.filter((j) => j.status === "running").map((j) => j.jobId));
        let sawTerminal = false;
        for (const id of runningRef.current) {
          if (!nowRunning.has(id)) sawTerminal = true;
        }
        runningRef.current = nowRunning;
        if (sawTerminal) void refreshAll(false);
      } catch {
        /* transient — next tick retries */
      }
    };
    void tick();
    const t = window.setInterval(tick, JOBS_POLL_MS);
    const backstop = window.setInterval(() => void refreshAll(false), BACKSTOP_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(t);
      window.clearInterval(backstop);
    };
  }, [spark.id, refreshAll]);

  const submitJob = useCallback(
    async (body: Parameters<typeof startJob>[0], okMsg: string) => {
      try {
        await startJob(body);
        pushToast(okMsg, "info");
        void refreshAll(false);
      } catch (err: unknown) {
        pushToast(err instanceof Error ? err.message : String(err));
      }
    },
    [pushToast, refreshAll]
  );

  // ── STORE ────────────────────────────────────────────────────────────
  const mount = matchStoreMount(spark.metrics?.storage ?? [], root);
  const storePct = mount ? Math.round(mount.percentage ?? 0) : 0;

  // ── MODELS ───────────────────────────────────────────────────────────
  const models: NasModel[] = inv?.models ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<NasModelDetail | null>(null);
  const detailSeq = useRef(0);
  const openDetail = useCallback((name: string) => {
    setSelected(name);
    setDetail(null);
    const seq = ++detailSeq.current;
    void fetchNasModelDetail(name)
      .then((d) => {
        if (detailSeq.current === seq && alive.current) setDetail(d);
      })
      .catch(() => {
        if (detailSeq.current === seq && alive.current)
          setDetail({ path: null, serveCommand: null, runMd: null, error: "detail fetch failed" });
      });
  }, []);

  // Two-click armed delete WITH dry-run plan preview (mockup §B):
  // click 1 → fetch plan + arm; click 2 → post the nas-delete job.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [plan, setPlan] = useState<NasDeletePlan | null>(null);
  const armTimer = useRef<number | null>(null);
  const disarmDelete = useCallback(() => {
    if (armTimer.current) window.clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedDelete(null);
    setPlan(null);
  }, []);
  useEffect(() => disarmDelete, [disarmDelete]);

  const handleDeleteClick = useCallback(
    (model: string) => {
      if (!model) return;
      if (armedDelete !== model) {
        if (armTimer.current) window.clearTimeout(armTimer.current);
        setArmedDelete(model);
        setPlan(null);
        armTimer.current = window.setTimeout(() => {
          setArmedDelete(null);
          setPlan(null);
        }, 8000);
        void fetchNasDeletePlan(model)
          .then((p) => {
            if (alive.current) setPlan(p);
          })
          .catch(() => {
            if (alive.current) setPlan({ plan: "", error: "dry-run plan fetch failed" });
          });
        return;
      }
      disarmDelete();
      void submitJob({ kind: "nas-delete", model, sparkId: spark.id }, `NAS delete queued for ${model}`);
    },
    [armedDelete, disarmDelete, spark.id, submitJob]
  );

  // Doctor repair is two-click armed too (kind repair-active runs --apply).
  const [armedRepair, setArmedRepair] = useState(false);
  const repairTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (repairTimer.current) window.clearTimeout(repairTimer.current);
    },
    []
  );
  const handleRepairClick = useCallback(() => {
    if (!armedRepair) {
      setArmedRepair(true);
      if (repairTimer.current) window.clearTimeout(repairTimer.current);
      repairTimer.current = window.setTimeout(() => setArmedRepair(false), 5000);
      return;
    }
    if (repairTimer.current) window.clearTimeout(repairTimer.current);
    setArmedRepair(false);
    void submitJob({ kind: "repair-active", sparkId: spark.id }, "Repair job started · repair-active --apply");
  }, [armedRepair, spark.id, submitJob]);

  // ── DOWNLOAD ─────────────────────────────────────────────────────────
  const [mode, setMode] = useState<"single" | "queue">("single");
  const [dlRepo, setDlRepo] = useState("");
  const [dlName, setDlName] = useState("");
  const [dlQuant, setDlQuant] = useState("");
  const [dlRev, setDlRev] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSingleDownload = useCallback(async () => {
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
      pushToast("Download job queued — follow it in CH·05 below", "info");
      setDlRepo("");
      setDlName("");
      setDlQuant("");
      setDlRev("");
      void refreshAll(false);
    } catch (err: unknown) {
      pushToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, dlRepo, dlName, dlQuant, dlRev, pushToast, refreshAll]);

  const [qRows, setQRows] = useState<QueueRow[]>([emptyRow(), emptyRow()]);
  const [qJobs, setQJobs] = useState(2);
  const patchRow = (i: number, patch: Partial<QueueRow>) =>
    setQRows((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const entries = toEntries(qRows);
  const handleQueue = useCallback(() => {
    if (entries.length === 0) {
      pushToast("Queue needs at least one entry with a source");
      return;
    }
    for (const e of entries) {
      if (e.source.length > 200) {
        pushToast(`Source too long (max 200 chars): ${e.source.slice(0, 24)}…`);
        return;
      }
      if (e.name && e.name.length > 120) {
        pushToast(`Name too long (max 120 chars): ${e.name.slice(0, 24)}…`);
        return;
      }
    }
    void submitJob(
      { kind: "queue", entries, jobs: qJobs, sparkId: spark.id },
      `Queue job started — ${entries.length} downloads, ${qJobs} parallel`
    );
  }, [entries, pushToast, qJobs, spark.id, submitJob]);

  // Derived chips ────────────────────────────────────────────────────────
  const installed = status?.version ? `v${status.version}` : null;
  const latest = release?.latest ?? null;
  // A stale release tag that is OLDER than the installed version must not
  // advertise a "vX available" update (string inequality would).
  const updateAvailable = versionIsNewer(latest, status?.version ?? null);

  const running = jobs.filter((j) => j.status === "running");
  const queueRunning = running.some((j) => j.kind === "queue");
  const selectedModel = models.find((m) => m.name === selected) ?? null;
  const selectedBusy = selected ? isModelBusyDownloading(selected, jobs) : false;
  const selectedState = selected ? modelDownloadState(selected, jobs) : null;

  const cmdSinglePreview = ["modelctl download", dlRepo.trim() || "org/model"]
    .concat(dlName.trim() ? ["--name", dlName.trim()] : [])
    .concat(dlQuant.trim() ? ["--quantization", dlQuant.trim()] : [])
    .concat(dlRev.trim() ? ["--revision", dlRev.trim()] : [])
    .concat(root ? ["--root", root] : [])
    .join(" ");

  const hw = spark.hardware?.device ?? null;

  return (
    <div
      className="spark-console nas-page"
      style={{ display: "flex", flexDirection: "column", gap: "var(--gap)" }}
    >
      {/* ── Rack header ─────────────────────────────────────────────── */}
      <header className="module rack" aria-label="Node identity">
        <div className="rack__back">
          <a
            className="node-back"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onNavigate(OVERVIEW_ID);
            }}
          >
            ‹ Overview
          </a>
          <div className="rack__id">
            <span
              className={`led${spark.online ? " led--live" : ""}`}
              title={spark.online ? "Online" : "Offline"}
              aria-label={spark.online ? "Online" : "Offline"}
            />
            <span className="rack__name">{spark.name}</span>
            <span className="chip chip--accent" title="Model-store node — serves nothing">
              NAS
            </span>
          </div>
        </div>
        <div className="plate" role="group" aria-label="Node data plate">
          {dataField("HW", hw)}
          {dataField("Store", root || null)}
          {dataField("Addr", spark.lanIp ?? null)}
          {dataField("Up", spark.online ? fmtUptimeShort(spark.uptime) : "offline")}
          <div className="plate__f">
            <span className="plate__k">Pkg</span>
            <span className="plate__v plate__v--row plate__v--pkg">
              {installed ? (
                <ScChip tone={status?.error ? "err" : "live"}>modelctl {installed}</ScChip>
              ) : status ? (
                <ScChip tone="err">modelctl missing</ScChip>
              ) : (
                <ScChip>modelctl …</ScChip>
              )}
              {updateAvailable && latest ? (
                <span className="chip chip--warn" title="latest GitHub release">
                  {latest} available
                </span>
              ) : null}
              {updateAvailable ? (
                <button
                  type="button"
                  className="key key--sm key--primary"
                  title="Runs the install-modelctl job: uv tool install --force <source>"
                  onClick={() =>
                    void submitJob(
                      { kind: "install-modelctl", sparkId: spark.id },
                      "modelctl update job started"
                    )
                  }
                >
                  ⟳ Update
                </button>
              ) : null}
            </span>
          </div>
        </div>
        <div className="rack__keys">
          <span
            className={`chip${spark.online ? " chip--live" : ""}`}
            title={spark.online ? "SSH probe ok" : "SSH probe offline"}
          >
            ssh
          </span>
          <span
            className="chip"
            title={
              spark.transport === "agent"
                ? "Spark Command Agent connected"
                : "Spark Command Agent not installed on this node"
            }
          >
            {spark.transport === "agent" ? "agent · on" : "agent · off"}
          </span>
          <button type="button" className="key key--primary" onClick={onEdit}>
            ✎ Edit
          </button>
        </div>
      </header>

      {/* ── CH·01 STORE ─────────────────────────────────────────────── */}
      <ScChHead
        code="01"
        title="Store"
        note="the modelctl root on this node — health, capacity, catalog"
      />
      <ScModule label="Store" id="sec-store">
        <div className="spread">
          <span className="mlabel">Root</span>
          <code className="cmdline" title={`modelctl catalog status --root ${root || "—"}`}>
            {root || "— (global default unset)"}
          </code>
        </div>

        <div className="gauge-grid gauge-grid--store">
          <div className="gauge">
            <div className="gauge__top">
              <span className="mlabel">Store capacity</span>
              <span className="gauge__value">
                {mount ? fmtStore(mount.used) : "—"}
                {mount ? <small> /{fmtStore(mount.total)}</small> : null}
              </span>
            </div>
            <ScSeg pct={storePct} tone={storePct > 85 ? "warning" : "accent"} />
            <div className="gauge__foot">
              <span>
                {mount
                  ? `${storePct}% used · ${fmtStore(mount.available)} free`
                  : "mount not in snapshot storage — enable storage polling on this node"}
              </span>
            </div>
          </div>
          <div className="gauge">
            <div className="gauge__top">
              <span className="mlabel">Models</span>
              <span className="gauge__value">
                {inv ? models.length : "—"}
                <small> active</small>
              </span>
            </div>
            <ScSeg pct={inv && !inv.error ? 100 : 0} tone="success" />
            <div className="gauge__foot">
              <span>
                {catalog?.error
                  ? `catalog.json unreadable: ${catalog.error}`
                  : `modelctl list · ${inv ? models.length : "?"} published entries`}
              </span>
            </div>
          </div>
        </div>

        <div className="hairline" />

        {/* catalog.json */}
        <div className="sub-card sub-card--inset">
          <div className="spread">
            <span className="mlabel">catalog.json</span>
            <div className="row">
              {catalog ? (
                catalog.error ? (
                  <ScChip tone="err">ERR</ScChip>
                ) : (
                  <ScChip tone="live">OK</ScChip>
                )
              ) : (
                <ScChip>…</ScChip>
              )}
              <button
                type="button"
                className="key key--sm"
                title={`modelctl catalog refresh --root ${root || "—"}`}
                onClick={() => void submitJob({ kind: "catalog-refresh", sparkId: spark.id }, "Catalog refresh job started")}
              >
                ⟳ Refresh catalog
              </button>
            </div>
          </div>
          {catalog?.error ? (
            <p className="cmd-cap">
              <span className="log-warn">{catalog.error}</span>
            </p>
          ) : (
            <p className="cmd-cap">
              <span>
                schema <b className="tnum">{catalog?.schema ?? "—"}</b>
              </span>
              <span>·</span>
              <span>
                generation <b className="tnum">{catalog?.generation ?? "—"}</b>
              </span>
              <span>·</span>
              <span>
                generated <b className="tnum">{agoLabel(catalog?.generatedAt)}</b>
              </span>
            </p>
          )}
        </div>

        {/* doctor */}
        <div className="sub-card sub-card--inset">
          <div className="spread">
            <span className="mlabel">
              Last doctor run · {agoLabel(doctor?.checkedAt)}
              {doctor?.stale ? " · stale" : ""}
            </span>
            <div className="row">
              <button
                type="button"
                className="key key--sm key--primary"
                title={`modelctl doctor --json --root ${root || "—"}`}
                onClick={() =>
                  void runNasDoctor(true)
                    .then((d) => alive.current && setDoctor(d))
                    .catch((err: unknown) => pushToast(err instanceof Error ? err.message : String(err)))
                }
              >
                ⚕ Run doctor
              </button>
              <button
                type="button"
                className="key key--sm key--warn"
                title={`modelctl repair-active --root ${root || "—"} --apply`}
                onClick={handleRepairClick}
              >
                {armedRepair ? "Confirm repair →" : "⚒ Repair active refs"}
              </button>
            </div>
          </div>
          <p className="cmd-cap">
            {doctor?.error ? (
              <span className="log-warn">{doctor.error}</span>
            ) : doctor ? (
              doctorSummary(doctor.report)
            ) : (
              "no doctor report yet"
            )}
          </p>
        </div>
      </ScModule>

      {/* ── CH·02 MODELS ────────────────────────────────────────────── */}
      <ScChHead
        code="02"
        title="Models"
        note="the NAS catalog — click a row for its paths and actions"
      />
      <ScModule label="Models" id="sec-models">
        <div className="bench-results">
          <div className="nas-table__head" aria-hidden="true">
            <span>Name</span>
            <span>Runtime</span>
            <span className="nas-table__col-repo nas-table__col-hide">Repository</span>
            <span className="nas-table__num nas-table__col-hide">Size</span>
            <span></span>
          </div>
          {models.length === 0 ? (
            <div className="nas-table__empty">
              {inv?.error ? `Inventory failed: ${inv.error}` : "The store is empty — queue a download below."}
            </div>
          ) : (
            models.map((m) => {
              const state = modelDownloadState(m.name, jobs);
              return (
                <button
                  key={m.name}
                  type="button"
                  className={`nas-table__row${selected === m.name ? " is-selected" : ""}`}
                  aria-pressed={selected === m.name}
                  onClick={() => openDetail(m.name)}
                >
                  <span className="nas-name">{m.name}</span>
                  <span>
                    {m.runtime ? <ScChip>{m.runtime}</ScChip> : <span className="nas-repo">—</span>}
                  </span>
                  <span className="nas-repo nas-table__col-repo nas-table__col-hide">
                    {m.repository ?? "—"}
                  </span>
                  <span className="nas-table__num nas-table__col-hide">
                    {m.bytes != null ? fmtTBorGB(m.bytes) : "—"}
                  </span>
                  <span className="nas-table__actions">
                    {state ? (
                      <span
                        className="nas-state"
                        title={state === "queue" ? "queue job in flight — resumable staging" : "download job in flight"}
                      >
                        <ScLed state="accent" />
                        {state === "queue" ? "queue · staging" : "downloading"}
                      </span>
                    ) : (
                      <span className="xref">detail ↓</span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <p className="cmd-cap">
          modelctl list --json {root ? `--root ${root}` : ""}{" "}
          <span className="log-dim">→ active validated objects only</span>
        </p>

        {/* master–detail card */}
        {selected ? (
          <div className="sub-card" aria-live="polite">
            <div className="spread">
              <div style={{ minWidth: 0 }}>
                <h3 className="detail-head__name">
                  {selected}
                  {selectedBusy ? (
                    <ScChip tone="accent">staging</ScChip>
                  ) : detail?.error ? (
                    <ScChip tone="err">unreadable</ScChip>
                  ) : (
                    <ScChip tone="live">active</ScChip>
                  )}
                </h3>
                <div className="detail-head__repo">
                  {selectedModel?.repository ?? "—"}
                  {selectedModel?.bytes != null ? ` · ${fmtTBorGB(selectedModel.bytes)}` : ""}
                </div>
              </div>
              <button
                type="button"
                className="key key--sm"
                aria-label="Close detail"
                onClick={() => {
                  setSelected(null);
                  setDetail(null);
                  disarmDelete();
                }}
              >
                ✕
              </button>
            </div>

            {selectedBusy ? (
              <div className="notice" role="note">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="notice__title">In staging · not active yet</div>
                  <p style={{ margin: "4px 0 0" }}>
                    A {selectedState === "queue" ? "queue" : "download"} job is pulling this model into
                    staging. Update and delete stay disabled until it publishes (or fails).
                  </p>
                </div>
              </div>
            ) : null}

            <div className="hairline" />

            <div className="kv-grid">
              <div className="kv">
                <span className="kv__label">Repository</span>
                <span className="kv__value">{selectedModel?.repository ?? "—"}</span>
              </div>
              <div className="kv">
                <span className="kv__label">Runtime</span>
                <span className="kv__value">{selectedModel?.runtime ?? "—"}</span>
              </div>
              <div className="kv">
                <span className="kv__label">Size · objects</span>
                <span className="kv__value">
                  {selectedModel?.bytes != null ? fmtTBorGB(selectedModel.bytes) : "—"}
                </span>
              </div>
            </div>

            <div className="field">
              <span className="field__label">
                Resolved path · modelctl path {selected} {root ? `--root ${root}` : ""}
              </span>
              <code className="cmdline" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", maxWidth: "100%" }}>
                {detail?.path ?? (detail ? detail.error || "—" : "…")}
              </code>
            </div>

            <div className="code-box">
              <div className="code-box__bar">
                <span className="field__label">
                  Serve command · modelctl serve-command {selected} {root ? `--root ${root}` : ""}
                </span>
                <span className="cmd-cap" style={{ marginLeft: "auto" }}>
                  not executed — shell-escaped string only
                </span>
              </div>
              <pre className="trace-body__pre" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {detail?.serveCommand ?? (detail?.error ? `— (${detail.error})` : "…")}
              </pre>
              {detail?.serveCommand ? (
                <ScCopy text={detail.serveCommand} title="Copy serve command" />
              ) : null}
            </div>

            <div className="code-box">
              <div className="code-box__bar">
                <span className="field__label">RUN.md excerpt · cards/{selected}/RUN.md</span>
                <button
                  type="button"
                  className="xref xref--accent"
                  style={{ marginLeft: "auto", background: "none", border: 0, cursor: "pointer" }}
                  title={`modelctl sync-cards ${selected} ${root ? `--root ${root}` : ""}`}
                  onClick={() =>
                    void submitJob(
                      { kind: "sync-cards", model: selected, sparkId: spark.id },
                      `Cards sync queued for ${selected}`
                    )
                  }
                >
                  refresh card →
                </button>
              </div>
              <pre className="trace-body__pre" style={{ maxHeight: 150, whiteSpace: "pre-wrap" }}>
                {detail?.runMd ?? "—"}
              </pre>
            </div>

            <div className="hairline" />

            <div className="spread">
              <div className="row">
                <button
                  type="button"
                  className="key key--sm"
                  disabled={selectedBusy}
                  title={`modelctl update ${selected} ${root ? `--root ${root}` : ""}`}
                  onClick={() =>
                    void submitJob(
                      { kind: "update", model: selected, sparkId: spark.id },
                      `Update queued for ${selected}`
                    )
                  }
                >
                  ↧ Update to latest revision
                </button>
                <button
                  type="button"
                  className="key key--sm"
                  title={`modelctl sync-cards ${selected} ${root ? `--root ${root}` : ""}`}
                  onClick={() =>
                    void submitJob(
                      { kind: "sync-cards", model: selected, sparkId: spark.id },
                      `Cards sync queued for ${selected}`
                    )
                  }
                >
                  ▤ Cards: sync-cards
                </button>
                <button
                  type="button"
                  className="key key--sm key--danger"
                  disabled={selectedBusy}
                  title={
                    armedDelete === selected
                      ? `Click again to delete ${selected} from the NAS store NOW — modelctl delete --apply --yes`
                      : `Delete ${selected} from the NAS store — two-step confirm with a dry-run plan first`
                  }
                  onClick={() => handleDeleteClick(selected)}
                >
                  {armedDelete === selected ? "Confirm delete →" : "␡ Delete"}
                </button>
              </div>
              <span className="cmd-cap" style={{ marginLeft: "auto" }}>
                modelctl update · sync-cards · delete … <code className="cmdline">--root {root || "—"}</code>
              </span>
            </div>

            {/* dry-run plan, revealed by the first Delete click */}
            <div className="plan-box" hidden={armedDelete !== selected}>
              <span className="plan-box__title">
                Dry-run plan · modelctl delete {selected} {root ? `--root ${root}` : ""}
              </span>
              <span className="plan-box__line">
                {plan == null
                  ? "fetching dry-run…"
                  : plan.error
                    ? plan.error
                    : plan.plan || "(no output)"}
              </span>
              <div className="row">
                <button type="button" className="key key--sm" onClick={disarmDelete}>
                  Cancel
                </button>
                <span className="cmd-cap">
                  second <code className="cmdline">Delete</code> click runs{" "}
                  <code className="cmdline">--apply</code>
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </ScModule>

      {/* ── CH·03 DOWNLOAD ──────────────────────────────────────────── */}
      <ScChHead code="03" title="Download" note="single pull, or a validated queue" />
      <ScModule label="Download" id="sec-download">
        <div className="seg-switch seg-switch--tight" role="tablist" aria-label="Download mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "single"}
            className={`seg-switch__opt${mode === "single" ? " is-on" : ""}`}
            onClick={() => setMode("single")}
          >
            Single
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "queue"}
            className={`seg-switch__opt${mode === "queue" ? " is-on" : ""}`}
            onClick={() => setMode("queue")}
          >
            Queue
          </button>
        </div>

        {mode === "single" ? (
          <div className="sub-card sub-card--inset">
            <div className="q-row" style={{ gridTemplateColumns: "minmax(0,1.9fr) minmax(0,1.2fr) 0.75fr 0.75fr auto" }}>
              <label className="field">
                <span className="field__label">
                  Repo / URL <span className="field__req">required</span>
                </span>
                <input
                  type="text"
                  value={dlRepo}
                  onChange={(e) => setDlRepo(e.target.value)}
                  placeholder="org/model or https://huggingface.co/…"
                  aria-label="Repo / URL"
                />
              </label>
              <label className="field">
                <span className="field__label">Name</span>
                <input
                  type="text"
                  value={dlName}
                  onChange={(e) => setDlName(e.target.value)}
                  placeholder="short store name"
                  aria-label="Name"
                />
              </label>
              <label className="field">
                <span className="field__label">Quantization</span>
                <input
                  type="text"
                  value={dlQuant}
                  onChange={(e) => setDlQuant(e.target.value)}
                  placeholder="Q4_K_M"
                  aria-label="Quantization"
                />
              </label>
              <label className="field">
                <span className="field__label">Revision</span>
                <input
                  type="text"
                  value={dlRev}
                  onChange={(e) => setDlRev(e.target.value)}
                  placeholder="main"
                  aria-label="Revision"
                />
              </label>
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="key key--sm key--run"
                  disabled={busy || !dlRepo.trim()}
                  title="modelctl download REPO --name N --quantization Q --root …"
                  onClick={() => void handleSingleDownload()}
                >
                  ⤓ Download
                </button>
              </div>
            </div>
            <p className="cmd-cap">{cmdSinglePreview}</p>
            <p className="field__hint">
              Full workflow: resolve revision → infer runtime → manifest → estimate/validate → resumable
              staging → atomic publish → activate symlink. Repeating the command reuses the manifest and
              valid objects; a conflicting manifest stops unless <code>--force</code>.
            </p>
          </div>
        ) : (
          <div className="sub-card sub-card--inset">
            <div className="spread">
              <span className="mlabel">downloads.yaml</span>
              <div className="row">
                <label className="field" style={{ gap: 2 }}>
                  <span className="field__label">Parallel jobs</span>
                  <select
                    className="select-inline"
                    style={{ width: "auto" }}
                    value={String(qJobs)}
                    aria-label="Parallel jobs"
                    title={`modelctl queue downloads.yaml --jobs ${qJobs}`}
                    onChange={(e) => setQJobs(Number(e.target.value))}
                  >
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="4">4</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="key key--sm"
                  title="append a downloads: entry"
                  onClick={() => setQRows((prev) => [...prev, emptyRow()])}
                >
                  + Add entry
                </button>
              </div>
            </div>

            <div className="q-rows">
              {qRows.map((r, i) => (
                <div className="q-row" key={i}>
                  <label className="field">
                    <span className="field__label">
                      Source {!r.source.trim() && i === 0 ? "" : ""}
                      {i === 0 ? <span className="field__req">required</span> : null}
                    </span>
                    <input
                      type="text"
                      value={r.source}
                      placeholder="org/model"
                      aria-label={`Source ${i + 1}`}
                      onChange={(e) => patchRow(i, { source: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Name</span>
                    <input
                      type="text"
                      value={r.name}
                      placeholder="—"
                      aria-label={`Name ${i + 1}`}
                      onChange={(e) => patchRow(i, { name: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Quant</span>
                    <input
                      type="text"
                      value={r.quantization}
                      placeholder="—"
                      aria-label={`Quant ${i + 1}`}
                      onChange={(e) => patchRow(i, { quantization: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Runtime</span>
                    <select
                      value={r.runtime}
                      aria-label={`Runtime ${i + 1}`}
                      onChange={(e) =>
                        patchRow(i, { runtime: e.target.value as QueueRow["runtime"] })
                      }
                    >
                      <option value="">—</option>
                      <option value="auto">auto</option>
                      <option value="vllm">vllm</option>
                      <option value="llama.cpp">llama.cpp</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="q-del"
                    title="remove this entry"
                    aria-label={`remove entry ${i + 1}`}
                    onClick={() => setQRows((prev) => prev.filter((_, k) => k !== i))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div className="hairline" />

            <div className="code-box">
              <span className="field__label">YAML preview</span>
              <pre className="trace-body__pre" style={{ maxHeight: 190 }}>
                {entries.length > 0
                  ? buildQueuePreview(entries, qJobs)
                  : "downloads:\n  # add at least one source"}
              </pre>
            </div>

            <div className="spread">
              <button
                type="button"
                className="key key--sm key--primary"
                disabled={entries.length === 0}
                title={`modelctl queue downloads.yaml --jobs ${qJobs} ${root ? `--root ${root}` : ""}`}
                onClick={handleQueue}
              >
                ✓ Validate + queue
              </button>
              <span className="cmd-cap">
                modelctl queue downloads.yaml --jobs {qJobs} {root ? `--root ${root}` : ""}
              </span>
            </div>
            <p className="field__hint">
              Preflight checks <b>all</b> sources before any transfer: schema, duplicate names, HF
              validation per entry, manifest conflicts, and that the root supports atomic symlinks. The
              queue continues after a per-entry failure. The YAML is built server-side from these
              validated entries — never pasted raw.
            </p>
          </div>
        )}
        {queueRunning ? (
          <p className="cmd-cap">
            <ScLed state="accent" /> a queue job is running — see CH·05 below
          </p>
        ) : null}
      </ScModule>

      {/* ── CH·04 MODELCTL ──────────────────────────────────────────── */}
      <ScChHead code="04" title="modelctl" note="the CLI that owns this store" />
      <ScModule label="modelctl package" id="sec-modelctl">
        <div className="kv-grid">
          <div className="kv">
            <span className="kv__label">Installed</span>
            <span className={`kv__value${status?.error ? " kv__value--warning" : " kv__value--success"}`}>
              {installed ?? (status ? "not installed" : "…")}
            </span>
            <span className="kv__hint">uv tool · modelctl --version</span>
          </div>
          <div className="kv">
            <span className="kv__label">Latest release</span>
            <span className={`kv__value${updateAvailable ? " kv__value--warning" : ""}`}>
              {latest ?? "unknown"}
            </span>
            <span className="kv__hint">
              GitHub · piresbruno/modelctl
              {release?.error ? ` · probe failed: ${release.error}` : release?.publishedAt ? ` · ${agoLabel(release.publishedAt)}` : ""}
            </span>
          </div>
          <div className="kv">
            <span className="kv__label">uv</span>
            <span className="kv__value">{status?.uv?.version ?? "—"}</span>
            <span className="kv__hint">tool runner</span>
          </div>
          <div className="kv">
            <span className="kv__label">Last job</span>
            <span className="kv__value" style={{ paddingTop: 2 }}>
              {jobs[0] ? (
                <span className={jobStatusClass(jobs[0].status)}>
                  {jobs[0].name || jobs[0].kind} · {jobs[0].status}
                </span>
              ) : (
                "—"
              )}
            </span>
            <span className="kv__hint">{jobs[0] ? agoLabel(jobs[0].endedAt ?? jobs[0].startedAt ?? jobs[0].createdAt) : ""}</span>
          </div>
        </div>
        <div className="hairline" />
        <div className="spread">
          <div className="row">
            <button
              type="button"
              className="key key--primary"
              title="runs the existing install-modelctl job on this node"
              onClick={() =>
                void submitJob({ kind: "install-modelctl", sparkId: spark.id }, "modelctl update job started")
              }
            >
              ⟳ Update modelctl
            </button>
          </div>
          <span className="cmd-cap">uv tool install --force …/modelctl → re-check after the job completes</span>
        </div>
        <p className="field__hint">
          Same job the compute nodes use — 0.x minor bumps are features; the store&apos;s{" "}
          <code>catalog.json</code> schema is migrated by the first <code>catalog refresh</code> after the
          update.
        </p>
      </ScModule>

      {/* ── CH·05 JOBS ──────────────────────────────────────────────── */}
      <ScChHead code="05" title="Jobs" note="this node only" />
      <ScModule label="Jobs" id="sec-jobs">
        {jobs.length === 0 ? (
          <p className="cmd-cap">
            <span className="log-dim">no jobs on this node yet — downloads, queue, catalog refresh, doctor repairs and updates appear here</span>
          </p>
        ) : (
          <div className="job-card">
            {jobs.slice(0, 12).map((j) => (
              <div className="job-row" key={j.jobId}>
                <span className={jobStatusClass(j.status)}>{j.status}</span>
                <span className="job-row__name">{j.name || j.kind}</span>
                <span className="job-row__meta">
                  {agoLabel(j.startedAt ?? j.createdAt)}
                  {j.lastError ? ` · ${j.lastError}` : ""}
                </span>
                {j.status === "running" && j.logTail ? (
                  <pre className="job-row__log">{j.logTail}</pre>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </ScModule>

      {/* ── 06 SYSTEM footer ────────────────────────────────────────── */}
      <ScModule label="System" id="sec-system" style={{ gap: "var(--space-2)" }}>
        <div className="sys-foot">
          <span className="kv">
            <span className="kv__label">Status</span>
            <span className={`kv__value${spark.online ? " kv__value--success" : ""}`}>
              {spark.online ? "online" : "offline"}
            </span>
          </span>
          <span className="kv">
            <span className="kv__label">Addr</span>
            <span className="kv__value">{spark.lanIp || "—"}</span>
          </span>
          <span className="kv">
            <span className="kv__label">Up</span>
            <span className="kv__value">{spark.online ? fmtUptimeShort(spark.uptime) : "—"}</span>
          </span>
          <span className="kv">
            <span className="kv__label">CPU temp</span>
            <span className="kv__value">
              {spark.metrics?.cpu?.temperature != null ? `${Math.round(spark.metrics.cpu.temperature)} °C` : "—"}
            </span>
          </span>
          <span className="kv">
            <span className="kv__label">Store free</span>
            <span className="kv__value">
              {mount ? `${fmtStore(mount.available)} / ${fmtStore(mount.total)}` : "—"}
            </span>
          </span>
          <span className="sys-foot__note">
            GPU, serving and benchmarks are intentionally absent — this node has none.
          </span>
        </div>
      </ScModule>

      {/* Toasts (house pattern) */}
      <div
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          zIndex: 60,
        }}
      >
        {toasts.map((t) => (
          <span
            key={t.id}
            className={`text-xs rounded px-2 py-1 ${t.kind === "error" ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent"}`}
          >
            {t.msg}
          </span>
        ))}
      </div>
    </div>
  );
}
