import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrefillPrompt, timeoutMsForSize, normalizeContextSizes, ALLOWED_CONTEXT_SIZES, DEFAULT_CONTEXT_SIZES } from "../PrefillBench.js";

test("buildPrefillPrompt scales with the target token count", () => {
  const small = buildPrefillPrompt(1000, "salt-1");
  const big = buildPrefillPrompt(100000, "salt-1");
  assert.ok(big.length > small.length, "larger target → longer prompt");
  assert.ok(small.includes("salt-1"), "salt embedded for uniqueness");
});

test("timeoutMsForSize grows with context size", () => {
  assert.ok(timeoutMsForSize(ALLOWED_CONTEXT_SIZES.at(-1)) > timeoutMsForSize(ALLOWED_CONTEXT_SIZES[0]));
});

test("normalizeContextSizes filters junk; non-array → default sizes", () => {
  const ok = normalizeContextSizes([1000, 999999, "abc", null]);
  assert.deepEqual(ok, ok.filter((n) => ALLOWED_CONTEXT_SIZES.includes(n)));
  assert.ok(ok.every((n) => ALLOWED_CONTEXT_SIZES.includes(n)));
  assert.deepEqual(normalizeContextSizes(undefined), []);
  assert.deepEqual(normalizeContextSizes("nope"), []);
});
