import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { atomicWrite } from "./util/atomicWrite.js";
import { getAppSecret, setAppSecret } from "./secretsStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SETTINGS_PATH =
  process.env.SETTINGS_JSON_PATH || path.join(ROOT, "config", "settings.json");

const DEFAULTS = Object.freeze({
  pollIntervalMs: 2000,
  defaultLlmPort: 8888,
  autoHideOffline: false,
  temperatureUnit: "celsius",
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: false,
  /** Layout density — compact (default) or comfortable. */
  density: "compact",
  /** Analysis section: reverse-proxy trace capture (A2/A3). */
  traceCapture: true,
  /** Analysis section: store request/response bodies (subject to size caps). */
  traceCaptureBodies: true,
  /** Analysis section: optional exact-origin CORS allowlist for /llm proxy. */
  traceProxyAllowedOrigins: [],
  /** modelctl integration (B1). */
  modelctl: Object.freeze({
    nasRoot: "/mnt/nas/llm-models",
    nasHostSparkId: null,
    remoteBin: "modelctl",
    source: "git+https://github.com/piresbruno/modelctl",
  }),
  /**
   * The agent token itself lives encrypted in secretsStore (never plaintext
   * here). `tokenConfigured` is derived at runtime; rotation happens only via
   * POST /api/agent/token/rotate (C3/C4).
   */
  agent: Object.freeze({ tokenConfigured: false }),
});

/** Agent token secret name in the secretsStore appSecrets bucket. */
export const AGENT_TOKEN_SECRET = "agentToken";

const MODELCTL_KEYS = ["nasRoot", "nasHostSparkId", "remoteBin", "source"];

function _isValidToken(t) {
  return typeof t === "string" && /^[0-9a-f]{64}$/.test(t);
}

/**
 * Ensure an agent token exists (64-hex), encrypted in secretsStore.
 * Auto-generated on first boot; rotation happens only via the dedicated route.
 * @returns {string | null} the token, or null when the secrets store is
 *   unwritable (Settings dialog surfaces "unavailable").
 */
export function ensureAgentToken() {
  const existing = getAppSecret(AGENT_TOKEN_SECRET);
  if (existing && _isValidToken(existing)) return existing;
  const token = crypto.randomBytes(32).toString("hex");
  setAppSecret(AGENT_TOKEN_SECRET, token);
  return token;
}

/** Replace the agent token (rotation). @returns {string} new 64-hex token */
export function rotateAgentToken() {
  const token = crypto.randomBytes(32).toString("hex");
  setAppSecret(AGENT_TOKEN_SECRET, token);
  return token;
}

/** @type {typeof DEFAULTS} */
let _settings = { ...DEFAULTS };

/** Runtime agent-token presence (set by ensure/rotate on boot or rotation). */
let _agentTokenConfigured = false;

/** Flip the derived `agent.tokenConfigured` flag after ensure/rotate. */
export function markAgentTokenConfigured() {
  _agentTokenConfigured = true;
}

function _clampSettings(settings) {
  const s = { ...settings };
  // Clamp poll interval to 1000ms minimum
  if (typeof s.pollIntervalMs !== "number" || s.pollIntervalMs < 1000) {
    s.pollIntervalMs = 1000;
  }
  // Clamp LLM port to 1–65535
  if (typeof s.defaultLlmPort !== "number" || s.defaultLlmPort < 1 || s.defaultLlmPort > 65535) {
    s.defaultLlmPort = DEFAULTS.defaultLlmPort;
  }
  // Ensure autoHideOffline is boolean
  s.autoHideOffline = Boolean(s.autoHideOffline);
  // Ensure benchDebugTraces is boolean
  s.benchDebugTraces = Boolean(s.benchDebugTraces);
  // Ensure temperatureUnit is valid
  if (s.temperatureUnit !== "celsius" && s.temperatureUnit !== "fahrenheit") {
    s.temperatureUnit = DEFAULTS.temperatureUnit;
  }
  // Ensure density is valid
  if (s.density !== "comfortable" && s.density !== "compact") {
    s.density = DEFAULTS.density;
  }
  // Analysis (A4): boolean clamps + origin allowlist shape
  s.traceCapture = Boolean(s.traceCapture);
  s.traceCaptureBodies = Boolean(s.traceCaptureBodies);
  if (!Array.isArray(s.traceProxyAllowedOrigins)) {
    s.traceProxyAllowedOrigins = [];
  } else {
    s.traceProxyAllowedOrigins = s.traceProxyAllowedOrigins.filter(
      (o) => typeof o === "string" && (o.startsWith("http://") || o.startsWith("https://"))
    );
  }
  // modelctl (B1): per-key deep merge so partial patches don't wipe siblings
  s.modelctl = _mergeModelctl(s.modelctl);
  // agent: never accept a token through settings — tokenConfigured is derived
  // at runtime from ensure/rotate (patch/file values always ignored).
  s.agent = { tokenConfigured: false };
  return s;
}

/**
 * Per-key deep merge of a modelctl candidate over DEFAULTS — a patch setting
 * only `nasRoot` must not wipe `remoteBin`/`source`.
 */
function _mergeModelctl(candidate) {
  const out = { ...DEFAULTS.modelctl };
  if (!candidate || typeof candidate !== "object") return out;
  for (const k of MODELCTL_KEYS) {
    const v = candidate[k];
    if (v === undefined) continue;
    if (k === "nasHostSparkId") {
      out[k] = typeof v === "string" && v ? v : null;
    } else if (typeof v === "string" && v.trim()) {
      out[k] = v;
    }
  }
  return out;
}
export function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    _settings = _clampSettings({ ...DEFAULTS, ...parsed });
  } catch (err) {
    if (err.code === "ENOENT") {
      _settings = _clampSettings({ ...DEFAULTS });
      saveSettings();
    } else {
      console.error("[settings] Failed to load settings.json:", err.message);
      _settings = _clampSettings({ ...DEFAULTS });
    }
  }
  return getSettings();
}

/** Persist current settings to disk. */
export function saveSettings() {
  try {
    // Atomic write (tmp + rename) — a SIGKILL/power loss mid-write must not
    // truncate settings.json. atomicWrite ensures the dir is created.
    atomicWrite(SETTINGS_PATH, JSON.stringify(_settings, null, 2) + "\n", 0o644);
  } catch (err) {
    console.error("[settings] Failed to save settings.json:", err.message);
  }
}

/** Get current settings (clamped; nested objects copied so callers can't mutate state). */
export function getSettings() {
  return {
    ..._settings,
    modelctl: { ..._settings.modelctl },
    traceProxyAllowedOrigins: [..._settings.traceProxyAllowedOrigins],
    agent: { tokenConfigured: _agentTokenConfigured },
  };
}

/**
 * Apply a partial patch, persist, and return the new settings.
 * @param {Partial<typeof DEFAULTS>} patch
 * @returns {typeof DEFAULTS}
 */
export function updateSettings(patch) {
  const merged = _clampSettings({ ..._settings, ...patch });
  _settings = merged;
  saveSettings();
  return getSettings();
}
