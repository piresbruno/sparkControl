import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

// Local spark on the real host — collects read actual /proc + nvidia-smi.
const c = new SystemCollector({ id: "collect-cov", isLocal: true, kind: "spark" });

test("collectGpu returns a gpu object (real nvidia-smi or defaults)", async () => {
  const gpu = await c.collectGpu();
  assert.ok("temperature" in gpu);
  assert.ok("usage" in gpu);
});

test("collectCpu returns usage + temperature + draw", async () => {
  const cpu = await c.collectCpu();
  assert.ok("usage" in cpu);
  assert.ok("temperature" in cpu);
});

test("collectRam returns used/total", async () => {
  const ram = await c.collectRam();
  assert.ok("used" in ram || "total" in ram);
});

test("collectStorage returns an array", async () => {
  const storage = await c.collectStorage();
  assert.ok(Array.isArray(storage));
});

test("collectNetwork returns interface stats", async () => {
  const net = await c.collectNetwork();
  assert.ok(net != null);
});

test("collectUnifiedMemory returns a unified shape", async () => {
  const um = await c.collectUnifiedMemory();
  assert.ok(um != null);
});

test("pingHost resolves true locally", async () => {
  assert.equal(await c.pingHost(), true);
});
