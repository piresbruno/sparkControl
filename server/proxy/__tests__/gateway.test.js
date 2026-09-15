/**
 * P4 cluster gateway — /llm/cluster/<servedName>/... resolves to live recipe
 * deployments: round-robin over healthy targets, warm-target fallback, 404
 * with discovery list, path/query/auth/trace passthrough.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLlmProxy } from "../llmProxy.js";
import { TraceStore } from "../../collectors/TraceStore.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-gw-"));
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, "key");
process.env.SETTINGS_JSON_PATH = path.join(tmp, "settings.json");

// Two fake engines, each answers which one it is.
let upA, upB, portA, portB;
let lastAuthA = null;

function mkUpstream(tag) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/v1/")) lastAuthA = req.headers.authorization || null;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          served: tag,
          path: req.url,
          ...(tag === "A" && req.method === "POST"
            ? { model: "m1", choices: [{ message: { content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } }
            : {}),
        })
      );
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

/** The gateway shim — tests overwrite `.targets`/`.names` directly. */
const gateway = { targets: () => [], names: () => ["glm-a"] };

let traceStore;
let serverHandle;
let baseUrl;

beforeEach(async () => {
  gateway.targets = () => [];
  gateway.names = () => ["glm-a"];
  upA = await mkUpstream("A");
  upB = await mkUpstream("B");
  portA = upA.address().port;
  portB = upB.address().port;
  traceStore = new TraceStore({ dbPath: ":memory:" });
  const registry = {
    getSpark(id) {
      if (id === "sp-a")
        return { id, isLocal: true, lanIp: "127.0.0.1", llmPorts: [portA], llmApiKeys: { [String(portA)]: "sk-A" } };
      if (id === "sp-b") return { id, isLocal: true, lanIp: "127.0.0.1", llmPorts: [portB] };
      return null;
    },
  };
  const app = express();
  app.use(
    "/llm",
    createLlmProxy({
      registry,
      secrets: null,
      settings: () => ({ traceCapture: true, traceCaptureBodies: true, proxyMaxInflightPerPort: 0 }),
      traceStore,
      gateway,
    })
  );
  serverHandle = await new Promise((r) => {
    const h = app.listen(0, "127.0.0.1", () => r(h));
  });
  baseUrl = `http://127.0.0.1:${serverHandle.address().port}`;
});

afterEach(async () => {
  await new Promise((r) => serverHandle.close(r));
  await new Promise((r) => upA.close(r));
  await new Promise((r) => upB.close(r));
  traceStore.stop();
});

async function get(p) {
  const res = await fetch(baseUrl + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("unknown served name → 404 with the known-names discovery list", async () => {
  const r = await get("/llm/cluster/nope/v1/models");
  assert.equal(r.status, 404);
  assert.match(r.body.error, /no deployment serves "nope"/);
  assert.deepEqual(r.body.known, ["glm-a"]);
});

test("round-robins across healthy targets, alternating upstreams", async () => {
  gateway.targets = () => [
    { sparkId: "sp-a", port: portA, healthy: true, recipeId: "ra" },
    { sparkId: "sp-b", port: portB, healthy: true, recipeId: "rb" },
  ];
  const one = await get("/llm/cluster/glm-a/v1/models");
  const two = await get("/llm/cluster/glm-a/v1/models");
  assert.equal(one.body.served, "A");
  assert.equal(two.body.served, "B", "second call rotates");
});

test("unhealthy targets are skipped while any healthy remains", async () => {
  gateway.targets = () => [
    { sparkId: "sp-a", port: portA, healthy: false, recipeId: "ra" },
    { sparkId: "sp-b", port: portB, healthy: true, recipeId: "rb" },
  ];
  const r = await get("/llm/cluster/glm-a/v1/models");
  assert.equal(r.body.served, "B");
});

test("all warm (none healthy) still routes — pool never dead-ends", async () => {
  gateway.targets = () => [
    { sparkId: "sp-a", port: portA, healthy: false, recipeId: "ra" },
    { sparkId: "sp-b", port: portB, healthy: false, recipeId: "rb" },
  ];
  const r = await get("/llm/cluster/glm-a/v1/models");
  assert.ok(["A", "B"].includes(r.body.served));
});

test("query string + path forwarded as remainder", async () => {
  gateway.targets = () => [{ sparkId: "sp-a", port: portA, healthy: true, recipeId: "ra" }];
  const r = await get("/llm/cluster/glm-a/v1/models?x=1");
  assert.equal(r.status, 200);
  assert.equal(r.body.path, "/v1/models?x=1", "cluster prefix consumed, remainder upstream");
});

test("trace records the RESOLVED spark/port, not the cluster name", async () => {
  gateway.targets = () => [{ sparkId: "sp-a", port: portA, healthy: true, recipeId: "ra" }];
  const res = await fetch(`${baseUrl}/llm/cluster/glm-a/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-a", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  await res.json();
  const { traces } = traceStore.list({ limit: 5 });
  const row = traces.find((x) => x.path === "/v1/chat/completions");
  assert.ok(row, "chat completion traced");
  assert.equal(row.sparkId, "sp-a");
  assert.equal(row.port, portA);
});

test("per-port stored key injection applies on the resolved spark/port", async () => {
  gateway.targets = () => [{ sparkId: "sp-a", port: portA, healthy: true, recipeId: "ra" }];
  lastAuthA = null;
  const r = await get("/llm/cluster/glm-a/v1/models");
  assert.equal(r.status, 200);
  assert.equal(lastAuthA, "Bearer sk-A");
});

test("direct spark/port routes unaffected by the gateway branch", async () => {
  const r = await get(`/llm/sp-b/${portB}/v1/models`);
  assert.equal(r.status, 200);
  assert.equal(r.body.served, "B");
});
