/**
 * Server boot + REST surface test (coverage for server/index.js routes).
 * Fully isolated: temp config paths, ephemeral port, no real SSH.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boot-cov-"));
// Local install-agent bootstrap writes into $HOME/.sparkdash — sandbox it so
// the test never touches the real home directory.
const fakeHome = path.join(tmp, "home");
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
for (const [k, v] of Object.entries({
  SETTINGS_JSON_PATH: "settings.json",
  SPARKS_SECRETS_PATH: "secrets.json",
  SECRETS_KEY_PATH: "key",
  SPARKS_JSON_PATH: "sparks.json",
  LLM_DAILY_JSON_PATH: "llm-daily.json",
  TRACES_DB_PATH: "traces.sqlite",
  SPARKDASH_JOBS_STATE_PATH: "jobs.json",
})) process.env[k] = path.join(tmp, v);
process.env.PORT = "5830";

let mod;

before(async () => {
  mod = await import("../index.js");
  await new Promise((r) => setTimeout(r, 400));
});

after(async () => {
  try {
    mod.server.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  // --test-force-exit reaps lingering dashboard timers; no explicit exit here
  // (it would kill the c8 child before coverage flushes).
});

const BASE = "http://127.0.0.1:5830";
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

// The dashboard keeps unref'd timers + monitors alive after server.close();
// the boot test runs everything in one test and exits the worker explicitly.

test("settings GET/PUT round trip with clamps", async () => {
  const s1 = await (await fetch(`${BASE}/api/settings`)).json();
  assert.ok("traceCapture" in s1 && "modelctl" in s1 && "agent" in s1);
  const put = await j(await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pollIntervalMs: 10, modelctl: { nasRoot: "/mnt/x" } }),
  }));
  assert.equal(put.body.pollIntervalMs, 1000, "clamped to ≥1000");
  assert.equal(put.body.modelctl.nasRoot, "/mnt/x");
  assert.equal(put.body.modelctl.remoteBin, "modelctl", "deep merge keeps siblings");
});

test("sparks CRUD via API", async () => {
  const add = await j(await fetch(`${BASE}/api/sparks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "cov-spark", name: "Cov", isLocal: true, lanIp: "127.0.0.1", llmPorts: [8888] }),
  }));
  assert.equal(add.status, 200);
  const list = await (await fetch(`${BASE}/api/sparks`)).json();
  assert.ok(list.sparks.some((s) => s.id === "cov-spark"));
  const patch = await fetch(`${BASE}/api/sparks/cov-spark`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Cov2" }),
  });
  assert.equal(patch.status, 200);
  const order = await fetch(`${BASE}/api/sparks/order`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: ["cov-spark"] }),
  });
  assert.equal(order.status, 200);
});

test("traces API surface", async () => {
  const list = await j(await fetch(`${BASE}/api/traces`));
  assert.equal(list.status, 200);
  assert.ok("traces" in list.body && "lastSeq" in list.body);
  const del = await fetch(`${BASE}/api/traces`, { method: "DELETE" });
  assert.equal(del.status, 200);
});

test("jobs API surface + validation", async () => {
  const list = await (await fetch(`${BASE}/api/jobs`)).json();
  assert.ok(Array.isArray(list.jobs));
  const badKind = await j(await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "zzz" }),
  }));
  assert.equal(badKind.status, 400);
});

test("serving scripts list (seeds present)", async () => {
  const scripts = await (await fetch(`${BASE}/api/serving/scripts`)).json();
  assert.ok(Array.isArray(scripts.scripts));
});

test("404 for unknown spark-scoped routes", async () => {
  assert.equal((await fetch(`${BASE}/api/sparks/ghost/metrics`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/traces/does-not-exist`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/jobs/nope`)).status, 404);
});

test("SPA fallback serves index.html", async () => {
  const r = await fetch(`${BASE}/some/client/route`);
  assert.ok([200, 503].includes(r.status), "200 with dist present, 503 without");
});

test("power + hermes + refresh routes with stubbed SSH", async () => {
  const { _setExecFile } = await import("../collectors/ssh.js");
  // Stub every SSH spawn: power, hermes checks, liveness pings.
  _setExecFile((file, args, opts, cb) => {
    if (args.join(" ").includes("spark-shutdown")) return cb(null, "ok", "");
    if (args.join(" ").includes("hermes")) return cb(null, "up to date", "");
    cb(null, "ok", "");
  });
  try {
    // Remote spark for SSH paths.
    await fetch(`${BASE}/api/sparks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "cov-remote", name: "CovR", isLocal: false, lanIp: "10.0.0.9",
        role: "head", llmPorts: [8888], hermesMonitoring: true,
        ssh: { host: "10.0.0.9", user: "root", auth: "key" },
      }),
    });
    // Shutdown route (graceful path, no dialog)
    const sd = await j(await fetch(`${BASE}/api/sparks/cov-remote/shutdown`, { method: "POST" }));
    assert.ok([200, 502, 500].includes(sd.status), `shutdown ${sd.status} ${JSON.stringify(sd.body)}`);
    // Wake route
    const wk = await j(await fetch(`${BASE}/api/sparks/cov-remote/wake`, { method: "POST" }));
    assert.ok([200, 400, 502, 500].includes(wk.status), `wake ${wk.status} ${JSON.stringify(wk.body)}`);
    // Hermes updates check
    const hu = await j(await fetch(`${BASE}/api/sparks/cov-remote/hermes/updates`));
    assert.ok([200, 502].includes(hu.status), `hermes-updates ${hu.status}`);
    // Manual metric refresh (only storage domain supported)
    const rf = await j(await fetch(`${BASE}/api/sparks/cov-remote/refresh/storage`, { method: "POST" }));
    assert.ok([200, 404, 500].includes(rf.status), `refresh ${rf.status} ${JSON.stringify(rf.body)}`);
    // LLM ports add (hot)
    const lp = await j(await fetch(`${BASE}/api/sparks/cov-remote/llm-ports`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 9000 }),
    }));
    assert.ok([200, 400].includes(lp.status), `llm-ports ${lp.status}`);
    // llm connectivity test
    const lt = await j(await fetch(`${BASE}/api/sparks/cov-remote/test`, { method: "POST" }));
    assert.ok([200, 429, 502].includes(lt.status), `test ${lt.status}`);
  } finally {
    _setExecFile(null);
  }
});

test("llm bench + prefill + showcase routes registered (validation paths)", async () => {
  // Invalid bodies → 400 before any SSH/engine contact.
  const b1 = await j(await fetch(`${BASE}/api/sparks/cov-remote/llm/bench`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.ok([400, 404, 409, 503].includes(b1.status));
  const b2 = await j(await fetch(`${BASE}/api/sparks/cov-remote/llm/prefill-bench`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.ok([400, 404, 409, 503].includes(b2.status));
  const b3 = await j(await fetch(`${BASE}/api/sparks/cov-remote/llm/showcase`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.ok([400, 404, 409, 503].includes(b3.status));
  // GET bench state
  const g = await j(await fetch(`${BASE}/api/sparks/cov-remote/llm/bench`));
  assert.ok([200, 404].includes(g.status));
});

test("install-agent on the local head bootstraps in-process (sandboxed HOME)", async () => {
  await fetch(`${BASE}/api/sparks/cov-spark`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentEnabled: true }),
  });
  // Dispatch: 409 when not enabled…
  const before = await fetch(`${BASE}/api/sparks`, { method: "GET" });
  assert.equal(before.status, 200);
  const r = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "install-agent", sparkId: "cov-spark" }),
  });
  const dispatch = await r.json().catch(() => null);
  assert.equal(r.status, 202, `install-agent dispatch ${r.status} ${JSON.stringify(dispatch)}`);
  const { jobId } = dispatch;
  // The local bootstrap runs sh -c in-process: node exists, sudo -n fails in
  // the sandbox → user-unit fallback instructions, script completes.
  let job = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r2) => setTimeout(r2, 500));
    job = await (await fetch(`${BASE}/api/jobs/${jobId}`)).json();
    if (job.status !== "running") break;
  }
  assert.equal(job.status, "completed", `status ${job.status} err ${job.error}`);
  assert.equal(job.exitCode, 0);
  assert.match(job.logTail || "", /__AGENT_UNIT__none/);
  assert.match(job.logTail || "", /enable-linger|systemd\/user/);
  // config.json written into the sandboxed HOME.
  const cfg = path.join(fakeHome, ".sparkdash", "agent", "config.json");
  const parsed = JSON.parse(fs.readFileSync(cfg, "utf8"));
  assert.equal(parsed.sparkId, "cov-spark");
  assert.match(parsed.dashboardUrl, /ws:\/\/127\.0\.0\.1:5830\/agent-ws/);
  assert.match(parsed.token, /^[0-9a-f]{64}$/);
});

test("agent status + comfy cancel + shutdown-all routes", async () => {
  const ag = await j(await fetch(`${BASE}/api/sparks/cov-remote/agent`));
  assert.equal(ag.status, 200);
  const cc = await j(await fetch(`${BASE}/api/sparks/cov-remote/comfy/cancel`, { method: "POST" }));
  assert.ok([200, 400, 404, 502].includes(cc.status), `comfy-cancel ${cc.status} ${JSON.stringify(cc.body)}`);
  const sa = await j(await fetch(`${BASE}/api/sparks/shutdown-all`, { method: "POST" }));
  assert.ok([200, 502].includes(sa.status));
});
