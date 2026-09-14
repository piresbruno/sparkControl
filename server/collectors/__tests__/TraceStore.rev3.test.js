/**
 * rev-3 TraceStore tests: clientHost column — in-place migration of pre-rev-3
 * (rev-2) databases and record()/get() round-trip of the new field.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TraceStore } from "../TraceStore.js";

const cleanups = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

/** Rev-2 schema (no clientHost) + one row — the DB shape before this rev. */
function createRev2Db(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE traces (
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
      resText TEXT,
      clientIp TEXT,
      clientUa TEXT,
      clientId TEXT,
      toolsReq TEXT,
      toolsUsed TEXT,
      cachedTokens INTEGER,
      bodyTruncated INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO traces (id, ts, sparkId, source, method, path, clientIp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("rev2-row", Date.now(), "sp-old", "proxy", "POST", "/v1/chat/completions", "10.0.30.9");
  db.close();
}

test("rev-2 DB migrates in place: clientHost column added, old row intact and readable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rev3-trace-mig-"));
  const dbPath = path.join(dir, "traces.sqlite");
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  createRev2Db(dbPath);

  const s = new TraceStore({ dbPath });
  const cols = s._db.prepare("PRAGMA table_info(traces)").all().map((c) => c.name);
  assert.ok(cols.includes("clientHost"), "column clientHost added");
  for (const c of ["clientIp", "clientUa", "clientId", "toolsReq", "toolsUsed", "cachedTokens", "bodyTruncated"]) {
    assert.ok(cols.includes(c), `rev-2 column ${c} survives`);
  }

  const { traces } = s.list();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].id, "rev2-row");
  assert.equal(traces[0].clientIp, "10.0.30.9");
  assert.equal(traces[0].clientHost, null); // migrated value defaults to NULL
  s.stop();
});

test("clientHost round-trips through record() → list() and get()", () => {
  const s = new TraceStore({ dbPath: ":memory:" });
  const { seq } = s.record({
    sparkId: "sp1",
    port: 8081,
    source: "proxy",
    method: "POST",
    path: "/v1/chat/completions",
    model: "m1",
    clientIp: "10.0.30.173",
    clientHost: "box.local",
  });
  assert.ok(seq > 0);
  const listed = s.list().traces[0];
  assert.equal(listed.clientHost, "box.local");
  const full = s.get(listed.id);
  assert.equal(full.clientHost, "box.local");
  s.stop();
});

test("clientHost is capped to 256 bytes and absent fields stay NULL", () => {
  const s = new TraceStore({ dbPath: ":memory:" });
  s.record({ id: "long", sparkId: "sp1", clientHost: "h".repeat(400) });
  s.record({ id: "bare", sparkId: "sp1" });
  assert.equal(s.get("long").clientHost.length, 256);
  assert.equal(s.get("bare").clientHost, null);
  s.stop();
});
