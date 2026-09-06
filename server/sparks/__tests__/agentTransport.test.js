import { test } from "node:test";
import assert from "node:assert/strict";
import { SparkMonitor } from "../SparkMonitor.js";
import { AgentRegistry } from "../../agent/agentRegistry.js";

function monitorStub(sparkOverrides = {}) {
  const spark = {
    id: "sp-agent",
    name: "Agent",
    isLocal: true,
    role: "head",
    llmPorts: [8888],
    ssh: { host: "127.0.0.1", user: "x", auth: "key" },
    ...sparkOverrides,
  };
  const monitor = new SparkMonitor(spark, {
    collectorFactory: null, // default ctor path builds real collectors; agent path never polls them
  });
  return monitor;
}

test("setAgentConnected switches transport + suspends SSH polls + applyAgentData parity", () => {
  const monitor = monitorStub();
  assert.equal(monitor.transport, "ssh");
  assert.equal(monitor.online, false);
  monitor.setAgentConnected(true, "1.0.0");
  assert.equal(monitor.transport, "agent");
  assert.equal(monitor.agentVersion, "1.0.0");
  assert.equal(monitor.online, true);
  assert.equal(monitor._agentSuspended, true);

  // applyAgentData writes the same _metrics shapes the collectors produce.
  const gpuShape = { temperature: 50, usage: 10, powerDraw: 20 };
  const cpuShape = { usage: 11, temperature: 45 };
  monitor.applyAgentData("gpu", gpuShape);
  monitor.applyAgentData("cpu", cpuShape);
  monitor.applyAgentData("llm", [{ port: 8888, modelId: "m1", available: true }]);
  assert.equal(monitor._metrics.gpu, gpuShape);
  assert.equal(monitor._metrics.cpu, cpuShape);
  assert.equal(monitor._metrics.llm.length, 1);
  assert.equal(monitor._metrics.llm[0].modelId, "m1");

  // SSH polls idle while suspended: _pollDomain returns without side effects.
  monitor._running = true;
  const before = monitor._metrics.gpu;
  return monitor._pollDomain("gpu").then(() => {
    assert.equal(monitor._metrics.gpu, before, "suspended SSH poll must not overwrite agent data");
  });
});

test("disconnect restores ssh transport; snapshot carries transport", () => {
  const monitor = monitorStub();
  monitor.setAgentConnected(true, "1.0.0");
  const snapOn = monitor.snapshot();
  assert.equal(snapOn.transport, "agent");
  assert.equal(snapOn.agentVersion, "1.0.0");
  monitor.setAgentConnected(false);
  assert.equal(monitor.transport, "ssh");
  assert.equal(monitor.agentVersion, null);
  assert.equal(monitor._agentSuspended, false);
  const snapOff = monitor.snapshot();
  assert.equal(snapOff.transport, "ssh");
});

test("registry events reach the monitor via listener wiring", () => {
  const reg = new AgentRegistry();
  const monitor = monitorStub();
  reg.onConnect((id, v) => monitor.setAgentConnected(true, v));
  reg.onDisconnect((id) => monitor.setAgentConnected(false));
  const fakeWs = { readyState: 1, send: () => {}, close: () => {} };
  reg.register(fakeWs, { sparkId: "sp-agent", token: "t", proto: 1, agentVersion: "9.9" }, "t", new Set(["sp-agent"]));
  assert.equal(monitor.transport, "agent");
  assert.equal(monitor.agentVersion, "9.9");
  reg.unregister(fakeWs);
  assert.equal(monitor.transport, "ssh");
});
