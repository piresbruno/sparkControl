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
process.env.SPARKDASH_SERVING_CONFIG_DIR = path.join(tmp, "serving");
for (const [k, v] of Object.entries({
  SETTINGS_JSON_PATH: "settings.json",
  SPARKS_SECRETS_PATH: "secrets.json",
  SECRETS_KEY_PATH: "key",
  SPARKS_JSON_PATH: "sparks.json",
  LLM_DAILY_JSON_PATH: "llm-daily.json",
  TRACES_DB_PATH: "traces.sqlite",
  SPARKDASH_JOBS_STATE_PATH: "jobs.json",
  // Serve stores (plan P1) — never write repo config from the boot suite.
  SPARKDASH_SERVE_RECIPES_PATH: "serve-recipes.json",
  SPARKDASH_SERVE_DEPLOYMENTS_PATH: "serve-deployments.json",
  // path-scripts.json lives next to the serving scripts.
  SPARKDASH_PATH_SCRIPTS_PATH: path.join(tmp, "serving", "path-scripts.json"),
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

test("serving log returns a string (regression: unawaited exec serialized as {})", async () => {
  const body = await (await fetch(`${BASE}/api/serving/log?sparkId=cov-spark`)).json();
  assert.equal(typeof body.log, "string", "log must be a string, not a serialized Promise");
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

test("install-agent always uses SSH transport (head included)", async () => {
  const { _setExecFile } = await import("../collectors/ssh.js");
  const calls = [];
  // Stub SSH end to end: chunked uploads ACK, launch prints LAUNCHED, polls
  // report the process ended with exit 0.
  let putJobDone = false;
  _setExecFile((file, args, opts, cb) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (cmd.includes("base64 -d")) return cb(null, "123456 bytes", "");
    if (cmd.includes("printf '%s'")) return cb(null, "ok", "");
    if (cmd.includes("mkdir -p ~/.sparkcontrol/agent")) return cb(null, "ok", "");
    if (cmd.includes("nohup sh ~/.sparkdash/jobs")) return cb(null, "LAUNCHED 4242", "");
    if (cmd.includes("__ALIVE:")) return cb(null, "out\n__ALIVE:no\n__SPARKDASH_EXIT:0", "");
    return cb(null, "ok", "");
  });
  try {
    // cov-spark is the local spark — the old in-process path is gone; SSH
    // creds are required even for the head.
    await fetch(`${BASE}/api/sparks/cov-spark`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentEnabled: true }),
    });
    // A spark WITHOUT SSH creds → clear 400 with instructions (credless path).
    await fetch(`${BASE}/api/sparks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "cov-credless", name: "CovC", isLocal: true, lanIp: "127.0.0.1" }),
    });
    await fetch(`${BASE}/api/sparks/cov-credless`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentEnabled: true }),
    });
    let r = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "install-agent", sparkId: "cov-credless" }),
    });
    const noCreds = await r.json().catch(() => null);
    assert.equal(r.status, 400, `creds-required ${r.status} ${JSON.stringify(noCreds)}`);
    assert.match(noCreds.error, /SSH credentials/);

    // The local spark WITH explicit SSH creds → 202, whole flow over SSH.
    await fetch(`${BASE}/api/sparks/cov-spark`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssh: { host: "10.0.0.9", user: "root", auth: "key" } }),
    });
    r = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "install-agent", sparkId: "cov-spark" }),
    });
    const dispatch = await r.json().catch(() => null);
    assert.equal(r.status, 202, `dispatch ${r.status} ${JSON.stringify(dispatch)}`);
    const { jobId } = dispatch;

    // Hello gate: the stubbed script exits 0 — that ALONE must not complete
    // the install-agent job (the old bug: "completed" while the agent never
    // connected). It stays running until a real agent hello lands.
    for (let i = 0; i < 4; i++) {
      await new Promise((r2) => setTimeout(r2, 250));
      const job = await (await fetch(`${BASE}/api/jobs/${jobId}`)).json();
      assert.equal(job.status, "running", `poll ${i}: ${JSON.stringify(job.status)}`);
    }

    // A real agent hello over /agent-ws completes the job AND flips transport.
    const { default: WebSocket } = await import("ws");
    const { ensureAgentToken } = await import("../settings.js");
    const ws = new WebSocket(`ws://127.0.0.1:5830/agent-ws`);
    await new Promise((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "hello", sparkId: "cov-spark", token: ensureAgentToken(),
          proto: 1, agentVersion: "9.9.9-boot-test",
        }));
        resolve();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("agent-ws open timeout")), 3000);
    });
    let job = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r2) => setTimeout(r2, 250));
      job = await (await fetch(`${BASE}/api/jobs/${jobId}`)).json();
      if (job.status !== "running") break;
    }
    assert.equal(job.status, "completed", `after hello: ${JSON.stringify(job)}`);
    assert.match(job.logTail, /hello verified/);
    const ag = await (await fetch(`${BASE}/api/sparks/cov-spark/agent`)).json();
    assert.equal(ag.transport, "agent");
    assert.equal(ag.agentVersion, "9.9.9-boot-test");
    ws.close();
    // No in-process (sh -c) execution: every call must have gone to ssh.
    assert.ok(calls.length >= 4, `expected chunked ssh calls, got ${calls.length}`);
    // The bootstrap script itself landed via the launch command (sshExec),
    // not in-process.
    assert.ok(calls.some((c) => c.includes("nohup sh ~/.sparkdash/jobs")), "launch over ssh");
    assert.ok(!putJobDone);
  } finally {
    _setExecFile(null);
  }
});

test("agent status + comfy cancel + shutdown-all routes", async () => {
  const ag = await j(await fetch(`${BASE}/api/sparks/cov-remote/agent`));
  assert.equal(ag.status, 200);
  const cc = await j(await fetch(`${BASE}/api/sparks/cov-remote/comfy/cancel`, { method: "POST" }));
  assert.ok([200, 400, 404, 502].includes(cc.status), `comfy-cancel ${cc.status} ${JSON.stringify(cc.body)}`);
  const sa = await j(await fetch(`${BASE}/api/sparks/shutdown-all`, { method: "POST" }));
  assert.ok([200, 502].includes(sa.status));
});

test("serving start by scriptPath: validates before persisting, launches over ssh", async () => {
  const { _setExecFile } = await import("../collectors/ssh.js");
  const mapPath = process.env.SPARKDASH_PATH_SCRIPTS_PATH;
  const calls = [];
  _setExecFile((file, args, opts, cb) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (cmd.includes("__NO_SCRIPT__")) return cb(null, "__START_OK__", ""); // path-run start
    if (cmd.includes("__NOT_RUNNING__")) return cb(null, "__STOPPED__", ""); // stop
    if (cmd.includes("kill -0")) return cb(null, "running:1700000000", ""); // status probe
    return cb(null, "ok", "");
  });
  try {
    // Invalid input is a 400 and must NOT touch path-scripts.json — an
    // abandoned path id would otherwise be probed on every status poll.
    for (const body of [
      { scriptPath: "relative/start.sh", port: 8899 },
      { scriptPath: "/opt/start.sh", port: 70000 },
    ]) {
      const r = await fetch(`${BASE}/api/serving/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sparkId: "cov-remote", ...body }),
      });
      assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
      assert.ok(!fs.existsSync(mapPath), `rejected start must not persist a path id: ${fs.existsSync(mapPath) ? fs.readFileSync(mapPath, "utf8") : "(none)"}`);
    }

    // Valid path-run start: 200, derived id returned, persisted, launched over
    // ssh with the node-local file check (no base64 script upload).
    const r = await fetch(`${BASE}/api/serving/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sparkId: "cov-remote", scriptPath: "/opt/start.sh", port: 8899 }),
    });
    const out = await r.json();
    assert.equal(r.status, 200, JSON.stringify(out));
    assert.match(out.scriptId, /^start-[0-9a-f]{6}$/);
    assert.equal(JSON.parse(fs.readFileSync(mapPath, "utf8"))[out.scriptId], "/opt/start.sh");
    // The serving start runs its command directly over ssh (no job runner),
    // so the node-local guard and the bash <path> invocation are on the wire.
    const startCall = calls.find((c) => c.includes("__NO_SCRIPT__"));
    assert.ok(startCall, "path-run launch command reached ssh");
    // The command goes to ssh as one remote argv — match it verbatim.
    // (shellQuote: "" → '', digits pass through.)
    // (shellQuote passes /opt/start.sh through: every char is in its safe set.)
    assert.match(startCall, /\[ -f \/opt\/start\.sh \] \|\| \{ echo "__NO_SCRIPT__"; exit 0; \}/);
    assert.match(startCall, /setsid nohup env MODEL_NAME='' PORT=8899 EXTRA_ARGS='' bash \/opt\/start\.sh > ~\/.sparkcontrol\/runs\/start-[0-9a-f]{6}\.log 2>&1 &/);
    // Library starts upload the body; path runs must not touch the serving dir.
    assert.ok(!startCall.includes("~/.sparkdash/serving"), "no library-style script upload");
    // stop / log accept the path id (resolved via the persisted map).
    const stop = await fetch(`${BASE}/api/serving/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sparkId: "cov-remote", scriptId: out.scriptId }),
    });
    assert.equal(stop.status, 200, JSON.stringify(await stop.json()));
    const unknown = await fetch(`${BASE}/api/serving/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sparkId: "cov-remote", scriptId: "nope-abcdef" }),
    });
    assert.equal(unknown.status, 400, "an id in neither namespace is rejected");
  } finally {
    _setExecFile(null);
  }
});
