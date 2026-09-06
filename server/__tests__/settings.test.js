import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate all persistence into a temp dir BEFORE importing the module —
// settings.js/secretsStore.js/config.js resolve paths from env at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(tmp, "settings.json");
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");

const settings = await import("../settings.js");
const secrets = await import("../secretsStore.js");

beforeEach(() => {
  // Fresh state per test: defaults, no settings file, no secrets file.
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

test("defaults expose new fields", () => {
  const s = settings.loadSettings();
  assert.equal(s.traceCapture, true);
  assert.equal(s.traceCaptureBodies, true);
  assert.deepEqual(s.traceProxyAllowedOrigins, []);
  assert.deepEqual(s.modelctl, {
    nasRoot: "/mnt/nas/llm-models",
    nasHostSparkId: null,
    remoteBin: "modelctl",
    source: "git+https://github.com/piresbruno/modelctl",
  });
  assert.deepEqual(s.agent, { tokenConfigured: false });
});

test("partial patch of modelctl.nasRoot keeps remoteBin/source (deep merge)", () => {
  settings.loadSettings();
  const s = settings.updateSettings({ modelctl: { nasRoot: "/mnt/big/llm" } });
  assert.equal(s.modelctl.nasRoot, "/mnt/big/llm");
  assert.equal(s.modelctl.remoteBin, "modelctl");
  assert.equal(s.modelctl.source, "git+https://github.com/piresbruno/modelctl");
  assert.equal(s.modelctl.nasHostSparkId, null);
  // Sibling top-level fields untouched too
  assert.equal(s.traceCapture, true);
});

test("patch of unrelated field does not disturb modelctl", () => {
  settings.loadSettings();
  settings.updateSettings({ modelctl: { remoteBin: "/opt/modelctl" } });
  const s = settings.updateSettings({ benchDebugTraces: true });
  assert.equal(s.modelctl.remoteBin, "/opt/modelctl");
  assert.equal(s.benchDebugTraces, true);
});

test("traceProxyAllowedOrigins filters non-http(s) entries and non-arrays reset", () => {
  settings.loadSettings();
  let s = settings.updateSettings({
    traceProxyAllowedOrigins: ["http://a:5173", "https://b.example", "javascript:alert(1)", 42],
  });
  assert.deepEqual(s.traceProxyAllowedOrigins, ["http://a:5173", "https://b.example"]);
  s = settings.updateSettings({ traceProxyAllowedOrigins: "nope" });
  assert.deepEqual(s.traceProxyAllowedOrigins, []);
});

test("agent token cannot be injected via settings patch", () => {
  settings.loadSettings();
  const s = settings.updateSettings({ agent: { token: "a".repeat(64) } });
  assert.deepEqual(s.agent, { tokenConfigured: false });
  assert.equal(secrets.getAppSecret(settings.AGENT_TOKEN_SECRET), null);
});

test("ensureAgentToken generates 64-hex once, persists encrypted, survives restarts", () => {
  settings.loadSettings();
  const t1 = settings.ensureAgentToken();
  assert.match(t1, /^[0-9a-f]{64}$/);
  settings.markAgentTokenConfigured();
  assert.deepEqual(settings.getSettings().agent, { tokenConfigured: true });
  // Encrypted at rest: plaintext token must not appear in the secrets file.
  const raw = fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8");
  assert.ok(!raw.includes(t1));
  // Idempotent: second boot returns the same token.
  assert.equal(settings.ensureAgentToken(), t1);
  // "Restart": reload modules in a fresh process simulation via loadSettings.
  settings.loadSettings();
  assert.equal(settings.ensureAgentToken(), t1);
});

test("rotateAgentToken replaces the token", () => {
  settings.loadSettings();
  const t1 = settings.ensureAgentToken();
  const t2 = settings.rotateAgentToken();
  assert.match(t2, /^[0-9a-f]{64}$/);
  assert.notEqual(t1, t2);
  assert.equal(secrets.getAppSecret(settings.AGENT_TOKEN_SECRET), t2);
});

test("app secrets survive credential saves; empty credential save keeps the file", async () => {
  const { saveSecrets } = await import("../secretsStore.js");
  settings.loadSettings();
  settings.ensureAgentToken();
  saveSecrets(new Map(), new Map());
  assert.equal(secrets.getAppSecret(settings.AGENT_TOKEN_SECRET) !== null, true);
  // Credential save with a password preserves the app secret too.
  saveSecrets(new Map([["spark-1", "pw"]]), new Map());
  const t = secrets.getAppSecret(settings.AGENT_TOKEN_SECRET);
  assert.match(t, /^[0-9a-f]{64}$/);
});

test("settings round-trips to disk with new fields", () => {
  settings.loadSettings();
  settings.updateSettings({ traceCapture: false, modelctl: { nasRoot: "/x" } });
  const raw = JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf8"));
  assert.equal(raw.traceCapture, false);
  assert.equal(raw.modelctl.nasRoot, "/x");
  assert.equal(raw.modelctl.remoteBin, "modelctl");
  const s = settings.loadSettings();
  assert.equal(s.traceCapture, false);
  assert.equal(s.modelctl.nasRoot, "/x");
});
