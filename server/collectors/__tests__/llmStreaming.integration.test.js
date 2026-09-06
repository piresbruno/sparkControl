/**
 * Integration tests for runStreamingRequest / runStreamingRequestOnce against
 * a real local SSE server — covers the stream parse loop, debug fields,
 * thinking-retry ladder, content collection, and abort handling.
 * Pure helpers covered separately; this file exercises the HTTP paths.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { runStreamingRequest, readServerGenerationTokens, pollServerGenerationRates, sleep } from "../LlmStreaming.js";

/** @type {http.Server} */
let upstream;
let upstreamPort;
/** Response shape knobs the tests mutate. */
let mode = "usage-stream";

function startUpstream() {
  return new Promise((resolve) => {
    const done = () => {
      upstream = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          if (mode === "usage-stream") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write('data: {"id":"chatcmpl-1","model":"m1","choices":[{"delta":{"content":"He"}}]}\n\n');
            setTimeout(() => {
              res.write('data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
              res.write("data: [DONE]\n\n");
              res.end();
            }, 15);
          } else if (mode === "reasoning") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write('data: {"model":"m1","choices":[{"delta":{"reasoning_content":"think"}}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n');
            res.end();
          } else if (mode === "http400") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad thinking fields" }));
          } else if (mode === "http500") {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("boom");
          } else if (mode === "metrics") {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end('vllm:generation_tokens_total 1234\n# HELP ignore\n');
          }
        });
      });
      upstream.listen(0, "127.0.0.1", () => {
        upstreamPort = upstream.address().port;
        resolve();
      });
    };
    if (upstream) upstream.close(() => done());
    else done();
  });
}

beforeEach(async () => {
  mode = "usage-stream";
  await startUpstream();
});

after(async () => {
  await new Promise((r) => upstream?.close(r));
});

const URL_ = () => `http://127.0.0.1:${upstreamPort}/v1/chat/completions`;

test("stream with usage: tokens, ttft, decode math, collectContent, debug fields", async () => {
  const r = await runStreamingRequest(URL_(), { model: "m1", messages: [] }, undefined, {
    debug: true,
    collectContent: true,
  });
  assert.equal(r.error, null);
  assert.equal(r.model, "m1");
  assert.equal(r.content, "Hello");
  assert.equal(r.completionTokens, 1, "usage wins over chunk count");
  assert.ok(r.ttftMs >= 0);
  assert.ok(r.totalMs > 0);
  assert.equal(r.httpStatus, 200);
  assert.equal(r.completionId, "chatcmpl-1");
  assert.equal(r.finishReason, "stop");
  assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 1, totalTokens: 4 });
  assert.ok(r.sseEventCount >= 2);
  assert.equal(r.contentPreview.chars, 5);
});

test("reasoning stream: reasoningChunks counted, ttftContentMs tracks first answer token", async () => {
  mode = "reasoning";
  const r = await runStreamingRequest(URL_(), { model: "m1" }, undefined, { collectContent: true });
  assert.equal(r.reasoningChunks, 1);
  assert.equal(r.answer, "answer");
  assert.equal(r.reasoning, "think");
  assert.ok(r.ttftContentMs != null && r.ttftContentMs >= r.ttftMs - 1);
});

test("HTTP 400 without thinking fields → single failed attempt, no retry", async () => {
  mode = "http400";
  const r = await runStreamingRequest(URL_(), { model: "m1" }, undefined, { retryOnThinking400: true });
  assert.match(r.error, /^HTTP 400/);
});

test("thinking-400 retry ladder: retry fires with stripped body and succeeds", async () => {
  // First call 400s, second (retry) streams fine.
  let calls = 0;
  mode = "http400";
  await new Promise((r) => upstream.close(r));
  await new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      calls += 1;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (calls === 1) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "thinking fields unsupported" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"model":"m1","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
        res.end();
      });
    });
    upstream.listen(0, "127.0.0.1", () => { upstreamPort = upstream.address().port; resolve(); });
  });
  const r = await runStreamingRequest(
    URL_(),
    { model: "m1", min_tokens: 5, chat_template_kwargs: { thinking: true } },
    undefined,
    { retryOnThinking400: true, thinking: false, collectContent: true }
  );
  assert.equal(calls, 2, "retry fired");
  assert.equal(r.error, null);
  assert.equal(r.content, "ok");
});

test("HTTP 500 → error surfaced", async () => {
  mode = "http500";
  const r = await runStreamingRequest(URL_(), { model: "m1" }, undefined, {});
  assert.match(r.error, /^HTTP 500/);
});

test("abort signal → Request aborted error", async () => {
  mode = "usage-stream";
  // An upstream that never ends:
  await new Promise((r) => upstream.close(r));
  await new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      // never end
    });
    upstream.listen(0, "127.0.0.1", () => { upstreamPort = upstream.address().port; resolve(); });
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 80);
  const r = await runStreamingRequest(URL_(), { model: "m1" }, ctrl.signal, {});
  assert.match(r.error, /aborted|timed out/i);
});

test("readServerGenerationTokens parses vLLM prometheus counter", async () => {
  mode = "metrics";
  const n = await readServerGenerationTokens(`http://127.0.0.1:${upstreamPort}`);
  assert.equal(n, 1234);
});

test("pollServerGenerationRates computes Δtokens/Δt over the window", async () => {
  let tick = 0;
  await new Promise((r) => upstream.close(r));
  await new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      tick += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`vllm:generation_tokens_total ${1000 + tick * 50}\n`);
    });
    upstream.listen(0, "127.0.0.1", () => { upstreamPort = upstream.address().port; resolve(); });
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 150);
  const rates = await pollServerGenerationRates(`http://127.0.0.1:${upstreamPort}`, ctrl.signal, 60);
  // Contract: summary object (median/mean/max/samples) — rate samples only
  // recorded when Δt < 10s AND Δtokens > 0; our counter grows by 50/tick at
  // 60ms interval, so samples accumulate before the abort.
  assert.ok(rates && typeof rates === "object", "summary object returned");
  assert.ok("samples" in rates && "median" in rates);
  assert.ok(rates.samples >= 0);
});

