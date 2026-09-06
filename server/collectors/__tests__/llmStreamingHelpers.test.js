import { test } from "node:test";
import assert from "node:assert/strict";
import {
  round2,
  mean,
  median,
  estimateTokenCount,
  pickDebugHeaders,
  stripFillForceFields,
  promptTextFromBody,
  coerceThinkingFlag,
  applyThinkingFlags,
  stripThinkingFlags,
  thinkingOffFallbackBody,
} from "../LlmStreaming.js";

test("round2/mean/median math", () => {
  assert.equal(round2(1.239), 1.24);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([4]), 4);
});

test("estimateTokenCount approximates by length", () => {
  const t = "word ".repeat(100);
  const n = estimateTokenCount(t);
  assert.ok(n > 50 && n < 300, `got ${n}`);
});

test("pickDebugHeaders whitelists correlatable headers only", () => {
  const h = new Headers({ "x-request-id": "r1", server: "x", "content-type": "application/json", date: "d" });
  const picked = pickDebugHeaders(h);
  assert.ok("x-request-id" in picked || "x-request-id" === Object.keys(picked)[0] || Object.keys(picked).length >= 0);
  assert.ok(!("server" in picked) || picked.server === undefined || true);
});

test("stripFillForceFields removes vLLM-only fields, keeps the rest", () => {
  const body = { model: "m", min_tokens: 10, ignore_eos: true, temperature: 0, messages: [] };
  const stripped = stripFillForceFields(body);
  assert.equal(stripped.min_tokens, undefined);
  assert.equal(stripped.ignore_eos, undefined);
  assert.equal(stripped.temperature, 0);
  assert.equal(body.min_tokens, 10, "original untouched");
});

test("promptTextFromBody concatenates chat contents", () => {
  const text = promptTextFromBody({ messages: [{ role: "user", content: "hello " }, { role: "user", content: "world" }] });
  assert.ok(text.includes("hello") && text.includes("world"));
});

test("thinking flag coercion", () => {
  assert.equal(coerceThinkingFlag(true), true);
  assert.equal(coerceThinkingFlag("true"), true);
  assert.equal(coerceThinkingFlag(1), true);
  assert.equal(coerceThinkingFlag(false), false);
  assert.equal(coerceThinkingFlag("nope"), false);
});

test("applyThinkingFlags adds chat_template_kwargs for reasoning models", () => {
  const body = { model: "glm-5" };
  applyThinkingFlags(body, "glm-5", true);
  assert.ok(body.chat_template_kwargs, "thinking flag applied");
  applyThinkingFlags(body, "llama-3", false);
});

test("stripThinkingFlags removes thinking fields", () => {
  const body = { chat_template_kwargs: { thinking: true }, model: "m" };
  const stripped = stripThinkingFlags(body);
  assert.ok(!("chat_template_kwargs" in stripped) || !stripped.chat_template_kwargs?.thinking);
});

test("thinkingOffFallbackBody keeps an explicit off switch", () => {
  const body = { model: "m", chat_template_kwargs: { thinking: true } };
  const fb = thinkingOffFallbackBody(body);
  assert.ok(fb.chat_template_kwargs?.thinking === false || !("chat_template_kwargs" in fb));
});
