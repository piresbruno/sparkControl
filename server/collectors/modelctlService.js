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
/** GitHub latest-release probe cache (Contract: 15 min, failures tolerated). */
export const RELEASE_CACHE_TTL_MS = 15 * 60_000;
/** Doctor / catalog / per-model detail caches — same 60 s window as the NAS list. */
export const DOCTOR_CACHE_TTL_MS = 60_000;
export const CATALOG_CACHE_TTL_MS = 60_000;
export const DETAIL_CACHE_TTL_MS = 60_000;
const STALE_MULTIPLIER = 5;

const MODELCTL_RELEASE_URL =
  "https://api.github.com/repos/piresbruno/modelctl/releases/latest";
const RELEASE_FETCH_TIMEOUT_MS = 8_000;

/** Model names validated here too (defense in depth; REST re-validates). */
// Leading '-' is rejected: shellQuote passes hyphenated names unquoted, so
// "-apply"/"-v" would become modelctl *flags* (option injection on a
// destructive command). Real store names never start with a dash.
const MODEL_NAME_RE = /^(?!-)[a-zA-Z0-9._-]+$/;

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

// ─── NAS-host job kinds (builders, pure) ───────────────────

/** `modelctl catalog refresh --root <nasRoot>` (job script body). */
export function buildCatalogRefreshScript({ nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `catalog refresh --root ${shellQuote(nasRoot)}`);
}

/** `modelctl repair-active [NAME] --root <nasRoot> --apply` (job script body; NAME optional = all). */
export function buildRepairActiveScript({ model, nasRoot, remoteBin = "modelctl" }) {
  const target = model ? `${shellQuote(model)} ` : "";
  return mctl(remoteBin, `repair-active ${target}--root ${shellQuote(nasRoot)} --apply`);
}

/** `modelctl cleanup-quarantine NAME --root <nasRoot> --apply` (job script body). */
export function buildCleanupQuarantineScript({ model, nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `cleanup-quarantine ${shellQuote(model)} --root ${shellQuote(nasRoot)} --apply`);
}

/** `modelctl sync-cards [NAME] --root <nasRoot>` (job script body; NAME optional = all). */
export function buildSyncCardsScript({ model, nasRoot, remoteBin = "modelctl" }) {
  const target = model ? `${shellQuote(model)} ` : "";
  return mctl(remoteBin, `sync-cards ${target}--root ${shellQuote(nasRoot)}`);
}

/** `modelctl update NAME --root <nasRoot>` (job script body — re-resolves revision, atomic swap). */
export function buildUpdateScript({ model, nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `update ${shellQuote(model)} --root ${shellQuote(nasRoot)}`);
}

/**
 * Queue job body: the validated downloads.yaml is embedded in base64 and
 * decoded to a per-run temp file `/tmp/modelctl-queue-$$.yaml` (`$$` = the
 * job shell's PID — unique per run, never collides, no argv hazards).
 * Then `modelctl queue <file> --jobs N --root R`; the modelctl exit code is
 * preserved for the job wrapper and the temp file is removed afterwards.
 */
export function buildQueueScript({ entries, jobs = 1, nasRoot, remoteBin = "modelctl" }) {
  const yaml = buildQueueYaml(entries);
  const b64 = Buffer.from(yaml, "utf8").toString("base64");
  const q = buildQueueCommand({ jobs, nasRoot, remoteBin });
  return [
    'f="/tmp/modelctl-queue-$$.yaml"',
    `printf '%s' ${shellQuote(b64)} | base64 -d > "$f"`,
    q,
    "code=$?",
    'rm -f "$f"',
    // `(exit $code)` — NOT `exit $code`: the job wrapper's
    // __SPARKDASH_EXIT trailer must stay reachable, so the body's final
    // command has to *be* the preserved exit code without quitting the shell.
    "(exit $code)",
  ].join("\n");
}

/**
 * The `modelctl queue "$f" --jobs N --root R` invocation. Runs inside
 * buildQueueScript's shell, where `$f` holds the temp YAML path (unquoted `$f`
 * is intentional: the path is server-built from safe characters).
 */
export function buildQueueCommand({ jobs = 1, nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `queue "$f" --jobs ${jobs} --root ${shellQuote(nasRoot)}`);
}

/**
 * Build the downloads.yaml from server-validated entries (never accept raw
 * YAML from clients). Every value is a JSON.stringify double-quoted scalar —
 * valid YAML quoting that neutralizes newlines/colons/injection.
 */
export function buildQueueYaml(entries) {
  const lines = ["downloads:"];
  for (const e of entries) {
    lines.push(`  - source: ${JSON.stringify(e.source)}`);
    if (e.name != null && e.name !== "") lines.push(`    name: ${JSON.stringify(e.name)}`);
    if (e.revision != null && e.revision !== "") lines.push(`    revision: ${JSON.stringify(e.revision)}`);
    if (e.quantization != null && e.quantization !== "") lines.push(`    quantization: ${JSON.stringify(e.quantization)}`);
    if (e.runtime != null && e.runtime !== "") lines.push(`    runtime: ${JSON.stringify(e.runtime)}`);
    if (e.mmproj != null && e.mmproj !== "") lines.push(`    mmproj: ${JSON.stringify(e.mmproj)}`);
    if (e.mtp != null && e.mtp !== "") lines.push(`    mtp: ${JSON.stringify(e.mtp)}`);
    if (e.force === true) lines.push("    force: true");
  }
  return lines.join("\n") + "\n";
}

// ─── Queue-entry validation (pure; REST layer maps errors → 400) ──

const QUEUE_ENTRY_KEYS = new Set([
  "source", "name", "revision", "quantization", "runtime", "mmproj", "mtp", "force",
]);
const QUEUE_RUNTIMES = new Set(["auto", "vllm", "llama.cpp"]);

/**
 * Validate queue entries + jobs. Returns { error } (precise message) or
 * { entries: [...cleaned], jobs }.
 * @param {unknown} rawEntries
 * @param {unknown} rawJobs
 */
export function validateQueueRequest(rawEntries, rawJobs) {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    return { error: "entries must be a non-empty array" };
  }
  if (rawEntries.length > 100) {
    return { error: "entries max 100" };
  }
  const jobs = rawJobs == null ? 1 : Number(rawJobs);
  if (![1, 2, 4].includes(jobs)) {
    return { error: "jobs must be 1, 2 or 4" };
  }
  const entries = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const e = rawEntries[i];
    const at = `entries[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      return { error: `${at} must be an object` };
    }
    for (const k of Object.keys(e)) {
      if (!QUEUE_ENTRY_KEYS.has(k)) return { error: `${at}.${k} is not a valid field` };
    }
    if (typeof e.source !== "string" || !e.source.trim() || e.source.length > 200) {
      return { error: `${at}.source is required (owner/model or URL, max 200 chars)` };
    }
    // YAML double-quoted scalars must stay single-line (JSON.stringify would
    // otherwise embed a \n escape the store CLI resolves into the repo name).
    if (/[\r\n]/.test(e.source)) {
      return { error: `${at}.source must be a single line` };
    }
    if (e.name != null && e.name !== "") {
      if (typeof e.name !== "string" || e.name.length > 120 || !validModelName(e.name)) {
        return { error: `${at}.name is invalid (max 120 chars, allowed: letters digits . _ -)` };
      }
    }
    for (const [key, max] of [["revision", 100], ["quantization", 100], ["mmproj", 200], ["mtp", 200]]) {
      const v = e[key];
      if (v != null && v !== "") {
        if (typeof v !== "string" || v.length > max) {
          return { error: `${at}.${key} must be a string (max ${max} chars)` };
        }
      }
    }
    if (e.runtime != null && e.runtime !== "") {
      if (!QUEUE_RUNTIMES.has(e.runtime)) {
        return { error: `${at}.runtime must be one of auto, vllm, llama.cpp` };
      }
    }
    if (e.force != null && typeof e.force !== "boolean") {
      return { error: `${at}.force must be a boolean` };
    }
    entries.push(e);
  }
  return { entries, jobs };
}

// ─── Read-endpoint commands (short-timeout execs) ──────────

/** `modelctl doctor --root <nasRoot> --json`. */
export function buildDoctorCommand({ nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `doctor --root ${shellQuote(nasRoot)} --json`);
}

/** Read the raw catalog.json (fast; no modelctl round-trip). */
export function buildCatalogReadCommand(nasRoot) {
  return `cat ${shellQuote(nasRoot)}/catalog.json 2>/dev/null`;
}

/** `modelctl path NAME --root <nasRoot>`. */
export function buildModelPathCommand({ model, nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `path ${shellQuote(model)} --root ${shellQuote(nasRoot)}`);
}

/** `modelctl serve-command NAME --root <nasRoot>` (prints, never executes). */
export function buildServeCommandProbe({ model, nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `serve-command ${shellQuote(model)} --root ${shellQuote(nasRoot)}`);
}

/** RUN.md excerpt (missing card tolerated via `|| true`). */
export function buildRunMdHeadCommand({ model, nasRoot }) {
  const card = shellQuote(`${String(nasRoot).replace(/\/+$/, "")}/cards/${model}/RUN.md`);
  return `head -c 20000 ${card} 2>/dev/null || true`;
}

/** `modelctl delete NAME --root <nasRoot>` — DRY-RUN (no --apply/--yes): prints the plan. */
export function buildNasDeletePlanCommand({ model, nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `delete ${shellQuote(model)} --root ${shellQuote(nasRoot)}`);
}

/** `modelctl staging-audit --root <nasRoot>` (read-only classification). */
export function buildStagingAuditCommand({ nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `staging-audit --root ${shellQuote(nasRoot)}`);
}

/** `modelctl objects-audit --root <nasRoot>` (read-only classification). */
export function buildObjectsAuditCommand({ nasRoot, remoteBin = "modelctl" }) {
  return mctl(remoteBin, `objects-audit --root ${shellQuote(nasRoot)}`);
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

/**
 * Parse `modelctl doctor --json` stdout → { report, error? }.
 *
 * modelctl emits a top-level ARRAY of audit items (`json.dumps([item.to_dict()
 * for item in audit_active_references(root)])`), each `{name,status,reference,
 * object,detail}`. Tolerates leading warning lines by slicing the outermost
 * JSON container: prefer the `[`…`]` array (canonical), fall back to `{`…`}`
 * (a future object-wrapped shape). Unparsable → { report: { raw: text } }.
 */
export function parseDoctorJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { report: null, error: "empty doctor output" };
  // 1. Whole text is usually pure JSON (the print() is the last thing modelctl
  //    writes). Accept an array OR object here so inner brackets never confuse
  //    a slice.
  try {
    const whole = JSON.parse(text);
    if (Array.isArray(whole) || (whole && typeof whole === "object")) return { report: whole };
  } catch {
    /* fall through to tolerant slice */
  }
  // 2. Leading warning lines: pick the OUTERMOST container by whichever opener
  //    ([ or {) appears first, then slice to its matching last closer. modelctl's
  //    canonical output is an ARRAY; an object wrapper is accepted too.
  const bStart = text.indexOf("[");
  const oStart = text.indexOf("{");
  const useArray = bStart >= 0 && (oStart < 0 || bStart <= oStart);
  const start = useArray ? bStart : oStart;
  const end = useArray ? text.lastIndexOf("]") : text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const val = JSON.parse(text.slice(start, end + 1));
      if (useArray ? Array.isArray(val) : val && typeof val === "object" && !Array.isArray(val)) {
        return { report: val };
      }
    } catch {
      /* fall through to raw */
    }
  }
  return { report: { raw: text } };
}

/**
 * Parse R/catalog.json → NasCatalogResponse shape:
 * { schema, generation, generatedAt, count, models } (models normalized via
 * parseModelctlList; unknown extra keys dropped). Missing/invalid text →
 * { error } (callers tolerate; contract: "parse error tolerated").
 */
export function parseNasCatalog(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return { error: "catalog.json not found" };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "catalog.json parse failed" };
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { error: "catalog.json parse failed" };
  }
  if (!obj || typeof obj !== "object") return { error: "catalog.json parse failed" };
  const models = Array.isArray(obj.models) ? obj.models.map((m) => ({
    name: typeof m?.name === "string" ? m.name : null,
    runtime: typeof m?.runtime === "string" ? m.runtime : null,
    repository: typeof m?.repository === "string" ? m.repository : null,
    bytes: Number.isFinite(m?.bytes) ? m.bytes : null,
  })) : [];
  return {
    schema: Number.isFinite(obj.schema) ? obj.schema : undefined,
    generation: Number.isFinite(obj.generation) ? obj.generation : undefined,
    generatedAt: typeof obj.generated_at === "string" || typeof obj.generated_at === "number" ? obj.generated_at : null,
    count: models.length,
    models,
  };
}

/**
 * Parse the GitHub latest-release payload → { latest, publishedAt }.
 * Tolerates malformed payloads (latest null). tag_name "v0.18.0" kept verbatim.
 */
export function parseReleasePayload(data) {
  const latest = typeof data?.tag_name === "string" && data.tag_name ? data.tag_name : null;
  const publishedAt = typeof data?.published_at === "string" ? data.published_at : null;
  return { latest, publishedAt };
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
export function createModelctlService({ exec, getSettings, registry, fetch: fetchImpl = globalThis.fetch }) {
  /** @type {Map<string, {at: number, value: object}>} key → cache entry */
  const nasCache = new Map();
  const nodeCache = new Map();
  const versionCache = new Map();
  const doctorCache = new Map();
  const catalogCache = new Map();
  const detailCache = new Map();
  let releaseCacheEntry = null;

  /** Per-node store root: spark.nasRoot || global settings.modelctl.nasRoot. */
  function nasRootFor(spark) {
    const sparkRoot = typeof spark?.nasRoot === "string" ? spark.nasRoot.trim() : "";
    if (sparkRoot) return sparkRoot;
    const cfgRoot = getSettings()?.modelctl?.nasRoot;
    return typeof cfgRoot === "string" ? cfgRoot : "";
  }

  /**
   * Default NAS node: a kind "nas" spark wins over everything else (it exists
   * to manage the store); then settings.modelctl.nasHostSparkId → role head →
   * isLocal → sole spark (unchanged legacy chain).
   */
  function defaultNasSpark() {
    const sparks = registry.sparks || [];
    const nasKind = sparks.find((s) => s.kind === "nas");
    if (nasKind) return nasKind;
    const cfg = getSettings()?.modelctl || {};
    if (cfg.nasHostSparkId) {
      const s = registry.getSpark(cfg.nasHostSparkId);
      if (s) return s;
    }
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

  async function listNasModels({ force = false } = {}) {
    if (!force) {
      const cached = _cacheGet(nasCache.get("nas"), NAS_CACHE_TTL_MS);
      if (cached) return cached;
    }
    const cfg = getSettings()?.modelctl || {};
    const spark = defaultNasSpark();
    if (!spark) {
      return { models: [], error: "no spark available for NAS operations" };
    }
    const nasRoot = nasRootFor(spark);
    if (!nasRoot) {
      return { models: [], error: "nasRoot not configured" };
    }
    try {
      const check = await checkModelctl(spark);
      if (!check.installed) {
        return _keepStale(nasCache, "nas", { models: [], error: "modelctl not installed" });
      }
      const out = await exec(spark, buildNasListCommand(nasRoot, cfg.remoteBin || "modelctl"), { timeoutMs: 30_000 });
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

  /** Resolve the NAS spark + its root, or an error payload for the caller. */
  function _nasTarget() {
    const spark = defaultNasSpark();
    if (!spark) return { error: "no spark available for NAS operations" };
    const nasRoot = nasRootFor(spark);
    if (!nasRoot) return { error: "nasRoot not configured" };
    const cfg = getSettings()?.modelctl || {};
    return { spark, nasRoot, remoteBin: cfg.remoteBin || "modelctl" };
  }

  /**
   * `modelctl doctor --root R --json` on the NAS spark. Cached 60 s; last-good
   * served stale for 5× TTL. exec/parse errors keep the previous report stale
   * rather than blanking the card. force=1 busts the cache.
   */
  async function runNasDoctor({ force = false } = {}) {
    if (!force) {
      const cached = _cacheGet(doctorCache.get("doctor"), DOCTOR_CACHE_TTL_MS);
      if (cached) return cached;
    }
    const t = _nasTarget();
    if (t.error) return { report: null, checkedAt: Date.now(), stale: false, error: t.error };
    try {
      const out = await exec(t.spark, buildDoctorCommand({ nasRoot: t.nasRoot, remoteBin: t.remoteBin }), { timeoutMs: 30_000 });
      if (String(out || "").includes("__MCTL_MISSING__")) {
        return _keepStale(doctorCache, "doctor", { report: null, checkedAt: Date.now(), error: "modelctl not installed" });
      }
      const { report, error } = parseDoctorJson(out);
      const value = { report, checkedAt: Date.now(), ...(error ? { error } : {}) };
      doctorCache.set("doctor", { at: Date.now(), value });
      return { ...value, stale: false };
    } catch (err) {
      return _keepStale(doctorCache, "doctor", { report: null, checkedAt: Date.now(), error: err.message || "node offline" });
    }
  }

  /**
   * Read R/catalog.json directly (fast; no modelctl round-trip). Parse/absence
   * errors tolerated → { error } (the store may predate the catalog feature).
   */
  async function fetchNasCatalog({ force = false } = {}) {
    if (!force) {
      const cached = _cacheGet(catalogCache.get("catalog"), CATALOG_CACHE_TTL_MS);
      if (cached) return cached;
    }
    const t = _nasTarget();
    if (t.error) return { checkedAt: Date.now(), stale: false, error: t.error };
    try {
      const out = await exec(t.spark, buildCatalogReadCommand(t.nasRoot), { timeoutMs: 10_000 });
      const parsed = parseNasCatalog(out);
      const value = { ...parsed, checkedAt: Date.now() };
      // Cache only good reads; an absent catalog re-probes next poll.
      if (!parsed.error) catalogCache.set("catalog", { at: Date.now(), value });
      return { ...value, stale: false };
    } catch (err) {
      return { checkedAt: Date.now(), stale: false, error: err.message || "node offline" };
    }
  }

  /**
   * path + serve-command + RUN.md excerpt for one active model. Three short
   * execs; each failure is tolerated individually (missing model → all null +
   * error only when nothing resolved). Cached per model for 60 s.
   */
  async function fetchNasModelDetail(model, { force = false } = {}) {
    const key = model;
    if (!force) {
      const cached = _cacheGet(detailCache.get(key), DETAIL_CACHE_TTL_MS);
      if (cached) return cached;
    }
    const t = _nasTarget();
    if (t.error) return { path: null, serveCommand: null, runMd: null, stale: false, error: t.error };
    const args = { model, nasRoot: t.nasRoot, remoteBin: t.remoteBin };
    let path = null;
    let serveCommand = null;
    let runMd = null;
    let firstError = null;
    const attempt = async (fn, label) => {
      try {
        return await exec(t.spark, fn(args), { timeoutMs: 15_000 });
      } catch (err) {
        firstError ||= `${label}: ${err.message || "exec failed"}`;
        return null;
      }
    };
    const pathOut = await attempt(buildModelPathCommand, "path");
    if (pathOut && !pathOut.includes("__MCTL_MISSING__")) path = pathOut.trim() || null;
    const serveOut = await attempt(buildServeCommandProbe, "serve-command");
    if (serveOut && !serveOut.includes("__MCTL_MISSING__")) serveCommand = serveOut.trim() || null;
    const runOut = await attempt(buildRunMdHeadCommand, "RUN.md");
    if (runOut && runOut.trim()) runMd = runOut;
    if (path === null && serveCommand === null && runMd === null) {
      const value = { path: null, serveCommand: null, runMd: null, error: firstError || "model not found in store" };
      return { ...value, stale: false };
    }
    const value = { path, serveCommand, runMd, ...(firstError ? { error: firstError } : {}) };
    detailCache.set(key, { at: Date.now(), value });
    return { ...value, stale: false };
  }

  /**
   * Dry-run delete plan (stdout of `modelctl delete NAME --root R`). Never
   * cached — the operator is about to act on it, so it must be live.
   */
  async function fetchNasDeletePlan(model) {
    const t = _nasTarget();
    if (t.error) return { plan: "", error: t.error };
    try {
      const out = await exec(
        t.spark,
        buildNasDeletePlanCommand({ model, nasRoot: t.nasRoot, remoteBin: t.remoteBin }),
        { timeoutMs: 30_000 }
      );
      if (String(out || "").includes("__MCTL_MISSING__")) {
        return { plan: "", error: "modelctl not installed" };
      }
      return { plan: String(out || "") };
    } catch (err) {
      return { plan: "", error: err.message || "node offline" };
    }
  }

  /**
   * GitHub latest-release probe (modelctl CLI). Time-based cache 15 min;
   * failures are cached too (avoid hammering) and NEVER throw: the shape is
   * always { latest, publishedAt, checkedAt, error? }.
   */
  async function checkRelease({ force = false } = {}) {
    if (!force && releaseCacheEntry && Date.now() - releaseCacheEntry.at <= RELEASE_CACHE_TTL_MS) {
      return releaseCacheEntry.value;
    }
    let value;
    try {
      const res = await fetchImpl(MODELCTL_RELEASE_URL, {
        signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
        headers: { accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub release probe failed: HTTP ${res.status}`);
      const data = await res.json();
      const { latest, publishedAt } = parseReleasePayload(data);
      value = { latest, publishedAt, checkedAt: Date.now() };
    } catch (err) {
      value = { latest: null, publishedAt: null, checkedAt: Date.now(), error: err.message || "release probe failed" };
    }
    releaseCacheEntry = { at: Date.now(), value };
    return value;
  }

  /**
   * Bust the NAS-store read caches after a terminal job that could have
   * changed the store. doctor=true additionally busts the version/doctor
   * caches (modelctl itself changed — update / sync-cards).
   */
  function invalidateNasCaches({ doctor = false } = {}) {
    nasCache.delete("nas");
    catalogCache.delete("catalog");
    for (const k of [...detailCache.keys()]) detailCache.delete(k);
    if (doctor) doctorCache.clear();
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
    nasRootFor,
    defaultNasSpark,
    checkModelctl,
    invalidateCheck,
    invalidateNasCaches,
    listNasModels,
    listNodeModels,
    runNasDoctor,
    fetchNasCatalog,
    fetchNasModelDetail,
    fetchNasDeletePlan,
    checkRelease,
    modelctlEnabledSparks,
    _caches: { nasCache, nodeCache, versionCache, doctorCache, catalogCache, detailCache },
  };
}
