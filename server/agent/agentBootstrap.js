/**
 * Agent bootstrap script builders (C3/C1) — pure, testable.
 *
 * Node layout created on the target:
 *   ~/.sparkdash/agent/sparkdash-agent.mjs   (bundle, uploaded by the runner)
 *   ~/.sparkdash/agent/config.json           {dashboardUrl, token, sparkId}
 *   ~/.sparkdash/agent/node/                 (official ARM64 Node ≥18, no sudo)
 *
 * Service: systemd SYSTEM unit via `sudo -n`; the job runner adds a `sudo -S`
 * variant for pass-auth sparks; final fallback = user unit + enable-linger
 * instructions in the job log (manual step). The script ends with
 * __AGENT_UNIT__system|none so the runner knows what happened.
 */
import { shellQuote } from "../util/shellQuote.js";

/** Node ARM64 LTS tarball used when the node lacks node ≥18. */
export const AGENT_NODE_VERSION = "22.14.0";
export const AGENT_NODE_TARBALL_URL = `https://nodejs.org/dist/v${AGENT_NODE_VERSION}/node-v${AGENT_NODE_VERSION}-linux-arm64.tar.xz`;

/**
 * install-agent job script. The runner uploads the bundle to
 * ~/.sparkdash/agent/sparkdash-agent.mjs right before launching this script.
 * @param {{
 *   dashboardUrl: string, token: string, sparkId: string,
 *   sshUser: string, force?: boolean,
 * }} p
 */
export function buildInstallAgentScript({ dashboardUrl, token, sparkId, sshUser, force = false }) {
  const agentDir = "~/.sparkdash/agent";
  const nodeDir = `${agentDir}/node`;
  const cfg = `${agentDir}/config.json`;
  const configJson = shellQuote(JSON.stringify({ dashboardUrl, token, sparkId }));
  const tarball = AGENT_NODE_TARBALL_URL;
  const nodeVer = AGENT_NODE_VERSION;
  const unitBody = [
    "[Unit]",
    "Description=sparkDash agent",
    "After=network-online.target",
    "",
    "[Service]",
    `User=${sshUser}`,
    "ExecStart=$NODE_BIN " + agentDir + "/sparkdash-agent.mjs",
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\\n");
  const lingerUser = shellQuote(sshUser);
  return [
    "set -u",
    `mkdir -p ${agentDir}`,
    // 1. Node runtime: official tarball into ~/.sparkdash/agent/node when
    //    `node` is missing or < 18 (no sudo needed).
    'NODE_BIN="$(command -v node || true)"',
    'if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)\' 2>/dev/null; then',
    `  if [ ! -x ${nodeDir}/bin/node ] || [ ${force ? "true" : "false"} = true ]; then`,
    `    echo "[install-agent] installing Node ${nodeVer} to ${nodeDir}…"`,
    `    curl -fsSL ${tarball} -o /tmp/sparkdash-node.tar.xz`,
    `    mkdir -p ${nodeDir}`,
    `    tar -xJf /tmp/sparkdash-node.tar.xz -C ${nodeDir} --strip-components=1`,
  "  fi",
  "  NODE_BIN=\"$HOME/.sparkdash/agent/node/bin/node\"",
  "fi",
  'if [ ! -x "$NODE_BIN" ]; then echo "ERROR: no usable node runtime found" >&2; exit 3; fi',
  '"$NODE_BIN" --version',
  // 2. config.json (0600 via umask)
  "umask 077",
  `printf '%s' ${configJson} > ${cfg}`,
  // 3. systemd SYSTEM unit via sudo -n; otherwise manual instructions.
    'UNIT=/etc/systemd/system/sparkdash-agent.service',
    `UNIT_CONTENT="${unitBody}"`,
    "if sudo -n true 2>/dev/null; then",
    '  printf "%b" "$UNIT_CONTENT" | sudo -n tee "$UNIT" >/dev/null',
    "  sudo -n systemctl daemon-reload",
    "  sudo -n systemctl enable --now sparkdash-agent.service",
    '  echo "__AGENT_UNIT__system"',
    "else",
    '  echo "__AGENT_UNIT__none"',
    '  echo "[install-agent] passwordless sudo unavailable. To finish manually:" >&2',
    '  echo "  1) mkdir -p ~/.config/systemd/user" >&2',
    '  echo "  2) create ~/.config/systemd/user/sparkdash-agent.service with ExecStart=$NODE_BIN ' + agentDir + '/sparkdash-agent.mjs" >&2',
    '  echo "  3) systemctl --user daemon-reload && systemctl --user enable --now sparkdash-agent" >&2',
    `  echo "  4) sudo loginctl enable-linger ${lingerUser}" >&2`,
    "fi",
    'echo "__AGENT_INSTALL_DONE__"',
  ].join("\n");
}

/** update-agent = same flow with --force redeploy of the bundle. */
export function buildUpdateAgentScript(opts) {
  return buildInstallAgentScript({ ...opts, force: true });
}
