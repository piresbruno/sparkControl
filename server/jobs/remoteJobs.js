/**
 * Remote job layer (B2) — long-running node operations over the SSH fallback.
 *
 * `sshExec` is blocking (default 10 s, 10 MB buffer), so heavyweight model
 * operations run DETACHED on the node with log polling:
 *   ~/.sparkdash/jobs/<id>.sh   generated script (base64-transported)
 *   ~/.sparkdash/jobs/<id>.log  job output (+ __SPARKDASH_EXIT:<code> trailer)
 *   ~/.sparkdash/jobs/<id>.pid  job pid (nohup)
 *
 * Lifecycle driver (P1): lazy single-flight poll-on-GET (concurrent GETs share
 * one in-flight node poll) + a 30 s background sweeper over active jobs, so
 * transitions happen even with no client watching. Transitions persist to
 * config/modelctl-jobs.json (last 30) via atomicWrite.
 *
 * Boot recovery (P1): persisted `running` jobs stay running on boot and are
 * resolved on first poll — pid alive → still running; dead + exit line →
 * completed/failed; dead without it → interrupted. Never blanket-marked.
 *
 * Per-node single-flight (P1): at most one ACTIVE job per node (any kind).
 *
 * Transport: every script goes base64 (`printf '%s' <b64> | base64 -d > path`).
 * All caller-supplied values pass through shellQuote. DI-friendly: pass
 * `exec` (async (spark, cmd, opts) => stdout) and `now` for tests.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sshExec } from "../collectors/ssh.js";
import { execOnLocalHost } from "../collectors/localHostExec.js";
import { shellQuote } from "../util/shellQuote.js";
import { atomicWrite } from "../util/atomicWrite.js";

/**
 * Execute a command on a spark. Remote sparks go over sshExec; local sparks
 * run on the HOST machine (host mount namespace + host user identity via
 * execOnLocalHost) so host-installed CLIs (modelctl, uv, serving binaries),
 * host mounts (NAS root) and the host user's ~/.sparkdash are visible — the
 * dashboard itself may be containerized, where none of those exist. On a
 * bare-host dev setup this degrades to plain in-process `sh -c`.
 */
export function execOnSpark(spark, cmd, opts = {}) {
  if (spark?.isLocal) {
    return execOnLocalHost(spark, cmd, opts);
  }
  return sshExec(spark, cmd, opts);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

const JOBS_STATE_PATH =
  process.env.SPARKDASH_JOBS_STATE_PATH || path.join(ROOT, "config", "modelctl-jobs.json");

const MAX_PERSISTED_JOBS = 30;
const SWEEP_INTERVAL_MS = 30_000;

/** Artifact pruning prepended to every job (7-day retention on the node). */
export const JOB_PRUNE_CMD =
  "find ~/.sparkdash/jobs -name '*.log' -mtime +7 -delete -o -name '*.sh' -mtime +7 -delete 2>/dev/null || true";

/**
 * Simpler, canonical launcher: writes the script via base64 (no heredoc
 * quoting hazards), launches detached, records pid.
 */
export function buildLaunchCommand(jobId, scriptBody) {
  const b64 = Buffer.from(scriptBody, "utf8").toString("base64");
  return [
    JOB_PRUNE_CMD,
    "mkdir -p ~/.sparkdash/jobs",
    `printf '%s' ${shellQuote(b64)} | base64 -d > ~/.sparkdash/jobs/${shellQuote(jobId)}.sh`,
    `SPARKDASH_LOG=~/.sparkdash/jobs/${shellQuote(jobId)}.log nohup sh ~/.sparkdash/jobs/${shellQuote(jobId)}.sh > ~/.sparkdash/jobs/${shellQuote(jobId)}.log 2>&1 &`,
    `echo $! > ~/.sparkdash/jobs/${shellQuote(jobId)}.pid`,
    `echo "LAUNCHED $(cat ~/.sparkdash/jobs/${shellQuote(jobId)}.pid)"`,
  ].join("\n");
}

/**
 * Wrap a user script so its exit code lands in the job log as
 * __SPARKDASH_EXIT. The wrapper writes to `$0.log`; for `sh jobs/<id>.sh`
 * that is jobs/<id>.sh.log — so the launcher passes the canonical log via
 * SPARKDASH_LOG and the wrapper prefers it.
 */
export function wrapJobScript(scriptBody) {
  return [
    'SPARKDASH_LOG="${SPARKDASH_LOG:-$0.log}"',
    `${scriptBody}`,
    "code=$?",
    'echo "__SPARKDASH_EXIT:$code" >> "$SPARKDASH_LOG" 2>/dev/null || true',
    "exit $code",
  ].join("\n");
}


/**
 * Build the poll command (pure; testable). Tolerates a missing log.
 */
export function buildPollCommand(jobId) {
  const q = shellQuote(jobId);
  return [
    `tail -c 4000 ~/.sparkdash/jobs/${q}.log 2>/dev/null;`,
    "printf '\\n__ALIVE:';",
    `if [ -f ~/.sparkdash/jobs/${q}.pid ] && kill -0 "$(cat ~/.sparkdash/jobs/${q}.pid)" 2>/dev/null; then echo yes; else echo no; fi;`,
    `grep -o '__SPARKDASH_EXIT:[0-9]*' ~/.sparkdash/jobs/${q}.log 2>/dev/null | tail -1`,
  ].join("\n");
}

/**
 * Parse poll output (pure; testable).
 * @param {string} out
 * @returns {{ logTail: string, alive: boolean, exitCode: number | null,
 *             status: "running" | "completed" | "failed" | "interrupted" }}
 */
export function parsePollOutput(out) {
  const aliveMatch = out.match(/__ALIVE:(yes|no)/);
  const exitMatch = out.match(/__SPARKDASH_EXIT:(\d+)/);
  const alive = aliveMatch ? aliveMatch[1] === "yes" : false;
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
  const logTail = out.split("\n__ALIVE:")[0] ?? "";
  let status;
  if (alive) {
    status = "running";
  } else if (exitCode != null) {
    status = exitCode === 0 ? "completed" : "failed";
  } else {
    status = "interrupted";
  }
  return { logTail: logTail.slice(-4000), alive, exitCode, status };
}

/**
 * Build the cancel command (pure; testable).
 */
export function buildCancelCommand(jobId) {
  const q = shellQuote(jobId);
  return [
    `if [ -f ~/.sparkdash/jobs/${q}.pid ]; then`,
    `  PID=$(cat ~/.sparkdash/jobs/${q}.pid);`,
    "  kill \"$PID\" 2>/dev/null || true;",
    "  sleep 1;",
    "  kill -9 \"$PID\" 2>/dev/null || true;",
    "fi; echo cancelled",
  ].join("\n");
}

export class RemoteJobManager {
  /**
   * @param {{
   *   exec?: (spark: object, cmd: string, opts?: object) => Promise<string>,
   *   now?: () => number,
   *   statePath?: string,
   *   sweepIntervalMs?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this._exec = opts.exec || execOnSpark;
    this._now = opts.now || Date.now;
    this._statePath = opts.statePath || JOBS_STATE_PATH;
    this._sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    /** @type {Map<string, object>} jobId → job record */
    this.jobs = new Map();
    /** @type {Map<string, Promise<object>>} jobId → in-flight poll */
    this._pollsInFlight = new Map();
    this._sweepTimer = null;
    this._load();
  }

  // ─── Persistence ──────────────────────────────────────────

  _load() {
    try {
      if (!fs.existsSync(this._statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this._statePath, "utf8"));
      for (const job of raw.jobs || []) {
        // Boot recovery (P1): running jobs stay running; resolved on first poll.
        this.jobs.set(job.jobId, job);
      }
    } catch (err) {
      console.error("[remoteJobs] failed to load state:", err.message);
    }
  }

  _persist() {
    try {
      const jobs = [...this.jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_PERSISTED_JOBS);
      atomicWrite(this._statePath, JSON.stringify({ version: 1, jobs }, null, 2) + "\n", 0o644);
    } catch (err) {
      console.error("[remoteJobs] failed to persist state:", err.message);
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /**
   * Start a detached job on the node.
   * @param {object} spark target node
   * @param {{ name: string, script: string, kind?: string }} spec
   * @returns {Promise<{ jobId: string }>}
   */
  async startRemoteJob(spark, { name, script, kind = "generic", transport = null }) {
    const jobId = `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const wrapped = wrapJobScript(script);
    const cmd = buildLaunchCommand(jobId, wrapped);
    const exec = transport === "ssh" ? sshExec : this._exec;
    await exec(spark, cmd, { timeoutMs: 15_000 });
    const job = {
      jobId,
      kind,
      name,
      sparkId: spark.id,
      status: "running",
      /** "ssh" forces SSH transport even for isLocal sparks (agent bootstrap). */
      transport,
      script: script.slice(0, 4000),
      createdAt: this._now(),
      startedAt: this._now(),
      endedAt: null,
      exitCode: null,
      logTail: "",
    };
    this.jobs.set(jobId, job);
    this._persist();
    return { jobId };
  }

  /**
   * Poll one job (single-flight per jobId; concurrent callers share the
   * in-flight poll). Resolves boot-recovery states on first poll.
   * @param {object} spark target node
   * @param {string} jobId
   * @returns {Promise<object>} job record (updated)
   */
  async pollRemoteJob(spark, jobId) {
    const existing = this._pollsInFlight.get(jobId);
    if (existing) return existing;
    const p = this._pollOnce(spark, jobId).finally(() => this._pollsInFlight.delete(jobId));
    this._pollsInFlight.set(jobId, p);
    return p;
  }

  async _pollOnce(spark, jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (job.status !== "running") return job; // terminal states don't re-poll
    let out = "";
    try {
      const exec = job.transport === "ssh" ? sshExec : this._exec;
      out = await exec(spark, buildPollCommand(jobId), { timeoutMs: 10_000 });
    } catch (err) {
      // Node offline / SSH failure: leave status untouched (still running,
      // resolved on a later poll). Surface via error field only.
      job.lastError = err.message;
      this._persist();
      return job;
    }
    const parsed = parsePollOutput(out);
    job.logTail = parsed.logTail;
    if (parsed.status !== "running" && job.status === "running") {
      // Terminal transition.
      job.status = parsed.status;
      job.exitCode = parsed.exitCode;
      job.endedAt = this._now();
      this._persist();
    } else if (job.status === "running" && job.bootPending) {
      // First poll after boot: pid alive → still running (clear the flag).
      delete job.bootPending;
      this._persist();
    }
    return job;
  }

  /**
   * Speculatively attach a hello-verifier to a job: when the job's exported
   * `expectAgentConnect` is set, the dashboard-side connection watcher marks
   * the job complete/failed based on agent connectivity (see serveAgentHello
   * registration in index.js).
   * @param {string} jobId
   */
  setExpectAgentConnect(jobId, expect = true) {
    const job = this.jobs.get(jobId);
    if (job) job.expectAgentConnect = expect;
  }

  /**
   * Called by index.js connection watchers: nil out the hello expectation once
   * the agent actually connects.
   * @param {string} sparkId
   */
  agentConnected(sparkId) {
    for (const job of this.jobs.values()) {
      if (job.sparkId === sparkId && job.expectAgentConnect && job.status === "running") {
        delete job.expectAgentConnect;
        job.status = "completed";
        job.exitCode = 0;
        job.endedAt = this._now();
        job.logTail = (job.logTail + "\n[install-agent] agent connected (hello verified)").slice(-4000);
        this._persist();
      }
    }
  }

  /**
   * Fail any expectAgentConnect job past its deadline (60 s) with guidance.
   * @param {number} now
   */
  failStaleHelloJobs(now, timeoutMs = 60_000) {
    for (const job of this.jobs.values()) {
      if (job.expectAgentConnect && job.status === "running" && now - job.startedAt > timeoutMs) {
        delete job.expectAgentConnect;
        job.status = "failed";
        job.error = "agent did not connect within 60s — check the journal: systemctl --user status sparkdash-agent (user unit) or journalctl -u sparkdash-agent (system unit)";
        job.endedAt = this._now();
        this._persist();
      }
    }
  }

  /**
   * Cancel a job (kill + kill -9 ladder).
   * @param {object} spark
   * @param {string} jobId
   */
  async cancelRemoteJob(spark, jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    try {
      const exec = job.transport === "ssh" ? sshExec : this._exec;
      await exec(spark, buildCancelCommand(jobId), { timeoutMs: 10_000 });
    } catch (err) {
      job.lastError = err.message;
    }
    if (job.status === "running") {
      job.status = "cancelled";
      job.endedAt = this._now();
      this._persist();
    }
    return job;
  }

  /** All jobs (newest first). */
  listJobs() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Per-node single-flight helper (P1): true when any ACTIVE job already
   * targets the node.
   * @param {string} sparkId
   */
  hasActiveJobForNode(sparkId) {
    for (const job of this.jobs.values()) {
      if (job.sparkId === sparkId && (job.status === "running" || job.status === "pending")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Background sweeper (P1): polls every active job every 30 s so
   * transitions happen with no client watching.
   * @param {(sparkId: string) => object | null} resolveSpark registry lookup
   */
  startSweeper(resolveSpark) {
    if (this._sweepTimer) return;
    this._resolveSpark = resolveSpark;
    this._sweepTimer = setInterval(() => {
      const active = this.listJobs().filter((j) => j.status === "running");
      if (active.some((j) => j.expectAgentConnect)) {
        this.failStaleHelloJobs(Date.now());
      }
      for (const job of active) {
        const spark = resolveSpark(job.sparkId);
        if (!spark) continue;
        this.pollRemoteJob(spark, job.jobId).catch(() => undefined);
      }
    }, this._sweepIntervalMs);
    this._sweepTimer.unref?.();
  }

  stopSweeper() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }
}

/** Dashboard singleton. */
let _manager = null;

export function getRemoteJobManager() {
  if (!_manager) _manager = new RemoteJobManager();
  return _manager;
}
