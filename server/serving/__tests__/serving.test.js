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
