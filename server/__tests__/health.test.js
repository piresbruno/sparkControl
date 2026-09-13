/**
 * GET /api/health diagnostics matrix (pure inputs, no real env).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHealth } from "../health.js";

const base = {
  bindHost: "127.0.0.1",
  configWritable: true,
  secretsKeyPresent: true,
  secretsKeyReadable: true,
  sshIdentityPresent: true,
};

test("a healthy deployment reports no errors or warnings", () => {
  const h = evaluateHealth({ ...base });
  assert.equal(h.ok, true);
  assert.equal(h.bindHost, "127.0.0.1");
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.warnings, []);
});

test("an unwritable config directory is an error", () => {
  const h = evaluateHealth({ ...base, configWritable: false });
  assert.equal(h.ok, false);
  assert.match(h.errors.join(" "), /not writable/);
});

test("missing secrets key and SSH identity are warnings", () => {
  const h = evaluateHealth({
    ...base,
    secretsKeyPresent: false,
    sshIdentityPresent: false,
  });
  assert.equal(h.ok, true);
  assert.equal(h.warnings.length, 2);
  assert.match(h.warnings.join(" "), /secrets key/i);
  assert.match(h.warnings.join(" "), /SSH identity/i);
});

test("an unreadable secrets key warns with the remedy instead of looking healthy", () => {
  const h = evaluateHealth({ ...base, secretsKeyReadable: false });
  assert.equal(h.ok, true, "still serves the dashboard; credentials are what degrade");
  assert.match(h.warnings.join(" "), /not readable/);
  assert.match(h.warnings.join(" "), /SPARKDASH_SECRETS_KEY/);
});

test("bind host is reported verbatim (LAN binds are the operator's call)", () => {
  const h = evaluateHealth({ ...base, bindHost: "0.0.0.0" });
  assert.equal(h.bindHost, "0.0.0.0");
  assert.equal(h.ok, true);
});
