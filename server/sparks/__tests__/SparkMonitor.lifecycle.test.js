/**
 * Lifecycle race guards: a collection that straddles stop()/updateConfig()
 * must not mutate the monitor (old-host metrics or rate baselines landing under
 * the new lifecycle), and it must not clear the new lifecycle's in-flight flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SparkMonitor } from "../SparkMonitor.js";

/** Local spark whose liveness path never touches the network or the fs. */
function monitorStub(overrides = {}) {
  const spark = {
    id: "sp-life",
    name: "Lifecycle",
    isLocal: true,
    role: "standalone",
    ssh: { host: "127.0.0.1", user: "x", auth: "key" },
    ...overrides,
  };
  const monitor = new SparkMonitor(spark);
  monitor.collector.pingHost = async () => {};
  return monitor;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let the liveness check clear pingHost and park on the uptime read. */
const flush = () => new Promise((r) => setImmediate(r));

test("stop() during an in-flight liveness check discards its result", async () => {
  const monitor = monitorStub();
  const uptimeGate = deferred();
  monitor._readUptime = () => uptimeGate.promise;
  monitor._running = true;

  const pending = monitor._checkOnline();
  await flush();
  assert.ok(monitor._inflight.online, "check parked on the uptime read");

  monitor.stop();
  uptimeGate.resolve(12345);
  await pending;

  assert.equal(monitor.online, false, "stale check must not flip online");
  assert.equal(monitor._uptimeSeconds, undefined, "stale uptime must not be committed");
  assert.ok(!monitor._inflight.online, "guard released, not left stuck");
});

test("updateConfig() discards an in-flight liveness result from the old config", async () => {
  const monitor = monitorStub();
  const uptimeGate = deferred();
  monitor._readUptime = () => uptimeGate.promise;
  monitor._running = true;

  const pending = monitor._checkOnline();
  await flush();
  monitor.updateConfig({ ...monitor.spark, name: "Renamed" });
  uptimeGate.resolve(4321);
  await pending;

  assert.equal(monitor.online, false, "old-config result must not flip online");
  assert.equal(monitor._uptimeSeconds, undefined, "old-config uptime must not be committed");
});
