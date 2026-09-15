/**
 * Serve REST surface (P1 routes) — register/probe → block → force → run →
 * state join → logs → stop → orphan, over the same ssh stub as serverBoot.
 * Isolated: temp config paths, ephemeral port 5831, no real SSH.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serve-routes-"));
const fakeHome = path.join(tmp, "home");
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
process.env.SPARKDASH_SERVING_CONFIG_DIR = path.join(tmp, "serving");
process.env.SPARKDASH_PATH_SCRIPTS_PATH = path.join(tmp, "serving", "path-scripts.json");
process.env.SPARKDASH_RUN_PORTS_PATH = path.join(tmp, "serving", "run-ports.json");
for (const [k, v] of Object.entries({
  SETTINGS_JSON_PATH: "settings.json",
  SPARKS_SECRETS_PATH: "secrets.json",
  SECRETS_KEY_PATH: "key",
  SPARKS_JSON_PATH: "sparks.json",
  LLM_DAILY_JSON_PATH: "llm-daily.json",
  TRACES_DB_PATH: "traces.sqlite",
  SPARKDASH_JOBS_STATE_PATH: "jobs.json",
  SPARKDASH_SERVE_RECIPES_PATH: path.join(tmp, "serve-recipes.json"),
  SPARKDASH_SERVE_DEPLOYMENTS_PATH: path.join(tmp, "serve-deployments.json"),
})) process.env[k] = path.join(tmp, v);
process.env.PORT = "0"; // env "0" is truthy -> parseInt 0 -> listen(0) = ephemeral port.

let mod;
let BASE;

before(async () => {
  mod = await import("../index.js");
  await new Promise((r) => setTimeout(r, 400));
  const addr = mod.server.address();
  if (!addr || addr.port === 5555) {
    // Port 0 fell through to the default — bail loudly rather than fight the
    // live dashboard instance.
    throw new Error(`unexpected listen port: ${JSON.stringify(addr)}`);
  }
  BASE = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  try {
    mod.server.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

// ─── node-side fixture: the fake recipe folder as probe output ───
function fakeProbeOut(port, model, servedName) {
  return [
    "__P_FILES__",
    "./start.sh 87400",
    "./start-tp4.sh 81000",
    "__P_GIT__",
    "cafe1234",
    "__P_DIRTY__",
    "__P_DISPATCH__",
    "start",
    "stop",
    "status",
    "logs",
    "__P_ENV__",
    `PORT=${port}`,
    `MODEL=${model}`,
    "NNODES=2",
    "TP=2",
    `SERVED_MODEL_NAME=${servedName}`,
    "WORKER_IP=10.0.0.9",
    "HF_TOKEN=hf_LEAKME",
    "__P_EXAMPLE__",
    "__P_CONTAINERS__",
    'start.sh:CONTAINER_HEAD="${CONTAINER_HEAD:-srv-head}"',
    'start.sh:CONTAINER_WORKER="${CONTAINER_WORKER:-srv-worker}"',
    "__P_END__",
  ].join("\n");
}

test("serve routes surface", async () => {
  const { _setExecFile } = await import("../collectors/ssh.js");
  const calls = [];
  const state = {
    jobsAlive: true,
    probeOut: fakeProbeOut(8899, "glm", "SRV-GLM"),
    nodeModels: [{ name: "glm", runtime: "vllm", repository: "org/GLM", bytes: 1 }],
    containers: "srv-head|running",
    health: "200",
  };
  _setExecFile((file, args, opts, cb) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (cmd.includes("--version")) return cb(null, "modelctl 0.18.0\n", "");
    if (cmd.includes("uv")) return cb(null, "__UV_MISSING__", "");
    if (cmd.includes("list --local --json")) return cb(null, JSON.stringify(state.nodeModels), "");
    if (cmd.includes("list --json --root")) return cb(null, "[]", "");
    if (cmd.includes("__P_FILES__")) return cb(null, state.probeOut, "");
    if (cmd.includes("__S_CONTAINERS__")) {
      return cb(null, `__S_CONTAINERS__\n${state.containers}\n__S_HEALTH__\n${state.health}\n__S_MODELS__\n{"data":[{"id":"SRV-GLM"}]}`, "");
    }
    if (cmd.includes("base64 -d > ~/.sparkdash/jobs")) return cb(null, "LAUNCHED 4242", "");
    if (cmd.includes("./start.sh stop")) return cb(null, "stopped.", "");
    if (cmd.includes("__SPARKDASH_EXIT")) {
      // Poll path: the driver stays alive until the test releases it — the
      // engine now polls jobs in-band during /api/serve/state (freshness).
      return cb(null, state.jobsAlive ? "__ALIVE:yes\n" : "__ALIVE:no\n__SPARKDASH_EXIT:0", "");
    }
    if (cmd.includes("docker logs")) return cb(null, "engine log line", "");
    if (cmd.includes("tail -c")) return cb(null, "driver log line", "");
    return cb(null, "ok", "");
  });

  try {
    // A remote spark with modelctl on.
    const add = await j(
      await fetch(`${BASE}/api/sparks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "srv-spark", name: "Srv", isLocal: false, lanIp: "10.0.0.8",
          ssh: { host: "10.0.0.8", user: "root", auth: "key" }, modelctlEnabled: true,
        }),
      })
    );
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const addB = await j(
      await fetch(`${BASE}/api/sparks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "srv-peer", name: "Peer", isLocal: false, lanIp: "10.0.0.9",
          ssh: { host: "10.0.0.9", user: "root", auth: "key" }, modelctlEnabled: true,
        }),
      })
    );
    assert.equal(addB.status, 200);
    const addNas = await j(
      await fetch(`${BASE}/api/sparks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "srv-nas", name: "Nas", isLocal: false, kind: "nas", lanIp: "10.0.0.10", nasRoot: "/mnt/llms",
          ssh: { host: "10.0.0.10", user: "root", auth: "key" },
        }),
      })
    );
    assert.equal(addNas.status, 200);

    // NAS nodes refuse recipes (D2 class of mistakes).
    const nasReg = await j(
      await fetch(`${BASE}/api/serve/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sparkId: "srv-nas", path: "/mnt/llms/whatever" }),
      })
    );
    assert.equal(nasReg.status, 409);

    // Bad inputs.
    const badPath = await j(
      await fetch(`${BASE}/api/serve/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sparkId: "srv-spark", path: "relative/start.sh" }),
      })
    );
    assert.equal(badPath.status, 400);
    const missingSpark = await j(
      await fetch(`${BASE}/api/serve/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sparkId: "nope", path: "/opt/recipes/glm" }),
      })
    );
    assert.equal(missingSpark.status, 404);

    // Register → probe meta lands, secret VALUES never do.
    const reg = await j(
      await fetch(`${BASE}/api/serve/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sparkId: "srv-spark", path: "/opt/recipes/glm/" }),
      })
    );
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const rec = reg.body.recipe;
    assert.equal(rec.meta.port, 8899);
    assert.equal(rec.meta.class, "repo");
    assert.deepEqual(rec.meta.variants.map((v) => v.rel), ["start-tp4.sh"]);
    assert.deepEqual(rec.meta.secretPresence, { HF_TOKEN: true });
    assert.ok(!JSON.stringify(reg.body).includes("hf_LEAKME"), "probe/secret hygiene over the wire");

    // Same folder re-register → 200, same id (D-folder identity).
    const again = await j(
      await fetch(`${BASE}/api/serve/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sparkId: "srv-spark", path: "/opt/recipes/glm" }),
      })
    );
    assert.equal(again.status, 200);
    assert.equal(again.body.recipe.id, rec.id);

    // List.
    const list = await j(await fetch(`${BASE}/api/serve/recipes`));
    assert.equal(list.status, 200);
    assert.equal(list.body.recipes.length, 1);

    // Start: model present → 202 recipe-run.
    const start = await j(
      await fetch(`${BASE}/api/serve/deployments/${rec.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );
    assert.equal(start.status, 202, JSON.stringify(start.body));
    assert.ok(start.body.jobId);

    // Second start while the driver runs → 409 resource lock.
    const start2 = await j(
      await fetch(`${BASE}/api/serve/deployments/${rec.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );
    assert.equal(start2.status, 400);
    assert.match(start2.body.error, /already active/);

    // State join: containers running + health 200 → healthy even mid-job(warmup).
    const st = await j(await fetch(`${BASE}/api/serve/state`));
    assert.equal(st.status, 200);
    const row = st.body.states.find((x) => x.recipeId === rec.id);
    assert.ok(row, "row present");
    assert.equal(row.state, "healthy");
    assert.equal(row.warmup, true);
    assert.equal(row.port, 8899);
    assert.equal(row.drift.drift, false);
    // D-port: recipe port was auto-registered on the spark.
    const sparkNow = await (await fetch(`${BASE}/api/sparks`)).json();
    assert.ok(sparkNow.sparks.find((s) => s.id === "srv-spark").llmPorts.includes(8899));

    // Logs: driver + engine endpoints.
    const dl = await j(await fetch(`${BASE}/api/serve/logs/${rec.id}?kind=driver`));
    assert.equal(dl.body.log, "driver log line");
    const el = await j(await fetch(`${BASE}/api/serve/logs/${rec.id}?kind=engine&rank=worker`));
    assert.equal(el.body.log, "engine log line");
    assert.equal(el.body.container, "srv-worker");

    // Stop → driver TERM + recipe stop verb; state → stopped.
    const stop = await j(
      await fetch(`${BASE}/api/serve/deployments/${rec.id}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.ok(calls.some((c) => c.includes("./start.sh stop")), "recipe stop verb ran");
    // resolve the cancelled job (poll answers exit 0) so the join can settle.
    const jobsList = await (await fetch(`${BASE}/api/jobs`)).json();
    const serveJob = jobsList.jobs.find((x) => x.kind === "recipe-run");
    assert.ok(serveJob);
    await fetch(`${BASE}/api/jobs/${serveJob.jobId}`);
    state.containers = "";
    state.health = "000";
    const st2 = await j(await fetch(`${BASE}/api/serve/state?refresh=1`));
    const row2 = st2.body.states.find((x) => x.recipeId === rec.id);
    assert.equal(row2.state, "stopped");

    // Placement block: model absent on node → 409 + remediations; force passes.
    state.nodeModels = [];
    const reg2 = await j(
      await fetch(`${BASE}/api/serve/recipes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sparkId: "srv-peer", path: "/opt/recipes/absent" }),
      })
    );
    assert.equal(reg2.status, 201);
    const blocked = await j(
      await fetch(`${BASE}/api/serve/deployments/${reg2.body.recipe.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.blocked, true);
    assert.ok(blocked.body.placement, "placement payload present");
    const forced = await j(
      await fetch(`${BASE}/api/serve/deployments/${reg2.body.recipe.id}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      })
    );
    assert.equal(forced.status, 202);

    // Delete flows.
    const delBusy = await j(await fetch(`${BASE}/api/serve/recipes/${reg2.body.recipe.id}`, { method: "DELETE" }));
    assert.equal(delBusy.status, 409, "delete refuses while a job runs");
    await fetch(`${BASE}/api/serve/deployments/${reg2.body.recipe.id}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const del = await j(await fetch(`${BASE}/api/serve/recipes/${reg2.body.recipe.id}`, { method: "DELETE" }));
    assert.equal(del.status, 200);

    // Unknown ids / verbs.
    const badVerb = await j(await fetch(`${BASE}/api/serve/deployments/${rec.id}/delete`, { method: "POST" }));
    assert.equal(badVerb.status, 400);
    const missing = await j(await fetch(`${BASE}/api/serve/deployments/nope-abc/start`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    assert.equal(missing.status, 404);

    // Orphan on node delete: recipes/deployments orphan, state=orphan.
    const rm = await j(await fetch(`${BASE}/api/sparks/srv-spark`, { method: "DELETE" }));
    assert.equal(rm.status, 200);
    const st3 = await j(await fetch(`${BASE}/api/serve/state?refresh=1`));
    const orph = st3.body.states.find((x) => x.recipeId === rec.id);
    assert.equal(orph.state, "orphan");
    assert.equal(orph.orphaned, true);
  } finally {
    _setExecFile(null);
  }
});

test("status ?all=1 multi-run list + legacy shape still default", async () => {
  const { _setExecFile } = await import("../collectors/ssh.js");
  const calls = [];
  _setExecFile((file, args, opts, cb) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (cmd.includes("for __S in")) {
      return cb(null, "example-vllm running:1700000000\nstart-abcdef stopped\n", "");
    }
    return cb(null, "ok", "");
  });
  try {
    const add = await j(
      await fetch(`${BASE}/api/sparks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "multi-spark", name: "M", isLocal: false, lanIp: "10.0.0.11", ssh: { host: "10.0.0.11", user: "root", auth: "key" } }),
      })
    );
    assert.equal(add.status, 200);
    const all = await j(await fetch(`${BASE}/api/serving/status?sparkId=multi-spark&all=1`));
    assert.equal(all.status, 200);
    assert.equal(all.body.runs.length, 2);
    assert.deepEqual(all.body.runs[0], { scriptId: "example-vllm", running: true, startedAt: 1700000000000 });
    // Legacy single-run default: first RUNNING id wins, old shape.
    const one = await j(await fetch(`${BASE}/api/serving/status?sparkId=multi-spark`));
    assert.equal(one.body.scriptId, "example-vllm");
    assert.equal(one.body.running, true);
    assert.equal(one.body.startedAt, 1700000000000);
    // ONE exec for discovery (was N+1).
    assert.equal(calls.filter((c) => c.includes("for __S in")).length, 2);
  } finally {
    _setExecFile(null);
  }
});

// ─── Serve-section unification: /api/serve/scripts cluster view ───

test("GET /api/serve/scripts: library list + running/path rows with ports", async () => {
  const { _setExecFile } = await import("../collectors/ssh.js");
  // a library script exists in the isolated serving config dir
  const fsP = await import("node:fs");
  const pathP = await import("node:path");
  const cfgDir = process.env.SPARKDASH_SERVING_CONFIG_DIR;
  fsP.mkdirSync(cfgDir, { recursive: true });
  fsP.writeFileSync(
    pathP.join(cfgDir, "example-vllm.sh"),
    "#!/usr/bin/env bash\n# sparkdash-serve: description=vLLM example defaultPort=8080\n"
  );
  const calls = [];
  _setExecFile((file, args, opts, cb) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    if (cmd.includes("for __S in")) return cb(null, "example-vllm running:1700000000\n", "");
    if (cmd.includes("setsid nohup env")) return cb(null, "__START_OK__", "");
    if (cmd.includes("__ST=")) return cb(null, "example-vllm running:1700000000\n", "");
    if (cmd.includes("__FOUND=")) return cb(null, "running:1700000000", "");
    if (cmd.includes("PGID")) return cb(null, "__STOPPED__", "");
    return cb(null, "ok", "");
  });
  try {
    const add = await j(
      await fetch(`${BASE}/api/sparks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "uni-spark", name: "U", isLocal: false, lanIp: "10.0.0.12", ssh: { host: "10.0.0.12", user: "root", auth: "key" } }),
      })
    );
    assert.equal(add.status, 200);

    // launch a path-run → port recorded; stop → row kept as stopped path entry
    const st = await j(
      await fetch(`${BASE}/api/serving/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sparkId: "uni-spark", scriptPath: "/home/me/start-x.sh", port: 9090 }),
      })
    );
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.status.running, true);
    assert.ok(st.body.scriptId.startsWith("start-x-"), st.body.scriptId);

    const list = await j(await fetch(`${BASE}/api/serve/scripts?refresh=1`));
    assert.equal(list.status, 200);
    assert.ok(list.body.scripts.some((x) => x.id === "example-vllm"), "library list includes seeded example-vllm");
    // path-recorded run is visible as a stopped row on its node, with the port
    const pathRow = list.body.runs.find((r) => r.kind === "path");
    assert.ok(pathRow, "path row present");
    assert.equal(pathRow.sparkId, "uni-spark");
    assert.equal(pathRow.path, "/home/me/start-x.sh");
    assert.equal(pathRow.port, 9090, "run-port persisted at start");
    // the running library script row carries a port (defaultPort fallback)
    const runRow = list.body.runs.find((r) => r.scriptId === "example-vllm");
    assert.ok(runRow?.running, "example-vllm running row");
    assert.equal(runRow.port, 8080);
    assert.ok(list.body.nodes.some((n) => n.sparkId === "uni-spark" && !n.probeError));
    // caching: refresh omitted → same payload, no extra execs
    const before = calls.length;
    await j(await fetch(`${BASE}/api/serve/scripts`));
    assert.equal(calls.length, before, "5 s cache must not re-probe");
  } finally {
    _setExecFile(null);
    fsP.rmSync(pathP.join(cfgDir, "example-vllm.sh"), { force: true });
  }
});
