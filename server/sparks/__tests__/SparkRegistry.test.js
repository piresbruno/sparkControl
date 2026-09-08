import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "registry-cov-"));
process.env.SPARKS_JSON_PATH = path.join(tmp, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");

const { SparkRegistry } = await import("../SparkRegistry.js");
const { setAppSecret } = await import("../../secretsStore.js");

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

const cfg = (id, over = {}) => ({
  id,
  name: id,
  lanIp: "10.0.0.5",
  isLocal: false,
  ssh: { host: "10.0.0.5", user: "root", auth: "key" },
  llmPorts: [8888],
  ...over,
});

test("addSpark normalizes, persists, rejects dupes and invalid ids", () => {
  const reg = new SparkRegistry();
  const s = reg.addSpark(cfg("spark-a"));
  assert.equal(s.id, "spark-a");
  assert.equal(s.role, "standalone");
  assert.equal(s.workerNode, false);
  assert.equal(s.modelctlEnabled, false, "B1 default");
  assert.equal(s.agentEnabled, false, "C1 default");
  assert.throws(() => reg.addSpark(cfg("spark-a")));
  assert.throws(() => reg.addSpark({ ...cfg("__overview__") }));
  // persisted to disk
  const onDisk = JSON.parse(fs.readFileSync(process.env.SPARKS_JSON_PATH, "utf8"));
  assert.equal(onDisk.sparks.length, 1);
});

test("worker normalization: role, label, head", () => {
  const reg = new SparkRegistry();
  const w = reg.addSpark(cfg("w1", { role: "worker", workerLabel: "Team X", workerHeadId: "head-1" }));
  assert.equal(w.role, "worker");
  assert.equal(w.workerNode, true);
  assert.equal(w.workerLabel, "Team X");
  assert.equal(w.workerHeadId, "head-1");
  assert.equal(w.llmMonitoring, false, "workers never monitor LLM");
});

test("setPassword/hasPassword never leak into public payloads", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("spark-b"));
  reg.setPassword("spark-b", "pw");
  assert.equal(reg.hasPassword("spark-b"), true);
  const pub = reg.publicSparks.find((s) => s.id === "spark-b");
  assert.equal(pub.ssh.password, undefined);
  assert.equal(pub.ssh.hasPassword, true);
});

test("llmApiKeyPorts expose ports only", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("spark-c"));
  reg._llmApiKeys.set("spark-c", { "8888": "sk", "9000": "sk2" });
  assert.deepEqual(reg.llmApiKeyPorts("spark-c").sort(), [8888, 9000]);
  assert.equal(reg.toPublic(reg.getSpark("spark-c")).llmApiKeys, undefined);
});

test("updateSpark merges + persists; removeSpark deletes", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("spark-d"));
  const updated = reg.updateSpark("spark-d", { name: "Renamed", llmPorts: [9000] });
  assert.equal(updated.name, "Renamed");
  assert.deepEqual(updated.llmPorts, [9000]);
  const onDisk = JSON.parse(fs.readFileSync(process.env.SPARKS_JSON_PATH, "utf8"));
  assert.equal(onDisk.sparks[0].name, "Renamed");
  reg.removeSpark("spark-d");
  assert.equal(reg.sparkIds.length, 0);
});

test("reorderSparks reorders the tab list", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("a"));
  reg.addSpark(cfg("b"));
  reg.addSpark(cfg("c"));
  const ordered = reg.reorderSparks(["c", "a", "b"]);
  assert.deepEqual(ordered.map((s) => s.id), ["c", "a", "b"]);
});

test("noteDetectedMac records and never accepts from PATCH", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("spark-e"));
  const s = reg.noteDetectedMac("spark-e", "aa:bb:cc:dd:ee:ff");
  assert.equal(s.detectedMacAddress, "aa:bb:cc:dd:ee:ff");
  const upd = reg.updateSpark("spark-e", { detectedMacAddress: "hacky" });
  assert.notEqual(upd.detectedMacAddress, "hacky");
});

test("config change listeners fire on add", () => {
  const reg = new SparkRegistry();
  let fired = 0;
  const off = reg.onChange?.(() => fired++) ?? (() => { reg._listeners.add(() => fired++); return () => {}; })();
  reg.addSpark(cfg("spark-f"));
  assert.ok(fired >= 1);
});

test("kind nas: forces monitoring off, standalone role, modelctl on; persists nasRoot", () => {
  const reg = new SparkRegistry();
  const nas = reg.addSpark(cfg("nas1", {
    kind: "nas",
    // Everything below must be coerced away by the registry:
    role: "head",
    llmMonitoring: true,
    comfyMonitoring: true,
    tailscaleMonitoring: true,
    hermesMonitoring: true,
    modelctlEnabled: false,
    nasRoot: "  /mnt/nas/llm-models  ",
  }));
  assert.equal(nas.kind, "nas");
  assert.equal(nas.role, "standalone");
  assert.equal(nas.workerNode, false);
  assert.equal(nas.workerHeadId, null);
  assert.equal(nas.workerLabel, null);
  assert.equal(nas.llmMonitoring, false);
  assert.equal(nas.comfyMonitoring, false);
  assert.equal(nas.tailscaleMonitoring, false);
  assert.equal(nas.hermesMonitoring, false);
  assert.equal(nas.modelctlEnabled, true, "NAS node always runs modelctl");
  assert.equal(nas.agentEnabled, false, "agent stays opt-in");
  assert.equal(nas.nasRoot, "/mnt/nas/llm-models", "trimmed, persisted");
  const onDisk = JSON.parse(fs.readFileSync(process.env.SPARKS_JSON_PATH, "utf8"));
  assert.equal(onDisk.sparks[0].nasRoot, "/mnt/nas/llm-models");
  assert.equal(onDisk.sparks[0].kind, "nas");
});

test("kind nas: empty nasRoot persists as \"\" (= use global)", () => {
  const reg = new SparkRegistry();
  const nas = reg.addSpark(cfg("nas2", { kind: "nas", nasRoot: "   " }));
  assert.equal(nas.nasRoot, "");
});

test("worker converted to nas via PATCH loses worker attribution", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("w2", { role: "worker", workerLabel: "Team", workerHeadId: "h1" }));
  const upd = reg.updateSpark("w2", { kind: "nas" });
  assert.equal(upd.kind, "nas");
  assert.equal(upd.role, "standalone");
  assert.equal(upd.workerNode, false);
  assert.equal(upd.workerLabel, null);
  assert.equal(upd.workerHeadId, null);
  assert.equal(upd.modelctlEnabled, true);
});

test("kind host/spark unchanged by the nas coercion; unknown kind rejected", () => {
  const reg = new SparkRegistry();
  const host = reg.addSpark(cfg("h1", {
    kind: "host",
    comfyMonitoring: true,
    tailscaleMonitoring: true,
    hermesMonitoring: true,
    modelctlEnabled: true,
    nasRoot: "/ignored-but-persisted",
  }));
  assert.equal(host.kind, "host");
  assert.equal(host.comfyMonitoring, true);
  assert.equal(host.tailscaleMonitoring, true);
  assert.equal(host.hermesMonitoring, true);
  assert.equal(host.modelctlEnabled, true);
  assert.equal(host.nasRoot, "/ignored-but-persisted");
  const plain = reg.addSpark(cfg("s1", { kind: "spark" }));
  assert.equal(plain.kind, "spark");
  assert.equal(plain.modelctlEnabled, false);
  assert.throws(() => reg.addSpark(cfg("x1", { kind: "bogus" })), /Invalid Spark kind/);
  assert.throws(() => reg.updateSpark("s1", { kind: "nas2" }), /Invalid Spark kind/);
  // A partial PATCH without kind never trips the check.
  const ok = reg.updateSpark("s1", { name: "Renamed" });
  assert.equal(ok.name, "Renamed");
  assert.equal(ok.kind, "spark");
});
