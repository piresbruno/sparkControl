/**
 * Durable registry mutations: persistence failures must surface (status 500)
 * and must never leave memory or sparks.json ahead of a failed write.
 *
 * Both scenarios break the filesystem, not the code: the registry path is
 * pointed at directories that exist as regular files (ENOTDIR on write).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "registry-dur-"));
const sparksPath = path.join(tmp, "sparks.json");
// Parent is a regular FILE → every write to this path fails with ENOTDIR.
const blockedDir = path.join(tmp, "blocked");
process.env.SPARKS_JSON_PATH = sparksPath;
process.env.SPARKS_SECRETS_PATH = path.join(blockedDir, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");

const { SparkRegistry } = await import("../SparkRegistry.js");

const cfg = (id, over = {}) => ({
  id,
  name: id,
  lanIp: "10.0.0.5",
  isLocal: false,
  ssh: { host: "10.0.0.5", user: "root", auth: "key" },
  llmPorts: [8888],
  ...over,
});

beforeEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(blockedDir, ""); // secrets path unreachable
});

test("a failed sparks.json write surfaces as 500 and leaves no phantom spark", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("keep-me"));
  assert.deepEqual(reg.sparkIds, ["keep-me"]);

  // Make sparks.json unwritable and try to add another spark.
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(tmp, ""); // tmp is now a file → writes into it fail
  try {
    assert.throws(
      () => reg.addSpark(cfg("ghost")),
      (err) => err.status === 500,
      "persistence failure must be reported as a server error"
    );
    assert.deepEqual(reg.sparkIds, ["keep-me"], "failed add must not commit in memory");
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.mkdirSync(tmp, { recursive: true });
  }
});

test("a failed secrets write rolls sparks.json back to the pre-update state", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("durable"));
  assert.deepEqual(reg.sparkIds, ["durable"]);
  const before = fs.readFileSync(sparksPath, "utf8");

  assert.throws(
    () => reg.updateSpark("durable", { name: "Renamed", ssh: { password: "pw" } }),
    (err) => err.status === 500,
    "secrets persistence failure must be reported as a server error"
  );

  assert.equal(fs.readFileSync(sparksPath, "utf8"), before, "sparks.json stays pre-update");
  assert.equal(reg.getSpark("durable").name, "durable", "memory stays pre-update");
  assert.equal(reg.hasPassword("durable"), false, "no half-applied credential");
  assert.equal(fs.existsSync(process.env.SPARKS_SECRETS_PATH), false);
});

test("a failed secrets write on remove re-adds the spark on disk", () => {
  const reg = new SparkRegistry();
  reg.addSpark(cfg("with-pw"));
  reg.addSpark(cfg("other"));
  // Seed credentials while the secrets path is still reachable.
  fs.rmSync(blockedDir, { force: true });
  fs.mkdirSync(blockedDir, { recursive: true });
  reg.setPassword("with-pw", "pw");
  reg.setPassword("other", "pw2");
  const before = fs.readFileSync(sparksPath, "utf8");

  // Block secrets again. Removing one spark still requires rewriting the
  // secrets file (the other credential remains), and that write now fails.
  fs.rmSync(blockedDir, { recursive: true, force: true });
  fs.writeFileSync(blockedDir, "");
  assert.throws(
    () => reg.removeSpark("with-pw"),
    (err) => err.status === 500,
    "secrets persistence failure must be reported as a server error"
  );

  assert.equal(fs.readFileSync(sparksPath, "utf8"), before, "sparks.json keeps the spark");
  assert.deepEqual(reg.sparkIds, ["with-pw", "other"], "memory keeps the spark");
  assert.equal(reg.hasPassword("with-pw"), true, "credential untouched");
});
