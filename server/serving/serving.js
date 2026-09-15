/**
 * Serving scripts (B4) — user-authored bash in config/serving/.
 *
 * Filename (sans .sh) = script id. Metadata header for the UI:
 *   # sparkdash-serve: description=... defaultPort=8080
 *
 * SECURITY (P1): scriptId validation — strict regex + path.resolve
 * containment inside config/serving (traversal ⇒ remote code execution).
 *
 * Env contract (no generated serve commands):
 *   MODEL_NAME   selected model ("" when none)
 *   PORT         user-specified port
 *   EXTRA_ARGS   ONE shellQuote'd string the script expands unquoted
 *
 * Execution target = any spark (role-agnostic); default node = first
 * serve-capable spark (kind "nas" EXCLUDED — plan D2), head → isLocal → sole.
 * Script content transported per run via base64 to
 * ~/.sparkcontrol/serving/<id>.sh. Supervision (SSH/local fallback path) uses
 * ~/.sparkcontrol/runs — the SAME home the node agent supervises (plan P0b /
 * D1 unification); the legacy ~/.sparkdash/runs dir is still probed by
 * start-guard/stop/status/log until pre-upgrade live runs retire (adoptLegacy
 * dual-read — switching the dir alone must never report a live engine stopped).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { shellQuote } from "../util/shellQuote.js";
import { atomicWrite } from "../util/atomicWrite.js";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

export const SERVING_SOURCE_DIR =
  process.env.SPARKDASH_SERVING_SOURCE_DIR || path.join(ROOT, "serving");
export const SERVING_CONFIG_DIR =
  process.env.SPARKDASH_SERVING_CONFIG_DIR || path.join(ROOT, "config", "serving");

/** Persistence for node-local script paths started by path (not library id). */
export const PATH_SCRIPTS_PATH =
  process.env.SPARKDASH_PATH_SCRIPTS_PATH || path.join(ROOT, "config", "serving", "path-scripts.json");

/** Persistence for the port each script-class run started with (unification). */
export const RUN_PORTS_PATH =
  process.env.SPARKDASH_RUN_PORTS_PATH || path.join(ROOT, "config", "serving", "run-ports.json");

/** Strict scriptId: 1–64 chars of [a-z0-9][a-z0-9._-], no leading dot/dash; `..` rejected explicitly. */
const SCRIPT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * Validate a scriptId and resolve it inside the serving config dir.
 * @returns {string} absolute script path
 * @throws {Error} on any violation (caller maps to 400)
 */
export function resolveScriptPath(scriptId, configDir = SERVING_CONFIG_DIR) {
  if (typeof scriptId !== "string" || !SCRIPT_ID_RE.test(scriptId) || scriptId.includes("..")) {
    throw new Error("Invalid script id: allowed a-z0-9._- (max 64), must not contain '..'");
  }
  const base = path.resolve(configDir);
  const resolved = path.resolve(base, `${scriptId}.sh`);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Invalid script id: escapes the serving directory");
  }
  if (!resolved.toLowerCase().endsWith(".sh") || path.dirname(resolved) !== base) {
    throw new Error("Invalid script id");
  }
  return resolved;
}

/**
 * Derive a stable scriptId for a node-local script path: sanitized basename
 * (lowercased, [a-z0-9._-] only, no leading dots/dashes, capped so the whole id
 * stays within SCRIPT_ID_RE's 64-char limit) plus a 6-hex sha1 of the absolute
 * path. Always suffixed, so the id never collides with a library script id, and
 * deterministic across restarts.
 */
export function derivePathScriptId(absPath) {
  const base = path
    .basename(String(absPath || ""))
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[.\-]+/, "")
    .slice(0, 57); // 57 + 1 dash + 6 hash = 64 = SCRIPT_ID_RE ceiling
  const safe = base.replace(/[.\-]+$/, "") || "script";
  const hash = crypto.createHash("sha1").update(String(absPath)).digest("hex").slice(0, 6);
  return `${safe}-${hash}`;
}

/** Read the persisted path-scripts map (path → absolute node path). */
export function getPathScripts(filePath = PATH_SCRIPTS_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Cap on persisted path-script entries (see recordPathScript). */
const PATH_SCRIPTS_KEEP = 32;

/**
 * Persist a path-script mapping. Write failures log and return false — the
 * start still proceeds (the UI keeps the scriptId from the start response).
 * @returns {boolean} persisted
 */
export function recordPathScript(id, absPath, filePath = PATH_SCRIPTS_PATH, port = null, sparkId = null) {
  try {
    const map = getPathScripts(filePath);
    map[id] = port != null || sparkId != null ? { path: absPath, port, sparkId } : absPath;
    // Bound the map: the no-scriptId status probe iterates every key, so an
    // unbounded file would grow SSH round trips per poll forever. JSON objects
    // preserve insertion order, so the oldest entries drop first.
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - PATH_SCRIPTS_KEEP))) delete map[k];
    atomicWrite(filePath, JSON.stringify(map, null, 2) + "\n", 0o644);
    return true;
  } catch (err) {
    console.error("[serving] failed to persist path script:", err.message);
    return false;
  }
}

/**
 * Remember the port a script-class run was started with, keyed by
 * `<sparkId>:<scriptId>` — the Serve section needs per-run ports the pidfile
 * probe cannot know. Bounded like path-scripts (oldest drop first).
 */
export function recordRunPort(sparkId, scriptId, port, filePath = RUN_PORTS_PATH) {
  try {
    const map = getRunPorts(filePath);
    map[`${sparkId}:${scriptId}`] = port;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 64))) delete map[k];
    atomicWrite(filePath, JSON.stringify(map, null, 2) + "\n", 0o644);
    return true;
  } catch (err) {
    console.error("[serving] failed to persist run port:", err.message);
    return false;
  }
}

/** Read the persisted run-port map ("<sparkId>:<scriptId>" → port). */
export function getRunPorts(filePath = RUN_PORTS_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Forget a run's port (after a confirmed stop). */
export function forgetRunPort(sparkId, scriptId, filePath = RUN_PORTS_PATH) {
  try {
    const map = getRunPorts(filePath);
    const key = `${sparkId}:${scriptId}`;
    if (!(key in map)) return false;
    delete map[key];
    atomicWrite(filePath, JSON.stringify(map, null, 2) + "\n", 0o644);
    return true;
  } catch (err) {
    console.error("[serving] failed to drop run port:", err.message);
    return false;
  }
}

export function resolveAnyScriptId(id, configDir = SERVING_CONFIG_DIR, filePath = PATH_SCRIPTS_PATH) {
  // Library first — but only when the script actually exists, so derived
  // path-script ids (which also match SCRIPT_ID_RE) fall through to the map.
  try {
    const libPath = resolveScriptPath(id, configDir);
    if (fs.existsSync(libPath)) return { kind: "library", path: libPath };
  } catch {
    /* not a library id */
  }
  const map = getPathScripts(filePath);
  const rec = map[id];
  const p = typeof rec === "string" ? rec : rec?.path;
  if (typeof p === "string" && p.startsWith("/"))
    return { kind: "path", path: p, port: typeof rec === "object" ? rec.port ?? null : null };
  throw new Error(`Unknown script id: ${id}`);
}

/**
 * Parse the `# sparkdash-serve:` metadata header.
 * @param {string} content
 * @returns {{ description: string, defaultPort: number | null }}
 */
export function parseServingHeader(content) {
  const meta = { description: "", defaultPort: null };
  const m = String(content || "").match(/^#\s*sparkdash-serve:\s*(.+)$/m);
  if (m) {
    const desc = m[1].match(/description=(.+?)(?:\s+\w+=|$)/);
    if (desc) meta.description = desc[1].trim();
    const port = m[1].match(/defaultPort=(\d+)/);
    if (port) {
      const p = parseInt(port[1], 10);
      if (p >= 1 && p <= 65535) meta.defaultPort = p;
    }
  }
  return meta;
}

/** List available serving scripts (id + header metadata). */
export function listServingScripts(configDir = SERVING_CONFIG_DIR) {
  try {
    if (!fs.existsSync(configDir)) return [];
    return fs
      .readdirSync(configDir)
      .filter((f) => f.endsWith(".sh"))
      .map((f) => {
        const id = f.slice(0, -3);
        try {
          if (!SCRIPT_ID_RE.test(id) || id.includes("..")) return null;
          const content = fs.readFileSync(path.join(configDir, f), "utf8");
          const meta = parseServingHeader(content);
          return { id, ...meta };
        } catch {
          return { id, description: "", defaultPort: null };
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/**
 * Copy seeded examples from the repo `serving/` dir into config/serving/
 * on first boot (existing files are never overwritten — user-edited).
 */
export function seedServingScripts(configDir = SERVING_CONFIG_DIR, sourceDir = SERVING_SOURCE_DIR) {
  try {
    if (!fs.existsSync(sourceDir)) return;
    fs.mkdirSync(configDir, { recursive: true });
    for (const f of fs.readdirSync(sourceDir)) {
      if (!f.endsWith(".sh")) continue;
      const dest = path.join(configDir, f);
      if (fs.existsSync(dest)) continue;
      fs.copyFileSync(path.join(sourceDir, f), dest);
      console.log(`[serving] seeded ${f}`);
    }
  } catch (err) {
    console.error("[serving] seeding failed:", err.message);
  }
}

// ─── Remote supervision command builders (pure) ───────────

/** Unified supervision home — identical to the agent's (agent/src/main.js). */
export const SERVE_RUNS_DIR = "~/.sparkcontrol/runs";
export const SERVE_SCRIPT_DIR = "~/.sparkcontrol/serving";
/** Pre-unification runs dir — dual-probed (never written again) so live
 * legacy runs keep working across the upgrade (plan P0b adoptLegacy). */
export const LEGACY_SERVE_RUNS_DIRS = ["~/.sparkdash/runs"];

/** All candidate runs dirs, newest home first. */
function runsDirs() {
  return [SERVE_RUNS_DIR, ...LEGACY_SERVE_RUNS_DIRS];
}

/** Shell guard: alive pidfile in ANY candidate dir → already running. */
function alreadyRunningGuard(id) {
  return [
    `for __D in ${runsDirs().join(" ")}; do`,
    `  if [ -f "$__D/${id}.pid" ] && kill -0 "$(cat "$__D/${id}.pid")" 2>/dev/null; then echo "__ALREADY_RUNNING__"; exit 9; fi`,
    "done",
  ].join("\n");
}

/** Build the script-transport + detached-start command (pure). */
export function buildServeStartCommand({ scriptId, scriptBody, modelName = "", port, extraArgs = "" }) {
  const b64 = Buffer.from(scriptBody, "utf8").toString("base64");
  const id = shellQuote(scriptId);
  return [
    `mkdir -p ${SERVE_RUNS_DIR} ${SERVE_SCRIPT_DIR}`,
    `printf '%s' ${shellQuote(b64)} | base64 -d > ${SERVE_SCRIPT_DIR}/${id}.sh`,
    alreadyRunningGuard(id),
    `setsid nohup env MODEL_NAME=${shellQuote(modelName)} PORT=${shellQuote(String(port))} EXTRA_ARGS=${shellQuote(extraArgs)} bash ${SERVE_SCRIPT_DIR}/${id}.sh > ${SERVE_RUNS_DIR}/${id}.log 2>&1 &`,
    `echo $! > ${SERVE_RUNS_DIR}/${id}.pid`,
    `sleep 1; kill -0 "$(cat ${SERVE_RUNS_DIR}/${id}.pid)" 2>/dev/null && echo "__START_OK__" || echo "__START_DEAD__"`,
  ].join("\n");
}

/**
 * Build the detached-start command for a node-local script path: identical
 * to buildServeStartCommand except the base64-upload line is replaced by an
 * on-node existence check and the engine runs via `bash <path>`.
 */
export function buildServeStartPathCommand({ scriptId, scriptPath, modelName = "", port, extraArgs = "" }) {
  const id = shellQuote(scriptId);
  const quotedPath = shellQuote(scriptPath);
  return [
    `mkdir -p ${SERVE_RUNS_DIR}`,
    `[ -f ${quotedPath} ] || { echo "__NO_SCRIPT__"; exit 0; }`,
    alreadyRunningGuard(id),
    `setsid nohup env MODEL_NAME=${shellQuote(modelName)} PORT=${shellQuote(String(port))} EXTRA_ARGS=${shellQuote(extraArgs)} bash ${quotedPath} > ${SERVE_RUNS_DIR}/${id}.log 2>&1 &`,
    `echo $! > ${SERVE_RUNS_DIR}/${id}.pid`,
    `sleep 1; kill -0 "$(cat ${SERVE_RUNS_DIR}/${id}.pid)" 2>/dev/null && echo "__START_OK__" || echo "__START_DEAD__"`,
  ].join("\n");
}

/** Build the stop command: pidfile (any candidate dir) → process-group kill → escalate. */
export function buildServeStopCommand(scriptId) {
  const id = shellQuote(scriptId);
  const allPids = runsDirs().map((d) => `${d}/${id}.pid`).join(" ");
  return [
    '__PF=""',
    `for __D in ${runsDirs().join(" ")}; do`,
    `  if [ -z "$__PF" ] && [ -r "$__D/${id}.pid" ] && kill -0 "$(cat "$__D/${id}.pid")" 2>/dev/null; then __PF="$__D/${id}.pid"; fi`,
    "done",
    `if [ -z "$__PF" ]; then rm -f ${allPids}; echo "__NOT_RUNNING__"; exit 0; fi`,
    'PGID=$(cat "$__PF")',
    `kill -- -"$PGID" 2>/dev/null || kill "$PGID" 2>/dev/null || true`,
    "sleep 1",
    `kill -0 "$PGID" 2>/dev/null && kill -9 -- -"$PGID" 2>/dev/null || true`,
    `rm -f ${allPids}`,
    'echo "__STOPPED__"',
  ].join("\n");
}

/** Build the status command: pidfile liveness (any candidate dir) + startedAt (mtime). */
export function buildServeStatusCommand(scriptId) {
  const id = shellQuote(scriptId);
  return [
    '__FOUND=""',
    `for __D in ${runsDirs().join(" ")}; do`,
    `  if [ -r "$__D/${id}.pid" ] && kill -0 "$(cat "$__D/${id}.pid")" 2>/dev/null; then`,
    `    MTIME=$(stat -c %Y "$__D/${id}.pid" 2>/dev/null || echo 0)`,
    '    echo "running:$MTIME"; __FOUND=1',
    "  fi",
    "done",
    '[ -n "$__FOUND" ] || echo "stopped"',
  ].join("\n");
}

/**
 * Multi-probe: one exec answers the status of EVERY script id (kills the old
 * N+1 serial discovery loop — plan P0b). Ids must already be validated
 * (SCRIPT_ID_RE); unvalidated input throws.
 */
export function buildServeStatusAllCommand(scriptIds) {
  const ids = [];
  for (const id of scriptIds || []) {
    if (typeof id !== "string" || !SCRIPT_ID_RE.test(id) || id.includes("..")) {
      throw new Error(`Invalid script id: ${id}`);
    }
    ids.push(shellQuote(id));
  }
  if (ids.length === 0) return 'echo ""';
  return [
    `for __S in ${ids.join(" ")}; do`,
    '  __ST="stopped"',
    `  for __D in ${runsDirs().join(" ")}; do`,
    '    if [ -r "$__D/$__S.pid" ] && kill -0 "$(cat "$__D/$__S.pid")" 2>/dev/null; then',
    '      __ST="running:$(stat -c %Y "$__D/$__S.pid" 2>/dev/null || echo 0)"',
    "    fi",
    "  done",
    '  echo "$__S $__ST"',
    "done",
  ].join("\n");
}

/**
 * Parse buildServeStatusAllCommand output → [{ scriptId, running, startedAt }].
 * Unparseable lines are skipped (a node returning garbage yields [], never a
 * false "stopped" storm — callers treat [] + explicit ids as unknown).
 */
export function parseServeStatusAllOutput(out) {
  const rows = [];
  for (const line of String(out ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^([a-zA-Z0-9._-]+) (running|stopped)(?::(\d+))?$/);
    if (!m) continue;
    rows.push({
      scriptId: m[1],
      running: m[2] === "running",
      startedAt: m[3] ? parseInt(m[3], 10) * 1000 : null,
    });
  }
  return rows;
}

/** Build the log tail command (dual-dir: a pre-unification run keeps tailing). */
export function buildServeLogCommand(scriptId, bytes = 4000) {
  const n = Math.max(500, Math.min(Math.round(Number(bytes) || 4000), 100_000));
  const id = shellQuote(scriptId);
  const paths = runsDirs().map((d) => `${d}/${id}.log`);
  const first = paths.shift();
  const fallback = paths.length ? ` || tail -c ${n} ${paths.join(" 2>/dev/null || tail -c " + n)} 2>/dev/null` : "";
  return `tail -c ${n} ${first} 2>/dev/null${fallback} || true`;
}

/** Parse start output → { started: boolean, alreadyRunning: boolean, error?: string } */
export function parseServeStartOutput(out) {
  const text = String(out || "");
  if (text.includes("__ALREADY_RUNNING__")) return { started: false, alreadyRunning: true };
  if (text.includes("__NO_SCRIPT__"))
    return { started: false, alreadyRunning: false, error: "script not found on node — check the path" };
  if (text.includes("__START_DEAD__")) return { started: false, alreadyRunning: false, error: "process exited immediately (see log)" };
  if (text.includes("__START_OK__")) return { started: true, alreadyRunning: false };
  return { started: false, alreadyRunning: false, error: text.trim() || "unknown start failure" };
}

/** Parse status output → { running: boolean | "unknown", startedAt: number | null, error?: string } */
export function parseServeStatusOutput(out) {
  const text = String(out || "").trim();
  const m = text.match(/running:(\d+)/);
  if (m) return { running: true, startedAt: parseInt(m[1], 10) * 1000 };
  if (text === "stopped") return { running: false, startedAt: null };
  return { running: "unknown", startedAt: null, error: text || "node offline" };
}
