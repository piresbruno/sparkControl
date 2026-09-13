/**
 * Diagnostics payload for GET /api/health: bind address plus the checks that
 * silently degrade a deployment (config writability, secrets key readability,
 * SSH identity). Pure decision logic is split from inspection so tests can
 * drive the matrix.
 */
import fs from "fs";
import path from "path";
import { SPARKS_JSON_PATH, SECRETS_KEY_PATH } from "./config.js";

export function evaluateHealth({
  bindHost,
  configWritable,
  secretsKeyPresent,
  secretsKeyReadable = true,
  sshIdentityPresent,
}) {
  const errors = [];
  const warnings = [];
  if (!configWritable) errors.push("Config directory is not writable");
  if (!secretsKeyPresent) warnings.push("Secrets key is not present yet");
  else if (!secretsKeyReadable) {
    warnings.push(
      `Secrets key exists but is not readable by this process (${SECRETS_KEY_PATH}); stored SSH passwords and per-port LLM keys stay unavailable. Fix ownership/permissions or set SPARKDASH_SECRETS_KEY.`
    );
  }
  if (!sshIdentityPresent) warnings.push("SSH identity is not mounted");
  return {
    ok: errors.length === 0,
    bindHost,
    errors,
    warnings,
  };
}

/** True when this process can actually read the key file (env key bypasses it). */
export function secretsKeyReadable() {
  if (String(process.env.SPARKDASH_SECRETS_KEY || "").trim()) return true;
  try {
    fs.accessSync(SECRETS_KEY_PATH, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function inspectHealth(host = process.env.BIND_HOST || "127.0.0.1") {
  const configDir = path.dirname(SPARKS_JSON_PATH);
  let writable = true;
  try {
    fs.accessSync(configDir, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  const identity = process.env.SSH_IDENTITY_FILE || path.join(process.env.HOME || "/root", ".ssh", "id_ed25519");
  return evaluateHealth({
    bindHost: host,
    configWritable: writable,
    secretsKeyPresent: Boolean(process.env.SPARKDASH_SECRETS_KEY) || fs.existsSync(SECRETS_KEY_PATH),
    secretsKeyReadable: secretsKeyReadable(),
    sshIdentityPresent: fs.existsSync(identity),
  });
}
