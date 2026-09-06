/**
 * Spark Command Agent (C1/C2) — small daemon on each node holding an OUTBOUND
 * WebSocket to the dashboard.
 *
 * Responsibilities:
 *  - push metric domain snapshots (shapes identical to the dashboard's own
 *    collectors — SystemCollector local mode + LlmProbe run in-process)
 *  - execute dashboard-supplied jobs (argv array, no remote shell) and stream
 *    output (capped 100 KB ring per reqId on the dashboard side)
 *  - supervise serving scripts (spawn + pidfile + log rotate 5 MB + kill
 *    process group on stop)
 *  - reconnect with exponential backoff 1 s → 30 s; on reconnect re-send
 *    hello and re-attach to any running serving child via its pidfile
 *
 * Protocol (proto 1):
 *  → hello      {type:"hello", sparkId, token, proto:1, agentVersion}
 *  ← welcome    {type:"welcome", proto:1, sparkId, config:{intervals, llmPorts, role, llmMonitoring, agentVersion}}
 *  ← config-update {config}
 *  → metrics    {domain, data}        ← llm {ports:[snapshot]}   → pong
 *  ← job-run    {reqId, script(b64), args[]}
 *  → job-out    {reqId, chunk}        → job-exit {reqId, code, logTail}
 *  ← job-kill   {reqId}
 *  ← serve      {reqId, action:"start"|"stop"|"status", scriptId, script(b64)?, env?}
 *  → serve-log  {scriptId, chunk}
 *  ← job-status-req {reqId}          → resp {reqId, ok, payload|error}
 *
 * Node layout on the node:
 *   ~/.sparkcontrol/agent/spark-command-agent.mjs  (esbuild bundle, ws bundled)
 *   ~/.sparkcontrol/agent/config.json          {dashboardUrl, token, sparkId}
 *   ~/.sparkcontrol/runs/<scriptId>.pid/.log   serving supervision state
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { WebSocket } from "ws";

const PROTO = 1;
const AGENT_VERSION = "1.0.0";
const HOME = path.join(os.homedir(), ".sparkcontrol");
const AGENT_DIR = path.join(HOME, "agent");
const RUNS_DIR = path.join(HOME, "runs");
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

function readConfig() {
  const cfgPath = process.env.SPARK_COMMAND_AGENT_CONFIG || path.join(AGENT_DIR, "config.json");
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (!raw.dashboardUrl || !raw.token || !raw.sparkId) {
    throw new Error("agent config.json must define dashboardUrl, token, sparkId");
  }
  return { cfgPath, ...raw };
}

function log(...args) {
  console.log(`[spark-command-agent ${new Date().toISOString()}]`, ...args);
}

// ─── Collectors (reused domain code, local mode) ──────────

async function createCollectors(sparkStub) {
  // Imported lazily so the bundle inlines the shared collectors; HOST_PATHS
  // defaults to real /proc, /sys — the agent runs directly on the node.
  const { SystemCollector } = await import("../../server/collectors/SystemCollector.js");
  const collector = new SystemCollector(sparkStub);
  return collector;
}

// ─── Serving supervision ──────────────────────────────────

class ServingSupervisor {
  constructor(send) {
    this._send = send;
    /** @type {Map<string, {child: import("child_process").ChildProcess, log: fs.WriteStream, scriptId: string, startedAt: number}>} */
    this.children = new Map();
    this._tailStreams = new Map();
  }

  _logPath(scriptId) {
    return path.join(RUNS_DIR, `${scriptId}.log`);
  }

  _pidPath(scriptId) {
    return path.join(RUNS_DIR, `${scriptId}.pid`);
  }

  _tail(scriptId) {
    // 5 MB rotation: truncate-at-start per run; if log exceeds 5 MB mid-run,
    // rotate by rename.
    const logPath = this._logPath(scriptId);
    try {
      const st = fs.statSync(logPath);
      if (st.size > 5 * 1024 * 1024) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      /* first run */
    }
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    return stream;
  }

  /** Re-attach after reconnect: adopt a live child via its pidfile. */
  reattach() {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    for (const f of fs.readdirSync(RUNS_DIR)) {
      if (!f.endsWith(".pid")) continue;
      const scriptId = f.slice(0, -4);
      if (this.children.has(scriptId)) continue;
      try {
        const pid = parseInt(fs.readFileSync(path.join(RUNS_DIR, f), "utf8").trim(), 10);
        process.kill(pid, 0); // liveness probe
        log(`reattached serving child ${scriptId} pid=${pid} (log streaming resumes)`);
        this._startTailOnly(scriptId, pid);
      } catch {
        /* stale pidfile */
      }
    }
  }

  /** Watch a log file for an adopted (not spawned) child and stream chunks. */
  _startTailOnly(scriptId, pid) {
    const logPath = this._logPath(scriptId);
    let offset = 0;
    try {
      offset = fs.statSync(logPath).size;
    } catch {
      offset = 0;
    }
    const timer = setInterval(() => {
      try {
        const st = fs.statSync(logPath);
        if (st.size > offset) {
          const fd = fs.openSync(logPath, "r");
          const buf = Buffer.alloc(st.size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = st.size;
          this._send({ type: "serve-log", scriptId, chunk: buf.toString("utf8") });
        }
        process.kill(pid, 0);
      } catch {
        clearInterval(timer);
      }
    }, 500);
  }

  async handleServe(msg) {
    const { action, scriptId, reqId } = msg;
    try {
      if (action === "start") {
        if (this.children.has(scriptId)) {
          return this._resp(reqId, false, { error: "already running" });
        }
        fs.mkdirSync(RUNS_DIR, { recursive: true });
        const scriptPath = path.join(RUNS_DIR, `${scriptId}.sh`);
        fs.writeFileSync(scriptPath, Buffer.from(msg.scriptB64, "base64"));
        fs.chmodSync(scriptPath, 0o700);
        // Truncate log at start (log overwritten per run, mirrors SSH path).
        fs.writeFileSync(this._logPath(scriptId), "");
        const env = { ...process.env, ...(msg.env || {}) };
        const child = spawn("bash", [scriptPath], {
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const logStream = this._tail(scriptId);
        const send = this._send;
        const push = (chunk) => {
          logStream.write(chunk);
          send({ type: "serve-log", scriptId, chunk: chunk.toString("utf8") });
        };
        child.stdout.on("data", push);
        child.stderr.on("data", push);
        const startedAt = Date.now();
        fs.writeFileSync(this._pidPath(scriptId), String(child.pid));
        this.children.set(scriptId, { child, logStream, scriptId, startedAt });
        child.on("exit", (code) => {
          logStream.end(`\n[spark-command-agent] exited code=${code}\n`);
          this.children.delete(scriptId);
          try {
            const pidNow = parseInt(fs.readFileSync(this._pidPath(scriptId), "utf8"), 10);
            if (pidNow === child.pid) fs.unlinkSync(this._pidPath(scriptId));
          } catch {
            /* already gone */
          }
        });
        return this._resp(reqId, true, { pid: child.pid, startedAt });
      }
      if (action === "stop") {
        const rec = this.children.get(scriptId);
        if (rec) {
          try {
            process.kill(-rec.child.pid, "SIGTERM"); // process group
          } catch {
            try {
              rec.child.kill("SIGTERM");
            } catch {
              /* gone */
            }
          }
          setTimeout(() => {
            try {
              process.kill(-rec.child.pid, "SIGKILL");
            } catch {
              /* gone */
            }
          }, 1500);
          return this._resp(reqId, true, { stopping: true });
        }
        // Not a live child — check pidfile (crash-survivor).
        try {
          const pid = parseInt(fs.readFileSync(this._pidPath(scriptId), "utf8"), 10);
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              /* gone */
            }
          }
          fs.unlinkSync(this._pidPath(scriptId));
          return this._resp(reqId, true, { stopped: true, adopted: true });
        } catch {
          return this._resp(reqId, true, { running: false });
        }
      }
      if (action === "status") {
        const rec = this.children.get(scriptId);
        if (rec) {
          return this._resp(reqId, true, { running: true, pid: rec.child.pid, startedAt: rec.startedAt });
        }
        try {
          const pid = parseInt(fs.readFileSync(this._pidPath(scriptId), "utf8"), 10);
          process.kill(pid, 0);
          const startedAt = fs.statSync(this._pidPath(scriptId)).mtimeMs;
          return this._resp(reqId, true, { running: true, pid, startedAt, adopted: true });
        } catch {
          return this._resp(reqId, true, { running: false });
        }
      }
      return this._resp(reqId, false, { error: `unknown action ${action}` });
    } catch (err) {
      return this._resp(reqId, false, { error: err.message });
    }
  }

  _resp(reqId, ok, payload) {
    return { type: "resp", reqId, ok, payload };
  }

  stopAll() {
    for (const rec of this.children.values()) {
      try {
        process.kill(-rec.child.pid, "SIGTERM");
      } catch {
        try {
          rec.child.kill("SIGTERM");
        } catch {
          /* gone */
        }
      }
    }
  }
}

// ─── Job execution ────────────────────────────────────────

class JobRunner {
  constructor(send) {
    this._send = send;
    /** @type {Map<number, import("child_process").ChildProcess>} */
    this.running = new Map();
    /** Last exit message per reqId (offline replay). */
    this.results = new Map();
  }

  run(msg) {
    const { reqId, scriptB64, args = [], shellMode = false } = msg;
    const script = Buffer.from(scriptB64, "base64").toString("utf8");
    // shellMode: the payload is a shell command list (dashboard builders emit
    // multi-line scripts). Otherwise argv array — no remote shell.
    const child = shellMode
      ? spawn("sh", ["-c", script], { env: process.env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(script, args.map(String), { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    this.running.set(reqId, child);
    let outLen = 0;
    const RING = 100 * 1024;
    let ring = "";
    const onChunk = (chunk) => {
      const text = chunk.toString("utf8");
      outLen += Buffer.byteLength(chunk);
      if (outLen <= RING) ring += text;
      else ring = ring.slice(Math.max(0, ring.length - RING)) + text;
      this._send({ type: "job-out", reqId, chunk: text });
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (err) => {
      this.running.delete(reqId);
      const exitMsg = { type: "job-exit", reqId, code: null, logTail: ring.slice(-4000), error: err.message };
      this.results.set(reqId, exitMsg);
      this._send(exitMsg);
      // resp frame lets agentRegistry.request() await this completion.
      this._send({ type: "resp", reqId, ok: false, error: err.message });
    });
    child.on("exit", (code) => {
      this.running.delete(reqId);
      const exitMsg = { type: "job-exit", reqId, code, logTail: ring.slice(-4000) };
      this.results.set(reqId, exitMsg);
      this._send(exitMsg);
      this._send({ type: "resp", reqId, ok: true, payload: { code, logTail: ring.slice(-4000) } });
    });
  }

  kill(reqId) {
    const child = this.running.get(reqId);
    if (!child) return;
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
}

// ─── Main ─────────────────────────────────────────────────

export async function main() {
  const cfg = readConfig();
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  /** Interval config pushed by the dashboard (welcome.config / config-update). */
  let intervalCfg = { ...cfg.intervals };
  let llmPorts = cfg.llmPorts || [];
  let role = cfg.role || "standalone";
  let llmMonitoring = cfg.llmMonitoring !== false;

  const sparkStub = {
    id: cfg.sparkId,
    isLocal: true,
    kind: "spark",
    disabledDevices: cfg.disabledDevices || [],
    disabledInterfaces: cfg.disabledInterfaces || [],
  };

  const collector = await createCollectors(sparkStub);
  /** port → LlmProbe (mirrors SparkMonitor's llmProbes map). */
  const llmProbes = new Map();
  async function syncLlmProbes() {
    const { LlmProbe } = await import("../../server/collectors/LlmProbe.js");
    const want = new Set(llmPorts);
    for (const [p, probe] of [...llmProbes]) {
      if (!want.has(p)) llmProbes.delete(p);
    }
    for (const p of llmPorts) {
      if (!llmProbes.has(p)) llmProbes.set(p, new LlmProbe({ ...sparkStub, llmPorts }, p));
    }
  }
  if (llmPorts.length > 0) await syncLlmProbes();

  let ws = null;
  let backoff = RECONNECT_MIN_MS;
  let closedByUs = false;

  const send = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  };

  const supervisor = new ServingSupervisor(send);
  const jobs = new JobRunner(send);

  async function handleIncoming(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome": {
        intervalCfg = { ...intervalCfg, ...(msg.config?.intervals || {}) };
        llmPorts = msg.config?.llmPorts || llmPorts;
        role = msg.config?.role || role;
        llmMonitoring = msg.config?.llmMonitoring !== false;
        await syncLlmProbes();
        startLoops();
        backoff = RECONNECT_MIN_MS;
        log("welcome received; cadences applied");
        supervisor.reattach();
        break;
      }
      case "config-update":
        intervalCfg = { ...intervalCfg, ...(msg.config?.intervals || {}) };
        llmPorts = msg.config?.llmPorts || llmPorts;
        role = msg.config?.role || role;
        llmMonitoring = msg.config?.llmMonitoring !== false;
        await syncLlmProbes();
        startLoops();
        if (msg.config?.token) {
          // Token rotation: persist and reconnect with the new token.
          cfg.token = msg.config.token;
          fs.writeFileSync(cfg.cfgPath, JSON.stringify({
            dashboardUrl: cfg.dashboardUrl, token: cfg.token, sparkId: cfg.sparkId,
          }, null, 2));
          closedByUs = true;
          try { ws.close(); } catch { /* ignore */ }
        }
        break;
      case "job-run":
        jobs.run(msg);
        break;
      case "job-kill":
        jobs.kill(msg.reqId);
        break;
      case "job-status-req": {
        const last = jobs.results.get(msg.reqId);
        if (last) send(last);
        else send({ type: "resp", reqId: msg.reqId, ok: false, error: "no such job result" });
        break;
      }
      case "serve":
        supervisor.handleServe(msg).then((r) => send(r));
        break;
      case "ping":
        send({ type: "pong" });
        break;
      default:
        break;
    }
  }

  function connect() {
    closedByUs = false;
    log(`connecting to ${cfg.dashboardUrl}`);
    ws = new WebSocket(cfg.dashboardUrl, { handshakeTimeout: 10_000 });

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "hello", sparkId: cfg.sparkId, token: cfg.token, proto: PROTO, agentVersion: AGENT_VERSION,
      }));
    });

    ws.on("message", (data) => handleIncoming(data.toString()));

    ws.on("close", () => {
      if (closedByUs) {
        // Token rotation closed us — reconnect immediately with new token.
        setTimeout(connect, 250);
        return;
      }
      const wait = backoff;
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      log(`disconnected; reconnecting in ${wait}ms`);
      setTimeout(connect, wait);
    });

    ws.on("error", (err) => {
      log("ws error:", err.message);
    });
  }

  // ── Metric push loops (dashboard-configured cadences) ──
  // Registered at startup with config-file defaults and re-created whenever
  // the dashboard pushes welcome/config-update so cadence changes apply.
  /** @type {ReturnType<typeof setInterval>[]} */
  let loopTimers = [];
  function startLoops() {
    for (const t of loopTimers) clearInterval(t);
    loopTimers = [];
    const loops = [
      ["gpu", intervalCfg.gpu || 2000, () => collector.collectGpu()],
      ["cpu", intervalCfg.cpu || 2000, () => collector.collectCpu()],
      ["ram", intervalCfg.ram || 2000, () => collector.collectRam()],
      ["network", intervalCfg.network || 2000, () => collector.collectNetwork()],
      ["storage", intervalCfg.storage || 5000, () => collector.collectStorage()],
    ];
    for (const [domain, interval, fn] of loops) {
      let busy = false;
      loopTimers.push(setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const data = await fn();
          send({ type: "metrics", domain, data });
        } catch {
          /* collection errors skipped this tick */
        } finally {
          busy = false;
        }
      }, interval));
    }
    // LLM probe loop (detection cadence for workers, full for monitored roles).
    const llmInterval = role === "worker" ? 10_000 : (intervalCfg.llm || 2000);
    loopTimers.push(setInterval(async () => {
      if (llmProbes.size === 0) return;
      try {
        const ports = [];
        for (const probe of llmProbes.values()) {
          const snap = await probe.probe();
          ports.push(snap);
        }
        if (ports.length > 0) send({ type: "llm", ports });
      } catch {
        /* skip */
      }
    }, llmInterval));
  }
  startLoops();

  connect();

  process.on("SIGTERM", () => { supervisor.stopAll(); process.exit(0); });
  process.on("SIGINT", () => { supervisor.stopAll(); process.exit(0); });
}

// Re-export for tests/bundling introspection.
export { PROTO, AGENT_VERSION };

// Entry point when run directly.
if (process.argv[1] && process.argv[1].endsWith("spark-command-agent.mjs")) {
  main().catch((err) => {
    console.error("[spark-command-agent] fatal:", err.message);
    process.exit(1);
  });
}
