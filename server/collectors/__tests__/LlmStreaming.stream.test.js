/**
 * The LLM stream dispatcher pairing: LLM_STREAM_AGENT belongs to the undici
 * install we fetch with. Node's global fetch rejects a foreign-version
 * dispatcher, so this pins the pairing that removes undici's 300 s
 * headers/body idle timeouts for long bench streams.
 * Run: npm test
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import http from "node:http";
import { fetch as undiciFetch } from "undici";
import { LLM_STREAM_AGENT, runStreamingRequest } from "../LlmStreaming.js";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("LLM_STREAM_AGENT is accepted by undici fetch", async () => {
  const { server, port } = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  try {
    const res = await undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: LLM_STREAM_AGENT });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("runStreamingRequest reaches an OpenAI SSE endpoint through the agent", async () => {
  const { server, port } = await startServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      assert.match(raw, /"stream":true/);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"t","model":"test","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
      res.write(
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      );
      res.end("data: [DONE]\n\n");
    });
  });
  try {
    const result = await runStreamingRequest(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      { model: "test", messages: [{ role: "user", content: "hi" }], stream: true },
      AbortSignal.timeout(5_000),
      { debug: true, collectContent: true }
    );
    assert.equal(result.error, null);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.content, "hi");
    assert.equal(result.completionTokens, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
