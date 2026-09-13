import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLlmProxy } from "../llmProxy.js";
import { TraceStore } from "../../collectors/TraceStore.js";
import { createInflightRegistry } from "../inflightRegistry.js";

// ─── Fake upstream engine ─────────────────────────────────
/** @type {http.Server} */
let upstream;
let upstreamPort;
/** Last Authorization header seen by the upstream. */
let lastAuth = null;
/** Mode: "sse" | "json" | "error" */
let mode = "sse";
/** Delay (ms) before the upstream answers (sse 2nd delta / json response). */
let upstreamDelayMs = 30;
/** Set when an upstream response socket closes before writableEnded. */
let upstreamSawClose = false;
/** Set when the fake upstream fully consumed a json-mode request body. */
let upstreamSawBody = false;
/** Upstream request counter (429-cap test). */
let upstreamHits = 0;
/** Live registry wired into the app under test. */
let inflight;

function startUpstream() {
  return new Promise((resolve) => {
    // Close the previous per-test upstream first — orphaned listeners hold
    // the event loop open after the suite ends.
    const done = () => {
      upstream = http.createServer((req, res) => {
        lastAuth = req.headers.authorization || null;
        upstreamHits += 1;
        if (mode === "error") {
          res.destroy();
          return;
        }
        if (mode === "sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
          res.on("close", () => {
            if (!res.writableEnded) upstreamSawClose = true;
          });
          setTimeout(() => {
            res.write(
              'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }, upstreamDelayMs);
          return;
        }
        if (mode === "tools") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":""}}]}}]}\n\n');
          res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":7}}}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (mode === "anthropic") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"get_weather"}}\n\n');
          res.write('data: {"type":"message_delta","usage":{"cache_read_input_tokens":11}}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        // json mode
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          upstreamSawBody = true;
          res.on("close", () => {
            if (!res.writableEnded) upstreamSawClose = true;
          });
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                model: "m1",
                choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 3, completion_tokens: 1 },
              })
            );
          }, upstreamDelayMs);
        });
      });
      upstream.listen(0, "127.0.0.1", () => {
        upstreamPort = upstream.address().port;
        resolve();
      });
    };
    if (upstream) {
      upstream.close(() => done());
    } else {
      done();
    }
  });
}

// ─── App under test ───────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-proxy-"));
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, "key");
process.env.SETTINGS_JSON_PATH = path.join(tmp, "settings.json");

/** @type {TraceStore} */
let traceStore;
/** @type {express.Express} */
let app;
/** Settings knobs the tests mutate per case. */
const knobs = { traceCapture: true, traceCaptureBodies: true, traceProxyAllowedOrigins: [], proxyMaxInflightPerPort: 0 };

const registry = {
  getSpark(id) {
    if (id === "sp1") {
      return {
        id,
        isLocal: true,
        lanIp: "10.0.0.5",
        llmPorts: [upstreamPort],
        llmApiKeys: { [String(upstreamPort)]: "sk-stored-key" },
      };
    }
    if (id === "sp-remote") return { id, isLocal: false, lanIp: "10.0.0.6", llmPorts: [upstreamPort] };
    if (id === "sp-badhost") return { id, isLocal: false, lanIp: "169.254.169.254", llmPorts: [upstreamPort] };
    if (id === "sp-nohost") return { id, isLocal: false, lanIp: "", llmPorts: [upstreamPort] };
    return null;
  },
};

beforeEach(async () => {
  await startUpstream();
  traceStore = new TraceStore({ dbPath: ":memory:" });
  knobs.traceCapture = true;
  knobs.traceCaptureBodies = true;
  knobs.traceProxyAllowedOrigins = [];
  knobs.proxyMaxInflightPerPort = 0;
  upstreamDelayMs = 30;
  upstreamSawClose = false;
  upstreamSawBody = false;
  upstreamHits = 0;
  inflight = createInflightRegistry();
  app = express();
  app.use("/llm", createLlmProxy({ registry, settings: () => knobs, traceStore, inflight }));
  // Mirrors the production DELETE /api/llm/inflight/:id route (index.js).
  app.delete("/api/llm/inflight/:id", (req, res) => {
    const ok = inflight.cancel(req.params.id, "user");
    if (!ok) return res.status(404).json({ error: "In-flight request not found" });
    res.json({ success: true });
  });
});

after(async () => {
  traceStore?.stop();
  upstream?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** fetch-like helper over raw http.request — no keep-alive pool, so the
 * test process exits even with lingering sockets. */
function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || "GET", headers: opts.headers || {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      }
    );
    req.on("error", reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

/** http.request handle for mid-flight abort tests — result/error are
 * stashed on the req object once they settle. */
function rawRequest(url, opts = {}) {
  const u = new URL(url);
  const req = http.request(
    {
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: opts.method || "GET",
      headers: opts.headers || {},
    },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        req.__result = { status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") };
      });
    }
  );
  req.on("error", (err) => {
    req.__error = err;
  });
  if (opts.body != null) req.write(opts.body);
  req.end();
  return req;
}

/** Run fn against the app under test (real listen, ephemeral port). */
async function withServer(fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.on("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, server);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("404 unknown spark; 400 bad port; 403 disallowed/empty host", async () => {
  await withServer(async (base) => {
    let r = await fetch(`${base}/llm/nosuch/80/v1/models`);
    assert.equal(r.status, 404);
    r = await fetch(`${base}/llm/sp1/0/health`);
    assert.equal(r.status, 400);
    r = await fetch(`${base}/llm/sp1/99999/health`);
    assert.equal(r.status, 400);
    r = await fetch(`${base}/llm/sp1/abc/health`);
    assert.equal(r.status, 400);
    r = await fetch(`${base}/llm/sp-badhost/80/health`);
    assert.equal(r.status, 403);
    r = await fetch(`${base}/llm/sp-nohost/80/health`);
    assert.equal(r.status, 403);
  });
});

test("SSE pass-through intact + trace recorded (usage parsed, resText joined)", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
    const text = await r.text();
    assert.ok(text.includes('"content":"Hel"') && text.includes('"content":"lo"'));
    assert.ok(text.includes("[DONE]"));

    const { traces } = traceStore.list();
    assert.equal(traces.length, 1);
    const t = traces[0];
    assert.equal(t.source, "proxy");
    assert.equal(t.status, 200);
    assert.equal(t.stream, true);
    assert.ok(t.ttftMs >= 0);
    assert.equal(t.promptTokens, 5);
    assert.equal(t.completionTokens, 2);
    assert.equal(t.tokensEstimated, false);
    assert.equal(t.finishReason, "stop");
    const full = traceStore.get(t.id);
    assert.equal(full.model, "m1");
    assert.ok(full.reqBody.includes('"hi"'));
    assert.equal(full.resText, 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n");
  });
});

test("no Authorization sent → stored per-port key injected; client header wins", async () => {
  await withServer(async (base) => {
    await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`);
    assert.equal(lastAuth, "Bearer sk-stored-key");
    await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`, {
      headers: { authorization: "Bearer client-key" },
    });
    assert.equal(lastAuth, "Bearer client-key");
  });
});

test("non-streaming JSON: ttft ≈ headers time, usage parsed from body", async () => {
  mode = "json";
  await withServer(async (base) => {
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", prompt: "x" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.usage.prompt_tokens, 3);
    const t = traceStore.list().traces[0];
    assert.equal(t.stream, false);
    assert.equal(t.promptTokens, 3);
    assert.equal(t.completionTokens, 1);
    assert.equal(t.tokensEstimated, false);
    assert.equal(t.status, 200);
    const full = traceStore.get(t.id);
    assert.equal(full.model, "m1");
    assert.equal(full.resText.includes('"completion_tokens":1'), true);
  });
});

test("streamed completion without usage → completionTokens estimated from deltas", async () => {
  mode = "sse";
  // Replace upstream with a no-usage variant.
  await new Promise((r) => upstream.close(r));
  await new Promise((resolve) => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
      res.end();
    });
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = upstream.address().port;
      resolve();
    });
  });
  await withServer(async (base) => {
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true }),
    });
    await r.text();
    const t = traceStore.list().traces[0];
    assert.equal(t.completionTokens, 2, "2 content deltas → estimated 2 tokens");
    assert.equal(t.tokensEstimated, true);
    assert.equal(t.promptTokens, null, "prompt tokens never estimated");
  });
});

test("successful GET to probe-style paths is NOT recorded; failures ARE", async () => {
  await withServer(async (base) => {
    mode = "json";
    let r = await fetch(`${base}/llm/sp1/${upstreamPort}/health`);
    assert.equal(r.status, 200);
    assert.equal(traceStore.list().traces.length, 0, "GET /health 200 excluded");
    r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`);
    assert.equal(r.status, 200);
    assert.equal(traceStore.list().traces.length, 0, "GET /v1/models 200 excluded");
    // Non-probe path IS recorded.
    r = await fetch(`${base}/llm/sp1/${upstreamPort}/some/endpoint`);
    assert.equal(r.status, 200);
    assert.equal(traceStore.list().traces.length, 1);
    // Probe path failure recorded (upstream destroys the socket → 502, no throw).
    mode = "error";
    r = await fetch(`${base}/llm/sp1/${upstreamPort}/health`);
    assert.equal(r.status, 502);
    const { traces } = traceStore.list();
    assert.equal(traces.length, 2);
    assert.equal(traces[0].status, null);
    assert.match(traces[0].error || "", /ECONNRESET|socket hang up/);
  });
});

test("traceCapture off → pure forwarding, zero records", async () => {
  mode = "sse";
  knobs.traceCapture = false;
  await withServer(async (base) => {
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true }),
    });
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(traceStore.list().traces.length, 0);
  });
});

test("captureBodies off → entry recorded but bodies null", async () => {
  knobs.traceCaptureBodies = false;
  await withServer(async (base) => {
    await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: false }),
    });
    // json mode upstream
    const t = traceStore.list().traces[0];
    assert.ok(t, "entry recorded");
    const full = traceStore.get(t.id);
    assert.equal(full.reqBody, null);
    assert.equal(full.resText, null);
  });
});

test("upstream connect failure → 502 + recorded error entry", async () => {
  await withServer(async (base) => {
    const deadPort = await new Promise((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const r = await fetch(`${base}/llm/sp1/${deadPort}/v1/models`);
    assert.equal(r.status, 502);
    const t = traceStore.list().traces[0];
    assert.equal(t.status, null);
    assert.match(t.error || "", /ECONNREFUSED/);
  });
});

test("CORS default OFF; allowlist echoes exact origin + enumerated headers; OPTIONS 204 only when allowed", async () => {
  await withServer(async (base) => {
    mode = "json";
    // No allowlist: no CORS headers, OPTIONS not short-circuited (forwarded).
    let r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`, {
      headers: { origin: "http://evil.example" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    // Allowlisted: exact echo + enumerated headers.
    knobs.traceProxyAllowedOrigins = ["http://ok.example:5173"];
    r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`, {
      headers: { origin: "http://ok.example:5173" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), "http://ok.example:5173");
    assert.equal(r.headers.get("access-control-allow-headers"), "Authorization, Content-Type, Accept");
    assert.equal(r.headers.get("access-control-allow-methods"), "GET, POST, PUT, DELETE, OPTIONS");
    // Non-allowlisted origin gets nothing.
    r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`, {
      headers: { origin: "http://other.example" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    // OPTIONS preflight: 204 locally when allowed.
    r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`, {
      method: "OPTIONS",
      headers: { origin: "http://ok.example:5173" },
    });
    assert.equal(r.status, 204);
    // OPTIONS from non-allowlisted origin → forwarded upstream (404/json), never 204.
    r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`, {
      method: "OPTIONS",
      headers: { origin: "http://nope.example" },
    });
    assert.notEqual(r.status, 204);
    // Never wildcard.
    knobs.traceProxyAllowedOrigins = ["*"];
    r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/models`, {
      headers: { origin: "http://anything.example" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });
});

test("query strings survive the forward", async () => {
  await withServer(async (base) => {
    mode = "json";
    let seen = null;
    await new Promise((r) => upstream.close(r));
    await new Promise((resolve) => {
      upstream = http.createServer((req, res) => {
        seen = req.url;
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      upstream.listen(0, "127.0.0.1", () => {
        upstreamPort = upstream.address().port;
        resolve();
      });
    });
    // Non-probe path so the entry gets recorded.
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions?foo=bar&baz=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1" }),
    });
    assert.equal(r.status, 200);
    assert.equal(seen, "/v1/chat/completions?foo=bar&baz=1");
    const t = traceStore.list().traces[0];
    assert.equal(t.path, "/v1/chat/completions");
    assert.equal(t.query, "foo=bar&baz=1");
  });
});

// ─── A4: in-flight visibility & cancellation ──────────────

test("A4: entry visible with model/stream patched; cancel → upstream socket closes, trace marked, unregistered", async () => {
  mode = "sse";
  upstreamDelayMs = 400;
  await withServer(async (base) => {
    const client = rawRequest(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true }),
    });
    await new Promise((r) => setTimeout(r, 60));
    const entries = inflight.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].sparkId, "sp1");
    assert.equal(entries[0].model, "m1");
    assert.equal(entries[0].stream, true);
    assert.equal(entries[0].path, "/v1/chat/completions");
    const id = entries[0].id;

    const del = await fetch(`${base}/api/llm/inflight/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);

    await new Promise((r) => client.on("close", r));
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(upstreamSawClose, "upstream should observe premature socket close");
    assert.equal(inflight.list().length, 0, "entry unregistered on terminal");
    const del2 = await fetch(`${base}/api/llm/inflight/${id}`, { method: "DELETE" });
    assert.equal(del2.status, 404);
    const t = traceStore.list().traces[0];
    assert.ok(/cancelled \(user\)/.test(t.error), `trace error: ${t.error}`);
    assert.equal(t.status, null);
  });
});

test("A4: downstream abort mid-SSE → upstream destroyed, trace cancelled (client disconnect)", async () => {
  mode = "sse";
  upstreamDelayMs = 500;
  await withServer(async (base) => {
    const client = rawRequest(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true }),
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(inflight.list().length, 1);
    client.destroy();
    await new Promise((r) => client.on("close", r));
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(upstreamSawClose, "upstream should observe the abort");
    assert.equal(inflight.list().length, 0);
    const t = traceStore.list().traces[0];
    assert.ok(/cancelled \(client disconnect\)/.test(t.error), `trace error: ${t.error}`);
  });
});

test("A4: non-streaming cancel before response → client 502; upstream saw the full body (§6.2)", async () => {
  mode = "json";
  upstreamDelayMs = 300;
  await withServer(async (base) => {
    const client = rawRequest(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1" }),
    });
    await new Promise((r) => setTimeout(r, 40));
    const id = inflight.list()[0].id;
    const del = await fetch(`${base}/api/llm/inflight/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);

    await new Promise((r) => client.on("close", r));
    assert.ok(client.__result, "client should receive a pre-header 502");
    assert.equal(client.__result.status, 502);
    assert.ok(upstreamSawBody, "upstream consumed the full body before the cancel");
    await new Promise((r) => setTimeout(r, 20));
    const t = traceStore.list().traces[0];
    assert.ok(/cancelled \(user\)/.test(t.error), `trace error: ${t.error}`);
    assert.equal(t.status, null);
  });
});

test("A4: 429 when proxyMaxInflightPerPort exceeded; slot frees after cancel", async () => {
  mode = "sse";
  upstreamDelayMs = 400;
  knobs.proxyMaxInflightPerPort = 1;
  await withServer(async (base) => {
    const first = rawRequest(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true }),
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(inflight.list().length, 1);
    assert.equal(upstreamHits, 1);

    const second = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true }),
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error, "in-flight cap exceeded");
    assert.equal(upstreamHits, 1, "capped request never reaches upstream");
    assert.equal(inflight.list().length, 1, "429 request is not tracked");

    inflight.cancel(inflight.list()[0].id, "user");
    await new Promise((r) => first.on("close", r));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(inflight.list().length, 0);

    const third = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true }),
    });
    assert.equal(third.status, 200);
  });
});

test("A4: toolsReq from body; toolsUsed + cachedTokens from SSE (OpenAI shape)", async () => {
  mode = "tools";
  await withServer(async (base) => {
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m1",
        stream: true,
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });
    assert.equal(r.status, 200);
    await r.text();
    const t = traceStore.list().traces[0];
    assert.deepEqual(t.toolsReq, ["get_weather"]);
    assert.deepEqual(t.toolsUsed, [{ name: "get_weather", count: 1 }]);
    assert.equal(t.cachedTokens, 7);
  });
});

test("A4: Anthropic-style tool_use + cache_read_input_tokens captured", async () => {
  mode = "anthropic";
  await withServer(async (base) => {
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", stream: true, tools: [{ name: "get_weather" }] }),
    });
    assert.equal(r.status, 200);
    await r.text();
    const t = traceStore.list().traces[0];
    assert.deepEqual(t.toolsReq, ["get_weather"]);
    assert.deepEqual(t.toolsUsed, [{ name: "get_weather", count: 1 }]);
    assert.equal(t.cachedTokens, 11);
  });
});

test("A4: traceMaxReqBody/traceMaxResBody knobs reach the proxy tee", async () => {
  mode = "json";
  knobs.traceMaxReqBody = 2 * 1024 * 1024;
  knobs.traceMaxResBody = 2 * 1024 * 1024;
  await withServer(async (base) => {
    const big = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "x".repeat(100 * 1024) }] });
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    assert.equal(r.status, 200);
    const t = traceStore.get(traceStore.list().traces[0].id);
    assert.equal(Buffer.byteLength(t.reqBody, "utf8"), Buffer.byteLength(big), "100 KB body stored whole (beyond the 32 KiB legacy const)");
    assert.equal(t.bodyTruncated, false);
  });
});

test("A4: small knob truncates with bodyTruncated set", async () => {
  mode = "json";
  knobs.traceMaxReqBody = 1024;
  // Fresh app wired to a store with the same knob — the store-side capText is
  // the hard guarantee (the proxy tee caps per chunk, so a single-chunk body
  // can overshoot the knob).
  const localStore = new TraceStore({ dbPath: ":memory:", maxReqBody: 1024 });
  traceStore = localStore;
  app = express();
  app.use("/llm", createLlmProxy({ registry, settings: () => knobs, traceStore: localStore, inflight }));
  await withServer(async (base) => {
    const big = JSON.stringify({ model: "m1", messages: [{ role: "user", content: "x".repeat(5 * 1024) }] });
    const r = await fetch(`${base}/llm/sp1/${upstreamPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    assert.equal(r.status, 200);
    const t = localStore.get(localStore.list().traces[0].id);
    assert.ok(Buffer.byteLength(t.reqBody, "utf8") <= 1024);
    assert.equal(t.bodyTruncated, true);
  });
  localStore.stop();
});
after(async () => {
  traceStore?.stop();
  await new Promise((r) => upstream?.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});
