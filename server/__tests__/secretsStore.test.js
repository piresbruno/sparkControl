import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-cov-"));
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");

const { loadSecrets, saveSecrets, getAppSecret, setAppSecret } = await import("../secretsStore.js");

test("save + load round trip for passwords and per-port LLM keys", () => {
  const passwords = new Map([["spark-1", "s3cret"]]);
  const llm = new Map([["spark-1", { "8080": "sk-key" }]]);
  saveSecrets(passwords, llm);
  const loaded = loadSecrets();
  assert.equal(loaded.passwords.get("spark-1"), "s3cret");
  assert.deepEqual(loaded.llmApiKeys.get("spark-1"), { "8080": "sk-key" });
});

test("app secret set/get + persistence", () => {
  setAppSecret("agentToken", "a".repeat(64));
  assert.equal(getAppSecret("agentToken"), "a".repeat(64));
  // Survives a reload from disk (fresh read).
  assert.equal(getAppSecret("agentToken"), "a".repeat(64));
});

test("secrets file is JSON with v2 buckets; app secrets ride along", () => {
  saveSecrets(new Map([["s2", "pw2"]]), new Map());
  const raw = JSON.parse(fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8"));
  assert.equal(raw.version, 2);
  assert.ok(raw.secrets.s2);
  assert.ok(raw.appSecrets.agentToken, "app bucket preserved by saveSecrets");
});

test("getAppSecret returns null for unknown/absent", () => {
  assert.equal(getAppSecret("nope"), null);
});
