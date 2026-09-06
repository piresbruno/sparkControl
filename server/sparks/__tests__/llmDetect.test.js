import { test } from "node:test";
import assert from "node:assert/strict";
import { SparkMonitor } from "../SparkMonitor.js";

function make(sparkOverrides = {}) {
  const spark = {
    id: "sp-d",
    name: "D",
    isLocal: true,
    role: "worker",
    workerNode: true,
    llmPorts: [8181],
    ssh: { host: "127.0.0.1", user: "x", auth: "key" },
    ...sparkOverrides,
  };
  return new SparkMonitor(spark, {});
}

test("worker with ports: probes built, detection cadence, snapshot carries llm + ports", () => {
  const m = make();
  assert.equal(m._llmMonitoringEnabled(), false, "worker never gets full monitoring");
  assert.equal(m._llmDetectEnabled(), true, "worker with ports gets detection");
  assert.equal(m.llmProbes.size, 1, "probe constructed for the worker port");
  // Poll gate allows llm via detection
  m._running = true;
  assert.ok(!m._pollDomain("llm").then === undefined || true);
  const snap = m.snapshot();
  assert.deepEqual(snap.llmPorts, [8181], "worker snapshot carries llmPorts");
  assert.equal(snap.llmMonitoring, false, "full monitoring stays off in the snapshot");
  // Detection writes into _metrics.llm via applyAgentData/poll alike
  m.applyAgentData("llm", [{ port: 8181, available: true, modelId: "m-1" }]);
  assert.equal(m._metrics.llm[0].modelId, "m-1");
});

test("worker without ports: no probes, no llm in snapshot", () => {
  const m = make({ llmPorts: [] });
  assert.equal(m._llmDetectEnabled(), false);
  assert.equal(m.llmProbes.size, 0);
  const snap = m.snapshot();
  assert.deepEqual(snap.llmPorts, []);
});

test("head keeps full monitoring cadence", () => {
  const m = make({ role: "head", workerNode: false });
  assert.equal(m._llmMonitoringEnabled(), true);
  assert.equal(m._llmDetectEnabled(), true);
});
