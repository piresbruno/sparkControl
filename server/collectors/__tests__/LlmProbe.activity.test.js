/**
 * Liveness timestamps for the "busy but silent" window. A long prefill reports
 * no prompt tokens until the request finishes, so both rates read 0 while the
 * engine works — consumers tell "working" from "wedged" with these two clocks
 * instead of guessing from tok/s.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";

const probe = () => new LlmProbe({ id: "s1", lanIp: "10.0.0.1" }, 8081);

test("lastOutputAt appears only once the output counter is seen growing", () => {
  const p = probe();

  // First sample of a running process: the counter's history is unknown, so no
  // output timestamp is claimed.
  p.totalOutputTokens = 6586;
  assert.equal(p._getSnapshot().lastOutputAt, null);

  // Unchanged counters stay silent.
  assert.equal(p._getSnapshot().lastOutputAt, null);

  const before = Date.now();
  p.totalOutputTokens = 6600;
  const snapshot = p._getSnapshot();
  assert.equal(typeof snapshot.lastOutputAt, "number");
  assert.ok(snapshot.lastOutputAt >= before);

  // Idle ticks keep the last real output time.
  const at = p._getSnapshot().lastOutputAt;
  assert.equal(p._getSnapshot().lastOutputAt, at);
});

test("busySinceAt spans the whole request set, running or waiting", () => {
  const p = probe();
  assert.equal(p._getSnapshot().busySinceAt, null, "idle");

  p._getSnapshot(); // prime the idle state
  p.requestsRunning = 2;
  const started = p._getSnapshot().busySinceAt;
  assert.equal(typeof started, "number");

  // Still busy → the start time is kept.
  assert.equal(p._getSnapshot().busySinceAt, started);

  // Waiting-only work still counts as busy (a queued request is not idle).
  p.requestsRunning = 0;
  p.requestsWaiting = 1;
  assert.equal(p._getSnapshot().busySinceAt, started);

  p.requestsWaiting = 0;
  assert.equal(p._getSnapshot().busySinceAt, null, "idle again");

  // A second busy stretch gets a fresh start time.
  p.requestsRunning = 1;
  const second = p._getSnapshot().busySinceAt;
  assert.equal(typeof second, "number");
  assert.ok(second >= started);
});

test("backend-specific slot counters drive the same busy clock", () => {
  const p = probe();
  p._getSnapshot();
  // llama.cpp / exl3 paths report slots instead of requestsRunning.
  p.requestsRunning = null;
  p.slotsActive = 1;
  assert.equal(typeof p._getSnapshot().busySinceAt, "number");

  p.slotsActive = 0;
  assert.equal(p._getSnapshot().busySinceAt, null);
});
