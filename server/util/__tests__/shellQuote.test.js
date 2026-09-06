import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { shellQuote } from "../shellQuote.js";

test("safe charset passes through unquoted", () => {
  assert.equal(shellQuote("Qwen3-30B-A3B"), "Qwen3-30B-A3B");
  assert.equal(shellQuote("/mnt/nas/llm-models"), "/mnt/nas/llm-models");
  assert.equal(shellQuote("git+https://github.com/piresbruno/modelctl"), "git+https://github.com/piresbruno/modelctl");
  assert.equal(shellQuote("~/.local/bin/modelctl"), "~/.local/bin/modelctl");
  assert.equal(shellQuote("a.b_c-d/e@f+g:h"), "a.b_c-d/e@f+g:h");
});

test("injection edges are single-quoted", () => {
  assert.equal(shellQuote("a b"), `'a b'`);
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(shellQuote("$(cmd)"), `'$(cmd)'`);
  assert.equal(shellQuote(";"), `';'`);
  assert.equal(shellQuote("`id`"), "'`id`'");
  assert.equal(shellQuote("a\nb"), `'a\nb'`);
});

test("dangerous metacharacters are inert inside the quoting", () => {
  // Everything shellQuote returns must be a single shell word.
  const cases = ["a b", "a'b", "$(cmd)", ";", "`id`", "a\nb", '"$x"', "a|b", "a&b", "$HOME", "*"];
  for (const c of cases) {
    const q = shellQuote(c);
    assert.ok(!/\s/.test(q.trim()) || q.startsWith("'"), `expected single word for ${JSON.stringify(c)}: ${q}`);
  }
  // Simplest equivalence: sh -c "printf %s <quoted>" must reproduce the input.
  for (const c of cases) {
    const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(c)}`], { encoding: "utf8" });
    assert.equal(out, c);
  }
});

test("quotes escape existing single quotes without breaking the wrapper", () => {
  const q = shellQuote("it's");
  assert.equal(q, `'it'\\''s'`);
  const out = execFileSync("sh", ["-c", `printf %s ${q}`], { encoding: "utf8" });
  assert.equal(out, "it's");
});
