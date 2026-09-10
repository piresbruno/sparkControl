/**
 * Regression: the initial snapshot on WS connect goes to the NEW client only.
 * Broadcasting it (old behavior) pushed a duplicate full snapshot at every
 * already-connected dashboard whenever another tab opened.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-snap-"));
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
process.env.PORT = "5834";

const BASE = "http://127.0.0.1:5834";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitMessage(client, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no WS message within timeout")), timeoutMs);
    client.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

let mod;

before(async () => {
  mod = await import("../../index.js");
  await delay(400);
  // Slow the periodic broadcast out of the way: only connection-triggered
  // snapshots can appear during the test window.
  await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pollIntervalMs: 60000 }),
  });
});

after(async () => {
  try {
    mod.server.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("opening a second dashboard sends a snapshot to it alone", async () => {
  const clientA = new WebSocket("ws://127.0.0.1:5834/ws");
  const aMessages = [];
  clientA.on("message", (d) => aMessages.push(d.toString()));
  clientA.on("error", () => {});

  const first = JSON.parse(await waitMessage(clientA));
  assert.equal(first.type, "snapshot", "A gets its initial snapshot");
  assert.equal(aMessages.length, 1);

  const clientB = new WebSocket("ws://127.0.0.1:5834/ws");
  const bMessages = [];
  clientB.on("message", (d) => bMessages.push(d.toString()));
  clientB.on("error", () => {});

  const second = JSON.parse(await waitMessage(clientB));
  assert.equal(second.type, "snapshot", "B gets its initial snapshot");

  // Window in which the pre-fix broadcast handed A a second snapshot.
  await delay(200);
  assert.equal(aMessages.length, 1, "existing client must not receive the new client's snapshot");
  assert.equal(bMessages.length, 1, "new client receives exactly one snapshot");

  clientA.close();
  clientB.close();
});
