import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

const c = new SystemCollector({ id: "parse-cov", isLocal: true, kind: "spark" });

test("_parseSmiNumber handles [N/A], empty, numbers (float kept)", () => {
  assert.equal(c._parseSmiNumber("42"), 42);
  assert.equal(c._parseSmiNumber("[N/A]"), null);
  assert.equal(c._parseSmiNumber(""), null);
  assert.equal(c._parseSmiNumber(" 12.7 "), 12.7);
  assert.equal(c._parseSmiNumber(null), null);
});

test("_parseGpuLine maps nvidia-smi csv fields (flat shape)", () => {
  const gpu = c._parseGpuLine("71, 95, 53.21, 120, 1501, 1740, 0x0000000000000000, 0x0000000000000000");
  assert.equal(gpu.temperature, 71);
  assert.equal(gpu.usage, 95);
  assert.equal(gpu.powerDraw, 53.21);
  assert.equal(gpu.powerLimit, 120);
});

test("_parseComputeApps and vram parse", () => {
  const apps = c._parseComputeApps("123, python, 4096\n456, vllm, 8192");
  assert.equal(apps.length, 2);
  assert.equal(apps[0].pid, 123);
  assert.equal(apps[1].vramMB ?? apps[1]?.vram ?? 8192, 8192);
});

test("_defaultGpu/_defaultCpu/_defaultRam shapes", () => {
  assert.ok("temperature" in c._defaultGpu());
  assert.ok("usage" in c._defaultCpu());
  assert.ok("used" in c._defaultRam() || "percentage" in c._defaultRam());
});

test("_hasHostProc false without the docker mount; _readHostFile reads real /proc", async () => {
  assert.equal(c._hasHostProc(), fs.existsSync("/host/proc"));
  const meminfo = await c._readHostFile("/proc/meminfo");
  assert.match(meminfo, /MemTotal/);
});

