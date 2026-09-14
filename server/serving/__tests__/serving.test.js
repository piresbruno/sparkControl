import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveScriptPath,
  parseServingHeader,
  listServingScripts,
  seedServingScripts,
  buildServeStartCommand,
  buildServeStopCommand,
  buildServeStatusCommand,
  buildServeLogCommand,
  parseServeStartOutput,
  parseServeStatusOutput,
  derivePathScriptId,
  recordPathScript,
  getPathScripts,
  resolveAnyScriptId,
  buildServeStartPathCommand,
} from "../serving.js";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serving-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("resolveScriptPath: valid ids resolve inside the serving dir", () => {
  const p = resolveScriptPath("example-vllm", tmp);
  assert.equal(p, path.join(tmp, "example-vllm.sh"));
  assert.equal(resolveScriptPath("My_Script.2", tmp), path.join(tmp, "My_Script.2.sh"));
});

test("resolveScriptPath: traversal and injection rejected (P1 RCE guard)", () => {
  for (const bad of ["../evil", "a/../b", "..", ".hidden", "-flag", "a/b", "a b", "a;b", "", null, "x".repeat(65)]) {
    assert.throws(() => resolveScriptPath(bad, tmp), undefined, `expected rejection for ${JSON.stringify(bad)}`);
  }
  // Deep escape attempt via encoded dots still caught by regex + containment.
  assert.throws(() => resolveScriptPath("....//....//etc", tmp));
  // Containment belt-and-suspenders: even a regex-passing id must stay inside.
  assert.throws(() => resolveScriptPath("sub/ok", tmp));
});

test("parseServingHeader extracts description and defaultPort", () => {
  const meta = parseServingHeader('# sparkdash-serve: description=vLLM server defaultPort=8080\nset -eu\n');
  assert.equal(meta.description, "vLLM server");
  assert.equal(meta.defaultPort, 8080);
  assert.deepEqual(parseServingHeader("# no header"), { description: "", defaultPort: null });
  assert.equal(parseServingHeader("# sparkdash-serve: defaultPort=99999").defaultPort, null, "port clamped to valid range");
});

test("listServingScripts reads the config dir with metadata", () => {
  fs.writeFileSync(path.join(tmp, "a.sh"), '# sparkdash-serve: description=Alpha defaultPort=7000\n');
  fs.writeFileSync(path.join(tmp, "b.sh"), "echo hi\n");
  const list = listServingScripts(tmp);
  assert.deepEqual(list.map((s) => s.id), ["a", "b"]);
  assert.equal(list[0].description, "Alpha");
  assert.equal(list[1].description, "");
});

test("seedServingScripts copies examples once; never overwrites user edits", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "seed-src-"));
  fs.writeFileSync(path.join(src, "example-a.sh"), "echo a\n");
  fs.writeFileSync(path.join(src, "readme.txt"), "ignore me");
  seedServingScripts(tmp, src);
  assert.ok(fs.existsSync(path.join(tmp, "example-a.sh")));
  assert.ok(!fs.existsSync(path.join(tmp, "readme.txt")));
  // User edit survives re-seed.
  fs.writeFileSync(path.join(tmp, "example-a.sh"), "echo user-edit\n");
  seedServingScripts(tmp, src);
  assert.equal(fs.readFileSync(path.join(tmp, "example-a.sh"), "utf8"), "echo user-edit\n");
  fs.rmSync(src, { recursive: true, force: true });
});

test("buildServeStartCommand: env contract quoted, setsid+nohup, pidfile, log overwrite, guard", () => {
  const cmd = buildServeStartCommand({
    scriptId: "example-vllm",
    scriptBody: "exec vllm serve x",
    modelName: "m1",
    port: 8080,
    extraArgs: "--gpu-memory-utilization 0.9",
  });
  assert.match(cmd, /env MODEL_NAME=m1 PORT=8080 EXTRA_ARGS='--gpu-memory-utilization 0\.9'/);
  assert.match(cmd, /setsid nohup env/);
  assert.match(cmd, /echo \$! > ~\/\.sparkdash\/runs\/example-vllm\.pid/);
  assert.match(cmd, /__ALREADY_RUNNING__/);
  // Injection-safe env values.
  const evil = buildServeStartCommand({ scriptId: "s", scriptBody: "x", modelName: "a;rm -rf /", port: 1 });
  assert.ok(evil.includes("'a;rm -rf /'"));
});

test("buildServeStopCommand: group kill ladder + missing pidfile → not running", () => {
  const cmd = buildServeStopCommand("example-vllm");
  assert.match(cmd, /__NOT_RUNNING__/);
  assert.match(cmd, /kill -- -"\$PGID"/);
  assert.match(cmd, /kill -9 -- -"\$PGID"/);
});

test("buildServeStatusCommand + parse: running with startedAt / stopped / offline-unknown", () => {
  const cmd = buildServeStatusCommand("example-vllm");
  assert.match(cmd, /kill -0 "\$\(cat ~\/\.sparkdash\/runs\/example-vllm\.pid\)"/);
  assert.match(cmd, /stat -c %Y/);
  assert.deepEqual(parseServeStatusOutput("running:1720000000"), { running: true, startedAt: 1720000000000 });
  assert.deepEqual(parseServeStatusOutput("stopped"), { running: false, startedAt: null });
  const unknown = parseServeStatusOutput("");
  assert.equal(unknown.running, "unknown");
  assert.ok(unknown.error != null);
});

test("parseServeStartOutput: ok / already-running / dead / unknown", () => {
  assert.deepEqual(parseServeStartOutput("__START_OK__"), { started: true, alreadyRunning: false });
  assert.deepEqual(parseServeStartOutput("__ALREADY_RUNNING__"), { started: false, alreadyRunning: true });
  assert.match(parseServeStartOutput("__START_DEAD__").error, /exited immediately/);
  assert.ok(parseServeStartOutput("").error);
});

test("buildServeLogCommand clamps byte counts", () => {
  assert.equal(buildServeLogCommand("s", 100), `tail -c 500 ~/.sparkdash/runs/s.log 2>/dev/null || true`);
  assert.match(buildServeLogCommand("s", 999999), /tail -c 100000/);
});

test("derivePathScriptId: sanitized basename + stable sha1 suffix, disjoint from library ids", () => {
  const id = derivePathScriptId("/home/me/My Server (v2).sh");
  assert.match(id, /^my-server--v2-[0-9a-f]{6}$/);
  // Deterministic across calls; different paths → different ids.
  assert.equal(id, derivePathScriptId("/home/me/My Server (v2).sh"));
  assert.notEqual(id, derivePathScriptId("/home/me/My Server (v3).sh"));
  // Same basename, different dirs → same sanitized prefix, different hash.
  const other = derivePathScriptId("/opt/other/My Server (v2).sh");
  assert.notEqual(other, id);
  assert.ok(other.startsWith("my-server--v2-"));
  // Empty basename falls back to "script".
  assert.match(derivePathScriptId("/opt/.sh"), /^script-[0-9a-f]{6}$/);
  // Long basenames stay within SCRIPT_ID_RE's 64-char ceiling (57 base + dash + 6 hash).
  const longId = derivePathScriptId("/opt/" + "a".repeat(120) + ".sh");
  assert.ok(longId.length <= 64, `id length ${longId.length} must be ≤ 64`);
  assert.match(longId, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.ok(!/[.-]$/.test(longId.slice(0, -7)), "no dangling separator before the hash");
});

test("recordPathScript persists and getPathScripts reads back; missing file is empty", () => {
  const mapPath = path.join(tmp, "path-scripts.json");
  assert.deepEqual(getPathScripts(mapPath), {});
  assert.equal(recordPathScript("a-123456", "/home/me/run.sh", mapPath), true);
  assert.deepEqual(getPathScripts(mapPath), { "a-123456": "/home/me/run.sh" });
  // Second record merges, not replaces.
  recordPathScript("b-abcdef", "/opt/x.sh", mapPath);
  assert.deepEqual(getPathScripts(mapPath), { "a-123456": "/home/me/run.sh", "b-abcdef": "/opt/x.sh" });
});


test("recordPathScript bounds the map to the newest 32 entries (status probe cost)", () => {
  const mapPath = path.join(tmp, "bounded.json");
  for (let i = 0; i < 40; i++) recordPathScript(`s-${String(i).padStart(2, "0")}`, `/opt/s${i}.sh`, mapPath);
  const map = getPathScripts(mapPath);
  assert.equal(Object.keys(map).length, 32);
  assert.equal(map["s-39"], "/opt/s39.sh"); // newest kept
  assert.equal(map["s-00"], undefined, "oldest dropped");
  assert.equal(map["s-07"], undefined);
  assert.ok(map["s-08"], "the newest 32 survive");
});

test("resolveAnyScriptId: library first, then path map, else throw", () => {
  const mapPath = path.join(tmp, "path-scripts.json");
  fs.writeFileSync(path.join(tmp, "lib.sh"), "echo hi\n");
  recordPathScript("p-123456", "/home/me/run.sh", mapPath);

  assert.deepEqual(resolveAnyScriptId("lib", tmp, mapPath), { kind: "library", path: path.join(tmp, "lib.sh") });
  assert.deepEqual(resolveAnyScriptId("p-123456", tmp, mapPath), { kind: "path", path: "/home/me/run.sh" });
  assert.throws(() => resolveAnyScriptId("missing", tmp, mapPath));
  // A path-map id pointing outside root-ish shapes stays a plain string —
  // only library ids get traversal-guarded.
  assert.throws(() => resolveAnyScriptId("nope", tmp, mapPath));
});

test("buildServeStartPathCommand: on-node file check, quoted path run, same env/pidfile contract", () => {
  const cmd = buildServeStartPathCommand({
    scriptId: "my-serve-123456",
    scriptPath: "/home/me/My Server (v2).sh",
    modelName: "Qwen3-32B-Q4",
    port: 8080,
    extraArgs: "--max-model-len 4096",
  });
  // Existence check emits the NO_SCRIPT marker and exits cleanly.
  assert.match(cmd, /^\[ -f ('\/home\/me\/My Server \(v2\)\.sh') \] \|\| \{ echo "__NO_SCRIPT__"; exit 0; \}$/m);
  // No base64 upload of library script body.
  assert.doesNotMatch(cmd, /base64 -d/);
  // Engine runs the node-local path via bash with the env contract.
  assert.match(
    cmd,
    /setsid nohup env MODEL_NAME=Qwen3-32B-Q4 PORT=8080 EXTRA_ARGS='--max-model-len 4096' bash '\/home\/me\/My Server \(v2\)\.sh' > ~\/\.sparkdash\/runs\/my-serve-123456\.log 2>&1 &/
  );
});
test("parseServeStartOutput: NO_SCRIPT maps to the check-the-path error", () => {
  assert.deepEqual(parseServeStartOutput("__NO_SCRIPT__"), {
    started: false,
    alreadyRunning: false,
    error: "script not found on node — check the path",
  });
});
