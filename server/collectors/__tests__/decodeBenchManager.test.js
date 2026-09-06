import { test } from "node:test";
import assert from "node:assert/strict";
import { DecodeBenchManager } from "../DecodeBench.js";
import { decodeBenchPromptForType, pickDecodeBenchPrompts } from "../../../src/shared/llmPrompts.js";

test("bench prompts exist for each type and scale with concurrency", () => {
  for (const t of ["structured", "prose", "code", "json"]) {
    const p = decodeBenchPromptForType(t);
    assert.ok(typeof p === "string" && p.length > 0, `${t} prompt non-empty`);
  }
  const picked = pickDecodeBenchPrompts(4, "structured");
  assert.equal(picked.length, 4);
});

test("DecodeBenchManager getActive/list lifecycle on a fresh manager", () => {
  const mgr = new DecodeBenchManager();
  assert.equal(mgr.getActive("nonexistent"), null);
  assert.deepEqual(mgr.list?.("nonexistent") ?? [], []);
});
