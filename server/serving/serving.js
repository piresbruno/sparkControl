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
 * Execution target = any spark (role-agnostic); default node = head → isLocal
 * → sole spark. Script content transported per run via base64 to
 * ~/.sparkdash/serving/<id>.sh. Supervision over SSH fallback via sshExec:
 * start (setsid nohup + pidfile + env snapshot, log overwritten per run),
 * stop (process-group kill ladder), status (pidfile + startedAt + env), log tail.
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
export function recordPathScript(id, absPath, filePath = PATH_SCRIPTS_PATH) {
  try {
    const map = getPathScripts(filePath);
    map[id] = absPath;
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
  const p = map[id];
  if (typeof p === "string" && p.startsWith("/")) return { kind: "path", path: p };
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

/** Build the script-transport + detached-start command (pure). */
export function buildServeStartCommand({ scriptId, scriptBody, modelName = "", port, extraArgs = "" }) {
  const b64 = Buffer.from(scriptBody, "utf8").toString("base64");
  const id = shellQuote(scriptId);
  return [
    "mkdir -p ~/.sparkdash/runs ~/.sparkdash/serving",
    `printf '%s' ${shellQuote(b64)} | base64 -d > ~/.sparkdash/serving/${id}.sh`,
    `if [ -f ~/.sparkdash/runs/${id}.pid ] && kill -0 "$(cat ~/.sparkdash/runs/${id}.pid)" 2>/dev/null; then echo "__ALREADY_RUNNING__"; exit 9; fi`,
    `setsid nohup env MODEL_NAME=${shellQuote(modelName)} PORT=${shellQuote(String(port))} EXTRA_ARGS=${shellQuote(extraArgs)} bash ~/.sparkdash/serving/${id}.sh > ~/.sparkdash/runs/${id}.log 2>&1 &`,
    `echo $! > ~/.sparkdash/runs/${id}.pid`,
    `date +%s > ~/.sparkdash/runs/${id}.env`,
    `sleep 1; kill -0 "$(cat ~/.sparkdash/runs/${id}.pid)" 2>/dev/null && echo "__START_OK__" || echo "__START_DEAD__"`,
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
    "mkdir -p ~/.sparkdash/runs",
    `[ -f ${quotedPath} ] || { echo "__NO_SCRIPT__"; exit 0; }`,
    `if [ -f ~/.sparkdash/runs/${id}.pid ] && kill -0 "$(cat ~/.sparkdash/runs/${id}.pid)" 2>/dev/null; then echo "__ALREADY_RUNNING__"; exit 9; fi`,
    `setsid nohup env MODEL_NAME=${shellQuote(modelName)} PORT=${shellQuote(String(port))} EXTRA_ARGS=${shellQuote(extraArgs)} bash ${quotedPath} > ~/.sparkdash/runs/${id}.log 2>&1 &`,
    `echo $! > ~/.sparkdash/runs/${id}.pid`,
    `date +%s > ~/.sparkdash/runs/${id}.env`,
    `sleep 1; kill -0 "$(cat ~/.sparkdash/runs/${id}.pid)" 2>/dev/null && echo "__START_OK__" || echo "__START_DEAD__"`,
  ].join("\n");
}

/** Build the stop command: pidfile → kill process group → escalate. */
export function buildServeStopCommand(scriptId) {
  const id = shellQuote(scriptId);
  return [
    `if [ ! -r ~/.sparkdash/runs/${id}.pid ]; then echo "__NOT_RUNNING__"; exit 0; fi`,
    `PGID=$(cat ~/.sparkdash/runs/${id}.pid)`,
    `kill -- -"$PGID" 2>/dev/null || kill "$PGID" 2>/dev/null || true`,
    "sleep 1",
    `kill -0 "$PGID" 2>/dev/null && kill -9 -- -"$PGID" 2>/dev/null || true`,
    `rm -f ~/.sparkdash/runs/${id}.pid`,
    'echo "__STOPPED__"',
  ].join("\n");
}

/** Build the status command: pidfile liveness + startedAt (pidfile mtime). */
export function buildServeStatusCommand(scriptId) {
  const id = shellQuote(scriptId);
  return [
    `if [ -r ~/.sparkdash/runs/${id}.pid ] && kill -0 "$(cat ~/.sparkdash/runs/${id}.pid)" 2>/dev/null; then`,
    `  MTIME=$(stat -c %Y ~/.sparkdash/runs/${id}.pid 2>/dev/null || echo 0)`,
    `  echo "running:$MTIME"`,
    "else",
    '  echo "stopped"',
    "fi",
  ].join("\n");
}

/** Build the log tail command. */
export function buildServeLogCommand(scriptId, bytes = 4000) {
  const n = Math.max(500, Math.min(Math.round(Number(bytes) || 4000), 100_000));
  return `tail -c ${n} ~/.sparkdash/runs/${shellQuote(scriptId)}.log 2>/dev/null || true`;
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
