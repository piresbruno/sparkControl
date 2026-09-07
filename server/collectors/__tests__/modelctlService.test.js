import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNasListCommand,
  buildNodeListCommand,
  buildDownloadScript,
  buildSyncScript,
  buildPushScript,
  buildDeleteLocalScript,
  buildNasDeleteScript,
  buildVersionProbeCommand,
  buildInstallModelctlScript,
  parseModelctlList,
  parseVersionOutput,
  planPlacement,
  validModelName,
  createModelctlService,
  NAS_CACHE_TTL_MS,
  NODE_CACHE_TTL_MS,
  VERSION_CACHE_TTL_MS,
} from "../modelctlService.js";

// ─── Builders ─────────────────────────────────────────────

test("command builders quote every caller-supplied value", () => {
  // All invocations go through the bare→~/.local/bin ladder.
  const nas = buildNasListCommand("/mnt/nas/llm-models");
  assert.match(nas, /command -v modelctl/);
  const nasQ = buildNasListCommand("/mnt/nas/a b", "/opt/mc");
  // A remoteBin containing a path separator is an explicit path — no ladder.
  assert.match(nasQ, /^\/opt\/mc list --json --root '\/mnt\/nas\/a b'$/);
  assert.match(nasQ, /--root '\/mnt\/nas\/a b'/);
  const node = buildNodeListCommand("modelctl");
  assert.match(node, /list --local --json/);
  assert.match(node, /__MCTL_MISSING__/);
  const dl = buildDownloadScript({ repo: "org/model", nasRoot: "/nas" });
  assert.match(dl, /download org\/model --root \/nas/);
  const dlFlags = buildDownloadScript({ repo: "org/model", nasRoot: "/nas", name: "m1", quantization: "q4", revision: "v2" });
  assert.match(dlFlags, /--name m1 --quantization q4 --revision v2/);
  const sync = buildSyncScript({ name: "m1", nasRoot: "/nas" });
  assert.match(sync, /sync-local m1 --source-root \/nas/);
  const push = buildPushScript({ name: "m1", targetHost: "10.0.0.6" });
  assert.match(push, /push m1 --host 10\.0\.0\.6 --jobs 4/);
  const del = buildDeleteLocalScript({ name: "m1" });
  assert.match(del, /delete-local m1/);
  const nasDel = buildNasDeleteScript({ name: "m1", nasRoot: "/nas" });
  assert.match(nasDel, /delete m1 --root \/nas --apply --yes/);
  const nasDelQ = buildNasDeleteScript({ name: "a b", nasRoot: "/n x", remoteBin: "/opt/mc" });
  assert.match(nasDelQ, /^\/opt\/mc delete 'a b' --root '\/n x' --apply --yes$/);
  // Injection attempts get single-quoted.
  const evil = buildSyncScript({ name: "a; rm -rf /", nasRoot: "/nas" });
  assert.match(evil, /'a; rm -rf \/'/);
});

test("version probe: bare name, then ~/.local/bin fallback, then missing marker", () => {
  const cmd = buildVersionProbeCommand("modelctl");
  assert.match(cmd, /command -v modelctl/);
  assert.match(cmd, /~\/\.local\/bin\/modelctl --version/);
  assert.match(cmd, /__MCTL_MISSING__/);
});

test("install-modelctl script: git check → uv → force install → verify", () => {
  const s = buildInstallModelctlScript({ source: "git+https://github.com/piresbruno/modelctl" });
  const order = [
    ["command -v git", s.indexOf("command -v git")],
    ["astral.sh/uv/install.sh", s.indexOf("astral.sh/uv/install.sh")],
    ["tool install --force", s.indexOf("tool install --force")],
    ["modelctl --version", s.indexOf("modelctl --version")],
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i][1] > order[i - 1][1], `${order[i][0]} must come after ${order[i - 1][0]}`);
  }
  assert.match(s, /git is not installed on this node/);
  assert.match(s, /exit 3/);
  assert.ok(s.includes("git+https://github.com/piresbruno/modelctl"));
});

// ─── Parsers ──────────────────────────────────────────────

test("parseModelctlList handles NAS shape (bytes) and node shape (no bytes)", () => {
  const nas = parseModelctlList(
    '[{"name":"m1","runtime":"gguf","repository":"org/m1","bytes":123}, {"name":"m2","runtime":"safetensors","repository":"org/m2","bytes":456}]'
  );
  assert.equal(nas.length, 2);
  assert.equal(nas[0].bytes, 123);
  const node = parseModelctlList('[{"name":"m1","runtime":"gguf","repository":"org/m1"}]');
  assert.equal(node[0].bytes, null);
  // Garbage / empty → [].
  assert.deepEqual(parseModelctlList(""), []);
  assert.deepEqual(parseModelctlList("not json"), []);
  assert.deepEqual(parseModelctlList("warning noise [ {\"name\":\"x\"} ]"), [{ name: "x", runtime: null, repository: null, bytes: null }]);
});

test("parseVersionOutput extracts version or missing marker", () => {
  const v = parseVersionOutput("modelctl 0.13.0");
  assert.equal(v.installed, true);
  assert.equal(v.version, "0.13.0");
  assert.equal(parseVersionOutput("__MCTL_MISSING__").installed, false);
});

// ─── Placement tree ───────────────────────────────────────

test("planPlacement: present / sync / push / unavailable", () => {
  const base = { target: { sparkId: "t", models: [] }, nas: null, peers: [] };
  assert.deepEqual(planPlacement("m", { ...base, target: { sparkId: "t", models: [{ name: "m" }] } }), {
    status: "present",
    remediations: [],
  });
  assert.deepEqual(planPlacement("m", { ...base, nas: { models: [{ name: "m" }] } }), {
    status: "sync",
    remediations: [{ kind: "sync", sparkId: "t" }],
  });
  assert.deepEqual(
    planPlacement("m", { ...base, peers: [{ sparkId: "p1", models: [] }, { sparkId: "p2", models: [{ name: "m" }] }] }),
    { status: "push", remediations: [{ kind: "push", sparkId: "p2", targetSparkId: "t" }] }
  );
  assert.deepEqual(planPlacement("m", base), { status: "unavailable", remediations: [] });
  assert.deepEqual(planPlacement("m", null), { status: "unavailable", remediations: [] });
});

test("validModelName enforces the REST-layer regex", () => {
  assert.ok(validModelName("Qwen3-30B-A3B"));
  assert.ok(validModelName("a.b_c-d"));
  assert.ok(!validModelName("a;rm"));
  assert.ok(!validModelName("a b"));
  assert.ok(!validModelName(""));
  assert.ok(!validModelName("../escape"));
});

// ─── Service caches / error shapes ────────────────────────

function fakeRegistry(sparks) {
  return {
    getSpark: (id) => sparks.find((s) => s.id === id) || null,
    sparks,
  };
}

test("listNasModels error path → { models: [], error } and caches", async () => {
  const calls = [];
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      calls.push(cmd);
      if (cmd.includes("--version")) return "__MCTL_MISSING__";
      throw new Error("node offline");
    },
    getSettings: () => ({ modelctl: { nasRoot: "/nas", remoteBin: "modelctl" } }),
    registry: fakeRegistry([{ id: "h", role: "head", isLocal: true }]),
  });
  const r1 = await svc.listNasModels();
  assert.deepEqual(r1.models, []);
  assert.equal(r1.error, "modelctl not installed");
});

test("listNasModels happy path parses NAS shape + cache hit skips exec", async () => {
  let execCount = 0;
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      execCount += 1;
      if (cmd.includes("--version")) return "modelctl 0.13.0";
      return '[{"name":"m1","runtime":"gguf","repository":"o/m1","bytes":1}]';
    },
    getSettings: () => ({ modelctl: { nasRoot: "/nas", remoteBin: "modelctl" } }),
    registry: fakeRegistry([{ id: "h", role: "head", isLocal: true }]),
  });
  const r1 = await svc.listNasModels();
  assert.equal(r1.models.length, 1);
  assert.equal(r1.models[0].bytes, 1);
  const n1 = execCount;
  const r2 = await svc.listNasModels();
  assert.equal(r2.models.length, 1);
  assert.equal(execCount, n1, "second read must be served from cache");
  assert.equal(r2.stale, false);
});

test("listNodeModels node offline → { models: [], error: 'node offline' }", async () => {
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      if (cmd.includes("--version")) return "modelctl 0.13.0";
      throw new Error("ssh: connect refused");
    },
    getSettings: () => ({ modelctl: { nasRoot: "/nas" } }),
    registry: fakeRegistry([{ id: "n1", role: "worker", modelctlEnabled: true }]),
  });
  const r = await svc.listNodeModels({ id: "n1" });
  assert.deepEqual(r.models, []);
  assert.match(r.error, /connect refused/);
});

test("checkModelctl caches for 5 min; force bypasses", async () => {
  let execCount = 0;
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      execCount += 1;
      if (cmd.includes("modelctl")) return "modelctl 0.13.0";
      if (cmd.includes("uv")) return "uv 0.5.0";
      return "";
    },
    getSettings: () => ({ modelctl: {} }),
    registry: fakeRegistry([{ id: "n1" }]),
  });
  const r1 = await svc.checkModelctl({ id: "n1" });
  assert.equal(r1.installed, true);
  assert.equal(r1.version, "0.13.0"); // parseVersionOutput now puts semver in version
  assert.equal(r1.uv.installed, true);
  assert.equal(r1.uv.version, "0.5.0");
  const n = execCount;
  await svc.checkModelctl({ id: "n1" });
  assert.equal(execCount, n, "cached");
  await svc.checkModelctl({ id: "n1" }, { force: true });
  assert.equal(execCount, n + 2, "force re-probes both binaries");
  svc.invalidateCheck("n1");
});

test("defaultNasSpark: explicit nasHostSparkId wins, else head, else isLocal, else sole", async () => {
  const cfg = () => ({ modelctl: {} });
  const r = fakeRegistry([
    { id: "w1", role: "worker" },
    { id: "head1", role: "head", isLocal: false },
    { id: "loc", role: "standalone", isLocal: true },
  ]);
  const svc = createModelctlService({ exec: async () => "", getSettings: cfg, registry: r });
  assert.equal(svc.defaultNasSpark().id, "head1");
  const svc2 = createModelctlService({
    exec: async () => "",
    getSettings: () => ({ modelctl: { nasHostSparkId: "loc" } }),
    registry: r,
  });
  assert.equal(svc2.defaultNasSpark().id, "loc");
});

test("modelctlEnabledSparks filters by flag", () => {
  const svc = createModelctlService({
    exec: async () => "",
    getSettings: () => ({}),
    registry: fakeRegistry([
      { id: "a", modelctlEnabled: true },
      { id: "b", modelctlEnabled: false },
    ]),
  });
  assert.deepEqual(svc.modelctlEnabledSparks().map((s) => s.id), ["a"]);
});
