import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../agentRegistry.js";

function fakeWs() {
  const sent = [];
  let closeCode = null;
  return {
    sent,
    get closeCode() { return closeCode; },
    readyState: 1,
    send: (m) => sent.push(m),
    close: (code) => { closeCode = code; },
  };
}

test("register handshake matrix: token/spark/proto", () => {
  const reg = new AgentRegistry();
  const expectedIds = new Set(["spark-1"]);
  assert.equal(reg.register(fakeWs(), { sparkId: "spark-1", token: "x", proto: 1 }, "good", expectedIds), 4001);
  assert.equal(reg.register(fakeWs(), { sparkId: "ghost", token: "good", proto: 1 }, "good", expectedIds), 4002);
  assert.equal(reg.register(fakeWs(), { sparkId: "spark-1", token: "good", proto: 9 }, "good", expectedIds), 4003);
  const ws = fakeWs();
  assert.equal(reg.register(ws, { sparkId: "spark-1", token: "good", proto: 1, agentVersion: "1.0.0" }, "good", expectedIds), null);
  assert.equal(reg.isConnected("spark-1"), true);
  assert.equal(reg.agentVersion("spark-1"), "1.0.0");
});

test("send + request/resp round trip", async () => {
  const reg = new AgentRegistry();
  const ws = fakeWs();
  reg.register(ws, { sparkId: "s1", token: "t", proto: 1 }, "t", new Set(["s1"]));
  assert.ok(reg.send("s1", { type: "ping" }));
  const p = reg.request("s1", { type: "serve", action: "status" }, 100);
  const reqId = JSON.parse(ws.sent.at(-1)).reqId;
  assert.ok(reg._resolvePending(reqId, { ok: true, payload: { running: false } }));
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, { running: false });
  const r2 = await reg.request("ghost", { type: "ping" });
  assert.equal(r2.ok, false);
});

test("request timeout resolves {ok:false}", async () => {
  const reg = new AgentRegistry();
  reg.register(fakeWs(), { sparkId: "s1", token: "t", proto: 1 }, "t", new Set(["s1"]));
  const r = await reg.request("s1", { type: "noop" }, 30);
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout/);
});

test("connect/disconnect events fire; unregister by ws", () => {
  const reg = new AgentRegistry();
  const events = [];
  reg.onConnect((id) => events.push(["c", id]));
  reg.onDisconnect((id) => events.push(["d", id]));
  const ws = fakeWs();
  reg.register(ws, { sparkId: "s1", token: "t", proto: 1 }, "t", new Set(["s1"]));
  reg.unregister(ws);
  assert.deepEqual(events, [["c", "s1"], ["d", "s1"]]);
  assert.equal(reg.isConnected("s1"), false);
});

test("second hello for same spark replaces the zombie connection", () => {
  const reg = new AgentRegistry();
  const ws1 = fakeWs();
  const ws2 = fakeWs();
  reg.register(ws1, { sparkId: "s1", token: "t", proto: 1 }, "t", new Set(["s1"]));
  reg.register(ws2, { sparkId: "s1", token: "t", proto: 1 }, "t", new Set(["s1"]));
  assert.equal(ws1.closeCode, 4000);
  assert.equal(reg.isConnected("s1"), true);
});
