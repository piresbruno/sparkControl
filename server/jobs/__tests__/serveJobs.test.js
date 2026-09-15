/**
 * P0a — serve-job semantics in the remote job layer: node-gate exemption
 * both directions, per-folder resource lock, active-pinned persistence,
 * TERM-only cancel (no kill -9 ladder) for recipe-run jobs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RemoteJobManager,
  SERVE_JOB_KINDS,
  buildCancelCommand,
} from "../remoteJobs.js";

function tracker(outputs) {
  const calls = [];
  let i = 0;
  const fn = async (spark, cmd, opts) => {
    calls.push({ spark: spark.id, cmd, opts });
    const out = typeof outputs === "function" ? outputs(cmd) : Array.isArray(outputs) ? outputs[i++] : undefined;
    if (out instanceof Error) throw out;
    return out ?? "LAUNCHED 4242";
  };
  fn.calls = calls;
  return fn;
}

const sparkA = { id: "spark-a", ssh: { host: "10.0.0.5", user: "root", auth: "key" } };
const sparkB = { id: "spark-b", ssh: { host: "10.0.0.6", user: "root", auth: "key" } };

test("recipe-run is exempt from hasActiveJobForNode in both directions", async () => {
  const exec = tracker();
  let t = 1000;
  const mgr = new RemoteJobManager({ exec, statePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rj-")), "jobs.json"), now: () => (t += 1000) });

  const { jobId } = await mgr.startRemoteJob(sparkA, {
    name: "serve glm", script: "echo x", kind: "recipe-run", resource: "spark-a:/opt/recipes/glm",
  });
  const job = mgr.getJob(jobId);
  assert.equal(job.resource, "spark-a:/opt/recipes/glm", "resource recorded");
  assert.equal(job.kind, "recipe-run");

  // Node gate ignores the serve job → modelctl jobs still allowed.
  assert.equal(mgr.hasActiveJobForNode("spark-a"), false, "serve job must not block node");
  // Non-serve active job still blocks the node.
  await mgr.startRemoteJob(sparkA, { name: "sync", script: "echo s", kind: "sync" });
  assert.equal(mgr.hasActiveJobForNode("spark-a"), true);
  // And the serve job doesn't count for the folder's second start attempt.
  assert.equal(mgr.hasActiveJobForResource("spark-a:/opt/recipes/glm"), true);
  assert.equal(mgr.hasActiveJobForResource("spark-a:/other"), false);
});

test("startRemoteJob rejects a second active job on the same resource via route-level lock helper", async () => {
  const mgr = new RemoteJobManager({
    exec: tracker(),
    statePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rj-")), "jobs.json"),
    now: () => Date.now(),
  });
  await mgr.startRemoteJob(sparkA, { name: "serve", script: "echo x", kind: "recipe-run", resource: "spark-a:/r" });
  assert.ok(mgr.hasActiveJobForResource("spark-a:/r"));
  const active = mgr.listActiveJobsForResource("spark-a:/r");
  assert.equal(active.length, 1);
  assert.equal(active[0].kind, "recipe-run");
});

test("persistence keeps ALL active jobs even past the terminal cap", async () => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rj-")), "jobs.json");
  let t = 1_000_000;
  const exec = tracker();
  const mgr = new RemoteJobManager({ exec, statePath, now: () => (t += 1000) });
  // A long-running serve job starts FIRST (oldest).
  const { jobId } = await mgr.startRemoteJob(sparkA, { name: "serve", script: "echo x", kind: "recipe-run", resource: "spark-a:/slow" });
  // 40 terminal jobs follow (newest evict it from a plain slice(0, 30)).
  for (let i = 0; i < 40; i++) {
    const j = await mgr.startRemoteJob(sparkA, { name: `job${i}`, script: "echo x", kind: "generic" });
    const rec = mgr.getJob(j.jobId);
    rec.status = "completed";
    rec.endedAt = t + 1;
    mgr._persist();
  }
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.ok(
    persisted.jobs.some((j) => j.jobId === jobId && j.status === "running"),
    "active serve job must survive the terminal-job cap"
  );
  assert.ok(persisted.jobs.length <= 40 + 1 + 5, "cap still applies to terminal jobs");
});

test("cancel of a recipe-run uses TERM-only (no kill -9 ladder) and 15 s budget", async () => {
  const exec = tracker(() => "LAUNCHED 1");
  const mgr = new RemoteJobManager({ exec, statePath: "/tmp/rj-cancel-test.json", now: () => Date.now() });
  const { jobId } = await mgr.startRemoteJob(sparkA, { name: "serve", script: "echo x", kind: "recipe-run", resource: "spark-a:/r" });
  exec.calls.length = 0;
  const job = await mgr.cancelRemoteJob(sparkA, jobId);
  assert.equal(job.status, "cancelled");
  const cancelCmd = exec.calls.at(-1).cmd;
  // TERM goes to the driver's PROCESS GROUP (wrapper + recipe launcher share
  // it) — a lone wrapper kill would leave start.sh alive to late-launch.
  assert.match(cancelCmd, /ps -o pgid=/, "group lookup");
  assert.match(cancelCmd, /kill -TERM -"\$PG"/, "group TERM");
  assert.doesNotMatch(cancelCmd, /kill -9/, "no escalation for serve drivers");
  assert.equal(exec.calls.at(-1).opts.timeoutMs, 15_000);
});

test("cancel of non-serve kinds keeps the kill -9 ladder + 10 s budget", async () => {
  const exec = tracker(() => "LAUNCHED 1");
  const mgr = new RemoteJobManager({ exec, statePath: "/tmp/rj-cancel-test2.json", now: () => Date.now() });
  const { jobId } = await mgr.startRemoteJob(sparkA, { name: "generic", script: "echo x", kind: "generic" });
  exec.calls.length = 0;
  await mgr.cancelRemoteJob(sparkA, jobId);
  assert.match(exec.calls.at(-1).cmd, /kill -9/);
  assert.equal(exec.calls.at(-1).opts.timeoutMs, 10_000);
});

test("buildCancelCommand termOnly is pure and both shapes exist", () => {
  const t = buildCancelCommand("j1", { termOnly: true });
  assert.match(t, /kill -TERM -"\$PG"/);
  assert.doesNotMatch(buildCancelCommand("j1", { termOnly: true }), /kill -9/);
  assert.match(buildCancelCommand("j1"), /kill -9 "\$PID" 2>\/dev\/null \|\| true/);
});

test("SERVE_JOB_KINDS surface is recipe-run (route whitelist pairs with this)", () => {
  assert.ok(SERVE_JOB_KINDS.has("recipe-run"));
  assert.ok(!SERVE_JOB_KINDS.has("sync"));
});
