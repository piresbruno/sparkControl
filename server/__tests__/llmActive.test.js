/**
 * A4 unified active-load API tests: GET /api/llm/active + POST /api/llm/stop-all.
 * Fully isolated: temp config paths, ephemeral-port fake upstream, no real SSH.
 * Manager state is seeded through the real singleton managers (exported from
 * index.js) — cancel/counting semantics are exercised against production code.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "a4-active-"));
const fakeHome = path.join(tmp, "home");
fs.mkdirSync(fakeHome, { recursive: true });
process.env.HOME = fakeHome;
for (const [k, v] of Object.entries({
  SETTINGS_JSON_PATH: "settings.json",
  SPARKS_SECRETS_PATH: "secrets.json",
  SECRETS_KEY_PATH: "key",
  SPARKS_JSON_PATH: "sparks.json",
  LLM_DAILY_JSON_PATH: "llm-daily.json",
  TRACES_DB_PATH: "traces.sqlite",
  SPARKDASH_JOBS_STATE_PATH: "jobs.json",
})) process.env[k] = path.join(tmp, v);
process.env.PORT = "5831";

const BASE = "http://127.0.0.1:5831";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mod;
let upstream;
let upstreamPort;
let sawUpstreamAbort = false;

/** POST with an abort-capable handle — stays in flight until destroyed. */
function rawRequest(pathUrl, body) {
  const req = http.request(
    { host: "127.0.0.1", port: 5831, path: pathUrl, method: "POST", headers: { "content-type": "application/json" } },
    (res) => {
      res.on("data", () => {});
      res.on("end", () => { req.__ended = true; });
    }
  );
  req.on("error", (err) => { req.__error = err; });
  if (body != null) req.write(body);
  req.end();
  return req;
}

/** Drop manager-state leftovers from earlier tests. */
function cleanupSeeds() {
  mod.decodeBenchManager.activeBySpark.delete("a4-spark");
  mod.prefillBenchManager.activeBySpark.delete("a4-spark");
  mod.showcaseManager.activeBySpark.delete("a4-spark");
}

function seedDecode(sparkId, status = "running") {
  const benchId = `a4-dec-${Math.random().toString(16).slice(2, 8)}`;
  mod.decodeBenchManager.jobs.set(benchId, {
    benchId,
    sparkId,
    status,
    startedAt: Date.now(),
    completedAt: null,
    config: { port: upstreamPort, modelId: "m-dec", concurrencies: [1], maxTokens: 8, promptType: "short" },
    progress: { currentConcurrency: 1, completedLevels: 0, totalLevels: 1, message: "Running…" },
    results: [],
    error: null,
    _abort: new AbortController(),
  });
  mod.decodeBenchManager.activeBySpark.set(sparkId, benchId);
  return benchId;
}

function seedPrefill(sparkId, status = "running") {
  const benchId = `a4-pre-${Math.random().toString(16).slice(2, 8)}`;
  mod.prefillBenchManager.jobs.set(benchId, {
    benchId,
    sparkId,
    status,
    startedAt: Date.now(),
    completedAt: null,
    config: { port: upstreamPort, modelId: "m-pre" },
    progress: { currentConcurrency: 1, completedLevels: 0, totalLevels: 1, message: "Running…" },
    results: [],
    error: null,
    _abort: new AbortController(),
  });
  mod.prefillBenchManager.activeBySpark.set(sparkId, benchId);
  return benchId;
}

function seedShowcase(sparkId) {
  const sessionId = `a4-sess-${Math.random().toString(16).slice(2, 8)}`;
  mod.showcaseManager.sessions.set(sessionId, {
    sessionId,
    sparkId,
    status: "running",
    rev: 0,
    port: upstreamPort,
    modelId: "m-show",
    maxTokens: 16,
    temperature: 0.7,
    thinking: false,
    promptType: null,
    startedAt: Date.now(),
    completedAt: null,
    prompts: [],
    streams: [
      {
        streamId: "st1",
        label: "p1",
        prompt: "",
        status: "running",
        content: "",
        reasoning: "",
        contentLength: 0,
        reasoningLength: 0,
        tokenCount: 5,
        ttftMs: null,
        decodeTps: 0,
        liveTokPerSec: 3,
        peakTokPerSec: 4,
        model: null,
        error: null,
      },
    ],
    _sentContentLengths: [],
    _sentReasoningLengths: [],
    _abort: new AbortController(),
    _lastTouchAt: Date.now(),
    _contentCap: 0,
    _lanIp: "127.0.0.1",
    _apiKey: null,
  });
  mod.showcaseManager.activeBySpark.set(sparkId, sessionId);
  return sessionId;
}

before(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.on("close", () => {
      if (!res.writableEnded) sawUpstreamAbort = true;
    });
    // Second delta far out — the request stays in flight until cancelled.
    const t = setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 10_000);
    if (typeof t.unref === "function") t.unref();
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = upstream.address().port;

  mod = await import("../index.js");
  await sleep(400);
  // Keep the seeded-session archive inside the sandbox.
  mod.showcaseManager.historyPath = path.join(tmp, "showcase-history.json");

  const add = await fetch(`${BASE}/api/sparks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "a4-spark", name: "A4", isLocal: true, lanIp: "127.0.0.1", llmPorts: [upstreamPort] }),
  });
  if (!add.ok) throw new Error(`spark registration failed: ${add.status}`);
});

after(async () => {
  try {
    mod.server.close();
  } catch {
    /* ignore */
  }
  try {
    upstream.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("GET /api/llm/active unions proxy, benches and showcase with progress", async () => {
  const client = rawRequest(`/llm/a4-spark/${upstreamPort}/v1/chat/completions`, JSON.stringify({ model: "m-proxy", stream: true }));
  await sleep(150);
  seedDecode("a4-spark");
  seedPrefill("a4-spark");
  seedShowcase("a4-spark");

  const r = await (await fetch(`${BASE}/api/llm/active?sparkId=a4-spark`)).json();
  const sources = r.items.map((i) => i.source).sort();
  assert.deepEqual(sources, ["decode-bench", "prefill-bench", "proxy", "showcase"]);

  const proxy = r.items.find((i) => i.source === "proxy");
  assert.equal(proxy.model, "m-proxy");
  assert.equal(proxy.stream, true);
  assert.equal(proxy.path, "/v1/chat/completions");
  assert.equal(proxy.cancelable, true);
  assert.ok(typeof proxy.progress.tokensSoFar === "number");

  const show = r.items.find((i) => i.source === "showcase");
  assert.equal(show.model, "m-show");
  assert.equal(show.progress.tokensSoFar, 5);
  assert.equal(show.progress.liveTokPerSec, 3);

  const dec = r.items.find((i) => i.source === "decode-bench");
  assert.equal(dec.model, "m-dec");
  assert.equal(dec.progress.totalLevels, 1);
  assert.equal(dec.cancelable, true);

  await fetch(`${BASE}/api/llm/stop-all`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sparkId: "a4-spark" }),
  });
  await sleep(50);
  client.destroy();
});

test("POST /api/llm/stop-all cancels running work per source and aborts the proxy socket", async () => {
  cleanupSeeds();
  sawUpstreamAbort = false;
  const client = rawRequest(`/llm/a4-spark/${upstreamPort}/v1/chat/completions`, JSON.stringify({ model: "m-proxy", stream: true }));
  await sleep(150);
  seedDecode("a4-spark");
  seedPrefill("a4-spark");
  const sessionId = seedShowcase("a4-spark");

  const res = await fetch(`${BASE}/api/llm/stop-all`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sparkId: "a4-spark", reason: "test stop-all" }),
  });
  assert.equal(res.status, 200);
  const counts = await res.json();
  assert.deepEqual(counts, { showcase: 1, decodeBench: 1, prefillBench: 1, proxy: 1 });

  await new Promise((r) => client.on("close", r));
  await sleep(30);
  assert.ok(sawUpstreamAbort, "stop-all destroyed the upstream socket");

  const active = await (await fetch(`${BASE}/api/llm/active?sparkId=a4-spark`)).json();
  // Seeded benches have no _runJob to flip their status (real ones do, in the
  // run's finally) — they linger as "Cancelling…" until their runner unwinds.
  assert.deepEqual(
    active.items.map((i) => i.source).sort(),
    ["decode-bench", "prefill-bench"]
  );
  const dec = active.items.find((i) => i.source === "decode-bench");
  assert.equal(dec.progress.message, "Cancelling…");

  const sess = mod.showcaseManager.sessions.get(sessionId);
  assert.equal(sess.status, "cancelled");
});

test("stop-all ignores finished jobs still lingering in activeBySpark", async () => {
  cleanupSeeds();
  seedDecode("a4-spark", "completed");
  const counts = await (
    await fetch(`${BASE}/api/llm/stop-all`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sparkId: "a4-spark" }),
    })
  ).json();
  assert.equal(counts.decodeBench, 0);
  assert.equal(counts.proxy, 0);
  cleanupSeeds();
});

test("GET /api/llm/clients groups live proxy entries; flush cancels only that client", async () => {
  sawUpstreamAbort = false;
  const client = rawRequest(`/llm/a4-spark/${upstreamPort}/v1/chat/completions`, JSON.stringify({ model: "m-proxy", stream: true }));
  await sleep(150);

  const r = await (await fetch(`${BASE}/api/llm/clients`)).json();
  assert.ok(Array.isArray(r.clients));
  assert.equal(r.clients.length, 1);
  const c = r.clients[0];
  assert.match(c.clientId, /^[0-9a-f]{12}$/);
  assert.equal(c.inflightCount, 1);
  assert.equal(c.inflight[0].model, "m-proxy");
  assert.equal(c.inflight[0].path, "/v1/chat/completions");
  assert.equal(typeof r.dashboardClients, "number");

  // Label the client via PUT /api/settings; the label shows up in the view.
  const put = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientLabels: { [c.clientId]: "incident-client" } }),
  });
  assert.equal(put.status, 200);
  const r2 = await (await fetch(`${BASE}/api/llm/clients`)).json();
  assert.equal(r2.clients[0].label, "incident-client");

  const del = await fetch(`${BASE}/api/llm/clients/${c.clientId}`, { method: "DELETE" });
  const body = await del.json();
  assert.equal(body.success, true);
  assert.equal(body.cancelled, 1);

  await new Promise((resolve) => client.on("close", resolve));
  await sleep(30);
  assert.ok(sawUpstreamAbort, "flush destroyed the upstream socket");
  const r3 = await (await fetch(`${BASE}/api/llm/clients`)).json();
  assert.equal(r3.clients.length, 0);
});

test("GET /api/traces/stats aggregates proxied requests", async () => {
  const since = Date.now() - 1000;
  // The fake upstream holds SSE responses open, so terminate each request
  // mid-flight (the incident pattern) — the cancel records the trace.
  for (let i = 0; i < 2; i++) {
    const client = rawRequest(`/llm/a4-spark/${upstreamPort}/v1/chat/completions`, JSON.stringify({ model: "m-stats", stream: true }));
    await sleep(100);
    const id = (await (await fetch(`${BASE}/api/llm/active?sparkId=a4-spark`)).json()).items.find((it) => it.source === "proxy").id;
    await fetch(`${BASE}/api/llm/inflight/${id}`, { method: "DELETE" });
    await new Promise((resolve) => client.on("close", resolve));
  }
  await sleep(50);

  const st = await (await fetch(`${BASE}/api/traces/stats?sparkId=a4-spark&since=${since}`)).json();
  // The window can also contain traces from earlier tests (e.g. the flushed
  // request) — pin the m-stats model row instead of the global total.
  assert.ok(st.totals.requests >= 2);
  assert.equal(st.byModel.find((row) => row.key === "m-stats").requests, 2);
  assert.ok(st.byPath.some((row) => row.key === "/v1/chat/completions"));
  assert.ok(st.byClient.some((row) => /^[0-9a-f]{12}$/.test(row.key)));
  assert.ok(st.byHour.length >= 1);
});
