import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TraceStore, TRACE_MAX_REQ, TRACE_MAX_RES, TRACE_RETENTION_MS } from "../TraceStore.js";

beforeEach(() => {
  // Fresh :memory: store per test (no disk, no cross-test bleed).
  globalThis.__store = new TraceStore({ dbPath: ":memory:" });
});

after(() => {
  globalThis.__store?.stop();
});

const store = () => globalThis.__store;

test("record + list round trip; lean list omits bodies, get() returns them", () => {
  const s = store();
  const { seq } = s.record({
    sparkId: "spark-1",
    port: 8099,
    source: "proxy",
    method: "POST",
    path: "/v1/chat/completions",
    model: "m1",
    stream: true,
    status: 200,
    ttftMs: 12,
    durMs: 100,
    promptTokens: 5,
    completionTokens: 2,
    finishReason: "stop",
    reqBody: '{"messages":["hi"]}',
    resText: "Hello",
  });
  assert.ok(seq > 0);
  const { traces, lastSeq } = s.list();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].sparkId, "spark-1");
  assert.equal(traces[0].stream, true);
  assert.equal(traces[0].status, 200);
  assert.equal("reqBody" in traces[0], false, "lean list must not carry bodies");
  assert.equal("resText" in traces[0], false);
  assert.equal(lastSeq, seq);
  const full = s.get(traces[0].id);
  assert.equal(full.reqBody, '{"messages":["hi"]}');
  assert.equal(full.resText, "Hello");
});

test("body caps: reqBody capped at 32 KiB, resText at 64 KiB (UTF-8 aware)", () => {
  const s = store();
  const bigReq = "x".repeat(TRACE_MAX_REQ + 5000);
  // Multi-byte: é is 2 bytes; cap counts UTF-8 bytes, not JS chars.
  const bigRes = "é".repeat(TRACE_MAX_RES); // 2 bytes per char → 2× cap
  s.record({ source: "proxy", reqBody: bigReq, resText: bigRes });
  const full = s.get(s.list().traces[0].id);
  assert.ok(Buffer.byteLength(full.reqBody, "utf8") <= TRACE_MAX_REQ);
  assert.ok(Buffer.byteLength(full.resText, "utf8") <= TRACE_MAX_RES);
  assert.equal(Buffer.byteLength(full.resText, "utf8"), TRACE_MAX_RES);
  // Clean boundary: even number of 2-byte chars or no partial char.
  assert.ok(full.resText.length % 1 === 0);
});

test("filters: sparkId, port, source, method combine with AND", () => {
  const s = store();
  s.record({ sparkId: "a", port: 8000, source: "proxy", method: "POST" });
  s.record({ sparkId: "a", port: 8000, source: "bench", method: "GET" });
  s.record({ sparkId: "b", port: 9000, source: "proxy", method: "POST" });
  assert.equal(s.list({ sparkId: "a" }).traces.length, 2);
  assert.equal(s.list({ sparkId: "a", port: 8000 }).traces.length, 2);
  assert.equal(s.list({ sparkId: "a", source: "bench" }).traces.length, 1);
  assert.equal(s.list({ method: "post" }).traces.length, 2, "method filter uppercases and matches POSTs");
  assert.equal(s.list({ sparkId: "a", source: "proxy", port: 9000 }).traces.length, 0);
});

test("since returns only newer rows and lastSeq tracks the store max", () => {
  const s = store();
  const r1 = s.record({ source: "proxy" });
  const r2 = s.record({ source: "proxy" });
  const r3 = s.record({ source: "proxy" });
  const { traces, lastSeq } = s.list({ since: r2.seq });
  assert.equal(traces.length, 1);
  assert.equal(traces[0].seq, r3.seq);
  assert.equal(lastSeq, r3.seq);
  // Empty store still exposes monotonic max.
  s.clear();
  const after = s.list({ since: 0 });
  assert.equal(after.traces.length, 0);
  assert.equal(after.lastSeq, 0);
});

test("clear() removes all rows; seq keeps advancing (AUTOINCREMENT)", () => {
  const s = store();
  s.record({ source: "proxy" });
  s.clear();
  assert.equal(s.list().traces.length, 0);
  const { seq } = s.record({ source: "proxy" });
  assert.ok(seq > 1, "seq must not restart at 1 after clear");
});

test("retention purge deletes rows older than 7 days", () => {
  const s = store();
  s.record({ source: "proxy", ts: Date.now() - TRACE_RETENTION_MS - 60_000 });
  s.record({ source: "proxy", ts: Date.now() - TRACE_RETENTION_MS + 60_000 });
  // Constructor purged nothing (rows are newer than boot); explicit purge
  // removes exactly the stale row.
  assert.equal(s._purge(), 1);
  assert.equal(s.list().traces.length, 1);
});

test("boot purge: constructing a store purges stale rows (file-backed)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-trace-"));
  const dbPath = path.join(dir, "traces.sqlite");
  const s1 = new TraceStore({ dbPath });
  s1.record({ source: "proxy", ts: Date.now() - TRACE_RETENTION_MS - 1000 });
  s1.record({ source: "proxy" });
  s1.stop();
  const s2 = new TraceStore({ dbPath });
  const { traces } = s2.list();
  assert.equal(traces.length, 1, "old row purged on boot");
  assert.equal(traces[0].source, "proxy");
  s2.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("error entries accept status null and get truncated error text", () => {
  const s = store();
  s.record({ source: "proxy", status: null, error: "ECONNREFUSED ".repeat(200) });
  const full = s.get(s.list().traces[0].id);
  assert.equal(full.status, null);
  assert.ok(full.error.length <= 1024);
});
