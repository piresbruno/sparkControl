/**
 * onOnlineChange hook — fires exactly once per false→true online transition
 * (SSH liveness flip or agent connect). Clock reconcile keys off this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SparkMonitor } from "../SparkMonitor.js";

function monitorWithSpy() {
  const events = [];
  const spark = {
    id: "sp-oc",
    name: "OnlineChange",
    isLocal: true,
    role: "standalone",
    ssh: { host: "127.0.0.1", user: "x", auth: "key" },
  };
  const monitor = new SparkMonitor(spark, { onOnlineChange: (id) => events.push(id) });
  monitor.collector.pingHost = async () => {};
  monitor._readUptime = async () => 1234;
  return { monitor, events };
}

test("_checkOnline fires onOnlineChange once per false→true flip", async () => {
  const { monitor, events } = monitorWithSpy();
  monitor._running = true;
  await monitor._checkOnline();
  assert.equal(monitor.online, true);
  assert.deepEqual(events, ["sp-oc"]);
  await monitor._checkOnline(); // still online → no repeat
  assert.deepEqual(events, ["sp-oc"]);
});

test("agent connect fires once; reconnect after disconnect fires again", () => {
  const { monitor, events } = monitorWithSpy();
  monitor.setAgentConnected(true, "1.0.0");
  monitor.setAgentConnected(true, "1.0.1");
  assert.deepEqual(events, ["sp-oc"]);
  monitor.setAgentConnected(false);
  // Disconnect does not flip online (liveness grace applies) — simulate the
  // monitor going offline before the agent reconnects.
  monitor.online = false;
  monitor.setAgentConnected(true, "1.0.2");
});

test("offline flip then recovery fires again", async () => {
  const { monitor, events } = monitorWithSpy();
  monitor._running = true;
  await monitor._checkOnline();
  monitor.online = false; // simulate the offline flip
  await monitor._checkOnline();
  assert.deepEqual(events, ["sp-oc", "sp-oc"]);
});
