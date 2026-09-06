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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

export const SERVING_SOURCE_DIR =
  process.env.SPARKDASH_SERVING_SOURCE_DIR || path.join(ROOT, "serving");
export const SERVING_CONFIG_DIR =
  process.env.SPARKDASH_SERVING_CONFIG_DIR || path.join(ROOT, "config", "serving");

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
