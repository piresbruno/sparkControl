/**
 * PrefillBench helpers + job-manager gates (no live LLM calls).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "http";
import os from "os";
import path from "path";
import fs from "fs";
import {
  ALLOWED_CONTEXT_SIZES,
  DEFAULT_CONTEXT_SIZES,
  PrefillBenchManager,
  buildPrefillPrompt,
  formatContextSize,
  normalizeContextSizes,
  timeoutMsForSize,
} from "../PrefillBench.js";

test("allowed sizes include 300k and power-of-two steps", () => {
  assert.ok(ALLOWED_CONTEXT_SIZES.includes(300000));
  assert.ok(ALLOWED_CONTEXT_SIZES.includes(1024));
  assert.ok(ALLOWED_CONTEXT_SIZES.includes(131072));
  assert.deepEqual(DEFAULT_CONTEXT_SIZES, [4096, 8192, 16384, 32768]);
});

test("formatContextSize uses compact labels", () => {
  assert.equal(formatContextSize(1024), "1k");
  assert.equal(formatContextSize(32768), "32k");
  assert.equal(formatContextSize(300000), "300k");
  assert.equal(formatContextSize(262144), "256k");
});

test("normalizeContextSizes sorts, uniques, and drops unknowns", () => {
  assert.deepEqual(normalizeContextSizes([8192, 1024, 8192, 99, "4096"]), [
    1024, 4096, 8192,
  ]);
  assert.deepEqual(normalizeContextSizes("nope"), []);
  assert.deepEqual(normalizeContextSizes([]), []);
});

test("buildPrefillPrompt puts salt first so sizes do not share a prefix", () => {
  const a = buildPrefillPrompt(128, "salt-aaa");
  const b = buildPrefillPrompt(128, "salt-bbb");
  assert.ok(a.startsWith("[prefill-bench salt-aaa]"));
  assert.ok(b.startsWith("[prefill-bench salt-bbb]"));
  assert.notEqual(a.slice(0, 40), b.slice(0, 40));
  const small = buildPrefillPrompt(64, "x");
  const large = buildPrefillPrompt(4096, "x");
  assert.ok(large.length > small.length * 10);
});

test("timeoutMsForSize scales with context and caps", () => {
  assert.equal(timeoutMsForSize(1024), 90_000);
  assert.ok(timeoutMsForSize(262144) > 1_800_000); // >30 min at 256k
  assert.ok(timeoutMsForSize(300000) <= 2_700_000);
  assert.ok(timeoutMsForSize(300000) > timeoutMsForSize(8192));
});

test("PrefillBenchManager.start rejects empty sizes and overlapping jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefill-bench-"));
  const mgr = new PrefillBenchManager(
    path.join(dir, "hist.json"),
    path.join(dir, "active.json")
  );
  assert.throws(
    () =>
      mgr.start({
        sparkId: "s1",
        lanIp: "127.0.0.1",
        port: 8888,
        modelId: "m",
        contextSizes: [],
      }),
    /at least one context size/i
  );

  mgr.activeBySpark.set("s1", "fake-id");
  assert.throws(
    () =>
      mgr.start({
        sparkId: "s1",
        lanIp: "127.0.0.1",
        port: 8888,
        modelId: "m",
        contextSizes: [1024],
      }),
    /already running/i
  );
});

test("a running job reports the in-flight size, its start time, and the abort cap", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefill-progress-"));
  const mgr = new PrefillBenchManager(
    path.join(dir, "hist.json"),
    path.join(dir, "active.json")
  );

  // Minimal SSE engine: first token after a delay, then a usage chunk.
  const engine = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      setTimeout(() => {
        res.write(
          'data: {"model":"m1","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1024,"completion_tokens":1,"total_tokens":1025}}\n\n'
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }, 200);
    });
  });
  await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const port = engine.address().port;
  const waitFor = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return null;
  };

  try {
    mgr.start({ sparkId: "s1", lanIp: "127.0.0.1", port, modelId: "m1", contextSizes: [1024] });

    // Warmup precedes the first level, so wait for the level to be announced.
    const inFlight = await waitFor(() => {
      const active = mgr.getActive("s1");
      return active?.progress?.currentContext != null ? active : null;
    });
    assert.ok(inFlight, "level reported in flight");
    assert.equal(inFlight.progress.currentContext, 1024);
    assert.equal(typeof inFlight.progress.levelStartedAt, "number");
    assert.equal(inFlight.progress.timeoutMs, timeoutMsForSize(1024));
    assert.match(inFlight.progress.message, /Prefilling 1k/);

    // Completion clears them: a finished job must not advertise a live level.
    const finished = await waitFor(() => {
      const active = mgr.getActive("s1");
      if (active) return null;
      const last = mgr.getLast("s1");
      return last && last.status !== "running" ? last : null;
    });
    assert.ok(finished, "job finished");
    assert.equal(finished.status, "completed");
    assert.equal(finished.progress.currentContext, null);
    assert.equal(finished.progress.levelStartedAt, null);
    assert.equal(finished.progress.timeoutMs, null);
  } finally {
    engine.close();
  }
});
