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
