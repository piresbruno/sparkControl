import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RemoteJobManager,
  buildLaunchCommand,
  buildPollCommand,
  buildCancelCommand,
  parsePollOutput,
  wrapJobScript,
  JOB_PRUNE_CMD,
} from "../remoteJobs.js";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remotejobs-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Fake exec returning canned stdout per call, recording commands. */
function fakeExec(outputs) {
  const calls = [];
  const fn = async (spark, cmd) => {
    calls.push(cmd);
    const out = outputs.shift();
    if (out instanceof Error) throw out;
    if (typeof out === "function") return out(cmd);
    return out ?? "";
  };
  fn.calls = calls;
  return fn;
}

const spark = { id: "spark-1", ssh: { host: "10.0.0.5", user: "root", auth: "key" } };

test("wrapJobScript appends the exit-code trailer to the canonical log", () => {
  const wrapped = wrapJobScript("echo hi");
  assert.match(wrapped, /__SPARKDASH_EXIT:\$code/);
  assert.match(wrapped, /SPARKDASH_LOG/);
  assert.match(wrapped, /exit \$code/);
});

test("buildLaunchCommand: prune prepended, script base64-transported, pid recorded", () => {
  const cmd = buildLaunchCommand("job-1", 'echo "a b" ; echo done\necho "__SPARKDASH_EXIT:$?"');
  assert.ok(cmd.includes(JOB_PRUNE_CMD), "artifact pruning must be prepended");
  assert.ok(cmd.includes("mkdir -p ~/.sparkdash/jobs"));
  assert.ok(cmd.includes("base64 -d > ~/.sparkdash/jobs/job-1.sh"));
  assert.ok(cmd.includes("nohup sh ~/.sparkdash/jobs/job-1.sh"));
  assert.ok(cmd.includes("echo $! > ~/.sparkdash/jobs/job-1.pid"));
  // Script is base64, so shell metacharacters never appear raw.
  assert.ok(!cmd.includes('echo "a b"'));
});

test("buildPollCommand tails log + liveness + exit line, tolerates missing log", () => {
  const cmd = buildPollCommand("job-9");
  assert.match(cmd, /tail -c 4000 ~\/\.sparkdash\/jobs\/job-9\.log 2>\/dev\/null/);
  assert.match(cmd, /kill -0 "\$\(cat ~\/\.sparkdash\/jobs\/job-9\.pid\)"/);
  assert.match(cmd, /__SPARKDASH_EXIT/);
});

test("parsePollOutput: alive / exit 0 / exit nonzero / interrupted", () => {
  assert.deepEqual(parsePollOutput("log line 1\nlog line 2\n__ALIVE:yes"), {
    logTail: "log line 1\nlog line 2",
    alive: true,
    exitCode: null,
    status: "running",
  });
  assert.equal(parsePollOutput("out\n__ALIVE:no\n__SPARKDASH_EXIT:0").status, "completed");
  assert.equal(parsePollOutput("out\n__ALIVE:no\n__SPARKDASH_EXIT:3").status, "failed");
  assert.equal(parsePollOutput("out\n__SPARKDASH_EXIT:3").exitCode, 3);
  assert.equal(parsePollOutput("out\n__ALIVE:no").status, "interrupted");
  assert.equal(parsePollOutput("").status, "interrupted");
});

test("buildCancelCommand: kill then kill -9 fallback", () => {
  const cmd = buildCancelCommand("job-2");
  assert.match(cmd, /kill "\$PID" 2>\/dev\/null \|\| true/);
  assert.match(cmd, /kill -9 "\$PID" 2>\/dev\/null \|\| true/);
});

test("startRemoteJob → running; poll transition to completed persists state", async () => {
  const statePath = path.join(tmp, "jobs.json");
  const exec = fakeExec([
    "LAUNCHED 1234", // start
    "hello from job\n__ALIVE:yes", // poll 1: running
    "hello from job\nbye\n__ALIVE:no\n__SPARKDASH_EXIT:0", // poll 2: completed
  ]);
  const mgr = new RemoteJobManager({ exec, now: () => 1000, statePath, sweepIntervalMs: 60_000 });
  const { jobId } = await mgr.startRemoteJob(spark, { name: "download", script: "echo hi", kind: "download" });
  assert.equal(mgr.getJob(jobId).status, "running");
  await mgr.pollRemoteJob(spark, jobId);
  assert.equal(mgr.getJob(jobId).status, "running");
  await mgr.pollRemoteJob(spark, jobId);
  const done = mgr.getJob(jobId);
  assert.equal(done.status, "completed");
  assert.equal(done.exitCode, 0);
  assert.ok(done.endedAt != null);
  // Persisted with the terminal state.
  const onDisk = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(onDisk.jobs.find((j) => j.jobId === jobId).status, "completed");
});

test("failed exit code → failed status", async () => {
  const exec = fakeExec([
    "LAUNCHED 1",
    "boom\n__ALIVE:no\n__SPARKDASH_EXIT:2",
  ]);
  const mgr = new RemoteJobManager({ exec, now: () => 1, statePath: path.join(tmp, "j.json") });
  const { jobId } = await mgr.startRemoteJob(spark, { name: "n", script: "false" });
  const job = await mgr.pollRemoteJob(spark, jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 2);
});

test("poll with node offline leaves status running (resolved later)", async () => {
  const exec = fakeExec([
    "LAUNCHED 1",
    new Error("ssh: connect failed"),
    "out\n__ALIVE:no\n__SPARKDASH_EXIT:0",
  ]);
  const mgr = new RemoteJobManager({ exec, now: () => 1, statePath: path.join(tmp, "j.json") });
  const { jobId } = await mgr.startRemoteJob(spark, { name: "n", script: "x" });
  let job = await mgr.pollRemoteJob(spark, jobId);
  assert.equal(job.status, "running", "offline poll must not mark interrupted");
  assert.ok(job.lastError);
  job = await mgr.pollRemoteJob(spark, jobId);
  assert.equal(job.status, "completed");
});

test("single-flight: concurrent polls share one node poll", async () => {
  let execCount = 0;
  const exec = async (spark, cmd) => {
    if (cmd.includes("base64 -d")) return "LAUNCHED 1";
    execCount += 1;
    await new Promise((r) => setTimeout(r, 20));
    return "out\n__ALIVE:yes";
  };
  const mgr = new RemoteJobManager({ exec, now: () => 1, statePath: path.join(tmp, "j.json") });
  const { jobId } = await mgr.startRemoteJob(spark, { name: "n", script: "x" });
  const [a, b] = await Promise.all([mgr.pollRemoteJob(spark, jobId), mgr.pollRemoteJob(spark, jobId)]);
  assert.equal(a.status, "running");
  assert.equal(b.status, "running");
  assert.equal(execCount, 1, "both callers must share the same in-flight poll");
});

test("boot recovery: persisted running job resolves on first poll (not blanket-interrupted)", async () => {
  const statePath = path.join(tmp, "jobs.json");
  // Seed a persisted "running" job as if the dashboard died mid-job.
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      jobs: [
        {
          jobId: "job-old",
          kind: "sync",
          name: "sync",
          sparkId: "spark-1",
          status: "running",
          script: "",
          createdAt: 1,
          startedAt: 1,
          endedAt: null,
          exitCode: null,
          logTail: "",
          bootPending: true,
        },
      ],
    })
  );
  // Case 1: pid dead + exit line → completed.
  const exec1 = fakeExec(["out\n__ALIVE:no\n__SPARKDASH_EXIT:0"]);
  const mgr1 = new RemoteJobManager({ exec: exec1, now: () => 2, statePath });
  const j1 = await mgr1.pollRemoteJob(spark, "job-old");
  assert.equal(j1.status, "completed");
  // Case 2: pid dead, no exit line → interrupted (node rebooted).
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, jobs: [{ jobId: "job-old", sparkId: "spark-1", status: "running", createdAt: 1, startedAt: 1, bootPending: true }] }));
  const exec2 = fakeExec(["out\n__ALIVE:no"]);
  const mgr2 = new RemoteJobManager({ exec: exec2, now: () => 2, statePath });
  const j2 = await mgr2.pollRemoteJob(spark, "job-old");
  assert.equal(j2.status, "interrupted");
  // Case 3: pid alive → still running, bootPending cleared.
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, jobs: [{ jobId: "job-old", sparkId: "spark-1", status: "running", createdAt: 1, startedAt: 1, bootPending: true }] }));
  const exec3 = fakeExec(["out\n__ALIVE:yes"]);
  const mgr3 = new RemoteJobManager({ exec: exec3, now: () => 2, statePath });
  const j3 = await mgr3.pollRemoteJob(spark, "job-old");
  assert.equal(j3.status, "running");
  assert.ok(!j3.bootPending);
});

test("per-node single-flight helper detects active jobs", async () => {
  const exec = fakeExec(["LAUNCHED 1"]);
  const mgr = new RemoteJobManager({ exec, now: () => 1, statePath: path.join(tmp, "j.json") });
  await mgr.startRemoteJob(spark, { name: "n", script: "x" });
  assert.equal(mgr.hasActiveJobForNode("spark-1"), true);
  assert.equal(mgr.hasActiveJobForNode("spark-2"), false);
});

test("cancel transitions running → cancelled", async () => {
  const exec = fakeExec(["LAUNCHED 1", "cancelled"]);
  const mgr = new RemoteJobManager({ exec, now: () => 1, statePath: path.join(tmp, "j.json") });
  const { jobId } = await mgr.startRemoteJob(spark, { name: "n", script: "x" });
  const job = await mgr.cancelRemoteJob(spark, jobId);
  assert.equal(job.status, "cancelled");
  assert.ok(job.endedAt != null);
});
