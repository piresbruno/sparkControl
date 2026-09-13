/**
 * sleep() must not leak abort listeners: a shared AbortSignal across many
 * sleeps (bench loops) used to accumulate one listener per call.
 * Run: npm test
 */
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { strict as assert } from "node:assert";
import { sleep } from "../LlmStreaming.js";

test("sleep removes its abort listener after normal completion", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 50; i += 1) {
    await sleep(1, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, `leak after iteration ${i}`);
  }
});

test("sleep rejects with AbortError on abort and removes its listener", async () => {
  const controller = new AbortController();
  const pending = sleep(10_000, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("sleep rejects immediately when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sleep(10_000, controller.signal), { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
