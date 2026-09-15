/**
 * P1 — recipe probe parsing + ServeEngine lifecycle semantics:
 * register/probe round-trip (fixture-shaped output), secret hygiene
 * (values NEVER stored), placement hard block + escape hatch + never-block
 * on unknown, TERM-first stop + desired-wins-over-failed-job, join
 * precedence (healthy > warmup-starting > stopping > failed), port coupling,
 * orphan GC on spark removal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RecipeStore,
  parseEnvText,
  parseContainerLines,
  parseRecipeProbe,
  parseProbeOutput,
  versionDrift,
  recipeKey,
} from "../recipes.js";
import {
  DeploymentStore,
  ServeEngine,
  joinServeState,
  modelInInventory,
  buildRecipeRunScript,
  buildRecipeVerbCommand,
  buildHeadProbeCommand,
  parseProbeStatus,
  rankStates,
  buildDriverLogCommand,
  buildEngineLogCommand,
} from "../deployments.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "serve-"));
}

// ─── probe parsing ─────────────────────────────────────────

const GLM_FILES = [
  "./download.sh 549",
  "./start-tp4.sh 81000",
  "./start.sh 87400",
  "./stop.sh 414",
];

function fakeProbe({ env = "", example = "", containers = [], dispatch = "start\nstop\nrestart\nstatus\nlogs\ndownload", files = GLM_FILES, git = "abc123", dirty = "" }) {
  return [
    "__P_FILES__",
    ...files,
    "__P_GIT__",
    git,
    "__P_DIRTY__",
    ...dirty,
    "__P_DISPATCH__",
    ...dispatch.split("\n").filter(Boolean),
    "__P_ENV__",
    ...env.split("\n"),
    "__P_EXAMPLE__",
    ...example.split("\n"),
    "__P_CONTAINERS__",
    ...containers,
    "__P_END__",
  ].join("\n");
}

test("parseEnvText: allow-list only, secret values DROPPED to presence", () => {
  const { vars, secrets } = parseEnvText(
    [
      "# comment",
      "PORT=8081",
      "MODEL=some/repo",
      "HF_TOKEN=hf_SUPERSECRET",
      "VLLM_API_KEY=sk-999",
      "SSH_PASSWORD=hunter2",
      "UNRELATED_KEY_XYZ=whatever",
      "export IMAGE=ghcr.io/x:tag",
      "  # indented comment",
    ].join("\n")
  );
  assert.equal(vars.PORT, "8081");
  assert.equal(vars.MODEL, "some/repo");
  assert.equal(vars.IMAGE, "ghcr.io/x:tag");
  assert.ok(!("UNRELATED_KEY_XYZ" in vars), "allow-list: unknown public keys ignored");
  assert.ok(!JSON.stringify(vars).includes("hf_SUPERSECRET"));
  assert.deepEqual(secrets, { HF_TOKEN: true, VLLM_API_KEY: true, SSH_PASSWORD: true });
  // allowSecrets opt-in exists for nothing that leaves the process; default drops.
  assert.equal(parseEnvText("HF_TOKEN=abc", { allowSecrets: true }).secrets.HF_TOKEN, "abc");
});

test("parseContainerLines: per-entry sets, ${VAR:-default} and plain forms", () => {
  const byEntry = parseContainerLines([
    "start.sh:CONTAINER_HEAD=\"${CONTAINER_HEAD:-glm53-exl3-head}\"",
    "start.sh:CONTAINER_WORKER=\"${CONTAINER_WORKER:-glm53-exl3-worker}\"",
    "start-tp4.sh:CONTAINER_HEAD=\"${CONTAINER_HEAD:-glm53-exl3-tp4-head}\"",
    "start-tp4.sh:CONTAINER_WORKER=\"${CONTAINER_WORKER:-glm53-exl3-tp4-w1}\"",
    "tp1/start.sh:CONTAINER_NAME='vllm-fn-tp1'",
  ]);
  assert.deepEqual(byEntry["start.sh"], {
    CONTAINER_HEAD: "glm53-exl3-head",
    CONTAINER_WORKER: "glm53-exl3-worker",
  });
  assert.equal(byEntry["start-tp4.sh"].CONTAINER_HEAD, "glm53-exl3-tp4-head");
  assert.equal(byEntry["tp1/start.sh"].CONTAINER_NAME, "vllm-fn-tp1");
});

test("parseRecipeProbe: repo class, variants, port, drift inputs; script class without dispatch", () => {
  const p = parseRecipeProbe(
    fakeProbe({
      env: "PORT=8081\nMODEL=brandonmusic/x\nNNODES=2\nTP=2\nREADY_TIMEOUT=3600\nSERVED_MODEL_NAME=GLM-EXL3\nWORKER_IP=10.0.0.2\nHF_TOKEN=hf_LEAKED",
      example: "PORT=8888\nHEAD_IP=10.100.24.2",
      containers: ["start.sh:CONTAINER_HEAD=\"${CONTAINER_HEAD:-glm53-exl3-head}\"", "start.sh:CONTAINER_WORKER=\"${CONTAINER_WORKER:-glm53-exl3-worker}\"", "start-tp4.sh:CONTAINER_HEAD=\"${CONTAINER_HEAD:-tp4-head}\""],
      git: "deadbeef",
    })
  );
  assert.equal(p.ok, true);
  assert.equal(p.meta.class, "repo");
  assert.equal(p.meta.port, 8081, ".env wins over .env.example");
  assert.equal(p.meta.headIp, "10.100.24.2", "example fills unset keys");
  assert.equal(p.meta.nnodes, 2);
  assert.equal(p.meta.tp, 2);
  assert.equal(p.meta.readyTimeoutS, 3600);
  assert.equal(p.meta.servedName, "GLM-EXL3");
  assert.equal(p.meta.entry, "start.sh");
  assert.deepEqual(p.meta.variants.map((v) => v.rel), ["start-tp4.sh"]);
  assert.deepEqual(Object.keys(p.meta.containers), ["CONTAINER_HEAD", "CONTAINER_WORKER"]);
  assert.equal(p.meta.containersByEntry["start-tp4.sh"].CONTAINER_HEAD, "tp4-head");
  assert.ok(!JSON.stringify(p).includes("hf_LEAKED"), "secret value must not survive parsing");
  assert.deepEqual(p.meta.secretPresence, { HF_TOKEN: true });
  assert.equal(p.versions.gitHead, "deadbeef");
  assert.equal(p.versions.dirtyBuild, false);
  assert.deepEqual(parseProbeOutput("__P_NOPATH__"), { noPath: true });
  assert.equal(parseRecipeProbe("__P_NOPATH__").error, "folder not found on node");
});

test("parseRecipeProbe: script-class dispatch (no status verb) + missing start.sh", () => {
  const noDispatch = parseRecipeProbe(
    fakeProbe({ env: "PORT=1", dispatch: "start\nstop" })
  );
  assert.equal(noDispatch.meta.class, "script");
  assert.ok(noDispatch.meta.verbs.includes("stop"));
  const noEntry = parseRecipeProbe(fakeProbe({ files: ["./download.sh 100"] }));
  assert.equal(noEntry.ok, false);
  assert.match(noEntry.error, /no start\.sh/);
});

test("versionDrift: head move / dirty build files; .env edits do not drift", () => {
  assert.deepEqual(versionDrift({ version: { gitHead: "a" } }, { gitHead: "b" }), { drift: true, rebuild: true });
  assert.deepEqual(versionDrift({ version: { gitHead: "a", dirtyBuild: false } }, { gitHead: "a", dirtyBuild: true }), { drift: true, rebuild: true });
  assert.equal(versionDrift({ version: { gitHead: "a" } }, { gitHead: "a" }).drift, false);
  assert.equal(versionDrift(null, { gitHead: "a" }).drift, false);
});

// ─── store ─────────────────────────────────────────────────

test("RecipeStore: identity unique on (sparkId, normalized path); re-register returns existing", () => {
  const dir = tmp();
  const store = new RecipeStore({ filePath: dir + "/recipes.json" });
  const a = store.register({ sparkId: "s1", path: "/opt/recipes/glm/" });
  const b = store.register({ sparkId: "s1", path: "/opt/recipes/glm" });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.recipe.id, b.recipe.id);
  assert.equal(store.register({ sparkId: "s2", path: "/opt/recipes/glm" }).created, true, "different spark = different recipe");
  assert.ok(recipeKey("s1", "/a/b/") === recipeKey("s1", "/a//b"));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── fakes + engine ────────────────────────────────────────

function mkFakes() {
  const dir = tmp();
  const sparkA = { id: "spark-a", kind: "spark", modelctlEnabled: true, lanIp: "10.0.0.1", ssh: { user: "ubuntu" } };
  const sparkB = { id: "spark-b", kind: "spark", modelctlEnabled: true, lanIp: "10.0.0.2" };
  const nas = { id: "nas-1", kind: "nas", modelctlEnabled: true };
  const registry = {
    getSpark: (id) => [sparkA, sparkB, nas].find((s) => s.id === id),
    sparks: [sparkA, sparkB, nas],
  };
  const jobs = [];
  const remoteJobs = {
    hasActiveJobForResource: (r) => jobs.some((j) => j.resource === r && j.status === "running"),
    listActiveJobsForResource: (r) => jobs.filter((j) => j.resource === r && (j.status === "running" || j.status === "pending")),
    getJob: (id) => jobs.find((j) => j.jobId === id) || null,
    startRemoteJob: async (sp, spec) => {
      const jobId = `job-${jobs.length + 1}`;
      jobs.push({ jobId, ...spec, sparkId: sp.id, status: "running", endedAt: null, exitCode: null });
      return { jobId };
    },
    cancelRemoteJob: async (sp, jobId) => {
      const j = jobs.find((x) => x.jobId === jobId);
      j.status = "cancelled";
      j.endedAt = 1;
      return j;
    },
  };
  const calls = [];
  const state = {
    headProbe: "__S_CONTAINERS__\nglm-head|running\n__S_HEALTH__\n200\n__S_MODELS__\n{}",
    peerProbe: "__S_CONTAINERS__\nglm-worker|running",
  };
  const exec = async (sp, cmd, opts) => {
    calls.push({ sparkId: sp.id, cmd, timeout: opts?.timeoutMs });
    if (cmd.includes("__S_CONTAINERS__")) {
      return sp.id === "spark-a" ? state.headProbe : state.peerProbe;
    }
    if (cmd.includes("base64 -d")) return `LAUNCHED ${jobs.length + 1}`;
    if (cmd.includes("./start.sh stop") || cmd.includes("./start.sh status")) return "stopped.";
    return "";
  };
  const nodeModels = { "spark-a": [{ name: "glm", repository: "org/GLM" }], "spark-b": [] };
  const modelctl = {
    listNodeModels: async (sp) => ({ models: nodeModels[sp.id] ?? [] }),
    listNasModels: async () => ({ models: [] }),
    modelctlEnabledSparks: () => [sparkA, sparkB],
  };
  const recipeStore = new RecipeStore({ filePath: dir + "/recipes.json" });
  const deployStore = new DeploymentStore({ filePath: dir + "/deploy.json" });
  const registered = recipeStore.register({ sparkId: "spark-a", path: "/opt/recipes/glm" });
  recipeStore.updateFromProbe(registered.recipe.id, {
    ok: true,
    meta: {
      port: 8081, model: "org/GLM", servedName: "GLM-EXL3", nnodes: 2, tp: 2,
      workerIp: "10.0.0.2", workerUser: null, headIp: "10.0.0.1",
      containers: { CONTAINER_HEAD: "glm-head", CONTAINER_WORKER: "glm-worker" },
      containersByEntry: { "start.sh": { CONTAINER_HEAD: "glm-head", CONTAINER_WORKER: "glm-worker" } },
      entry: "start.sh", variants: [], class: "repo", verbs: ["start", "stop", "status", "logs", "restart"],
      secretPresence: {},
    },
    versions: { gitHead: "aaa", dirtyBuild: false, probedAt: Date.now() },
    files: ["start.sh"],
    dispatch: { verbs: ["start", "stop", "status", "logs", "restart"] },
  });
  return { dir, sparkA, sparkB, nas, registry, jobs, remoteJobs, calls, exec, state, modelctl, nodeModels, recipeStore, deployStore, recipe: registered.recipe };
}

function mkEngine(f, over = {}) {
  return new ServeEngine({
    recipeStore: f.recipeStore,
    deployStore: f.deployStore,
    remoteJobs: f.remoteJobs,
    exec: f.exec,
    registry: f.registry,
    getSettings: () => ({}),
    modelctl: f.modelctl,
    llmSnapshot: () => [],
    ensureLlmPort: async () => true,
    ...over,
  });
}

test("start: placement present → recipe-run job launched with the folder verb; resource lock", async () => {
  const f = mkFakes();
  const eng = mkEngine(f);
  const r = await eng.start(f.recipe.id);
  assert.equal(r.ok, true);
  const job = f.jobs[0];
  assert.equal(job.kind, "recipe-run");
  assert.equal(job.resource, "spark-a:/opt/recipes/glm");
  assert.match(job.script, /cd \/opt\/recipes\/glm \|\| \{ echo "__RECIPE_NOPATH__"; exit 3; \}/);
  assert.match(job.script, /^\.\/start\.sh start$/m, "runs the recipe's own verb");
  assert.equal(f.deployStore.byRecipe(f.recipe.id).desired, "running");
  // second start while active → locked
  const r2 = await eng.start(f.recipe.id);
  assert.equal(r2.ok, false, "blocked by resource lock");
  assert.match(r2.error, /already active/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("start: absent MODEL → 409-shape block with placement remediation; force escapes; unknown never blocks", async () => {
  const f = mkFakes();
  f.nodeModels["spark-a"] = [];
  f.nodeModels["spark-b"] = [{ name: "glm", repository: "org/GLM" }];
  f.recipe.meta = { ...f.recipe.meta, model: "glm" };
  const eng = mkEngine(f);
  const blocked = await eng.start(f.recipe.id);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.placement.status, "push"); // peer holds it
  assert.deepEqual(blocked.placement.remediations, [{ kind: "push", sparkId: "spark-b", targetSparkId: "spark-a" }]);
  assert.match(blocked.error, /pull it from Hugging Face/);
  assert.equal(f.jobs.length, 0, "nothing launched while blocked");

  const forced = await eng.start(f.recipe.id, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(f.jobs.length, 1);

  // modelctl errored → check "unknown" → allowed (never block on unknown)
  f.jobs.length = 0;
  const eng2 = mkEngine(f, { modelctl: { ...f.modelctl, listNodeModels: async () => ({ models: [], error: "offline" }) } });
  const f2 = await eng2.start(f.recipe.id);
  assert.equal(f2.ok, true);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("stop: desired recorded first, live driver TERM-cancelled BEFORE the stop verb exec", async () => {
  const f = mkFakes();
  const eng = mkEngine(f);
  await eng.start(f.recipe.id);
  const dep = f.deployStore.byRecipe(f.recipe.id);
  assert.equal(dep.desired, "running");
  const res = await eng.stop(f.recipe.id);
  assert.equal(res.ok, true);
  assert.equal(f.deployStore.byRecipe(f.recipe.id).desired, "stopped", "intent persisted");
  assert.equal(f.jobs[0].status, "cancelled", "driver TERM'd via cancel (termOnly in real manager)");
  // ordering: cancel precedes the stop-verb exec
  const verbIdx = f.calls.findIndex((c) => c.cmd.includes("./start.sh stop"));
  const launchIdx = f.calls.findIndex((c) => c.cmd.includes("base64 -d"));
  assert.ok(verbIdx > launchIdx);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("join precedence: healthy(>warmup job) > starting > stopping > failed; probe-401 keyed", () => {
  const j = joinServeState; // shorthand
  assert.equal(j({ desired: "running", job: { status: "running" }, llm: { available: true }, servedName: "X" }).state, "healthy");
  assert.equal(j({ desired: "running", job: { status: "running" }, llm: { available: true } }).warmup, true);
  assert.equal(j({ desired: "stopped", job: { status: "running" } }).state, "stopping");
  assert.equal(j({ desired: "running", job: { status: "running" }, probe: { health: 503, containers: {} } }).state, "starting");
  assert.equal(j({ desired: "running", job: { status: "failed", exitCode: 1 }, probe: { containers: {} }, ranks: { CONTAINER_HEAD: "absent" } }).state, "failed");
  // desired=stopped wins over a failed receipt (never "failed" after a user stop)
  assert.equal(j({ desired: "stopped", job: { status: "failed", exitCode: 1 }, ranks: { CONTAINER_HEAD: "absent" } }).state, "stopped");
  assert.equal(j({ desired: "running", probe: { health: 401, containers: {} }, ranks: { CONTAINER_HEAD: "running" } }).state, "healthy-keyed");
  assert.equal(j({ desired: "running", probe: { dockerError: "denied", containers: {} } }).state, "unknown");
  assert.equal(j({ desired: "running", ranks: { CONTAINER_HEAD: "running" }, probe: { containers: { x: "running" } } }).state, "up");
  assert.equal(j({ desired: "running" }).state, "stopped");
  assert.equal(j({ desired: "running", orphaned: true }).state, "orphan");
  const m = j({ desired: "running", llm: { available: true, modelId: "llama/GLM-EXL3" }, servedName: "GLM-EXL3" });
  assert.equal(m.state, "healthy");
  assert.equal(m.servedIdMatch, true, "basename compare, case-insensitive");
});

test("stateFor: running job + probe 200 → healthy warmup; ranks merged across head+peer", async () => {
  const f = mkFakes();
  const eng = mkEngine(f);
  await eng.start(f.recipe.id);
  const s = await eng.stateFor(f.recipe.id, { refresh: true });
  assert.equal(s.state, "healthy");
  assert.equal(s.warmup, true);
  assert.equal(s.topology.workerSparkId, "spark-b");
  assert.deepEqual(s.ranks, { CONTAINER_HEAD: "running", CONTAINER_WORKER: "running" });
  // the peer was probed on ITS OWN transport [D-logs/D-folder]
  assert.ok(f.calls.some((c) => c.sparkId === "spark-b" && c.cmd.includes("__S_CONTAINERS__")));
  assert.equal(s.drift.drift, false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("stateFor: drift surfaces after git HEAD moves; stop receipt after cancelled job", async () => {
  const f = mkFakes();
  const eng = mkEngine(f);
  await eng.start(f.recipe.id);
  await eng.stop(f.recipe.id);
  f.recipeStore.updateFromProbe(f.recipe.id, {
    ok: true,
    meta: { ...f.recipe.meta, port: 8081 },
    versions: { gitHead: "bbb", dirtyBuild: false, probedAt: Date.now() },
    files: [],
    dispatch: {},
  });
  // Containers gone after the stop: nothing runs.
  f.state.headProbe = "__S_CONTAINERS__\n__S_HEALTH__\n000";
  f.state.peerProbe = "__S_CONTAINERS__";
  const s = await eng.stateFor(f.recipe.id, { refresh: true });
  assert.equal(s.state, "stopped");
  assert.equal(s.drift.drift, true, "HEAD moved since startedWith");
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("orphan: registry remove → recipes+deployments orphan; state = orphan; no probe exec", async () => {
  const f = mkFakes();
  const eng = mkEngine(f);
  await eng.start(f.recipe.id);
  await eng.stop(f.recipe.id);
  const n = eng.orphanSpark("spark-a");
  assert.equal(n.recipes, 1);
  assert.equal(n.deployments, 1);
  assert.equal(f.deployStore.byRecipe(f.recipe.id).desired, "stopped");
  const callsBefore = f.calls.length;
  const s = await eng.stateFor(f.recipe.id, { refresh: true });
  assert.equal(s.state, "orphan");
  assert.equal(f.calls.length, callsBefore, "orphans are never probed");
  eng.adoptSpark("spark-a");
  assert.equal(f.recipeStore.get(f.recipe.id).orphaned, false);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("nas spark refuses recipes; invalid entry refuses launch", async () => {
  const f = mkFakes();
  const eng = mkEngine(f);
  const r = f.recipeStore.register({ sparkId: "nas-1", path: "/mnt/x" });
  const out = await eng.start(r.recipe.id);
  assert.equal(out.ok, false);
  assert.match(out.error, /NAS/);
  // invalid variant falls back error path
  const bad = await eng.start(f.recipe.id, { variant: "../../evil" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /variant|entry/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("logs: driver tails the node job file; engine uses docker logs with cursor", async () => {
  assert.match(buildDriverLogCommand("job-7"), /tail -c 6000 ~\/\.sparkdash\/jobs\/job-7\.log/);
  assert.match(buildDriverLogCommand("job-7", 999999), /tail -c 100000/);
  assert.match(buildEngineLogCommand("glm-head", { tail: 100, since: "2026-09-15T00:00:00Z" }), /docker logs -t --since 2026-09-15T00:00:00Z --tail 100 glm-head/);
  assert.match(buildEngineLogCommand("a b", {}), /docker logs -t --tail 200 'a b'/);
  const f = mkFakes();
  const eng = mkEngine(f);
  await eng.start(f.recipe.id);
  const dl = await eng.driverLog(f.recipe.id);
  assert.equal(typeof dl.log, "string");
  const el = await eng.engineLog(f.recipe.id, { rank: "head" });
  assert.equal(el.container, "glm-head");
  const ew = await eng.engineLog(f.recipe.id, { rank: "worker" });
  assert.equal(ew.container, "glm-worker");
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("verb guards: run/verb builders reject unknown verbs; probe parse handles docker permission denial", () => {
  assert.throws(() => buildRecipeRunScript("/x", "start.sh", "rm"), /invalid recipe verb/);
  assert.throws(() => buildRecipeVerbCommand("/x", "start.sh", "delete-all"), /invalid recipe verb/);
  const p = parseProbeStatus("__S_CONTAINERS__\npermission denied while talking to the docker daemon\n__S_HEALTH__\n000");
  assert.equal(p.dockerError, "permission denied while talking to the docker daemon");
  assert.deepEqual(rankStates({ CONTAINER_HEAD: "glm" }, p), { CONTAINER_HEAD: "error" });
  assert.deepEqual(rankStates({ CONTAINER_HEAD: "glm" }, { containers: {} }), { CONTAINER_HEAD: "absent" });
});

test("modelInInventory: name/repo/basename matching, unknown on missing list", () => {
  const models = [{ name: "glm", repository: "org/GLM" }];
  assert.equal(modelInInventory("org/GLM", models), true);
  assert.equal(modelInInventory("glm", models), true);
  assert.equal(modelInInventory("ORG/glm", models), true);
  assert.equal(modelInInventory("other", models), false);
  assert.equal(modelInInventory("org/GLM", null), null);
  assert.equal(modelInInventory(null, models), null);
});
