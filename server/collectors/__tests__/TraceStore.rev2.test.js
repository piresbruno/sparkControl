/**
 * A4 rev-2 TraceStore tests: in-place migration of pre-rev-2 databases and
 * the rev-2 columns (client identity, tools, cached tokens, truncation flag).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TraceStore } from "../TraceStore.js";

const REV2 = ["clientIp", "clientUa", "clientId", "toolsReq", "toolsUsed", "cachedTokens", "bodyTruncated"];
const cleanups = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

/** Pre-rev-2 schema (21 columns, no client/tool/cache fields) + one row. */
function createOldDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      ts INTEGER NOT NULL,
      sparkId TEXT,
      port INTEGER,
      source TEXT,
      method TEXT,
      path TEXT,
      query TEXT,
      model TEXT,
      stream INTEGER,
      status INTEGER,
      ttftMs INTEGER,
      durMs INTEGER,
      promptTokens INTEGER,
      completionTokens INTEGER,
      tokensEstimated INTEGER,
      finishReason TEXT,
      error TEXT,
      reqBody TEXT,
      resText TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts);
  `);
  db.prepare(
    `INSERT INTO traces (id, ts, sparkId, port, source, method, path, model, stream, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("old-row-1", Date.now(), "sp-old", 8081, "proxy", "POST", "/v1/chat/completions", "m1", 1, 200);
  db.close();
}

test("old DB migrates in place: columns added, existing row intact, new records work", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a4-trace-mig-"));
  const dbPath = path.join(dir, "traces.sqlite");
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  createOldDb(dbPath);

  const s = new TraceStore({ dbPath });
  const cols = s._db.prepare("PRAGMA table_info(traces)").all().map((c) => c.name);
  for (const name of REV2) {
    assert.ok(cols.includes(name), `column ${name} added`);
  }

  // Old row survives with the new fields null.
  const { traces } = s.list();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].id, "old-row-1");
  assert.equal(traces[0].sparkId, "sp-old");
  assert.equal(traces[0].model, "m1");
  assert.equal(traces[0].toolsUsed, null);
  assert.equal(traces[0].cachedTokens, null);

  // New records persist all rev-2 fields; JSON round-trips through list().
  s.record({
    source: "proxy",
    clientId: "abc123def456",
    clientIp: "10.0.30.173",
    clientUa: "curl/8.0",
    toolsReq: ["get_weather"],
    toolsUsed: [{ name: "get_weather", count: 2 }],
    cachedTokens: 9,
    bodyTruncated: true,
  });
  const t2 = s.list().traces[0];
  assert.equal(t2.clientId, "abc123def456");
  assert.equal(t2.clientIp, "10.0.30.173");
  assert.deepEqual(t2.toolsReq, ["get_weather"]);
  assert.deepEqual(t2.toolsUsed, [{ name: "get_weather", count: 2 }]);
  assert.equal(t2.cachedTokens, 9);
  assert.equal(t2.bodyTruncated, true);
  s.stop();
});

test("old DB row keeps full get() intact after migration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a4-trace-mig2-"));
  const dbPath = path.join(dir, "traces.sqlite");
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  createOldDb(dbPath);

  const s = new TraceStore({ dbPath });
  const full = s.get("old-row-1");
  assert.equal(full.path, "/v1/chat/completions");
  assert.equal(full.stream, true);
  assert.equal(full.status, 200);
  s.stop();
});

test("fresh DBs get the rev-2 columns from CREATE TABLE (no ALTER needed)", () => {
  const s = new TraceStore({ dbPath: ":memory:" });
  const cols = s._db.prepare("PRAGMA table_info(traces)").all().map((c) => c.name);
  for (const name of REV2) {
    assert.ok(cols.includes(name), `column ${name} in fresh schema`);
  }
  // record/list round trip with rev-2 fields omitted → nulls.
  s.record({ source: "proxy" });
  const t = s.list().traces[0];
  assert.equal(t.clientId, null);
  assert.equal(t.toolsReq, null);
  assert.equal(t.toolsUsed, null);
  assert.equal(t.bodyTruncated, false);
  s.stop();
});

test("constructor overrides pin caps and retention (knob-independent tests)", () => {
  const s = new TraceStore({ dbPath: ":memory:", maxReqBody: 128, retentionDays: 1 });
  s.record({ source: "proxy", reqBody: "x".repeat(500) });
  const full = s.get(s.list().traces[0].id);
  assert.ok(Buffer.byteLength(full.reqBody, "utf8") <= 128);
  s.record({ source: "proxy", ts: Date.now() - 2 * 86_400_000 });
  assert.equal(s._purge(), 1, "1-day retention purges the stale row");
  s.stop();
});
