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
  buildQueueScript,
  buildQueueYaml,
  buildCatalogRefreshScript,
  buildRepairActiveScript,
  buildCleanupQuarantineScript,
  buildSyncCardsScript,
  buildUpdateScript,
  buildDoctorCommand,
  buildCatalogReadCommand,
  buildNasDeletePlanCommand,
  validateQueueRequest,
  parseModelctlList,
  parseVersionOutput,
  parseDoctorJson,
  parseNasCatalog,
  parseReleasePayload,
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
  // option-injection: leading dash must not become a modelctl flag
  assert.ok(!validModelName("-apply"));
  assert.ok(!validModelName("--yes"));
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

// ─── NAS-host builders ────────────────────────────────────

test("buildQueueYaml: entries → downloads.yaml lines (JSON-quoted scalars)", () => {
  const y = buildQueueYaml([
    { source: "org/model-a", name: "a-q4", quantization: "Q4_K_M", runtime: "llama.cpp", force: true },
    { source: "org/model-b", revision: "main", mmproj: "mmproj-F16.gguf", mtp: "draft" },
  ]);
  const lines = y.split("\n");
  assert.equal(lines[0], "downloads:");
  assert.equal(lines[1], '  - source: "org/model-a"');
  assert.equal(lines[2], '    name: "a-q4"');
  assert.equal(lines[3], '    quantization: "Q4_K_M"');
  assert.equal(lines[4], '    runtime: "llama.cpp"');
  assert.equal(lines[5], "    force: true");
  assert.equal(lines[6], '  - source: "org/model-b"');
  assert.ok(y.includes('    revision: "main"'));
  assert.ok(y.includes('    mmproj: "mmproj-F16.gguf"'));
  assert.ok(y.includes('    mtp: "draft"'));
  // Optional keys are omitted when absent/empty — never emitted as "".
  assert.ok(!y.includes("name: \"\""));
  assert.ok(!lines[6].includes("force"));
});

test("buildQueueScript: temp file, base64 body, flags, root quoting, injection neutralized", () => {
  const s = buildQueueScript({
    entries: [{ source: "org/m; rm -rf / $(whoami)" }],
    jobs: 4,
    nasRoot: "/mnt/nas/a b",
    remoteBin: "/opt/mc",
  });
  // Explicit path remoteBin → no bare-name ladder.
  assert.match(s, /^f="\/tmp\/modelctl-queue-\$\$\.yaml"/);
  // Base64 is (padding excepted) shellQuote-safe; accept either quoting.
  const yaml = buildQueueYaml([{ source: "org/m; rm -rf / $(whoami)" }]);
  const b64 = Buffer.from(yaml, "utf8").toString("base64");
  assert.ok(s.includes(b64), "validated YAML embedded as base64");
  assert.match(s, /printf '%s' '?[A-Za-z0-9+/=]+'? \| base64 -d > "\$f"/);
  assert.match(s, /\/opt\/mc queue "\$f" --jobs 4 --root '\/mnt\/nas\/a b'/);
  assert.match(s, /code=\$\?/);
  assert.match(s, /rm -f "\$f"/);
  assert.match(s, /exit \$code/);
  // The injection attempt only exists inside the quoted YAML scalar (b64 has
  // no spaces): the shell never sees `rm -rf /` as argv.
  assert.ok(!s.includes("rm -rf /"));
});

test("validateQueueRequest: accepts clean entries; rejects unknown keys, bad names, bad jobs", () => {
  const ok = validateQueueRequest([{ source: "org/m", runtime: "auto", force: false }], 2);
  assert.equal(ok.error, undefined);
  assert.equal(ok.jobs, 2);
  assert.equal(ok.entries.length, 1);

  assert.match(validateQueueRequest([], 1).error, /non-empty/);
  assert.match(validateQueueRequest([{ source: "org/m" }], 3).error, /jobs must be 1, 2 or 4/);
  assert.match(validateQueueRequest([{ source: "org/m", bogus: 1 }], 1).error, /entries\[0\]\.bogus is not a valid field/);
  assert.match(validateQueueRequest([{ source: "" }], 1).error, /source is required/);
  assert.match(validateQueueRequest([{ source: "x".repeat(201) }], 1).error, /max 200/);
  assert.match(validateQueueRequest([{ source: "a\nb" }], 1).error, /single line/);
  assert.match(validateQueueRequest([{ source: "org/m", name: "-evil" }], 1).error, /name is invalid/);
  assert.match(validateQueueRequest([{ source: "org/m", name: "x".repeat(121) }], 1).error, /name is invalid/);
  assert.match(validateQueueRequest([{ source: "org/m", runtime: "exllama" }], 1).error, /runtime must be one of/);
  assert.match(validateQueueRequest([{ source: "org/m", revision: "x".repeat(101) }], 1).error, /revision must be a string \(max 100/);
  assert.match(validateQueueRequest([{ source: "org/m", force: "yes" }], 1).error, /force must be a boolean/);
});

test("NAS store job builders: catalog-refresh / repair-active / cleanup-quarantine / sync-cards / update", () => {
  const cr = buildCatalogRefreshScript({ nasRoot: "/nas", remoteBin: "/opt/mc" });
  assert.equal(cr, "/opt/mc catalog refresh --root /nas");

  // repair-active: model omitted = all refs; present = quoted name before --root.
  const raAll = buildRepairActiveScript({ model: null, nasRoot: "/nas", remoteBin: "/opt/mc" });
  assert.equal(raAll, "/opt/mc repair-active --root /nas --apply");
  const raOne = buildRepairActiveScript({ model: "m 1", nasRoot: "/nas", remoteBin: "/opt/mc" });
  assert.equal(raOne, "/opt/mc repair-active 'm 1' --root /nas --apply");

  const cq = buildCleanupQuarantineScript({ model: "m1", nasRoot: "/n x", remoteBin: "/opt/mc" });
  assert.equal(cq, "/opt/mc cleanup-quarantine m1 --root '/n x' --apply");

  const scAll = buildSyncCardsScript({ model: undefined, nasRoot: "/nas", remoteBin: "/opt/mc" });
  assert.equal(scAll, "/opt/mc sync-cards --root /nas");
  const scOne = buildSyncCardsScript({ model: "m1", nasRoot: "/nas", remoteBin: "/opt/mc" });
  assert.equal(scOne, "/opt/mc sync-cards m1 --root /nas");

  const up = buildUpdateScript({ model: "m1", nasRoot: "/nas", remoteBin: "/opt/mc" });
  assert.equal(up, "/opt/mc update m1 --root /nas");

  // Injection attempt on model names → single-quoted, never flag-injectable.
  const evil = buildUpdateScript({ model: "a; reboot", nasRoot: "/nas" });
  assert.match(evil, /update 'a; reboot'/);
});

test("doctor / catalog-read / delete-plan builders quote the root", () => {
  const d = buildDoctorCommand({ nasRoot: "/n x", remoteBin: "/opt/mc" });
  assert.equal(d, "/opt/mc doctor --root '/n x' --json");
  assert.equal(buildCatalogReadCommand("/n x"), "cat '/n x'/catalog.json 2>/dev/null");
  const p = buildNasDeletePlanCommand({ model: "m1", nasRoot: "/nas", remoteBin: "/opt/mc" });
  assert.equal(p, "/opt/mc delete m1 --root /nas");
});

// ─── NAS parsers ──────────────────────────────────────────

test("parseDoctorJson: array (real contract), object, warning-prefixed, raw fallback", () => {
  // modelctl doctor --json emits a top-level ARRAY of audit items.
  const arr = parseDoctorJson(
    JSON.stringify([
      { name: "a", status: "valid", reference: "/r/active/a", object: "/r/models/x", detail: "" },
      { name: "b", status: "repairable_directory", reference: "/r/active/b", object: null, detail: "x" },
    ])
  );
  assert.equal(arr.error, undefined);
  assert.ok(Array.isArray(arr.report));
  assert.equal(arr.report[1].status, "repairable_directory");
  // Empty array is still an array (not raw).
  assert.deepEqual(parseDoctorJson("[]").report, []);
  // Object shape (defensive): inner "[]" must NOT be mistaken for the container.
  const clean = parseDoctorJson('{"ok":true,"issues":[]}');
  assert.deepEqual(clean.report, { ok: true, issues: [] });
  assert.equal(clean.error, undefined);
  // Leading warning line + array.
  const noisyArr = parseDoctorJson('warning: dirty catalog\n[{"name":"a","status":"valid"}]');
  assert.deepEqual(noisyArr.report, [{ name: "a", status: "valid" }]);
  // Leading warning line + object.
  const noisy = parseDoctorJson('warn: dirty catalog\n{"ok":false}');
  assert.deepEqual(noisy.report, { ok: false });
  const raw = parseDoctorJson("doctor says everything is fine");
  assert.deepEqual(raw.report, { raw: "doctor says everything is fine" });
  assert.equal(parseDoctorJson("").error, "empty doctor output");
});

test("parseNasCatalog: catalog.json shape → normalized response", () => {
  const r = parseNasCatalog(JSON.stringify({
    schema: 1,
    generation: 42,
    generated_at: "2026-09-01T00:00:00Z",
    active_fingerprint: "abc",
    models: [{ name: "m1", runtime: "gguf", repository: "org/m1", bytes: 7 }, { name: "m2" }],
  }));
  assert.equal(r.error, undefined);
  assert.equal(r.schema, 1);
  assert.equal(r.generation, 42);
  assert.equal(r.generatedAt, "2026-09-01T00:00:00Z");
  assert.equal(r.count, 2);
  assert.equal(r.models[0].bytes, 7);
  assert.equal(r.models[1].runtime, null);
  assert.deepEqual(parseNasCatalog(""), { error: "catalog.json not found" });
  assert.deepEqual(parseNasCatalog("{oops"), { error: "catalog.json parse failed" });
});

test("parseReleasePayload: tag/published_at, malformed tolerated", () => {
  assert.deepEqual(parseReleasePayload({ tag_name: "v0.18.0", published_at: "2026-08-30T10:00:00Z" }), {
    latest: "v0.18.0",
    publishedAt: "2026-08-30T10:00:00Z",
  });
  assert.deepEqual(parseReleasePayload({}), { latest: null, publishedAt: null });
  assert.deepEqual(parseReleasePayload(null), { latest: null, publishedAt: null });
  assert.deepEqual(parseReleasePayload({ tag_name: 5, published_at: 7 }), { latest: null, publishedAt: null });
});

// ─── NAS service executors ────────────────────────────────

test("defaultNasSpark prefers kind 'nas' over head/nasHostSparkId chain", () => {
  const r = fakeRegistry([
    { id: "head1", role: "head" },
    { id: "nas1", kind: "nas", role: "standalone" },
    { id: "loc", isLocal: true },
  ]);
  const svc = createModelctlService({
    exec: async () => "",
    // Even an explicit nasHostSparkId must not beat a kind-nas node.
    getSettings: () => ({ modelctl: { nasHostSparkId: "head1" } }),
    registry: r,
  });
  assert.equal(svc.defaultNasSpark().id, "nas1");
});

test("nasRootFor: per-spark root wins, empty falls back to global", () => {
  const svc = createModelctlService({
    exec: async () => "",
    getSettings: () => ({ modelctl: { nasRoot: "/global" } }),
    registry: fakeRegistry([]),
  });
  assert.equal(svc.nasRootFor({ nasRoot: "/spark" }), "/spark");
  assert.equal(svc.nasRootFor({ nasRoot: "" }), "/global");
  assert.equal(svc.nasRootFor({}), "/global");
  assert.equal(svc.nasRootFor(null), "/global");
  const svc2 = createModelctlService({
    exec: async () => "",
    getSettings: () => ({}),
    registry: fakeRegistry([]),
  });
  assert.equal(svc2.nasRootFor({}), "");
});

test("listNasModels uses defaultNasSpark's per-spark nasRoot", async () => {
  const seen = [];
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      seen.push(cmd);
      if (cmd.includes("--version")) return "modelctl 0.18.0";
      return "[{\"name\":\"m1\",\"runtime\":\"gguf\",\"repository\":\"o/m1\",\"bytes\":5}]";
    },
    getSettings: () => ({ modelctl: { nasRoot: "/global", remoteBin: "modelctl" } }),
    registry: fakeRegistry([{ id: "nas1", kind: "nas", nasRoot: "/per-spark" }]),
  });
  const r = await svc.listNasModels();
  assert.equal(r.models[0].name, "m1");
  assert.ok(seen.some((c) => c.includes("--root /per-spark")), "must use the spark's own root");
  assert.ok(!seen.some((c) => c.includes("--root /global")));
});

test("runNasDoctor: parses json, caches, force busts, exec error keeps stale", async () => {
  let execCount = 0;
  let mode = "ok";
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      if (cmd.includes("--version")) return "modelctl 0.18.0";
      execCount += 1;
      if (mode === "boom") throw new Error("ssh down");
      return '{"ok":false,"issues":["dirty"]}';
    },
    getSettings: () => ({ modelctl: { nasRoot: "/nas" } }),
    registry: fakeRegistry([{ id: "nas1", kind: "nas" }]),
  });
  const r1 = await svc.runNasDoctor();
  assert.deepEqual(r1.report, { ok: false, issues: ["dirty"] });
  assert.equal(r1.stale, false);
  const r2 = await svc.runNasDoctor();
  assert.equal(execCount, 1, "cached");
  assert.equal(r2.report.ok, false);
  await svc.runNasDoctor({ force: true });
  assert.equal(execCount, 2, "force re-runs");
  mode = "boom";
  const r3 = await svc.runNasDoctor({ force: true });
  assert.equal(r3.report, null);
  assert.equal(r3.error, "ssh down");
  // The error entry is itself cached (house _keepStale pattern, same as
  // listNasModels): the next non-force read re-serves it without an exec.
  const before = execCount;
  const r4 = await svc.runNasDoctor();
  assert.equal(execCount, before, "error served from cache, no re-exec");
  assert.equal(r4.error, "ssh down");
});

test("fetchNasCatalog: reads catalog.json via cat, caches good reads only", async () => {
  let execCount = 0;
  let payload = JSON.stringify({ schema: 1, generation: 3, generated_at: "x", models: [{ name: "m1" }] });
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      assert.match(cmd, /^cat \/nas\/catalog\.json 2>\/dev\/null$/, "must be a plain cat, not modelctl");
      execCount += 1;
      if (payload === null) throw new Error("cat: no such file");
      return payload;
    },
    getSettings: () => ({ modelctl: { nasRoot: "/nas" } }),
    registry: fakeRegistry([{ id: "nas1", kind: "nas" }]),
  });
  const r1 = await svc.fetchNasCatalog();
  assert.equal(r1.generation, 3);
  assert.equal(r1.count, 1);
  await svc.fetchNasCatalog();
  assert.equal(execCount, 1, "cached");
  payload = null;
  const r2 = await svc.fetchNasCatalog({ force: true });
  assert.match(r2.error, /no such file/);
  const r3 = await svc.fetchNasCatalog();
  assert.equal(r3.generation, 3, "last good still cache-served after a failed force");
});

test("fetchNasModelDetail: path + serve-command + RUN.md; partial failure tolerated", async () => {
  const calls = [];
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      calls.push(cmd);
      if (cmd.startsWith("/opt/mc path")) return "/nas/active/m1/model.gguf\n";
      if (cmd.startsWith("/opt/mc serve-command")) return "llama-server -m /nas/active/m1/model.gguf";
      if (cmd.startsWith("head -c")) return "# Run\nport 8888";
      throw new Error("unexpected cmd " + cmd);
    },
    getSettings: () => ({ modelctl: { nasRoot: "/nas", remoteBin: "/opt/mc" } }),
    registry: fakeRegistry([{ id: "nas1", kind: "nas" }]),
  });
  const r = await svc.fetchNasModelDetail("m1");
  assert.equal(r.path, "/nas/active/m1/model.gguf");
  assert.equal(r.serveCommand, "llama-server -m /nas/active/m1/model.gguf");
  assert.equal(r.runMd, "# Run\nport 8888");
  assert.equal(r.error, undefined);
  assert.equal(calls.length, 3);
  // Second read served from cache.
  const r2 = await svc.fetchNasModelDetail("m1");
  assert.equal(calls.length, 3, "detail cached per model");
  assert.equal(r2.path, r.path);

  // All three fail → error surfaced, nothing throws.
  const svc2 = createModelctlService({
    exec: async () => { throw new Error("node down"); },
    getSettings: () => ({ modelctl: { nasRoot: "/nas" } }),
    registry: fakeRegistry([{ id: "nas1", kind: "nas" }]),
  });
  const bad = await svc2.fetchNasModelDetail("m1");
  assert.equal(bad.path, null);
  assert.match(bad.error, /path: node down/);
});

test("fetchNasDeletePlan: live dry-run, never cached", async () => {
  let execCount = 0;
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      assert.match(cmd, /delete m1 --root \/nas(?! --apply)/, "dry-run: no --apply/--yes");
      execCount += 1;
      return "would remove active/m1\nwould refresh catalog";
    },
    getSettings: () => ({ modelctl: { nasRoot: "/nas" } }),
    registry: fakeRegistry([{ id: "nas1", kind: "nas" }]),
  });
  const r1 = await svc.fetchNasDeletePlan("m1");
  assert.match(r1.plan, /would remove active\/m1/);
  await svc.fetchNasDeletePlan("m1");
  assert.equal(execCount, 2, "delete-plan must always be live");
});

test("checkRelease: fake fetch → parsed payload; 15-min cache; failures never throw", async () => {
  let fetchCount = 0;
  const fakeFetch = async (url, opts) => {
    fetchCount += 1;
    assert.equal(url, "https://api.github.com/repos/piresbruno/modelctl/releases/latest");
    return { ok: true, json: async () => ({ tag_name: "v0.18.0", published_at: "2026-08-30T10:00:00Z" }) };
  };
  const svc = createModelctlService({
    exec: async () => "",
    getSettings: () => ({}),
    registry: fakeRegistry([]),
    fetch: fakeFetch,
  });
  const r1 = await svc.checkRelease();
  assert.equal(r1.latest, "v0.18.0");
  assert.equal(r1.publishedAt, "2026-08-30T10:00:00Z");
  assert.equal(r1.error, undefined);
  assert.ok(Number.isFinite(r1.checkedAt));
  await svc.checkRelease();
  assert.equal(fetchCount, 1, "cached 15 min");

  // Failure path: HTTP 500 → { latest: null, error } cached, never throws.
  const svc2 = createModelctlService({
    exec: async () => "",
    getSettings: () => ({}),
    registry: fakeRegistry([]),
    fetch: async () => ({ ok: false, status: 500 }),
  });
  const f = await svc2.checkRelease();
  assert.equal(f.latest, null);
  assert.match(f.error, /HTTP 500/);

  // Network throw is also swallowed.
  const svc3 = createModelctlService({
    exec: async () => "",
    getSettings: () => ({}),
    registry: fakeRegistry([]),
    fetch: async () => { throw new Error("enotfound"); },
  });
  const f3 = await svc3.checkRelease();
  assert.equal(f3.latest, null);
  assert.equal(f3.error, "enotfound");
});

test("invalidateNasCaches busts store reads; doctor flag optional", async () => {
  let execCount = 0;
  const svc = createModelctlService({
    exec: async (spark, cmd) => {
      execCount += 1;
      if (cmd.includes("--version")) return "modelctl 0.18.0";
      if (cmd.includes("list --json")) return "[]";
      return '{"ok":true}';
    },
    getSettings: () => ({ modelctl: { nasRoot: "/nas" } }),
    registry: fakeRegistry([{ id: "nas1", kind: "nas" }]),
  });
  await svc.listNasModels();
  await svc.runNasDoctor();
  const n = execCount;
  await svc.listNasModels();
  await svc.runNasDoctor();
  assert.equal(execCount, n, "both cached");
  svc.invalidateNasCaches();
  await svc.listNasModels();
  await svc.runNasDoctor();
  // checkModelctl's version probe stays cached in versionCache, so a busted
  // nas list costs exactly one exec; doctor stays cached without the flag.
  assert.equal(execCount, n + 1, "nas list busted; doctor still cached without the flag");
  svc.invalidateNasCaches({ doctor: true });
  await svc.runNasDoctor();
  assert.equal(execCount, n + 2, "doctor busted with flag");
});
