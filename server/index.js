import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { SparkRegistry } from "./sparks/SparkRegistry.js";
import { SparkMonitor } from "./sparks/SparkMonitor.js";
import { sshExec, sshTest, llmTest, comfyTest } from "./collectors/ssh.js";
import { comfyCancelJob } from "./collectors/comfyActions.js";
import { validateSparkTarget, createRateLimiter } from "./validate.js";
import { getSettings, updateSettings, loadSettings, ensureAgentToken, rotateAgentToken, markAgentTokenConfigured } from "./settings.js";

/** Current agent token (read fresh — rotation replaces the stored value). */
function getAgentToken() {
  return ensureAgentToken();
}

import { broadcastForLanIp, effectiveMac, normalizeMac, sendWol } from "./wol.js";
import {
  decodeBenchManager,
  DECODE_BENCH_DEFAULTS,
} from "./collectors/DecodeBench.js";
import {
  prefillBenchManager,
  PREFILL_BENCH_DEFAULTS,
} from "./collectors/PrefillBench.js";
import { showcaseManager } from "./collectors/ShowcaseManager.js";
import { llmProbeHost } from "./collectors/llmHost.js";
import { llmDaily } from "./collectors/LlmDaily.js";
import { compareSemver, getLatestRelease } from "./collectors/HermesReleases.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

/** Bundled agent artifact uploaded by install-agent (npm run build:agent). */
const AGENT_BUNDLE_PATH = process.env.SPARKDASH_AGENT_BUNDLE || path.join(ROOT, "agent", "dist", "sparkdash-agent.mjs");
// Default to loopback: the dashboard exposes SSH and remote power controls, so it
// should not be reachable on the LAN unless explicitly opted in. Set BIND_HOST to the
// host's LAN IP (or 0.0.0.0) to expose it; docker-compose.yml already sets 0.0.0.0.
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "5555", 10);
const LLM_PORT = parseInt(process.env.LLM_PORT || "8888", 10);
const COMFY_PORT = parseInt(process.env.COMFY_PORT || "8188", 10);

/** Per-spark LLM HTTP port (1–65535), else env default. */
function resolveLlmPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    // Prefer llmPorts array, fall back to legacy llmPort
    const ports = sparkOrPort.llmPorts;
    if (Array.isArray(ports) && ports.length > 0) {
      const n = ports[0];
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    }
    const raw = sparkOrPort.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return LLM_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return LLM_PORT;
}

/** Per-spark ComfyUI HTTP port (1–65535), else env default 8188. */
function resolveComfyPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    const raw = sparkOrPort.comfyPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return COMFY_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return COMFY_PORT;
}

/** Optional Bearer token for a Spark LLM port (from encrypted secrets). */
function resolveLlmApiKey(spark, port) {
  const keys = spark?.llmApiKeys;
  if (!keys || typeof keys !== "object") return null;
  const raw = keys[String(port)] ?? keys[port];
  const key = raw != null ? String(raw).trim() : "";
  return key || null;
}

// Rate-limit ephemeral + registered connectivity tests (per client IP)
const allowTest = createRateLimiter(20, 60_000);

// ─── Spark registry ──────────────────────────────────────
const registry = new SparkRegistry();

// ─── Monitor map ─────────────────────────────────────────
const monitors = new Map();

// ─── Start monitor for a Spark ───────────────────────────
function startMonitor(spark) {
  if (monitors.has(spark.id)) return;
  const monitor = new SparkMonitor(spark, {
    onWolMac: (id, mac) => {
      const updated = registry.noteDetectedMac(id, mac);
      if (updated) {
        const mon = monitors.get(id);
        if (mon) mon.updateConfig(registry.getSpark(id));
      }
    },
    // Hermes check / update results must not wait for the next broadcast tick.
    onHermesChange: () => forceBroadcast(),
  });
  monitors.set(spark.id, monitor);
  monitor.start();
}

// ─── Stop and remove monitor for a Spark ─────────────────
function stopMonitor(id) {
  const monitor = monitors.get(id);
  if (monitor) {
    monitor.stop();
    monitors.delete(id);
  }
}

// ─── Start all monitors from registry ───────────────────
function startAllMonitors() {
  for (const spark of registry.sparks) {
    startMonitor(spark);
  }
}

/** Snapshots in registry tab order (not Map insertion order). */
function orderedSnapshots() {
  return registry.sparkIds
    .map((id) => monitors.get(id))
    .filter(Boolean)
    .map((m) => m.snapshot());
}

// ─── Express app ─────────────────────────────────────────
const app = express();
const server = createServer(app);

// ─── Analysis reverse proxy (A2) — BEFORE express.json so raw bodies tee ──
import { createLlmProxy } from "./proxy/llmProxy.js";
// ─── Node operations (B2/B3) ──────────────────────────────
import {
  getRemoteJobManager,
  buildLaunchCommand,
  execOnSpark,
} from "./jobs/remoteJobs.js";
import {
  createModelctlService,
  buildDownloadScript,
  buildSyncScript,
  buildPushScript,
  buildDeleteLocalScript,
  buildInstallModelctlScript,
  planPlacement,
  validModelName,
} from "./collectors/modelctlService.js";
import { seedServingScripts } from "./serving/serving.js";
import { getAgentRegistry } from "./agent/agentRegistry.js";
import { buildInstallAgentScript, buildUpdateAgentScript } from "./agent/agentBootstrap.js";
import { shellQuote } from "./util/shellQuote.js";
import { getTraceStore, closeTraceStore } from "./collectors/TraceStore.js";
import {
  POLL_INTERVAL_GPU,
  POLL_INTERVAL_CPU,
  POLL_INTERVAL_NETWORK,
  POLL_INTERVAL_STORAGE,
  POLL_INTERVAL_LLM,
} from "./config.js";
const remoteJobs = getRemoteJobManager();
const modelctl = createModelctlService({
  exec: execOnSpark,
  getSettings,
  registry,
});
remoteJobs.startSweeper((id) => registry.getSpark(id));

const agentRegistry = getAgentRegistry();

/**
 * Capped ring buffers for agent-relayed streams (C2): job output per reqId,
 * serving logs per scriptId. Consumers (job poll, serving log) read the tail.
 */

// ─── Agent transport wiring (C3) ─────────────────────────
agentRegistry.onConnect((sparkId, version) => {
  const monitor = monitors.get(sparkId);
  if (monitor) monitor.setAgentConnected(true, version);
});
agentRegistry.onDisconnect((sparkId) => {
  const monitor = monitors.get(sparkId);
  if (monitor) monitor.setAgentConnected(false);
});
const agentDataRings = (() => {
  const rings = new Map();
  const MAX = 100 * 1024;
  const RING_TTL_MS = 30 * 60_000;
  function record(msg) {
    const key = msg.type === "serve-log" ? `serve:${msg.scriptId}` : `job:${msg.reqId}`;
    let ring = rings.get(key);
    if (!ring) {
      ring = { buf: "", at: Date.now() };
      rings.set(key, ring);
    }
    ring.at = Date.now();
    ring.buf = (ring.buf + (msg.chunk ?? "")).slice(-MAX);
  }
  function tail(key, bytes = 4000) {
    const ring = rings.get(key);
    return ring ? ring.buf.slice(-bytes) : "";
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, r] of rings.entries()) {
      if (now - r.at > RING_TTL_MS) rings.delete(k);
    }
  }, 5 * 60_000).unref?.();
  return { record, tail };
})();

const traceStore = getTraceStore();
traceStore.startRetentionTimer();
app.use("/llm", createLlmProxy({
  registry,
  secrets: null, // per-port keys resolve from the spark object (registry._withSecrets)
  settings: getSettings,
  traceStore,
}));

app.use(express.json());

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ─── REST API ────────────────────────────────────────────
// Never return SSH passwords in any response
app.get("/api/sparks", (_req, res) => {
  res.json({ sparks: registry.publicSparks });
});

// Ephemeral connectivity test — does not persist or start a monitor
app.post("/api/sparks/test", async (req, res) => {
  try {
    if (!allowTest(clientKey(req))) {
      return res.status(429).json({ error: "Too many test requests; try again shortly" });
    }
    const body = req.body || {};
    const validationError = validateSparkTarget(body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = {
      id: body.id || "ephemeral-test",
      name: body.name || "test",
      lanIp: body.lanIp || "",
      cx7Ip: body.cx7Ip || null,
      isLocal: Boolean(body.isLocal),
      llmPort: resolveLlmPort(body),
      comfyPort: resolveComfyPort(body),
      comfyMonitoring: Boolean(body.comfyMonitoring),
      ssh: {
        host: body.ssh?.host || body.lanIp || "",
        user: body.ssh?.user || "root",
        auth: body.ssh?.auth === "pass" ? "pass" : "key",
        password: body.ssh?.password,
      },
    };
    if (!spark.lanIp && !spark.ssh.host) {
      return res.status(400).json({ error: "lanIp or ssh.host required" });
    }
    const llmPort = resolveLlmPort(spark);
    const comfyPort = resolveComfyPort(spark);
    const [sshResult, llmResult, comfyResult] = await Promise.all([
      spark.isLocal ? Promise.resolve({ ok: true, message: "local (skipped SSH)" }) : sshTest(spark),
      llmTest(spark, llmPort),
      spark.comfyMonitoring
        ? comfyTest(spark, comfyPort)
        : Promise.resolve({ ok: true, message: "disabled", skipped: true }),
    ]);
    res.json({
      id: spark.id,
      ssh: sshResult,
      llm: llmResult,
      comfy: comfyResult,
      ok: sshResult.ok || llmResult.ok || (comfyResult.ok && !comfyResult.skipped),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks", (req, res) => {
  try {
    const validationError = validateSparkTarget(req.body || {});
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = registry.addSpark(req.body);
    startMonitor(spark);
    res.json({ success: true, spark: registry.toPublic(spark) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/sparks/:id", (req, res) => {
  try {
    const body = req.body || {};
    // Only validate host fields if they are being updated
    if (body.lanIp != null || body.ssh?.host != null || body.ssh?.user != null) {
      const existing = registry.getSpark(req.params.id);
      if (!existing) return res.status(404).json({ error: "Spark not found" });
      const merged = {
        lanIp: body.lanIp ?? existing.lanIp,
        ssh: { ...existing.ssh, ...(body.ssh || {}) },
      };
      const validationError = validateSparkTarget(merged);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    }

    // Password-only update: hot-apply without full monitor restart
    const keys = Object.keys(body).filter((k) => k !== "ssh");
    const sshKeys = body.ssh ? Object.keys(body.ssh) : [];
    const passwordOnly =
      keys.length === 0 &&
      sshKeys.length > 0 &&
      sshKeys.every((k) => k === "password");

    if (passwordOnly && body.ssh?.password) {
      const spark = registry.setPassword(req.params.id, body.ssh.password);
      const mon = monitors.get(req.params.id);
      if (mon) mon.updateConfig(registry.getSpark(req.params.id));
      return res.json({ success: true, spark, hasPassword: true });
    }

    const spark = registry.updateSpark(req.params.id, body);
    // Restart monitor so collectors pick up host/auth/isLocal changes
    stopMonitor(req.params.id);
    startMonitor(spark);
    res.json({
      success: true,
      spark: registry.toPublic(spark),
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/sparks/:id", (req, res) => {
  try {
    const removed = registry.removeSpark(req.params.id);
    if (!removed) return res.status(404).json({ error: "Spark not found" });
    stopMonitor(req.params.id);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reorder Sparks in the tab bar (persisted to sparks.json)
app.put("/api/sparks/order", (req, res) => {
  try {
    const order = req.body?.order;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: "body.order must be an array of spark ids" });
    }
    const sparks = registry.reorderSparks(order);
    res.json({ success: true, sparks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Global settings ──────────────────────────────────────
app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  try {
    const patch = req.body || {};
    const newSettings = updateSettings(patch);
    // If poll interval changed, restart the broadcast timer
    if (patch.pollIntervalMs != null) {
      restartBroadcast();
    }
    res.json(newSettings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Analysis traces (A4) ─────────────────────────────────
/** GET /api/traces — lean list (no bodies). ?sparkId=&port=&source=&method=&since=&limit= */
app.get("/api/traces", (req, res) => {
  const q = req.query;
  const port = q.port != null && q.port !== "" ? Number(q.port) : undefined;
  const since = q.since != null && q.since !== "" ? Number(q.since) : undefined;
  const limit = q.limit != null && q.limit !== "" ? Number(q.limit) : undefined;
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return res.status(400).json({ error: "port must be an integer 1–65535" });
  }
  res.json(traceStore.list({
    sparkId: q.sparkId || undefined,
    port,
    source: q.source || undefined,
    method: q.method || undefined,
    since: Number.isFinite(since) ? since : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  }));
});

/** GET /api/traces/:id — full entry incl. bodies. */
app.get("/api/traces/:id", (req, res) => {
  const entry = traceStore.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "Trace not found" });
  res.json(entry);
});

/** DELETE /api/traces — clear all. */
app.delete("/api/traces", (_req, res) => {
  try {
    traceStore.clear();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get("/api/sparks/:id/metrics", (req, res) => {
  const monitor = monitors.get(req.params.id);
  if (!monitor) return res.status(404).json({ error: "Spark not found" });
  res.json(monitor.snapshot());
});

// Test SSH + LLM connectivity for a registered Spark.
// Optional body.ssh.password is ALWAYS saved (even if the host is down).
app.post("/api/sparks/:id/test", async (req, res) => {
  if (!allowTest(clientKey(req))) {
    return res.status(429).json({ error: "Too many test requests; try again shortly" });
  }
  try {
    const body = req.body || {};
    const incomingPassword = body.ssh?.password ?? body.password;
    // Persist password first — does not require host reachability
    if (incomingPassword != null && incomingPassword !== "") {
      registry.setPassword(req.params.id, incomingPassword);
    }

    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const [sshResult, llmResult, comfyResult] = await Promise.all([
      spark.isLocal ? Promise.resolve({ ok: true, message: "local (skipped SSH)" }) : sshTest(spark),
      llmTest(spark, resolveLlmPort(spark)),
      spark.comfyMonitoring
        ? comfyTest(spark, resolveComfyPort(spark))
        : Promise.resolve({ ok: true, message: "disabled", skipped: true }),
    ]);
    res.json({
      id: req.params.id,
      ssh: sshResult,
      llm: llmResult,
      comfy: comfyResult,
      ok: sshResult.ok || llmResult.ok || (comfyResult.ok && !comfyResult.skipped),
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Remote jobs + modelctl (B5 batch 1) ──────────────────
const MODEL_JOB_KINDS = new Set(["download", "sync", "push", "delete-local", "install-modelctl", "install-agent", "update-agent"]);

/** Shared job-poll context: registry spark lookup (may be gone mid-job). */
function jobSpark(id) {
  return registry.getSpark(id);
}

app.post("/api/jobs", async (req, res) => {
  try {
    const body = req.body || {};
    const kind = String(body.kind || "");
    if (!MODEL_JOB_KINDS.has(kind)) {
      return res.status(400).json({ error: `kind must be one of ${[...MODEL_JOB_KINDS].join(", ")}` });
    }
    let spark = null;
    let script = null;
    let name = kind;
    const cfg = getSettings().modelctl || {};

    if (kind === "download") {
      if (!body.repo || typeof body.repo !== "string" || body.repo.length > 200) {
        return res.status(400).json({ error: "repo is required (max 200 chars)" });
      }
      if (!cfg.nasRoot) return res.status(400).json({ error: "modelctl.nasRoot not configured" });
      if (body.name && !validModelName(body.name)) return res.status(400).json({ error: "invalid model name" });
      spark = modelctl.defaultNasSpark();
      if (!spark) return res.status(409).json({ error: "no spark available for NAS operations" });
      script = buildDownloadScript({
        repo: body.repo,
        nasRoot: cfg.nasRoot,
        name: body.name,
        quantization: body.quantization,
        revision: body.revision,
        remoteBin: cfg.remoteBin,
      });
      name = `download ${body.name || body.repo}`;
    } else {
      const sparkId = body.sparkId;
      if (!sparkId) return res.status(400).json({ error: "sparkId is required" });
      spark = registry.getSpark(sparkId);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      if (!spark.modelctlEnabled && kind !== "install-agent" && kind !== "update-agent") {
        return res.status(409).json({ error: `modelctl is not enabled on ${sparkId}` });
      }
      if (kind === "install-modelctl") {
        script = buildInstallModelctlScript({ source: cfg.source, remoteBin: cfg.remoteBin });
        name = "install modelctl (uv)";
      } else if (kind === "install-agent" || kind === "update-agent") {
        if (!spark.agentEnabled) {
          return res.status(409).json({ error: `agent is not enabled on ${sparkId}` });
        }
        if (spark.isLocal) {
          return res.status(400).json({ error: "install-agent targets remote nodes (the dashboard host does not bootstrap itself)" });
        }
        if (spark.ssh?.auth === "pass" && !registry.hasPassword(sparkId)) {
          return res.status(400).json({ error: "agent bootstrap over password SSH requires the stored password" });
        }
        // Upload the bundle (~130 KB) in base64 chunks — a single argv with the
        // whole payload trips E2BIG. Chunks ride in separate sshExec calls.
        const bundleB64 = fs.readFileSync(AGENT_BUNDLE_PATH).toString("base64");
        const CHUNK = 48_000; // argv-safe size per ssh call
        const remoteSh = path.join("~/.sparkdash/agent/sparkdash-agent.mjs");
        try {
          await execOnSpark(spark, "mkdir -p ~/.sparkdash/agent", { timeoutMs: 15_000 });
          for (let i = 0; i < bundleB64.length; i += CHUNK) {
            const part = bundleB64.slice(i, i + CHUNK);
            const op = i === 0 ? ">" : ">>";
            await execOnSpark(spark, `printf '%s' ${shellQuote(part)} ${op} ${remoteSh}.b64`, { timeoutMs: 20_000 });
          }
          await execOnSpark(spark, `base64 -d ${remoteSh}.b64 > ${remoteSh} && rm -f ${remoteSh}.b64 && wc -c ${remoteSh}`, { timeoutMs: 20_000 });
        } catch (err) {
          return res.status(502).json({ error: `bundle upload failed: ${err.message}` });
        }
        const bootstrapScript = kind === "install-agent"
          ? buildInstallAgentScript({
              dashboardUrl: `ws://${req.headers.host}/agent-ws`,
              token: getAgentToken(),
              sparkId,
              sshUser: spark.ssh?.user || "root",
            })
          : buildUpdateAgentScript({
              dashboardUrl: `ws://${req.headers.host}/agent-ws`,
              token: getAgentToken(),
              sparkId,
              sshUser: spark.ssh?.user || "root",
            });
        script = bootstrapScript;
        name = kind === "install-agent" ? "install agent" : "update agent (force redeploy)";
      } else {
        const m = body.model;
        if (!validModelName(m)) return res.status(400).json({ error: "invalid or missing model name" });
        if (kind === "sync") {
          if (!cfg.nasRoot) return res.status(400).json({ error: "modelctl.nasRoot not configured" });
          script = buildSyncScript({ name: m, nasRoot: cfg.nasRoot, remoteBin: cfg.remoteBin });
          name = `sync ${m}`;
        } else if (kind === "push") {
          const sourceSparkId = body.sourceSparkId || sparkId;
          const targetSparkId = body.targetSparkId;
          if (!targetSparkId) return res.status(400).json({ error: "targetSparkId is required" });
          const src = registry.getSpark(sourceSparkId);
          const tgt = registry.getSpark(targetSparkId);
          if (!src || !tgt) return res.status(404).json({ error: "Spark not found" });
          if (!src.modelctlEnabled || !tgt.modelctlEnabled) {
            return res.status(409).json({ error: "modelctl must be enabled on both nodes" });
          }
          const targetHost = tgt.cx7Ip || tgt.lanIp;
          if (!targetHost) return res.status(400).json({ error: "target has no reachable host" });
          // push runs on the SOURCE node, stream to the target host.
          spark = src;
          script = buildPushScript({ name: m, targetHost, remoteBin: cfg.remoteBin });
          name = `push ${m} → ${targetSparkId}`;
        } else if (kind === "delete-local") {
          script = buildDeleteLocalScript({ name: m, remoteBin: cfg.remoteBin });
          name = `delete-local ${m}`;
        }
      }
    }
    if (remoteJobs.hasActiveJobForNode(spark.id)) {
      return res.status(409).json({ error: `A job is already running on ${spark.id}` });
    }
    const { jobId } = await remoteJobs.startRemoteJob(spark, { name, script, kind });
    res.status(202).json({ jobId, kind, sparkId: spark.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/jobs", (_req, res) => {
  res.json({ jobs: remoteJobs.listJobs() });
});

app.get("/api/jobs/:id", async (req, res) => {
  const job = remoteJobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status === "running") {
    const spark = jobSpark(job.sparkId);
    if (spark) await remoteJobs.pollRemoteJob(spark, job.jobId).catch(() => undefined);
  }
  res.json(remoteJobs.getJob(req.params.id) || job);
});

app.post("/api/jobs/:id/cancel", async (req, res) => {
  const job = remoteJobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const spark = jobSpark(job.sparkId);
  if (!spark) return res.status(404).json({ error: "Spark not found for job" });
  const updated = await remoteJobs.cancelRemoteJob(spark, job.jobId);
  res.json(updated);
});

// ─── Model inventories ────────────────────────────────────
app.get("/api/models/nas", async (_req, res) => {
  try {
    const r = await modelctl.listNasModels();
    res.json(r);
  } catch (err) {
    res.json({ models: [], error: err.message });
  }
});

app.get("/api/sparks/:id/models", async (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (!spark.modelctlEnabled) {
    return res.status(409).json({ error: `modelctl is not enabled on ${spark.id}` });
  }
  try {
    const r = await modelctl.listNodeModels(spark);
    res.json(r);
  } catch (err) {
    res.json({ models: [], error: err.message || "node offline" });
  }
});

app.get("/api/sparks/:id/modelctl", async (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const r = await modelctl.checkModelctl(spark, { force: req.query.force === "1" });
  res.json(r);
});

/** GET /api/sparks/:id/agent — transport state for the UI badge. */
app.get("/api/sparks/:id/agent", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  res.json({
    sparkId: spark.id,
    agentEnabled: Boolean(spark.agentEnabled),
    connected: agentRegistry.isConnected(spark.id),
    transport: agentRegistry.isConnected(spark.id) ? "agent" : "ssh",
    agentVersion: agentRegistry.agentVersion(spark.id),
  });
});

/** POST /api/agent/token/rotate — new 64-hex token; pushes config-update to
 * connected agents (they rewrite config.json + reconnect); disconnected
 * agents must be re-bootstrapped. */
app.post("/api/agent/token/rotate", (req, res) => {
  try {
    const token = rotateAgentToken();
    markAgentTokenConfigured();
    const current = getAgentToken();
    let notified = 0;
    for (const [sparkId] of agentRegistry.connections) {
      if (agentRegistry.send(sparkId, { type: "config-update", config: { token: current } })) {
        notified += 1;
      }
    }
    res.json({ success: true, tokenConfigured: true, notified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/** Serving/jobs exec that prefers the agent transport (C3) and falls back to
 * execOnSpark (SSH/local) when the agent is not connected. The agent handles
 * `serve` frames itself; generic commands run as one-shot job-run scripts. */
async function execForSpark(spark, cmd, opts = {}) {
  if (agentRegistry.isConnected(spark.id)) {
    const r = await agentRegistry.request(spark.id, {
      type: "job-run",
      scriptB64: Buffer.from(cmd, "utf8").toString("base64"),
      args: [],
      shellMode: true,
    }, opts.timeoutMs || 15_000);
    if (r.ok) {
      // resp carries {code, logTail} from the agent's completion frame.
      return r.payload?.logTail ?? "";
    }
    throw new Error(r.error || "agent exec failed");
  }
  return execOnSpark(spark, cmd, opts);
}

// ─── Serving (B4/B5 batch 2) ──────────────────────────────
import {
  resolveScriptPath,
  listServingScripts,
  buildServeStartCommand,
  buildServeStopCommand,
  buildServeStatusCommand,
  buildServeLogCommand,
  parseServeStartOutput,
  parseServeStatusOutput,
  parseServingHeader,
} from "./serving/serving.js";

/** In-process start guard: one active start per node (remote check is the second gate). */
const startingSparks = new Set();

/** Default serving node: nasHostSparkId → head → isLocal → sole spark. */
function defaultServingSpark() {
  const cfg = getSettings().modelctl || {};
  if (cfg.nasHostSparkId) {
    const s = registry.getSpark(cfg.nasHostSparkId);
    if (s) return s;
  }
  return modelctl.defaultNasSpark();
}

app.get("/api/serving/scripts", (_req, res) => {
  res.json({ scripts: listServingScripts() });
});

app.post("/api/serving/start", async (req, res) => {
  try {
    const body = req.body || {};
    let scriptPath;
    try {
      scriptPath = resolveScriptPath(body.scriptId);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!fs.existsSync(scriptPath)) {
      return res.status(404).json({ error: `Serving script not found: ${body.scriptId}` });
    }
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }
    if (body.modelName != null && body.modelName !== "" && !validModelName(body.modelName)) {
      return res.status(400).json({ error: "invalid model name" });
    }
    if (body.extraArgs != null && (typeof body.extraArgs !== "string" || body.extraArgs.length > 2000)) {
      return res.status(400).json({ error: "extraArgs must be a string (max 2000 chars)" });
    }
    const spark = body.sparkId ? registry.getSpark(body.sparkId) : defaultServingSpark();
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Placement-aware start (B4): when a model is requested and absent on the
    // target node, answer 409 with remediations instead of starting.
    if (body.modelName) {
      let inv = null;
      try {
        inv = await modelctl.listNodeModels(spark);
      } catch {
        /* offline → presence unknown; start may still work if model resolves */
      }
      if (inv && Array.isArray(inv.models) && !inv.models.some((m) => m?.name === body.modelName)) {
        const placement = await planPlacementFor(body.modelName, spark);
        return res.status(409).json({
          error: `Model "${body.modelName}" is not present on ${spark.id}`,
          placement,
        });
      }
    }

    if (startingSparks.has(spark.id)) {
      return res.status(409).json({ error: `A start is already in progress on ${spark.id}` });
    }
    startingSparks.add(spark.id);
    try {
      const scriptBody = fs.readFileSync(scriptPath, "utf8");
      const cmd = buildServeStartCommand({
        scriptId: body.scriptId,
        scriptBody,
        modelName: body.modelName || "",
        port,
        extraArgs: body.extraArgs || "",
      });
      let out = "";
      try {
        out = await execForSpark(spark, cmd, { timeoutMs: 20_000 });
      } catch (err) {
        return res.status(502).json({ error: `start failed: ${err.message}` });
      }
      const parsed = parseServeStartOutput(out);
      if (parsed.alreadyRunning) {
        return res.status(409).json({ error: `A serving script is already running on ${spark.id}` });
      }
      if (!parsed.started) {
        return res.status(502).json({ error: parsed.error || "start failed" });
      }
      // One immediate status poll.
      let status = { running: true };
      try {
        const stOut = await execForSpark(spark, buildServeStatusCommand(body.scriptId), { timeoutMs: 10_000 });
        status = parseServeStatusOutput(stOut);
      } catch {
        /* status optional */
      }
      res.json({ success: true, sparkId: spark.id, scriptId: body.scriptId, port, status });
    } finally {
      startingSparks.delete(spark.id);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/serving/stop", async (req, res) => {
  try {
    const body = req.body || {};
    let scriptId = body.scriptId;
    // stop defaults to the sole/first script when only a sparkId is given.
    if (!scriptId) {
      const scripts = listServingScripts();
      scriptId = scripts[0]?.id;
      if (!scriptId) return res.status(404).json({ error: "No serving scripts configured" });
    }
    let scriptPath;
    try {
      scriptPath = resolveScriptPath(scriptId);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const spark = body.sparkId ? registry.getSpark(body.sparkId) : defaultServingSpark();
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    let out = "";
    try {
      out = await execForSpark(spark, buildServeStopCommand(scriptId), { timeoutMs: 15_000 });
    } catch (err) {
      return res.status(502).json({ error: `stop failed: ${err.message}` });
    }
    res.json({ success: true, running: false, output: out.trim().slice(-200) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/serving/status", async (req, res) => {
  try {
    const sparkId = req.query.sparkId;
    const spark = sparkId ? registry.getSpark(sparkId) : defaultServingSpark();
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const scripts = listServingScripts();
    if (scripts.length === 0) return res.json({ sparkId: spark.id, running: false });
    try {
      resolveScriptPath(req.query.scriptId || scripts[0].id);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    // One active script per node: without an explicit scriptId, find the
    // running one (pidfile present) instead of blindly probing the first.
    let scriptId = req.query.scriptId;
    if (!scriptId) {
      for (const s of scripts) {
        try {
          const out = await execOnSpark(spark, buildServeStatusCommand(s.id), { timeoutMs: 10_000 });
          if (parseServeStatusOutput(out).running === true) {
            scriptId = s.id;
            break;
          }
        } catch {
          /* offline handled below */
        }
      }
      scriptId = scriptId || scripts[0].id;
    }
    try {
      const out = await execForSpark(spark, buildServeStatusCommand(scriptId), { timeoutMs: 10_000 });
      const parsed = parseServeStatusOutput(out);
      res.json({ sparkId: spark.id, scriptId, ...parsed });
    } catch (err) {
      res.json({ sparkId: spark.id, scriptId, running: "unknown", error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/serving/log", async (req, res) => {
  try {
    const sparkId = req.query.sparkId;
    const spark = sparkId ? registry.getSpark(sparkId) : defaultServingSpark();
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const scripts = listServingScripts();
    const scriptId = req.query.scriptId || scripts[0]?.id;
    if (!scriptId) return res.status(404).json({ error: "No serving scripts configured" });
    try {
      resolveScriptPath(scriptId);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const bytes = Number(req.query.bytes) || 4000;
    let log = "";
    try {
      log = await agentDataRings.tail(`serve:${scriptId}`, bytes) || execForSpark(spark, buildServeLogCommand(scriptId, bytes), { timeoutMs: 10_000 });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
    res.json({ sparkId: spark.id, scriptId, log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/serving/placement", async (req, res) => {
  try {
    const model = req.query.model;
    if (!validModelName(model)) {
      return res.status(400).json({ error: "invalid or missing model name" });
    }
    const spark = req.query.sparkId ? registry.getSpark(req.query.sparkId) : defaultServingSpark();
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const [targetInv, nasInv] = await Promise.all([
      modelctl.listNodeModels(spark).catch(() => null),
      modelctl.listNasModels().catch(() => null),
    ]);
    const peers = [];
    for (const p of modelctl.modelctlEnabledSparks()) {
      if (p.id === spark.id) continue;
      const inv = await modelctl.listNodeModels(p).catch(() => null);
      if (inv && Array.isArray(inv.models) && inv.models.length > 0) {
        peers.push({ sparkId: p.id, models: inv.models });
      }
    }
    const placement = planPlacement(model, {
      target: { sparkId: spark.id, models: targetInv?.models ?? [] },
      nas: nasInv?.models?.length ? { models: nasInv.models } : null,
      peers,
    });
    res.json(placement);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Placement for the start-409 path: real inventories, target override. */
async function planPlacementFor(model, targetSpark) {
  const peers = modelctl.modelctlEnabledSparks().filter((s) => s.id !== targetSpark.id);
  const [targetInv, nasInv] = await Promise.all([
    modelctl.listNodeModels(targetSpark).catch(() => null),
    modelctl.listNasModels().catch(() => null),
  ]);
  const peerInvs = [];
  for (const p of peers) {
    const inv = await modelctl.listNodeModels(p).catch(() => null);
    if (inv && Array.isArray(inv.models) && inv.models.length > 0) {
      peerInvs.push({ sparkId: p.id, models: inv.models });
    }
  }
  return planPlacement(model, {
    target: { sparkId: targetSpark.id, models: targetInv?.models ?? [] },
    nas: nasInv?.models?.length ? { models: nasInv.models } : null,
    peers: peerInvs,
  });
}


// Cancel a ComfyUI job (running interrupt and/or pending dequeue).
app.post("/api/sparks/:id/comfy/cancel", async (req, res) => {
  if (!allowTest(clientKey(req))) {
    return res.status(429).json({ error: "Too many requests; try again shortly" });
  }
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.comfyMonitoring) {
      return res.status(400).json({ error: "ComfyUI monitoring is disabled for this Spark" });
    }
    const promptId = req.body?.promptId ?? req.body?.prompt_id;
    if (!promptId || typeof promptId !== "string") {
      return res.status(400).json({ error: "promptId is required" });
    }
    const result = await comfyCancelJob(spark, promptId, resolveComfyPort(spark));
    // Nudge a comfy re-poll so UI updates quickly
    const mon = monitors.get(req.params.id);
    if (mon) void mon._pollDomain?.("comfy");
    res.json({ success: result.ok, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual metric refresh ──────────────────────────────
app.post("/api/sparks/:id/refresh/:domain", async (req, res) => {
  try {
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const { domain } = req.params;
    if (domain !== "storage") {
      return res.status(400).json({ error: "Only 'storage' domain is supported" });
    }
    await monitor.refreshDomain(domain);
    forceBroadcast();
    res.json({ success: true, domain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Hermes Agent ───────────────────────────────────
// Batch route first (like shutdown-all/wake-all): a plain Sparks-suffixed
// path (3 segments) that cannot be captured by /api/sparks/:id/hermes/* (4).
/** One-click `hermes update` on every Spark with hermes monitoring enabled. */
app.post("/api/sparks/hermes/update-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const monitor = monitors.get(spark.id);
    const entry = { id: spark.id, name: spark.name, ok: false, started: false, skipped: false };
    if (!spark.hermesMonitoring || !monitor) {
      entry.skipped = true;
      entry.reason = spark.hermesMonitoring
        ? "monitor not running"
        : "Hermes Agent monitoring is disabled (enable it in Edit Spark)";
      results.push(entry);
      continue;
    }
    const result = monitor.runHermesUpdate();
    entry.started = Boolean(result.started);
    entry.ok = Boolean(result.started);
    if (!result.started) {
      entry.skipped = true;
      entry.reason = result.reason || "update already running";
    }
    results.push(entry);
  }
  res.json({ success: true, results });
});

/** Re-check for a hermes update now (bypasses the poll cadence). */
app.post("/api/sparks/:id/hermes/check", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const result = await monitor.hermesProbe.check();
    monitor.applyHermesCheck(result);
    res.json({ success: true, hermes: monitor.snapshot().hermes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** One-click `hermes update` via SSH. Returns 202; progress via snapshot. */
app.post("/api/sparks/:id/hermes/update", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const result = await monitor.runHermesUpdate();
    res.status(result.started ? 202 : 200).json({
      success: result.started,
      reason: result.reason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-Spark Hermes update preview: the latest release (cached globally), the
// installed version, the actual pending commits on this Spark (HEAD..origin/main)
// and a resolved `view` so the dialog shows the commit list for minor /
// no-bump updates and the full release changelog only when a real version bump
// is pending.
app.get("/api/sparks/:id/hermes/updates", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });

    const installedVersion = monitor.snapshot().hermes?.version || null;
    const pending = await monitor.hermesProbe.pendingCommits();

    let release = null;
    let releaseError = null;
    try {
      release = await getLatestRelease();
    } catch (err) {
      releaseError = err instanceof Error ? err.message : String(err);
    }

    // Resolve which content the dialog should lead with. A version bump exists
    // only when the latest tagged release is newer than what is installed;
    // otherwise the pending update is commits on main and those are the honest
    // changelog. Without both versions, fall back to the release when available.
    const hasPending = Boolean(pending && pending.commits && pending.commits.length > 0);
    const releaseNewer =
      release?.semver && installedVersion && compareSemver(release.semver, installedVersion) > 0;
    const view = releaseNewer ? "release" : hasPending ? "commits" : "release";

    res.json({
      success: true,
      view,
      release,
      releaseError,
      installedVersion,
      pending,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save / update SSH password only (works while host is offline)
app.put("/api/sparks/:id/password", (req, res) => {
  try {
    const password = req.body?.password ?? req.body?.ssh?.password;
    if (password == null || password === "") {
      return res.status(400).json({ error: "password is required" });
    }
    const spark = registry.setPassword(req.params.id, password);
    // Refresh monitor with password in memory (no need if already running — updateConfig)
    const mon = monitors.get(req.params.id);
    if (mon) mon.updateConfig(registry.getSpark(req.params.id));
    res.json({ success: true, spark, hasPassword: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled storage devices for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-devices", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledDevices } = req.body;
    if (!Array.isArray(disabledDevices)) {
      return res.status(400).json({ error: "disabledDevices must be an array" });
    }

    const updated = registry.updateSpark(req.params.id, { disabledDevices });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledDevices });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled network interfaces for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-interfaces", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledInterfaces } = req.body;
    if (!Array.isArray(disabledInterfaces)) {
      return res.status(400).json({ error: "disabledInterfaces must be an array" });
    }

    const cleaned = disabledInterfaces.filter((n) => typeof n === "string" && n.length > 0);
    const updated = registry.updateSpark(req.params.id, { disabledInterfaces: cleaned });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledInterfaces: cleaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update LLM probe ports for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPorts;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "llmPorts must be an array" });
    }
    const ports = raw
      .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
    // Deduplicate
    const unique = [...new Set(ports)];
    if (unique.length === 0) {
      return res.status(400).json({ error: "llmPorts must contain at least one valid port 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    const updated = registry.updateSpark(req.params.id, { llmPorts: unique });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, unique);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Backward-compat: update single LLM port (delegates to llm-ports)
app.put("/api/sparks/:id/llm-port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "llmPort must be an integer 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    // Replace the ports list with just this single port
    const updated = registry.updateSpark(req.params.id, { llmPorts: [n] });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, [n]);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPort: n,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Add a single LLM port to a Spark (hot — no monitor restart)
app.post("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.port;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    if (currentPorts.includes(n)) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: [...currentPorts, n] });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, llmPorts: updated.llmPorts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an LLM port from a Spark (hot — no monitor restart)
app.delete("/api/sparks/:id/llm-ports/:port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    // Primary (first) port cannot be removed — only additional ports
    if (currentPorts[0] === port) {
      return res.status(400).json({ error: "Cannot remove the primary LLM port" });
    }
    const newPorts = currentPorts.filter((p) => p !== port);
    if (newPorts.length === 0) {
      return res.status(400).json({ error: "Cannot remove the last LLM port" });
    }
    if (newPorts.length === currentPorts.length) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: newPorts });
    registry.clearLlmApiKey(req.params.id, port);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Set / clear optional LLM API key for one port (encrypted secrets store)
app.put("/api/sparks/:id/llm-ports/:port/api-key", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "apiKey")) {
      return res.status(400).json({ error: "apiKey is required (use \"\" to clear)" });
    }

    const apiKey = req.body.apiKey == null ? "" : String(req.body.apiKey);
    const publicSpark = registry.setLlmApiKey(req.params.id, port, apiKey);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      spark: publicSpark,
      hasApiKey: registry.hasLlmApiKey(req.params.id, port),
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Daily decode / prefill tok/s rollups (busy samples, last 14 UTC days by default).
 * Query: port (required for multi-port), days (1–30).
 */
app.get("/api/sparks/:id/llm/daily", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const ports =
    Array.isArray(spark.llmPorts) && spark.llmPorts.length
      ? spark.llmPorts
      : [resolveLlmPort(spark)];
  let port = req.query.port != null ? Number(req.query.port) : ports[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  let days = req.query.days != null ? Number(req.query.days) : 14;
  if (!Number.isFinite(days)) days = 14;
  res.json(llmDaily.getSeries(spark.id, port, { days }));
});

/**
 * Decode throughput benchmark (streaming, post-first-token tok/s).
 *
 * POST body: { port?, concurrencies: number[], maxTokens?, promptType? }
 * promptType is structured | prose | code | json (default structured).
 * Returns immediately with a bench job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prefill benchmark is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let port = req.body?.port != null ? Number(req.body.port) : ports[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  if (!ports.includes(port)) {
    return res.status(400).json({ error: "port is not configured for this Spark" });
  }

  // Resolve model id for this port from live snapshot when possible
  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    const benchDebug = Boolean(getSettings().benchDebugTraces);
    const job = decodeBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      concurrencies: req.body?.concurrencies,
      maxTokens: req.body?.maxTokens,
      promptType: req.body?.promptType,
      debug: benchDebug,
      apiKey: resolveLlmApiKey(spark, port),
      sampleHardware:
        benchDebug && monitor
          ? async () => {
              const fromGpu = (gpu, um) =>
                gpu
                  ? {
                      gpuUsage: gpu.usage ?? null,
                      temperature: gpu.temperature ?? null,
                      powerDraw: gpu.power?.draw ?? null,
                      powerLimit: gpu.power?.limit ?? null,
                      vramUsed: gpu.vram?.used ?? null,
                      vramTotal: gpu.vram?.total ?? null,
                      vramAvailable: gpu.vram?.available ?? null,
                      memAvailable: um?.available ?? null,
                    }
                  : null;

              // Local: fresh collect so the timeline isn't stuck on the 2s poll cache.
              // Remote: use snapshot only — SSH collectGpu every 1s is too heavy mid-bench.
              if (spark.isLocal) {
                try {
                  const [gpu, um] = await Promise.all([
                    monitor.collector.collectGpu(),
                    monitor.collector.collectUnifiedMemory(),
                  ]);
                  return fromGpu(gpu, um);
                } catch {
                  /* fall through */
                }
              }
              const snap = monitor.snapshot();
              return fromGpu(snap?.metrics?.gpu, snap?.metrics?.unifiedMemory);
            }
          : null,
    });
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = decodeBenchManager.getActive(spark.id);
  const history = decodeBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = decodeBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: DECODE_BENCH_DEFAULTS,
  });
});

/** Clear finished bench history for a Spark (optional ?port=). Does not cancel a running job. */
app.delete("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  decodeBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job); // already public shape from manager
});

app.delete("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * Prefill throughput + TTFT at selected context sizes (up to 300k).
 *
 * POST body: { port?, contextSizes: number[] }
 * Returns 202 job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A decode benchmark is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let port = req.body?.port != null ? Number(req.body.port) : ports[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  if (!ports.includes(port)) {
    return res.status(400).json({ error: "port is not configured for this Spark" });
  }

  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    const job = prefillBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      contextSizes: req.body?.contextSizes,
      apiKey: resolveLlmApiKey(spark, port),
    });
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = prefillBenchManager.getActive(spark.id);
  const history = prefillBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = prefillBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: PREFILL_BENCH_DEFAULTS,
  });
});

app.delete("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  prefillBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/prefill-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = prefillBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job);
});

app.delete("/api/sparks/:id/llm/prefill-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = prefillBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * LLM Prompt Showcase — concurrent streaming demos.
 *
 * POST body: { port, modelId?, maxTokens?, temperature?, thinking?, promptType?, prompts: string[] }
 * Returns 202 { sessionId }; poll GET for deltas; DELETE :sessionId to cancel.
 * Finished runs are archived; GET collection lists history; DELETE collection clears it.
 */
app.post("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  if (req.body?.port == null) {
    return res.status(400).json({ error: "port is required" });
  }
  const port = Number(req.body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  if (!ports.includes(port)) {
    return res.status(400).json({ error: "port is not configured for this Spark" });
  }

  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    const result = showcaseManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      maxTokens: req.body?.maxTokens,
      temperature: req.body?.temperature,
      thinking: req.body?.thinking,
      promptType: req.body?.promptType,
      prompts: req.body?.prompts,
      apiKey: resolveLlmApiKey(spark, port),
    });
    res.status(202).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/** Active session + finished history summaries (no stream bodies). */
app.get("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  res.json({
    active: showcaseManager.getActive(spark.id),
    history: showcaseManager.getHistory(spark.id),
  });
});

/** Clear finished showcase history for a Spark. Does not cancel a running session. */
app.delete("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a showcase is running" });
  }
  showcaseManager.clearHistory(spark.id);
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const sinceRaw = req.query.since;
  const since =
    sinceRaw != null && sinceRaw !== ""
      ? parseInt(String(sinceRaw), 10)
      : null;
  const session = showcaseManager.getSession(
    spark.id,
    req.params.sessionId,
    Number.isInteger(since) ? since : null
  );
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

app.delete("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const session = showcaseManager.cancel(spark.id, req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

// ─── Power management ────────────────────────────────────
// Shutdown uses host script: sudo -n /usr/local/bin/spark-shutdown (passwordless).
// These routes are unauthenticated like the rest of the LAN dashboard — do not
// expose port 5555 beyond a trusted network.

const SHUTDOWN_BIN = "/usr/local/bin/spark-shutdown";
/**
 * Remote: verify script + passwordless sudo, then background shutdown so SSH
 * returns before the host dies. Failures before backgrounding surface to the UI.
 */
const SHUTDOWN_REMOTE_CMD = [
  `test -x ${SHUTDOWN_BIN} || { echo "missing ${SHUTDOWN_BIN}" >&2; exit 127; }`,
  `sudo -n true || { echo "sudo -n required for ${SHUTDOWN_BIN}" >&2; exit 126; }`,
  `nohup sudo -n ${SHUTDOWN_BIN} >/dev/null 2>&1 &`,
  `sleep 0.3`,
  `exit 0`,
].join("; ");

function shutdownErrorStatus(msg) {
  if (/timed out|connection refused|unreachable|no route|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return 503;
  }
  return 500;
}

/**
 * Only treat "host dropped the SSH session mid-shutdown" as success.
 * Connect timeouts / auth / missing script must remain real errors.
 */
function isBenignShutdownSshError(msg) {
  return /ECONNRESET|Connection reset|broken pipe|Connection closed by remote|closed by remote host|Connection to .* closed/i.test(
    String(msg || "")
  );
}

/**
 * Kick off graceful shutdown. Always aims to return quickly so the browser
 * gets a real JSON response instead of "Failed to fetch" when the SSH session
 * drops as the host powers off.
 */
function initiateSparkShutdown(spark) {
  if (spark.isLocal) {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn("sudo", ["-n", SHUTDOWN_BIN], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (err) => {
          const msg = err.message || String(err);
          if (/ENOENT|not found/i.test(msg)) {
            reject(new Error(`${SHUTDOWN_BIN} not found on this host`));
          } else {
            reject(new Error(msg));
          }
        });
        child.unref();
        resolve("Shutdown initiated");
      } catch (err) {
        reject(err);
      }
    });
  }

  return sshExec(spark, SHUTDOWN_REMOTE_CMD, { timeoutMs: 8000 })
    .then(() => "Shutdown initiated")
    .catch((err) => {
      const msg = err.message || String(err);
      if (isBenignShutdownSshError(msg)) {
        return "Shutdown initiated";
      }
      throw err;
    });
}

/** Batch routes first so they never collide with /:id/* if routing changes. */
app.post("/api/sparks/shutdown-all", async (_req, res) => {
  const results = [];
  // Remotes first, local last — shutting down the dashboard host mid-loop would
  // skip remaining Sparks.
  const ordered = [
    ...registry.sparks.filter((s) => !s.isLocal),
    ...registry.sparks.filter((s) => s.isLocal),
  ];
  for (const spark of ordered) {
    const monitor = monitors.get(spark.id);
    if (!monitor?.online) {
      results.push({ id: spark.id, ok: false, skipped: true, error: "Offline — skipped" });
      continue;
    }
    try {
      // Local dashboard host: acknowledge before power-off kills this process.
      if (spark.isLocal) {
        results.push({ id: spark.id, ok: true, message: "Shutdown initiated" });
        setImmediate(() => {
          void initiateSparkShutdown(spark).catch((err) => {
            console.error(`[shutdown-all] local ${spark.id}:`, err.message);
          });
        });
        continue;
      }
      await initiateSparkShutdown(spark);
      results.push({ id: spark.id, ok: true });
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
    }
  }
  res.json({ success: true, results });
});

app.post("/api/sparks/wake-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const cleanMac = effectiveMac(spark);
    if (!cleanMac) {
      results.push({
        id: spark.id,
        ok: false,
        error: "No MAC address (enP7s7 not seen yet; set override in Edit Spark)",
      });
      continue;
    }
    try {
      const broadcast = broadcastForLanIp(spark.lanIp);
      const sent = await sendWol(cleanMac, broadcast);
      results.push({ id: spark.id, ok: true, mac: sent.mac, broadcast: sent.broadcast });
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
    }
  }
  res.json({ success: true, results });
});

app.post("/api/sparks/:id/shutdown", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Local: send JSON first, then power off — otherwise the process dies mid-response
    // and the UI shows "Failed to fetch".
    if (spark.isLocal) {
      res.json({ success: true, message: "Shutdown initiated" });
      setImmediate(() => {
        void initiateSparkShutdown(spark).catch((err) => {
          console.error(`[shutdown] local ${spark.id}:`, err.message);
        });
      });
      return;
    }

    try {
      const message = await initiateSparkShutdown(spark);
      res.json({ success: true, message, output: message });
    } catch (err) {
      const msg = err.message || String(err);
      res.status(shutdownErrorStatus(msg)).json({
        error: shutdownErrorStatus(msg) === 503 ? `Spark unreachable: ${msg}` : msg,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks/:id/wake", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Body mac > user override > auto-detected enP7s7
    const cleanMac = normalizeMac(req.body?.mac) || effectiveMac(spark);
    if (!cleanMac) {
      if (req.body?.mac || spark.macAddress) {
        return res.status(400).json({
          error: `Invalid MAC address: ${req.body?.mac || spark.macAddress}`,
        });
      }
      return res.status(400).json({
        error:
          "No MAC address yet. Wait until the node is online so enP7s7 can be detected, or set a MAC override in Edit Spark.",
      });
    }

    const broadcast = broadcastForLanIp(spark.lanIp);
    try {
      const sent = await sendWol(cleanMac, broadcast);
      res.json({
        success: true,
        message: `Magic packet sent to ${sent.mac} via ${sent.broadcast}`,
        mac: sent.mac,
        broadcast: sent.broadcast,
      });
    } catch (err) {
      res.status(500).json({ error: `WoL send failed: ${err.message || String(err)}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Static files (built frontend) ───────────────────────
const distDir = path.join(ROOT, "dist");
const indexHtml = path.join(distDir, "index.html");
app.use(express.static(distDir));

// ─── SPA fallback (Express v5 wildcard) ───────────────────
app.get("*splat", (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    return res
      .status(503)
      .type("text")
      .send("Frontend not built. Run `npm run build` or use `npm run dev`.");
  }
  res.sendFile(indexHtml);
});

// ─── WebSocket ──────────────────────────────────────────
// Both endpoints share the HTTP server's upgrade event; path-routed manually
// (two `{path}`-scoped WebSocketServer instances would steal each other's
// upgrades — the first one answers every upgrade with 400 for other paths).
const wss = new WebSocketServer({ noServer: true });
const agentWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else if (pathname === "/agent-ws") agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
  else socket.destroy();
});
agentWss.on("connection", (ws) => {
  let registered = false;
  ws.on("message", async (raw) => {
    if (registered) {
      // Post-handshake frames: resp replies + messages the registry routes.
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "resp" && msg.reqId) {
          agentRegistry._resolvePending(msg.reqId, msg);
          return;
        }
        if (msg.type === "metrics" || msg.type === "llm") {
          const sparkId = agentRegistry.unregister ? [...agentRegistry.connections.entries()].find(([, c]) => c.ws === ws)?.[0] : null;
          if (sparkId) {
            const monitor = monitors.get(sparkId);
            if (monitor) monitor.applyAgentData(msg.domain, msg.type === "llm" ? msg.ports : msg.data);
          }
          return;
        }
        if (msg.type === "serve-log" || msg.type === "job-out" || msg.type === "job-exit") {
          // Relayed to job/serving watchers via the snapshot polling model —
          // the dashboard keeps a capped ring per reqId/scriptId.
          agentDataRings.record(msg);
          return;
        }
        if (msg.type === "pong") return;
        return;
      } catch {
        return;
      }
    }
    // First message must be hello.
    let hello = null;
    try {
      hello = JSON.parse(raw.toString());
    } catch {
      ws.close(4003, "bad handshake frame");
      return;
    }
    if (hello?.type !== "hello") {
      ws.close(4003, "first message must be hello");
      return;
    }
    const sparkIds = new Set(registry.sparkIds);
    const code = agentRegistry.register(ws, hello, getAgentToken(), sparkIds);
    if (code) {
      ws.close(code, code === 4001 ? "bad token" : code === 4002 ? "unknown spark" : "proto mismatch");
      return;
    }
    registered = true;
    const spark = registry.getSpark(hello.sparkId);
    ws.send(JSON.stringify({
      type: "welcome",
      proto: 1,
      sparkId: hello.sparkId,
      config: {
        intervals: {
          gpu: POLL_INTERVAL_GPU,
          cpu: POLL_INTERVAL_CPU,
          ram: POLL_INTERVAL_CPU,
          network: POLL_INTERVAL_NETWORK,
          storage: POLL_INTERVAL_STORAGE,
          llm: POLL_INTERVAL_LLM,
        },
        llmPorts: spark?.llmPorts || [],
        role: spark?.role || "standalone",
        llmMonitoring: spark?.llmMonitoring !== false,
      },
    }));
    console.log(`[agent-ws] ${hello.sparkId} connected (agent v${hello.agentVersion || "?"})`);
  });
  ws.on("close", () => {
    const sparkId = agentRegistry.unregister(ws);
    if (sparkId) console.log(`[agent-ws] ${sparkId} disconnected`);
  });
  ws.on("error", () => {
    /* close follows */
  });
});

wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  // Send the initial snapshot through the same path the broadcast uses so the
  // new client benefits from the same payload format (and bufferedAmount
  // guard, although a freshly-open socket trivially passes it).
  broadcastPayload(buildSnapshotPayload());
  ws.on("close", () => {
    console.log("[ws] client disconnected");
  });
});

// ─── Broadcast snapshot (dynamic interval) ────────────────
let broadcastTimer = null;
let _lastBroadcastPayload = null;

/** Build the snapshot payload string. Centralized so broadcast + refresh share it. */
function buildSnapshotPayload() {
  return JSON.stringify({
    type: "snapshot",
    sparks: orderedSnapshots(),
    refreshInterval: getSettings().pollIntervalMs,
  });
}

/**
 * Send a payload to every open WS client.
 * - Drops clients whose send queue is backlogged (>1 MB) to avoid unbounded
 *   buffering on slow/flaky connections (e.g. phone over spotty WiFi).
 * - Returns the payload so callers can compare against the previous broadcast.
 */
function broadcastPayload(payload) {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return; // OPEN only
    if (client.bufferedAmount > 1_000_000) {
      try {
        client.close(1008, "client too slow");
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      client.send(payload);
    } catch {
      /* per-client send failure — ignore, close handler will clean up */
    }
  });
}

/**
 * Force an immediate broadcast, ignoring the diff cache.
 * Used after a user action (manual refresh / hermes check / update) so the
 * UI reflects the result right away instead of on the next poll tick.
 */
function forceBroadcast() {
  const payload = buildSnapshotPayload();
  _lastBroadcastPayload = payload;
  broadcastPayload(payload);
}

function startBroadcast() {
  const interval = getSettings().pollIntervalMs;
  broadcastTimer = setInterval(() => {
    const payload = buildSnapshotPayload();
    // Skip the broadcast entirely when nothing changed since the last tick.
    // A 1s poll that produces identical snapshots becomes free for idle tabs.
    if (_lastBroadcastPayload !== null && payload === _lastBroadcastPayload) return;
    _lastBroadcastPayload = payload;
    broadcastPayload(payload);
  }, interval);
}

function restartBroadcast() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  _lastBroadcastPayload = null; // force a fresh broadcast on the new cadence
  startBroadcast();
}

// ─── Start ───────────────────────────────────────────────
loadSettings();
seedServingScripts();
ensureAgentToken();
markAgentTokenConfigured();
startBroadcast();

server.listen(PORT, BIND_HOST, () => {
  console.log(`[sparkDash] server listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[sparkDash] WebSocket endpoint ws://${BIND_HOST}:${PORT}/ws`);
  const isLoopback =
    BIND_HOST === "localhost" || BIND_HOST === "::1" || /^127\./.test(BIND_HOST);
  if (isLoopback) {
    console.log("[sparkDash] localhost-only; set BIND_HOST=0.0.0.0 (or a LAN IP) to allow remote access");
  } else {
    console.warn(
      `[sparkDash] WARNING: bound to ${BIND_HOST} — reachable on the LAN. This dashboard is unauthenticated and can SSH into and power off your Sparks; restrict access at the network/firewall layer.`
    );
  }
  startAllMonitors();
});

// ─── Graceful shutdown ─────────────────────────────────
let _shuttingDown = false;
function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[sparkDash] ${signal} received, shutting down…`);
  try {
    // Finalize in-flight benches before the process dies so clients polling
    // GET /llm/bench/:id do not hit "Benchmark not found" after --watch reload.
    decodeBenchManager.interruptAll(
      "Interrupted — server restarted while the benchmark was running"
    );
    prefillBenchManager.interruptAll(
      "Interrupted — server restarted while the benchmark was running"
    );
  } catch (err) {
    console.error("[sparkDash] failed to finalize benchmarks:", err.message);
  }
  try {
    llmDaily.flush();
  } catch (err) {
    console.error("[sparkDash] failed to flush LLM daily history:", err.message);
  }
  try {
    if (broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
    for (const m of monitors.values()) m.stop();
    monitors.clear();
  } catch (err) {
    console.error("[sparkDash] error during shutdown:", err.message);
  }
  try {
    closeTraceStore();
  } catch (err) {
    console.error("[sparkDash] failed to close trace store:", err.message);
  }
  try {
    wss.clients.forEach((c) => {
      try {
        c.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
  wss.close();
  server.close(() => process.exit(0));
  // Safety net: if server.close hangs (lingering keep-alive), force-exit.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server, wss, registry, modelctl, remoteJobs };
