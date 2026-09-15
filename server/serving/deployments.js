/**
 * Serve deployments (plan P1) — desired-run records over registered recipes.
 *
 * A deployment is ONE per recipe folder (D-folder): starting a second variant
 * requires stopping the first (enforced by the recipe-run resource lock).
 * Lifecycle rides the recipe's OWN verbs — the dashboard never generates serve
 * commands:
 *   start / restart → `recipe-run` job (detached, setsid session so TERM of
 *                     the driver group can't leave the launcher alive to
 *                     late-launch containers — stop-race fix [R4])
 *   stop            → cancel job (TERM, termOnly) when live, then one-shot
 *                     exec of `./entry stop` (idempotent per recipe stop())
 *   status          → probe join, no ownership: WS llm metrics ∪ live job ∪
 *                     one head exec (docker ps + /health code [+ peer probe])
 *   logs            → driver: tail of ~/.sparkdash/jobs/<id>.log (the real
 *                     transcript — the poll ring is 4 KB and in-memory);
 *                     engine: `docker logs --tail N [--since]` per container
 *
 * State join precedence (desired always beats job exit code — a stop the user
 * issued mid-download must never read as "failed"):
 *   orphaned recipe        → "orphan"
 *   live job ∧ desired run → "starting"
 *   live job ∧ desired stop→ "stopping"
 *   llm metrics healthy    → "healthy" (+ servedId match flag)
 *   /health 200 (probe)    → "healthy (unprobed port)"
 *   containers running     → "up" (engine visible, API silent)
 *   job failed/cancelled ∧ desired run → "failed"
 *   probe error/offline    → "unknown"  (NEVER rendered as stopped)
 *   else                   → "stopped"
 * + drift: git HEAD moved / build files dirtied since startedWith.version.
 *
 * Placement gate [D-bridge]: hard block when the parsed MODEL is provably
 * absent on the head (409 + planPlacement remediations); unknown/unparseable/
 * errored inventories warn only. force:true is the explicit escape hatch.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { shellQuote } from "../util/shellQuote.js";
import { atomicWrite } from "../util/atomicWrite.js";
import { versionDrift } from "./recipes.js";
import { planPlacement } from "../collectors/modelctlService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

export const RECIPE_VERBS = new Set(["start", "stop", "restart", "status", "logs", "download"]);

/** Marker: driver launched detached in its own session (setsid). */
/**
 * USER/LOGNAME are unset in non-interactive ssh/nohup shells; recipes that
 * default WORKER_USER to $USER under `set -u` abort without them (live-smoke
 * finding: start.sh:94). `id -un` works everywhere POSIX.
 */
function shellEnvBootstrap() {
  return [
    '[ -n "${USER:-}" ] || USER=$(id -un); export USER',
    '[ -n "${LOGNAME:-}" ] || LOGNAME=$USER; export LOGNAME',
  ].join("\n");
}

export function buildRecipeRunScript(absPath, entry, verb) {
  if (!RECIPE_VERBS.has(verb)) throw new Error(`invalid recipe verb: ${verb}`);
  return [
    shellEnvBootstrap(),
    `cd ${shellQuote(absPath)} || { echo "__RECIPE_NOPATH__"; exit 3; }`,
    `./${entry} ${verb}`,
  ].join("\n");
}

/** One-shot verb exec (stop / status text fallback). */
export function buildRecipeVerbCommand(absPath, entry, verb) {
  if (!RECIPE_VERBS.has(verb)) throw new Error(`invalid recipe verb: ${verb}`);
  return `${shellEnvBootstrap()}\ncd ${shellQuote(absPath)} && ./${entry} ${verb}`;
}

/**
 * Head status probe (one exec): container set + engine health + key
 * enforcement. Pure. `port` optional; `names` = expected container names.
 */
export function buildHeadProbeCommand(port, names = []) {
  const lines = [
    "echo __S_CONTAINERS__",
    "docker ps -a --format '{{.Names}}|{{.State}}' 2>&1 | head -60",
  ];
  if (Number.isInteger(port)) {
    lines.push("echo __S_HEALTH__");
    lines.push(
      `printf '%s' "$(curl -s -o /dev/null -w '%{http_code}' -m 4 http://127.0.0.1:${port}/health 2>/dev/null || echo 000)"`
    );
    lines.push("echo");
    lines.push("echo __S_MODELS__");
    lines.push(
      `printf '%s' "$(curl -s -m 4 http://127.0.0.1:${port}/v1/models 2>/dev/null | head -c 1500)"`
    );
    lines.push("echo");
  }
  void names; // expected-set membership is decided by the parser (probe is set-free)
  return lines.join("\n");
}

/**
 * Peer (worker) probe run FROM the head via ssh — mirrors how the recipe does
 * it (BatchMode; the head already holds the key the recipe uses).
 */
export function buildPeerProbeViaHead(workerSsh) {
  const q = shellQuote(workerSsh);
  return [
    "echo __S_CONTAINERS__",
    `timeout 12 ssh -o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new ${q} 'docker ps -a --format "{{.Names}}|{{.State}}"' 2>&1 | head -60`,
  ].join("\n");
}

/** Parse probe output → { containers: {name: "running"|"exited"|"absent"|"error"}, health: number|null }. */
export function parseProbeStatus(out) {
  const text = String(out ?? "");
  const result = { containers: {}, health: null, modelsRaw: null };
  const cIdx = text.indexOf("__S_CONTAINERS__");
  if (cIdx < 0) return { ...result, parseError: "probe output missing" };
  let rest = text.slice(cIdx + "__S_CONTAINERS__".length);
  const hIdx = rest.indexOf("__S_HEALTH__");
  const containersBlock = hIdx >= 0 ? rest.slice(0, hIdx) : rest;
  for (const line of containersBlock.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (/permission denied|cannot connect|command not found|dial tcp/i.test(t)) {
      result.dockerError = t.slice(0, 200);
      continue;
    }
    const m = t.match(/^(.+)\|(running|exited|created|restarting|removing|paused|dead)$/);
    if (m) result.containers[m[1]] = m[2] === "running" ? "running" : "exited";
  }
  if (hIdx >= 0) {
    rest = rest.slice(hIdx + "__S_HEALTH__".length);
    const mIdx = rest.indexOf("__S_MODELS__");
    const hLine = (mIdx >= 0 ? rest.slice(0, mIdx) : rest).trim().split("\n")[0] || "";
    const code = parseInt(hLine, 10);
    result.health = Number.isInteger(code) ? code : null;
    if (mIdx >= 0) {
      result.modelsRaw = rest.slice(mIdx + "__S_MODELS__".length).trim().split("\n")[0] || null;
    }
  }
  return result;
}

/** Container-set states against an expected map ({CONTAINER_HEAD: name, ...}). */
export function rankStates(expected, probe) {
  // ranks: for each expected name → probe.containers[name] ?? "absent" (when
  // docker answered) / "error" (docker error / unknown).
  const out = {};
  const keys = Object.keys(expected || {});
  if (!probe || (probe.dockerError && Object.keys(probe.containers).length === 0)) {
    for (const k of keys) out[k] = "error";
    return out;
  }
  for (const k of keys) {
    const name = expected[k];
    out[k] = probe.containers?.[name] ?? "absent";
  }
  return out;
}

/** Driver log tail command (the node-side transcript, not the 4 KB ring). */
export function buildDriverLogCommand(jobId, bytes = 6000) {
  const n = Math.max(500, Math.min(Math.round(Number(bytes) || 6000), 100_000));
  return `tail -c ${n} ~/.sparkdash/jobs/${shellQuote(jobId)}.log 2>/dev/null || true`;
}

/** Engine log tail for one container. */
export function buildEngineLogCommand(container, { tail = 200, since = null } = {}) {
  const t = Math.max(10, Math.min(Math.round(Number(tail) || 200), 5000));
  const c = shellQuote(container);
  const s = since ? `--since ${shellQuote(String(since))} ` : "";
  // -t: ISO prefixes make the UI follow-loop cursor-safe with --since.
  return `docker logs -t ${s}--tail ${t} ${c} 2>&1 | tail -c 100000 || true`;
}

// ─── Pure state join ───────────────────────────────────────

/**
 * @param {{
 *   desired: "running"|"stopped",
 *   orphaned?: boolean,
 *   job?: { status: string, jobId: string, endedAt?: number|null, exitCode?: number|null } | null,
 *   llm?: { available?: boolean, modelId?: string|null } | null,
 *   probe?: { health?: number|null, containers?: object, dockerError?: string } | null,
 *   ranks?: Record<string, string> | null,
 *   servedName?: string | null,
 *   engineIds?: string[] | null,
 * }} f
 *
 * Precedence notes: a live driver job means "starting" ONLY while the API is
 * silent — start.sh keeps running post-ready warmup after /health passes
 * (boot-shape sweep, minutes), and the truth is then healthy, not starting.
 * desired=stopped always outranks a live job (stopping, never "failed").
 */
export function joinServeState(f) {
  const jobLive = f.job && (f.job.status === "running" || f.job.status === "pending");
  const anyRankRunning = f.ranks ? Object.values(f.ranks).some((v) => v === "running") : false;
  const allProbeError = f.probe?.dockerError && !Object.keys(f.probe?.containers || {}).length;
  // /v1/models ids from either source (WS probe or raw probe output).
  const seenIds = [
    ...(f.llm?.modelId ? [f.llm.modelId] : []),
    ...(f.engineIds || []),
  ];
  const idMatch =
    !f.servedName || seenIds.length === 0
      ? null
      : seenIds.some((id) => normModel(id) === normModel(f.servedName));
  const apiUp = f.llm?.available || f.probe?.health === 200;
  if (f.orphaned) return { state: "orphan", jobLive: Boolean(jobLive) };
  // User intent first while a driver is still alive.
  if (jobLive && f.desired === "stopped") return { state: "stopping", jobId: f.job.jobId };
  if (apiUp && idMatch === false) {
    // The port answers, but with someone else's engine (port collision with
    // an unrelated server) — never report this deployment healthy.
    return { state: "foreign", servedId: seenIds[0] || null, servedIdMatch: false };
  }
  if (apiUp) {
    return {
      state: "healthy",
      jobId: jobLive ? f.job.jobId : undefined,
      warmup: Boolean(jobLive && f.desired === "running"),
      servedIdMatch: idMatch,
    };
  }
  if (jobLive && f.desired === "running") return { state: "starting", jobId: f.job.jobId };
  if (f.probe?.health === 401 && anyRankRunning) {
    return { state: "healthy-keyed", authRequired: true };
  }
  if (allProbeError) return { state: "unknown", reason: "probe exec failed" };
  // Stopped by request but containers still draining → stopping, never "up".
  if (anyRankRunning && f.desired === "stopped") return { state: "stopping" };
  if (anyRankRunning) return { state: "up", note: "containers running; API not answering yet" };
  const jobFailed = f.job && (f.job.status === "failed" || f.job.status === "cancelled" || f.job.status === "interrupted");
  if (f.desired === "running" && jobFailed) {
    return { state: "failed", exitCode: f.job.exitCode ?? null };
  }
  return { state: "stopped" };
}

/** "id":"x" occurrences from a possibly-truncated /v1/models payload. */
export function parseModelIds(raw) {
  if (!raw) return null;
  const ids = [...String(raw).matchAll(/"id"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  return ids.length ? ids : null;
}

function normModel(s) {
  const t = String(s || "").trim();
  const base = t.split("/").pop() || t;
  return base.toLowerCase();
}

/**
 * Cluster placement matrix from per-source inventories (pure, P3). Each
 * source lists ONLY its own models; membership is looked up per
 * (model,node). Identity/bytes prefer the NAS (store of record), falling
 * back to any node; keys match on local name, HF repo id, or basename.
 * @param {Array<{sparkId?: string, nas?: boolean, models: Array<object>}>} sources
 * @param {string[]} computeSparkIds column order
 * @param {Record<string, string[]>} servedByNode live-deployment labels per node
 */
export function buildPlacementMatrix(sources, computeSparkIds, servedByNode = {}) {
  const byId = new Map(); // sparkId -> models[]
  let nas = null;
  for (const src of sources || []) {
    if (!src || !Array.isArray(src.models)) continue;
    if (src.nas) {
      nas = src.models;
      continue;
    }
    if (src.sparkId) byId.set(src.sparkId, src.models);
  }
  const ids = computeSparkIds?.length ? computeSparkIds : [...byId.keys()];
  const keyFor = (m) =>
    String(m?.name || (m?.repository ? String(m.repository).toLowerCase() : "") || "").toLowerCase();
  // Row identity: NAS first, then nodes (first-seen bytes/name win once set).
  const identity = new Map();
  const absorb = (m) => {
    const k = keyFor(m);
    if (!k) return;
    const prev = identity.get(k);
    identity.set(k, {
      key: k,
      name: m.name ?? prev?.name ?? k,
      runtime: m.runtime ?? prev?.runtime ?? null,
      repository: m.repository ?? prev?.repository ?? null,
      bytes: m.bytes ?? prev?.bytes ?? null,
    });
  };
  for (const m of nas || []) absorb(m);
  for (const list of byId.values()) for (const m of list) absorb(m);

  const holds = (list, row) =>
    Array.isArray(list) &&
    list.some((x) => {
      const kx = keyFor(x);
      return (
        kx === row.key ||
        (row.repository && kx === String(row.repository).toLowerCase()) ||
        (row.name && x?.name === row.name)
      );
    });

  const models = [];
  for (const row of identity.values()) {
    const nodes = {};
    for (const id of ids) nodes[id] = holds(byId.get(id), row) ? "current" : "absent";
    // served = a live recipe deployment on that node names this model
    const servedOn = ids.filter((id) =>
      (servedByNode[id] || []).some((label) => {
        const l = String(label || "").toLowerCase();
        if (!l) return false;
        return (
          l === row.key ||
          row.key.includes(l) ||
          l.includes(row.key) ||
          (row.repository && l.includes(String(row.repository).toLowerCase()))
        );
      })
    );
    models.push({ ...row, nas: holds(nas, row) ? "active" : "absent", nodes, servedOn });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return { nodes: ids, models };
}

/** Capacity preflight from matrix bytes vs per-node storage (pure). */
export function capacityCheck(modelRow, storageByNode, reserveBytes = 0) {
  if (!modelRow || modelRow.bytes == null) return null;
  const out = [];
  for (const [sparkId, rows] of Object.entries(storageByNode || {})) {
    const list = Array.isArray(rows) ? rows : [];
    // biggest available wins (model lands on the data mount)
    const best = list.reduce((a, b) => ((b?.available ?? -1) > (a?.available ?? -1) ? b : a), null);
    if (!best) continue;
    const free = (best.available || 0) * 1024 * 1024; // collector is MiB
    out.push({
      sparkId,
      mount: best.label,
      freeBytes: free,
      neededBytes: modelRow.bytes + reserveBytes,
      fits: free >= modelRow.bytes + reserveBytes,
    });
  }
  return out;
}

/** Topology guard (pure): nnodes declared by the variant vs available compute nodes. */
export function checkTopology(variantMeta, computeNodeCount) {
  const nn = variantMeta?.nnodes ?? null;
  if (!nn || nn <= 1) return { ok: true, nnodes: nn || 1, computeNodes: computeNodeCount };
  if (computeNodeCount < nn) {
    return {
      ok: false,
      nnodes: nn,
      computeNodes: computeNodeCount,
      reason: `variant wants ${nn} nodes, cluster has ${computeNodeCount} compute node${computeNodeCount > 1 ? "s" : ""}`,
    };
  }
  return { ok: true, nnodes: nn, computeNodes: computeNodeCount };
}

/** Model id ↔ inventory match: local name, HF repo id, or lowercased compare. */
export function modelInInventory(model, models) {
  if (!model || !Array.isArray(models)) return null; // unknown
  const m = String(model).trim();
  const mLower = m.toLowerCase();
  const mBase = mLower.split("/").pop();
  return (
    models.some(
      (x) =>
        x?.name === m ||
        (x?.name && x.name.toLowerCase() === mLower) ||
        (x?.repository && x.repository.toLowerCase() === mLower) ||
        (x?.name && mBase && x.name.toLowerCase() === mBase) ||
        (x?.repository && x.repository && x.repository.toLowerCase() === mBase)
    ) ?? false
  );
}

// ─── Deployment store ──────────────────────────────────────

export class DeploymentStore {
  constructor(opts = {}) {
    this._file =
      opts.filePath ||
      process.env.SPARKDASH_SERVE_DEPLOYMENTS_PATH ||
      path.join(ROOT, "config", "serve-deployments.json");
    this._now = opts.now || Date.now;
    /** @type {Map<string, object>} */
    this.deployments = new Map();
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const raw = JSON.parse(fs.readFileSync(this._file, "utf8"));
      for (const d of raw.deployments || []) {
        if (d?.id && d?.recipeId) this.deployments.set(d.id, d);
      }
    } catch (err) {
      console.error("[serve-deployments] failed to load state:", err.message);
    }
  }

  _persist() {
    try {
      const deployments = [...this.deployments.values()].sort((a, b) => a.id.localeCompare(b.id));
      atomicWrite(this._file, JSON.stringify({ version: 1, deployments }, null, 2) + "\n", 0o644);
    } catch (err) {
      console.error("[serve-deployments] failed to persist state:", err.message);
    }
  }

  list() {
    return [...this.deployments.values()];
  }

  get(id) {
    return this.deployments.get(id) || null;
  }

  byRecipe(recipeId) {
    for (const d of this.deployments.values()) if (d.recipeId === recipeId) return d;
    return null;
  }

  /** One deployment per recipe — reused across restarts (identity = recipeId). */
  upsertForRecipe(recipeId, patch = {}) {
    let d = this.byRecipe(recipeId);
    if (!d) {
      d = {
        id: `dep-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`,
        recipeId,
        desired: "stopped",
        variant: null,
        port: null,
        portAdded: false,
        jobId: null,
        startedWith: null,
        createdAt: this._now(),
        updatedAt: this._now(),
      };
      this.deployments.set(d.id, d);
    }
    Object.assign(d, patch, { updatedAt: this._now() });
    this._persist();
    return d;
  }

  remove(id) {
    if (!this.deployments.delete(id)) return false;
    this._persist();
    return true;
  }
}

// ─── Engine ────────────────────────────────────────────────

export class ServeEngine {
  /**
   * @param {{
   *   recipeStore, deployStore, remoteJobs,
   *   exec: async (spark, cmd, opts?) => string,      // transport-aware (agent-first)
   *   registry: { getSpark(id), sparks },
   *   getSettings: () => object,
   *   modelctl: { listNodeModels(spark), listNasModels(opts), modelctlEnabledSparks() },
   *   llmSnapshot?: (sparkId) => { available, modelId, port }[] | null,  // metrics.llm rows
   *   storageSnapshot?: (sparkId) => { label, available, total }[] | null, // for matrix capacity
   *   ensureLlmPort?: async (sparkId, port) => boolean,                  // add + hot-reload (returns added)
   *   dropLlmPort?: async (sparkId, port) => void,
   *   nudgeLlm?: (sparkId) => void,  // force an immediate llm re-probe (stop settle)
   *   now?: () => number,
   *   probeTtlMs?: number,
   *   versionOf?: (recipe) => object|null,
   * }} deps
   */
  constructor(deps) {
    this._ = deps;
    this._probeCache = new Map(); // recipeId → { at, data }
    this._inflight = new Map(); // recipeId → promise
  }

  _spark(id) {
    return this._.registry.getSpark(id);
  }

  _resourceKey(recipe) {
    return `${recipe.sparkId}:${recipe.path}`;
  }

  /** Expected container map for the deployment's variant entry (pure-ish). */
  _expectedContainers(recipe, variant) {
    const byEntry = recipe.meta?.containersByEntry || {};
    const set =
      byEntry[variant || recipe.meta?.entry || "start.sh"] ||
      byEntry[recipe.meta?.entry] ||
      recipe.meta?.containers ||
      {};
    const out = {};
    for (const [k, v] of Object.entries(set)) {
      // CONTAINER_HEAD → head rank; any other CONTAINER_* → worker ranks.
      out[k] = v;
    }
    return out;
  }

  /** Map worker-rank container names to sparks via .env IPs (best effort). */
  _peerSparkForWorkers(recipe) {
    const meta = recipe.meta || {};
    if (!meta.workerIp) return null;
    const ips = new Set([meta.workerIp]);
    for (const s of this._.registry.sparks || []) {
      if (s.id === recipe.sparkId) continue;
      if (s.lanIp && ips.has(s.lanIp)) return s;
      if (s.cx7Ip && ips.has(s.cx7Ip)) return s;
    }
    return null;
  }

  // ── lifecycle ──

  /** Compute-node helper: every registered non-NAS spark. */
  _computeSparks() {
    return (this._.registry.sparks || []).filter((sp) => sp.kind !== "nas");
  }

  /**
   * Placement pre-check for the parsed MODEL on the head node. Inventories
   * fan out in parallel (P3 — was a serial per-peer round trip).
   * @returns {Promise<{ check: "present"|"absent"|"unknown", placement?: object }>}
   */
  async placementCheck(recipe) {
    const model = recipe.meta?.model;
    if (!model) return { check: "unknown" };
    const spark = this._spark(recipe.sparkId);
    if (!spark || !spark.modelctlEnabled) return { check: "unknown" };
    const { modelctl } = this._;
    const inv = await modelctl.listNodeModels(spark).catch(() => null);
    if (!inv || inv.error) return { check: "unknown" };
    const present = modelInInventory(model, inv?.models);
    if (present) return { check: "present" };
    // Absent → remediation plan (sync from NAS / push from peer).
    const peers = (await Promise.all(
      (modelctl.modelctlEnabledSparks() || [])
        .filter((p) => p.id !== spark.id && p.kind !== "nas")
        .map(async (p) => {
          const pInv = await modelctl.listNodeModels(p).catch(() => null);
          return pInv?.models?.length ? { sparkId: p.id, models: pInv.models } : null;
        })
    )).filter(Boolean);
    let nasInv = null;
    try {
      const nas = await modelctl.listNasModels();
      if (nas?.models?.length) nasInv = { models: nas.models };
    } catch {
      /* NAS unknown → planPlacement degrades to push/unavailable */
    }
    // planPlacement matches STORE names exactly, but a recipe's MODEL is
    // usually the HF repo id — resolve the canonical store name from any
    // inventory that holds the model (NAS first: store of record), then plan
    // and carry that name on every remediation (jobs take store names).
    const looser = String(model).toLowerCase();
    const base = looser.includes("/") ? looser.split("/").pop() : looser;
    const holdsLoose = (list) =>
      (list || []).find(
        (m) =>
          m?.name === model ||
          String(m?.repository || "").toLowerCase() === looser ||
          String(m?.name || "").toLowerCase() === looser ||
          String(m?.repository || "").toLowerCase() === base ||
          String(m?.name || "").toLowerCase() === base
      )?.name ?? null;
    const canonical =
      holdsLoose(nasInv?.models) ||
      peers.map((p) => holdsLoose(p.models)).find(Boolean) ||
      holdsLoose(inv?.models) ||
      model;
    const placement = planPlacement(canonical, {
      target: { sparkId: spark.id, models: inv?.models ?? [] },
      nas: nasInv,
      peers,
    });
    const remediations = placement.remediations.map((rem) => ({ ...rem, model: canonical }));
    return { check: "absent", placement: { ...placement, remediations } };
  }

  /**
   * Cluster placement matrix (P3): every source's OWN inventory + the live
   * recipe deployments as served labels + capacity vs storage snapshots.
   */
  async matrix() {
    const { modelctl } = this._;
    const computes = this._computeSparks();
    const nodeInv = await Promise.all(
      computes.map(async (sp) => {
        const inv = await modelctl.listNodeModels(sp).catch(() => null);
        return { sparkId: sp.id, nas: false, models: inv?.models || [] };
      })
    );
    const nasInv = await modelctl
      .listNasModels()
      .then((r) => (r?.models ? { nas: true, models: r.models } : null))
      .catch(() => null);
    const sources = [...(nasInv ? [nasInv] : []), ...nodeInv];
    const servedByNode = {};
    for (const rec of this._.recipeStore.list()) {
      const dep = this._.deployStore.byRecipe(rec.id);
      if (!dep || dep.desired !== "running") continue;
      // Serve the MODEL identity (not the recipe label): matrix rows are
      // keyed by store name / repo id, so served marks land on the row the
      // recipe actually runs (label kept as a fallback chip match).
      const ids = [rec.sparkId];
      // TP>1 recipes serve their peer too (rank on the worker)
      if (rec.meta?.workerIp) {
        const peer = this._peerSparkForWorkers(rec);
        if (peer) ids.push(peer.id);
      }
      for (const id of ids) {
        const arr = (servedByNode[id] ||= []);
        arr.push(rec.label || rec.path.split("/").pop());
        if (rec.meta?.model) arr.push(rec.meta.model);
        if (rec.meta?.servedName) arr.push(rec.meta.servedName);
      }
    }
    const built = buildPlacementMatrix(sources, computes.map((sp) => sp.id), servedByNode);
    const capacity = {};
    for (const sp of computes) {
      const snap = this._.storageSnapshot ? this._.storageSnapshot(sp.id) : null;
      if (Array.isArray(snap)) capacity[sp.id] = snap;
    }
    return { nodes: built.nodes.map((id) => ({ sparkId: id, name: this._spark(id)?.name || id })), models: built.models, capacity, at: Date.now() };
  }

  /**
   * Start (or restart) a recipe deployment.
   * @param {string} recipeId
   * @param {{ variant?: string|null, force?: boolean }} [opts]
   * @returns {Promise<{ ok: true, jobId, deployment } | { ok: false, blocked: true, placement, error } | { ok: false, error }>}
   */
  async start(recipeId, { variant = null, force = false } = {}) {
    const recipes = this._.recipeStore;
    const recipe = recipes.get(recipeId);
    if (!recipe) return { ok: false, error: "recipe not found" };
    if (recipe.orphaned) return { ok: false, error: "recipe node was removed (orphaned)" };
    const spark = this._spark(recipe.sparkId);
    if (!spark) return { ok: false, error: `spark ${recipe.sparkId} not found` };
    if (spark.kind === "nas") return { ok: false, error: "NAS nodes cannot host recipes" };

    const entry = variant || recipe.entry || recipe.meta?.entry || "start.sh";
    const vlist = (recipe.meta?.variants || []).map((v) => v.rel);
    if (variant && !vlist.includes(variant) && variant !== recipe.meta?.entry) {
      return { ok: false, error: `unknown variant: ${variant}` };
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(entry) || entry.includes("..") || entry.startsWith("/")) {
      return { ok: false, error: "invalid entry path" };
    }

    const resource = this._resourceKey(recipe);
    if (this._.remoteJobs.hasActiveJobForResource(resource)) {
      return { ok: false, error: `a recipe-run job is already active for this folder` };
    }

    // [P3] topology guard: a variant whose NNODES exceed the fleet never
    // starts (cheap, no inventories needed).
    const variantMeta = {
      nnodes: variant ? null : recipe.meta?.nnodes ?? null,
    };
    // Variant entries carry their own NNODES default (start-tp4.sh → 4); the
    // probe only parsed the .env for the default entry — infer from the name.
    if (variant) {
      const m = variant.match(/tp(\d+)\b/i);
      variantMeta.nnodes = m ? parseInt(m[1], 10) : recipe.meta?.nnodes ?? null;
    }
    const topo = checkTopology(variantMeta, this._computeSparks().length);
    if (!topo.ok) {
      return { ok: false, error: topo.reason, topology: topo };
    }

    // [D-bridge] hard block only when ABSENCE is proven; unknown warns never block.
    if (!force) {
      const pc = await this.placementCheck(recipe);
      if (pc.check === "absent") {
        return {
          ok: false,
          blocked: true,
          error: `model "${recipe.meta.model}" is not on ${recipe.sparkId} — starting would pull it from Hugging Face`,
          placement: pc.placement,
        };
      }
    }

    // D-port: register the recipe port so WS probes (and hero/bench/proxy) exist.
    let portAdded = false;
    if (Number.isInteger(recipe.meta?.port) && this._.ensureLlmPort) {
      portAdded = await this._.ensureLlmPort(spark.id, recipe.meta.port).catch(() => false);
    }
    const script = buildRecipeRunScript(recipe.path, entry, "start");
    const { jobId } = await this._.remoteJobs.startRemoteJob(spark, {
      name: `serve ${recipe.label || path.posix.basename(recipe.path)} (start)`,
      script,
      kind: "recipe-run",
      resource,
    });

    const deployment = this._.deployStore.upsertForRecipe(recipeId, {
      variant: variant || null,
      desired: "running",
      jobId,
      port: recipe.meta?.port ?? null,
      portAdded: portAdded || undefined,
      startedWith: { version: this._.versionOf ? this._.versionOf(recipe) : recipe.versions || null, at: Date.now() },
    });
    return { ok: true, jobId, deployment };
  }

  /**
   * Stop: TERM-first driver kill (group; [R4] late-launch race), then the
   * recipe's own stop verb. desired=stopped recorded BEFORE anything runs.
   */
  async stop(recipeId) {
    const recipe = this._.recipeStore.get(recipeId);
    if (!recipe) return { ok: false, error: "recipe not found" };
    const deployment = this._.deployStore.byRecipe(recipeId);
    if (!deployment) return { ok: false, error: "no deployment for recipe" };
    const spark = this._spark(recipe.sparkId);
    if (!spark) return { ok: false, error: "spark not found" };

    this._.deployStore.upsertForRecipe(recipeId, { desired: "stopped", lastStopAt: Date.now() });

    // 1) driver first — a live recipe-run must die before the stop verb, or it
    //    can reach launch_cluster after the containers we're about to remove.
    const live = this._.remoteJobs.listActiveJobsForResource(this._resourceKey(recipe));
    for (const job of live) {
      await this._.remoteJobs.cancelRemoteJob(spark, job.jobId).catch(() => undefined);
    }

    // 2) the recipe's own stop verb (idempotent — docker rm -f || log).
    const entry = deployment.variant || recipe.entry || recipe.meta?.entry || "start.sh";
    const cmd = buildRecipeVerbCommand(recipe.path, entry, "stop");
    let out = "";
    try {
      out = await this._.exec(spark, cmd, { timeoutMs: 30_000 });
    } catch (err) {
      return { ok: false, error: `stop exec failed: ${err.message}`, partial: true };
    }
    this._probeCache.delete(recipeId);
    // The WS llm[] row lags one monitor poll behind the vanished container —
    // nudge an immediate re-probe (head + mapped peer) so the join settles.
    if (this._.nudgeLlm) {
      this._.nudgeLlm(spark.id);
      const peer = this._peerSparkForWorkers(recipe);
      if (peer) this._.nudgeLlm(peer.id);
    }
    return { ok: true, output: out.trim().slice(-400) };
  }

  async restart(recipeId) {
    const s = await this.stop(recipeId);
    if (!s.ok && !s.partial) return s;
    // brief settle so the probe cache/job states settle before the new driver
    await new Promise((r) => setTimeout(r, 500));
    return this.start(recipeId, { variant: this._.deployStore.byRecipe(recipeId)?.variant });
  }

  // ── state ──

  /**
   * Join one recipe's deployment state. `refresh` forces the exec probe;
   * otherwise a probe cache (default 5 s) is reused.
   */
  async stateFor(recipeId, { refresh = false } = {}) {
    const recipe = this._.recipeStore.get(recipeId);
    if (!recipe) return null;
    const deployment = this._.deployStore.byRecipe(recipeId);
    const resource = this._resourceKey(recipe);
    // Live job on the folder wins; else the deployment's last known terminal
    // job (failed/cancelled receipts feed the join).
    const [activeJob] = this._.remoteJobs.listActiveJobsForResource(resource);
    const lastJob = deployment?.jobId ? this._.remoteJobs.getJob(deployment.jobId) : null;
    const job =
      activeJob ||
      (lastJob && ["completed", "failed", "cancelled", "interrupted"].includes(lastJob.status) ? lastJob : null);

    const meta = recipe.meta || {};
    const llmRows = this._.llmSnapshot ? this._.llmSnapshot(recipe.sparkId) || [] : [];
    const llm = Number.isInteger(meta.port) ? llmRows.find((r) => r.port === meta.port) || null : null;

    // A live driver's state is polled through the manager (single-flight;
    // the sweeper alone is up to 30 s stale — too slow for the 5 s table).
    if (job?.status === "running" && !recipe.orphaned) {
      const jSpark = this._spark(job.sparkId || recipe.sparkId);
      if (jSpark && this._.remoteJobs.pollRemoteJob) {
        try {
          await this._.remoteJobs.pollRemoteJob(jSpark, job.jobId);
        } catch {
          /* best-effort */
        }
      }
    }

    let probe = null;
    let ranks = null;
    const cached = this._probeCache.get(recipeId);
    if (!refresh && cached && Date.now() - cached.at < (this._.probeTtlMs ?? 5000)) {
      probe = cached.probe;
      ranks = cached.ranks;
    } else if (!recipe.orphaned) {
      const spark = this._spark(recipe.sparkId);
      if (spark) {
        try {
          const out = await this._.exec(spark, buildHeadProbeCommand(meta.port), { timeoutMs: 12_000 });
          probe = parseProbeStatus(out);
          const expected = this._expectedContainers(recipe, deployment?.variant);
          // Rank split by name: *WORKER* keys → peer ranks; everything else
          // (CONTAINER_HEAD, single-node CONTAINER_NAME) → the head.
          const isWorkerKey = (k) => /WORKER/i.test(k);
          const headNames = Object.fromEntries(Object.entries(expected).filter(([k]) => !isWorkerKey(k)));
          ranks = rankStates(headNames, probe);
          // worker ranks: prefer the peer's own transport; else head-side ssh hop.
          const workerNames = Object.fromEntries(Object.entries(expected).filter(([k]) => isWorkerKey(k)));
          const workerKeys = Object.keys(workerNames);
          if (workerKeys.length) {
            const peer = this._peerSparkForWorkers(recipe);
            let peerProbe = null;
            if (peer) {
              try {
                const pOut = await this._.exec(peer, buildHeadProbeCommand(null), { timeoutMs: 12_000 });
                peerProbe = parseProbeStatus(pOut);
              } catch {
                peerProbe = null;
              }
            }
            if (!peerProbe) {
              const user = meta.workerUser || spark.ssh?.user || "root";
              const target = meta.workerIp ? `${user}@${meta.workerIp}` : null;
              if (target) {
                try {
                  const hop = await this._.exec(spark, buildPeerProbeViaHead(target), { timeoutMs: 15_000 });
                  peerProbe = parseProbeStatus(hop);
                } catch {
                  peerProbe = null;
                }
              }
            }
            const peerRanks = rankStates(workerNames, peerProbe);
            for (const [k, v] of Object.entries(peerRanks)) ranks[k] = v;
          }
          this._probeCache.set(recipeId, { at: Date.now(), probe, ranks });
        } catch (err) {
          probe = { containers: {}, dockerError: err.message, health: null };
          ranks = null;
        }
      }
    }

    const versionNow = recipe.versions || null;
    const drift = deployment?.startedWith ? versionDrift(deployment.startedWith, versionNow) : { drift: false };

    const base = {
      recipeId,
      sparkId: recipe.sparkId,
      path: recipe.path,
      label: recipe.label || path.posix.basename(recipe.path),
      variant: deployment?.variant || null,
      port: meta.port ?? deployment?.port ?? null,
      servedName: meta.servedName || null,
      model: meta.model || null,
      topology: {
        nnodes: meta.nnodes ?? null,
        tp: meta.tp ?? null,
        workerIp: meta.workerIp || null,
        workerSparkId: this._peerSparkForWorkers(recipe)?.id || null,
      },
      version: versionNow,
      orphaned: Boolean(recipe.orphaned),
      probeError: recipe.probeError || null,
      ranks: ranks || null,
      engine: probe ? { health: probe.health, modelsRaw: probe.modelsRaw, dockerError: probe.dockerError || null } : null,
    };
    if (!deployment) return { ...base, state: "unstarted", desired: null };
    const joined = joinServeState({
      desired: deployment.desired,
      orphaned: recipe.orphaned,
      job: job ? { status: job.status, jobId: job.jobId, endedAt: job.endedAt, exitCode: job.exitCode } : null,
      llm,
      probe,
      ranks,
      servedName: meta.servedName,
      engineIds: parseModelIds(probe?.modelsRaw),
      drift,
    });
    return {
      ...base,
      deployment,
      job: job ? { jobId: job.jobId, status: job.status, exitCode: job.exitCode ?? null, endedAt: job.endedAt ?? null } : null,
      ...joined,
      drift,
    };
  }

  async listStates({ refresh = false } = {}) {
    const recipes = this._.recipeStore.list();
    return Promise.all(
      recipes.map((r) =>
        this.stateFor(r.id, { refresh }).catch((err) => ({
          recipeId: r.id,
          sparkId: r.sparkId,
          state: "unknown",
          error: err.message,
        }))
      )
    );
  }

  // ── logs ──

  async driverLog(recipeId, bytes = 6000) {
    const recipe = this._.recipeStore.get(recipeId);
    const deployment = recipe && this._.deployStore.byRecipe(recipeId);
    const jobId = deployment?.jobId;
    if (!recipe || !jobId) return { log: "" };
    const spark = this._spark(recipe.sparkId);
    if (!spark) return { log: "", error: "spark not found" };
    try {
      return { log: await this._.exec(spark, buildDriverLogCommand(jobId, bytes), { timeoutMs: 10_000 }), jobId };
    } catch (err) {
      return { log: "", error: err.message };
    }
  }

  async engineLog(recipeId, { rank = "head", tail = 200, since = null } = {}) {
    const recipe = this._.recipeStore.get(recipeId);
    if (!recipe) return { log: "", error: "recipe not found" };
    const deployment = this._.deployStore.byRecipe(recipeId);
    const expected = this._expectedContainers(recipe, deployment?.variant);
    const key = rank === "head" ? "CONTAINER_HEAD" : `CONTAINER_${rank.toUpperCase()}`;
    const name =
      expected[key] ||
      (rank !== "head" ? Object.entries(expected).find(([k]) => k !== "CONTAINER_HEAD")?.[1] : null);
    if (!name) return { log: "", error: `no ${rank} container name known` };
    const spark = this._spark(recipe.sparkId);
    if (!spark) return { log: "", error: "spark not found" };
    const cmd = buildEngineLogCommand(name, { tail, since });
    const target =
      rank === "head"
        ? spark
        : this._peerSparkForWorkers(recipe) || null;
    try {
      if (target) return { log: await this._.exec(target, cmd, { timeoutMs: 15_000 }), container: name };
      // No mapped peer: run through the head's own ssh hop (recipe-style).
      const user = recipe.meta?.workerUser || spark.ssh?.user || "root";
      if (!recipe.meta?.workerIp) return { log: "", error: "worker target unknown" };
      const hop = `timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=6 ${shellQuote(
        `${user}@${recipe.meta.workerIp}`
      )} ${shellQuote(cmd)}`;
      return { log: await this._.exec(spark, hop, { timeoutMs: 25_000 }), container: name };
    } catch (err) {
      return { log: "", error: err.message };
    }
  }

  /** Boot reconcile [D-boot]: re-probe only — never auto-start. */
  reconcileOnBoot() {
    // desired=running rows stay; their state resolves on first stateFor().
    // (Job boot recovery lives in remoteJobs._load.) No timers, no starts.
    return { deployments: this._.deployStore.list().filter((d) => d.desired === "running").length };
  }

  /**
   * P4 gateway pool: every RUNNING-desired deployment whose served name
   * (SERVED_MODEL_NAME, else the model basename) matches `servedName`.
   * Health is the cheap WS llm row (no exec) — selection-time only.
   * @returns {Array<{sparkId: string, port: number, healthy: boolean, recipeId: string}>}
   */
  gatewayTargets(servedName) {
    const want = String(servedName || "").trim().toLowerCase();
    if (!want) return [];
    const out = [];
    for (const rec of this._.recipeStore.list()) {
      const dep = this._.deployStore.byRecipe(rec.id);
      if (!dep || dep.desired !== "running" || rec.orphaned) continue;
      const names = [
        rec.meta?.servedName,
        rec.meta?.model ? String(rec.meta.model).split("/").pop() : null,
      ].filter(Boolean);
      if (!names.some((n) => String(n).toLowerCase() === want)) continue;
      const port = rec.meta?.port ?? dep.port;
      if (!Number.isInteger(port)) continue;
      const rows = this._.llmSnapshot ? this._.llmSnapshot(rec.sparkId) || [] : [];
      const row = rows.find((r) => r.port === port);
      out.push({ sparkId: rec.sparkId, port, healthy: Boolean(row?.available), recipeId: rec.id });
    }
    return out;
  }

  /** Served names currently in the gateway pool (for 404 discovery). */
  gatewayNames() {
    const set = new Set();
    for (const rec of this._.recipeStore.list()) {
      const dep = this._.deployStore.byRecipe(rec.id);
      if (!dep || dep.desired !== "running" || rec.orphaned) continue;
      if (rec.meta?.servedName) set.add(rec.meta.servedName);
      if (rec.meta?.model) set.add(String(rec.meta.model).split("/").pop());
    }
    return [...set];
  }

  /** GC helpers: orphan everything referencing a removed spark. */
  orphanSpark(sparkId) {
    const n1 = this._.recipeStore.setOrphanedBySpark(sparkId, true);
    let n2 = 0;
    for (const d of this._.deployStore.list()) {
      const r = this._.recipeStore.get(d.recipeId);
      if (r && r.sparkId === sparkId) {
        this._.deployStore.upsertForRecipe(d.recipeId, { desired: "stopped", deadAt: Date.now() });
        n2++;
      }
    }
    return { recipes: n1, deployments: n2 };
  }

  adoptSpark(sparkId) {
    return this._.recipeStore.setOrphanedBySpark(sparkId, false);
  }
}


