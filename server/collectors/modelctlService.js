/**
 * modelctl service (B3) — command builders, parsers, caches, and placement
 * planning for the modelctl CLI on nodes.
 *
 * Design:
 *  - Command builders + JSON parsers are PURE (DI-injectable exec for tests).
 *  - All values shellQuote'd; model names additionally validated at REST.
 *  - Host selection: NAS ops on settings.modelctl.nasHostSparkId (else head →
 *    isLocal → sole spark); node ops on the target spark when modelctlEnabled.
 *  - Inventory caches: NAS 60 s / node 30 s; last good result served stale
 *    for 5× TTL with stale:true; errors → { models: [], error }.
 *  - checkModelctl cached 5 min; probes bare name then ~/.local/bin fallback.
 *  - NAS `delete` is opt-in from the Models catalog: dry-run by default,
 *    then --apply --yes for the real removal (managed root store only).
 */
import { shellQuote } from "../util/shellQuote.js";

export const NAS_CACHE_TTL_MS = 60_000;
export const NODE_CACHE_TTL_MS = 30_000;
export const VERSION_CACHE_TTL_MS = 5 * 60_000;
const STALE_MULTIPLIER = 5;

/** Model names validated here too (defense in depth; REST re-validates). */
const MODEL_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function validModelName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 128 && MODEL_NAME_RE.test(name);
}

// ─── Command builders (pure) ──────────────────────────────

/** Wrap a modelctl invocation in the bare→~/.local/bin ladder (non-interactive SSH doesn't source rc files). */
function mctl(remoteBin, args) {
  const bare = shellQuote(remoteBin);
  // A remoteBin containing a path separator is an explicit path — skip the
  // bare-name branch (it would command -v a slash path) and just use it.
  if (remoteBin.includes("/")) {
    return `${bare} ${args}`;
  }
  return [
    `if command -v ${bare} >/dev/null 2>&1; then ${bare} ${args};`,
    `elif [ -x ~/.local/bin/${bare} ]; then ~/.local/bin/${bare} ${args};`,
    "else echo __MCTL_MISSING__; fi",
  ].join(" ");
}

/** `modelctl list --json --root <nasRoot>` — NAS catalog. */
export function buildNasListCommand(nasRoot, remoteBin = "modelctl") {
  return mctl(remoteBin, `list --json --root ${shellQuote(nasRoot)}`);
}
/** `modelctl list --local --json` — node registrations. */
export function buildNodeListCommand(remoteBin = "modelctl") {
  return mctl(remoteBin, "list --local --json");
}

/** `modelctl download <repo> --root <nasRoot>` + optional flags (job script body). */
export function buildDownloadScript({ repo, nasRoot, name, quantization, revision, remoteBin = "modelctl" }) {
  const parts = ["download", shellQuote(repo), "--root", shellQuote(nasRoot)];
  if (name) parts.push("--name", shellQuote(name));
  if (quantization) parts.push("--quantization", shellQuote(quantization));
  if (revision) parts.push("--revision", shellQuote(revision));
  return mctl(remoteBin, parts.join(" "));
}

/** `modelctl sync-local <name> --source-root <nasRoot>` (job script body). */
export function buildSyncScript({ name, nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `sync-local ${shellQuote(name)} --source-root ${shellQuote(nasRoot)}`);
}

/** `modelctl push <name> --host <target> --jobs 4` (job script body, run on the SOURCE node). */
export function buildPushScript({ name, targetHost, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `push ${shellQuote(name)} --host ${shellQuote(targetHost)} --jobs 4`);
}

/** `modelctl delete-local <name>` (job script body). */
export function buildDeleteLocalScript({ name, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `delete-local ${shellQuote(name)}`);
}

/**
 * `modelctl delete <name> --root <nasRoot> --apply --yes` (job script body).
 * Destructive: permanently removes the model from the MANAGED ROOT STORE on
 * the NAS (active ref → catalog → journals/staging/unreferenced objects).
 * Non-interactive runs need --yes; dry-run (no --apply) never deletes.
 */
export function buildNasDeleteScript({ name, nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `delete ${shellQuote(name)} --root ${shellQuote(nasRoot)} --apply --yes`);
}

/**
 * Version probe: bare name first (PATH), then the ~/.local/bin fallback.
 * Non-interactive SSH doesn't source rc files, hence the explicit fallback.
 */
export function buildVersionProbeCommand(remoteBin = "modelctl") {
  return [
    `if command -v ${shellQuote(remoteBin)} >/dev/null 2>&1; then`,
    `  ${shellQuote(remoteBin)} --version;`,
    `elif [ -x ~/.local/bin/${shellQuote(remoteBin)} ]; then`,
    `  ~/.local/bin/${shellQuote(remoteBin)} --version;`,
    "else",
    "  echo __MCTL_MISSING__;",
    "fi",
  ].join("\n");
}

/** uv probe (same ladder). */
export function buildUvProbeCommand() {
  return [
    "if command -v uv >/dev/null 2>&1; then",
    "  uv --version;",
    "elif [ -x ~/.local/bin/uv ]; then",
    "  ~/.local/bin/uv --version;",
    "else",
    "  echo __UV_MISSING__;",
    "fi",
  ].join("\n");
}

/**
 * install-modelctl job script (B3): git check → uv installer → uv tool
 * install --force → verify. Exit code lands in the job log via the wrapper.
 */
export function buildInstallModelctlScript({ source, remoteBin = "modelctl" }) {
  return [
    'echo "[install] checking git…"',
    "if ! command -v git >/dev/null 2>&1; then",
    '  echo "ERROR: git is not installed on this node. Install git (e.g. sudo apt install git) and retry." >&2',
    "  exit 3",
    "fi",
    'echo "[install] ensuring uv…"',
    "if ! command -v uv >/dev/null 2>&1 && [ ! -x ~/.local/bin/uv ]; then",
    '  curl -LsSf https://astral.sh/uv/install.sh | sh',
    "fi",
    'UV_BIN="$(command -v uv || echo ~/.local/bin/uv)"',
    `echo "[install] uv tool install --force ${source}"`,
    `"$UV_BIN" tool install --force ${shellQuote(source)}`,
    'echo "[install] verifying…"',
    `if command -v ${shellQuote(remoteBin)} >/dev/null 2>&1; then`,
    `  ${shellQuote(remoteBin)} --version`,
    "elif [ -x ~/.local/bin/" + shellQuote(remoteBin) + " ]; then",
    `  ~/.local/bin/${shellQuote(remoteBin)} --version`,
    "else",
    '  echo "ERROR: modelctl not found after install" >&2',
    "  exit 4",
    "fi",
  ].join("\n");
}

// ─── Parsers (pure) ───────────────────────────────────────

/**
 * Parse `list --json` output. NAS shape: [{name, runtime, repository, bytes}];
 * node shape: [{name, runtime, repository}] (no bytes). Missing fields → null.
 * @param {string} stdout
 * @returns {Array<{name: string|null, runtime: string|null, repository: string|null, bytes: number|null}>}
 */
export function parseModelctlList(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      name: typeof m.name === "string" ? m.name : null,
      runtime: typeof m.runtime === "string" ? m.runtime : null,
      repository: typeof m.repository === "string" ? m.repository : null,
      bytes: Number.isFinite(m.bytes) ? m.bytes : null,
    }));
}

/**
 * Parse version-probe output → { installed, version }.
 * `installed` is the boolean gate; `version` carries the semver-ish string.
 */
export function parseVersionOutput(stdout, missingMarker = "__MCTL_MISSING__") {
  const text = String(stdout || "");
  if (text.includes(missingMarker)) return { installed: false, version: null };
  const m = text.match(/\d+\.\d+\.\d+[^\s]*/);
  if (m) return { installed: true, version: m[0] };
  const first = text.trim().split("\n")[0];
  return { installed: Boolean(first), version: first || null };
}

// ─── Placement decision tree (pure) ───────────────────────

/**
 * planPlacement(model, inventories, opts?) →
 *   { status: "present" | "sync" | "push" | "unavailable",
 *     remediations: [{ kind: "sync", sparkId } | { kind: "push", sparkId, targetSparkId }] }
 *
 * @param {string} model
 * @param {{
 *   target: { sparkId: string, models: Array<{name: string}> },
 *   nas: { models: Array<{name: string}> } | null,
 *   peers: Array<{ sparkId: string, models: Array<{name: string}> }>,
 * }} inventories
 */
export function planPlacement(model, inventories) {
  const target = inventories?.target;
  if (!target) return { status: "unavailable", remediations: [] };
  const has = (list) => Array.isArray(list) && list.some((m) => m?.name === model);
  if (has(target.models)) {
    return { status: "present", remediations: [] };
  }
  if (inventories.nas && has(inventories.nas.models)) {
    return {
      status: "sync",
      remediations: [{ kind: "sync", sparkId: target.sparkId }],
    };
  }
  const peer = (inventories.peers || []).find((p) => p && has(p.models));
  if (peer) {
    return {
      status: "push",
      remediations: [{ kind: "push", sparkId: peer.sparkId, targetSparkId: target.sparkId }],
    };
  }
  return { status: "unavailable", remediations: [] };
}

// ─── Cached executors ─────────────────────────────────────

function _cacheGet(entry, ttl) {
  if (!entry) return null;
  const age = Date.now() - entry.at;
  if (age <= ttl) return { ...entry.value, stale: false };
  if (age <= ttl * STALE_MULTIPLIER) return { ...entry.value, stale: true };
  return null;
}

/**
 * ModelctlService — cached executors over the pure builders.
 * @param {{
 *   exec: (spark: object, cmd: string, opts?: object) => Promise<string>,
 *   getSettings: () => object,
 *   registry: { getSpark(id: string): object | null, sparks: object[] },
 * }} deps
 */
export function createModelctlService({ exec, getSettings, registry }) {
  /** @type {Map<string, {at: number, value: object}>} key → cache entry */
  const nasCache = new Map();
  const nodeCache = new Map();
  const versionCache = new Map();

  /**
   * Default serving/NAS node: settings.modelctl.nasHostSparkId → role head →
   * isLocal → sole spark.
   */
  function defaultNasSpark() {
    const cfg = getSettings()?.modelctl || {};
    if (cfg.nasHostSparkId) {
      const s = registry.getSpark(cfg.nasHostSparkId);
      if (s) return s;
    }
    const sparks = registry.sparks || [];
    return sparks.find((s) => s.role === "head") || sparks.find((s) => s.isLocal) || sparks[0] || null;
  }

  async function checkModelctl(spark, { force = false } = {}) {
    const key = spark.id;
    if (!force) {
      const cached = _cacheGet(versionCache.get(key), VERSION_CACHE_TTL_MS);
      if (cached) return cached;
    }
    const cfg = getSettings()?.modelctl || {};
    const remoteBin = cfg.remoteBin || "modelctl";
    const result = { installed: false, version: null, uv: { installed: false, version: null } };
    try {
      const out = await exec(spark, buildVersionProbeCommand(remoteBin), { timeoutMs: 10_000 });
      if (!out.includes("__MCTL_MISSING__")) {
        const parsed = parseVersionOutput(out);
        result.installed = parsed.installed;
        result.version = parsed.version;
      }
    } catch (err) {
      result.error = err.message;
    }
    try {
      const out = await exec(spark, buildUvProbeCommand(), { timeoutMs: 10_000 });
      if (!out.includes("__UV_MISSING__")) {
        const uvParsed = parseVersionOutput(out, "__UV_MISSING__");
        result.uv.installed = uvParsed.installed;
        result.uv.version = uvParsed.version;
      }
    } catch {
      /* uv optional */
    }
    versionCache.set(key, { at: Date.now(), value: result });
    return { ...result, stale: false };
  }

  /** Invalidate the version cache (after install-modelctl completes). */
  function invalidateCheck(sparkId) {
    versionCache.delete(sparkId);
  }

  async function listNasModels() {
    const cached = _cacheGet(nasCache.get("nas"), NAS_CACHE_TTL_MS);
    if (cached) return cached;
    const cfg = getSettings()?.modelctl || {};
    const spark = defaultNasSpark();
    if (!spark) {
      return { models: [], error: "no spark available for NAS operations" };
    }
    if (!cfg.nasRoot) {
      return { models: [], error: "nasRoot not configured" };
    }
    try {
      const check = await checkModelctl(spark);
      if (!check.installed) {
        return _keepStale(nasCache, "nas", { models: [], error: "modelctl not installed" });
      }
      const out = await exec(spark, buildNasListCommand(cfg.nasRoot, cfg.remoteBin || "modelctl"), { timeoutMs: 30_000 });
      const value = { models: parseModelctlList(out), sparkId: spark.id };
      nasCache.set("nas", { at: Date.now(), value });
      return { ...value, stale: false };
    } catch (err) {
      return _keepStale(nasCache, "nas", { models: [], error: err.message || "node offline" });
    }
  }

  async function listNodeModels(spark) {
    const key = spark.id;
    const cached = _cacheGet(nodeCache.get(key), NODE_CACHE_TTL_MS);
    if (cached) return cached;
    try {
      const check = await checkModelctl(spark);
      if (!check.installed) {
        return _keepStale(nodeCache, key, { models: [], error: "modelctl not installed" });
      }
      const cfg = getSettings()?.modelctl || {};
      const out = await exec(spark, buildNodeListCommand(cfg.remoteBin || "modelctl"), { timeoutMs: 30_000 });
      const value = { models: parseModelctlList(out), sparkId: key };
      nodeCache.set(key, { at: Date.now(), value });
      return { ...value, stale: false };
    } catch (err) {
      return _keepStale(nodeCache, key, { models: [], error: err.message || "node offline" });
    }
  }

  function _keepStale(cache, key, errorValue) {
    // Served value must reflect the error now, but keep last-good around for
    // 5× TTL reads handled by _cacheGet. Simplest: cache the error briefly and
    // also return it; a previously-good entry older than TTL but within 5×
    // TTL was already returned before we got here (cache hit path).
    cache.set(key, { at: Date.now() - 4 * 60_000 * 0, value: errorValue });
    return { ...errorValue, stale: false };
  }

  /** Peers = every other modelctl-enabled spark. */
  function modelctlEnabledSparks() {
    return (registry.sparks || []).filter((s) => s.modelctlEnabled);
  }

  return {
    defaultNasSpark,
    checkModelctl,
    invalidateCheck,
    listNasModels,
    listNodeModels,
    modelctlEnabledSparks,
    _caches: { nasCache, nodeCache, versionCache },
  };
}
