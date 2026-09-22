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
 * Per-node single-flight (P1): at most one ACTIVE job per node (any kind) —
 * EXCEPT serve jobs (`kind: "recipe-run"`, plan P0a): an hours-long recipe driver
 * neither blocks modelctl jobs nor is blocked by them; serve jobs are instead
 * serialized per recipe folder via `resource` (one active job per resource).
 * Persistence keeps ALL active jobs (terminal jobs are what `MAX_PERSISTED_JOBS`
 * trims — a running serve driver must never be evicted from the state file).
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

/**
 * Serve job kinds (plan P0a): exempt from the per-node single-flight gate in
 * both directions, serialized instead per `resource` (a recipe folder), kept
 * in persisted state regardless of the terminal-job cap, and cancelled with
 * TERM only (no kill -9 ladder) so a serve driver dies without escalating.
 */
export const SERVE_JOB_KINDS = new Set(["recipe-run"]);

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
 * @param {string} jobId
 * @param {{ termOnly?: boolean }} [opts] termOnly = SIGTERM the driver's
 *   PROCESS GROUP (no kill -9 escalation): the job wrapper and its child
 *   recipe launcher share the non-interactive shell's group (no job
 *   control), so a group TERM kills the launcher too — a lone wrapper TERM
 *   would leave start.sh alive to launch containers AFTER the stop [R4].
 */
export function buildCancelCommand(jobId, { termOnly = false } = {}) {
  const q = shellQuote(jobId);
  if (termOnly) {
    return [
      `if [ -f ~/.sparkdash/jobs/${q}.pid ]; then`,
      `  PID=$(cat ~/.sparkdash/jobs/${q}.pid);`,
      `  PG=$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ');`,
      `  if [ -n "$PG" ]; then kill -TERM -"$PG" 2>/dev/null || true; else kill "$PID" 2>/dev/null || true; fi`,
      "fi; echo cancelled",
    ].join("\n");
  }
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
   *   onJobTerminal?: (job: object) => void,
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
    /** @type {((job: object) => void) | null} cache-invalidation hook (set by server boot) */
    this.onJobTerminal = opts.onJobTerminal || null;
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
      // Active jobs always persist (an hours-long serve driver must never be
      // evicted by the terminal-cap); only terminal records are capped.
      const all = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
      const active = all.filter((j) => j.status === "running" || j.status === "pending");
      const terminal = all.filter((j) => j.status !== "running" && j.status !== "pending");
      const jobs = [...active, ...terminal.slice(0, MAX_PERSISTED_JOBS)].sort(
        (a, b) => b.createdAt - a.createdAt
      );
      atomicWrite(this._statePath, JSON.stringify({ version: 1, jobs }, null, 2) + "\n", 0o644);
    } catch (err) {
      console.error("[remoteJobs] failed to persist state:", err.message);
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /**
   * Start a detached job on the node.
   * @param {object} spark target node
   * @param {{ name: string, script: string, kind?: string, transport?: string|null,
   *           resource?: string|null }} spec — `resource` is the serve-folder
   *           lock key for recipe-run jobs (one active job per folder).
   * @returns {Promise<{ jobId: string }>}
   */
  async startRemoteJob(spark, { name, script, kind = "generic", transport = null, resource = null }) {
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
      /** Serve-folder lock key (recipe-run only). */
      ...(resource ? { resource } : {}),
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
    // Enforce the hello deadline on any poll (the UI polls at 1 s — don't make
    // it wait for the 30 s sweeper to learn the agent never showed up).
    if (job.expectAgentConnect) this.failStaleHelloJobs(this._now());
    if (job.status !== "running") return job;
    let out = "";
    try {
      const exec = job.transport === "ssh" ? sshExec : this._exec;
      out = await exec(spark, buildPollCommand(jobId), { timeoutMs: 10_000 });
      // Node reachable again — a transient poll failure no longer describes
      // this job; don't let it haunt the terminal status in the UI.
      delete job.lastError;
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
      if (job.expectAgentConnect && parsed.status === "completed") {
        // Bootstrap script succeeded — the job is only "done" once the
        // agent's hello lands (agentConnected) or failStaleHelloJobs times
        // it out. Exit 0 alone does NOT mean the agent runs.
        this._persist();
        return job;
      }
      // Terminal transition.
      delete job.expectAgentConnect;
      job.status = parsed.status;
      job.exitCode = parsed.exitCode;
      job.endedAt = this._now();
      this._persist();
      this._notifyTerminal(job);
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
        this._notifyTerminal(job);
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
        job.lastError = "agent did not connect within 60s — check the journal: systemctl --user status spark-command-agent (user unit) or journalctl -u spark-command-agent (system unit)";
        job.endedAt = this._now();
        this._persist();
        this._notifyTerminal(job);
      }
    }
  }

  /**
   * Cancel a job. Non-serve kinds: kill + kill -9 ladder. Serve kinds
   * (`SERVE_JOB_KINDS`): TERM only — the deployment engine follows with the
   * recipe's own stop verb; escalation here would race docker teardown.
   * @param {object} spark
   * @param {string} jobId
   */
  async cancelRemoteJob(spark, jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    const serve = SERVE_JOB_KINDS.has(job.kind);
    try {
      const exec = job.transport === "ssh" ? sshExec : this._exec;
      await exec(spark, buildCancelCommand(jobId, { termOnly: serve }), {
        timeoutMs: serve ? 15_000 : 10_000,
      });
    } catch (err) {
      job.lastError = err.message;
    }
    if (job.status === "running") {
      job.status = "cancelled";
      job.endedAt = this._now();
      this._persist();
      this._notifyTerminal(job);
    }
    return job;
  }

  /**
   * Fire the boot-registered cache-invalidation hook after a job reaches a
   * terminal state. Never lets a hook error break the poll/cancel path.
   * @param {object} job
   */
  _notifyTerminal(job) {
    if (!this.onJobTerminal) return;
    try {
      this.onJobTerminal(job);
    } catch (err) {
      console.error("[remoteJobs] onJobTerminal hook failed:", err.message);
    }
  }

  /** All jobs (newest first). */
  listJobs() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Per-node single-flight helper (P1): true when any ACTIVE NON-SERVE job
   * targets the node. Serve jobs (recipe-run) are excluded in both directions:
   * an hours-long driver must not lock modelctl jobs out of its node, and a
   * modelctl transfer must not 409 a deployment start (plan P0a). Serve jobs
   * serialize per folder via hasActiveJobForResource.
   * @param {string} sparkId
   */
  hasActiveJobForNode(sparkId) {
    for (const job of this.jobs.values()) {
      if (SERVE_JOB_KINDS.has(job.kind)) continue;
      if (job.sparkId === sparkId && (job.status === "running" || job.status === "pending")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Serve-folder lock (P0a): true when an ACTIVE recipe-run job already owns
   * `resource` (the recipe folder key, `${sparkId}:${path}`).
   * @param {string} resource
   */
  hasActiveJobForResource(resource) {
    if (!resource) return false;
    for (const job of this.jobs.values()) {
      if (!SERVE_JOB_KINDS.has(job.kind)) continue;
      if (job.resource === resource && (job.status === "running" || job.status === "pending")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Active (running/pending) serve jobs for one folder resource, newest first.
   * @param {string} resource
   */
  listActiveJobsForResource(resource) {
    return this.listJobs().filter(
      (j) =>
        SERVE_JOB_KINDS.has(j.kind) &&
        j.resource === resource &&
        (j.status === "running" || j.status === "pending")
    );
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
