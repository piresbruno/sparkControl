/**
 * Agent bootstrap script builders (C3/C1) — pure, testable.
 *
 * Node layout created on the target:
 *   ~/.sparkcontrol/agent/spark-command-agent.mjs   (bundle, uploaded by the runner)
 *   ~/.sparkcontrol/agent/config.json           {dashboardUrl, token, sparkId}
 *   ~/.sparkcontrol/agent/node/                 (official ARM64 Node ≥18, no sudo)
 *
 * Service: systemd SYSTEM unit via `sudo -n`; fallback = user unit via
 * `systemctl --user` (works without sudo whenever the SSH user has a systemd
 * user manager; enable-linger is attempted via `sudo -n` only). The script
 * ends with __AGENT_UNIT__system|user|none so the runner knows what happened.
 * A `none` result is an INSTALL FAILURE — the script exits 4 so the job
 * terminalizes as failed immediately (install-agent jobs otherwise complete
 * only when the agent's hello lands, see the hello-gate in remoteJobs).
 */
import { shellQuote } from "../util/shellQuote.js";

/** Node ARM64 LTS tarball used when the node lacks node ≥18. */
export const AGENT_NODE_VERSION = "22.14.0";
export const AGENT_NODE_TARBALL_URL = `https://nodejs.org/dist/v${AGENT_NODE_VERSION}/node-v${AGENT_NODE_VERSION}-linux-arm64.tar.xz`;

/**
 * install-agent job script. The runner uploads the bundle to
 * ~/.sparkcontrol/agent/spark-command-agent.mjs right before launching this script.
 * @param {{
 *   dashboardUrl: string, token: string, sparkId: string,
 *   sshUser: string, force?: boolean,
 * }} p
 */
export function buildInstallAgentScript({ dashboardUrl, token, sparkId, sshUser, force = false }) {
  const agentDir = "~/.sparkcontrol/agent";
  const nodeDir = `${agentDir}/node`;
  const cfg = `${agentDir}/config.json`;
  const configJson = shellQuote(JSON.stringify({ dashboardUrl, token, sparkId }));
  const tarball = AGENT_NODE_TARBALL_URL;
  const nodeVer = AGENT_NODE_VERSION;
  const unitBody = [
    "[Unit]",
    "Description=Spark Command Agent",
    "After=network-online.target",
    "",
    "[Service]",
    `User=${sshUser}`,
    "ExecStart=$NODE_BIN " + agentDir + "/spark-command-agent.mjs",
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\\n");
  const lingerUser = shellQuote(sshUser);
  const unitUserBody = [
    "[Unit]",
    "Description=Spark Command Agent",
    "After=network-online.target",
    "",
    "[Service]",
    "ExecStart=$NODE_BIN " + agentDir + "/spark-command-agent.mjs",
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\\n");
  return [
    "set -u",
    // SSH non-interactive sessions often lack XDG_RUNTIME_DIR — required by
    // systemctl --user (falls back to the bus at $XDG_RUNTIME_DIR/bus).
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    `mkdir -p ${agentDir}`,
    // 1. Node runtime: official tarball into ~/.sparkcontrol/agent/node when
    //    `node` is missing or < 18 (no sudo needed).
    'NODE_BIN="$(command -v node || true)"',
    'if [ -z "$NODE_BIN" ] || ! "$NODE_BIN" -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)\' 2>/dev/null; then',
    `  if [ ! -x ${nodeDir}/bin/node ] || [ ${force ? "true" : "false"} = true ]; then`,
    `    echo "[install-agent] installing Node ${nodeVer} to ${nodeDir}…"`,
    `    curl -fsSL ${tarball} -o /tmp/sparkcontrol-node.tar.xz`,
    `    mkdir -p ${nodeDir}`,
    `    tar -xJf /tmp/sparkcontrol-node.tar.xz -C ${nodeDir} --strip-components=1`,
  "  fi",
  "NODE_BIN=\"$HOME/.sparkcontrol/agent/node/bin/node\"",
  "fi",
  'if [ ! -x "$NODE_BIN" ]; then echo "ERROR: no usable node runtime found" >&2; exit 3; fi',
  '"$NODE_BIN" --version',
  // 2. config.json (0600 via umask)
  "umask 077",
  `printf '%s' ${configJson} > ${cfg}`,
  // 3. systemd SYSTEM unit via sudo -n; else USER unit (no sudo needed when
  //    the SSH session has a systemd user manager); else manual instructions.
    'UNIT=/etc/systemd/system/spark-command-agent.service',
    `UNIT_CONTENT="${unitBody}"`,
    `UNIT_USER_CONTENT="${unitUserBody}"`,
    "if sudo -n true 2>/dev/null; then",
    '  printf "%b" "$UNIT_CONTENT" | sudo -n tee "$UNIT" >/dev/null',
    "  sudo -n systemctl daemon-reload",
    "  sudo -n systemctl enable --now spark-command-agent.service",
    '  echo "__AGENT_UNIT__system"',
    "elif systemctl --user show-environment >/dev/null 2>&1; then",
    "  mkdir -p ~/.config/systemd/user",
    '  printf "%b" "$UNIT_USER_CONTENT" > ~/.config/systemd/user/spark-command-agent.service',
    "  systemctl --user daemon-reload",
    "  systemctl --user enable --now spark-command-agent",
    '  echo "__AGENT_UNIT__user"',
    // Linger keeps the agent across logout/reboot; best-effort (needs sudo).
    `  sudo -n loginctl enable-linger ${lingerUser} 2>/dev/null || echo "[install-agent] NOTE: linger not enabled — agent stops at logout; run: sudo loginctl enable-linger ${sshUser}" >&2`,
    "else",
    '  echo "__AGENT_UNIT__none"',
    '  echo "[install-agent] could not install a service (no passwordless sudo, no systemd user manager). To finish manually:" >&2',
    '  echo "  1) mkdir -p ~/.config/systemd/user" >&2',
'  echo "  2) create ~/.config/systemd/user/spark-command-agent.service with ExecStart=$NODE_BIN ' + agentDir + '/spark-command-agent.mjs" >&2',
 '  echo "  3) systemctl --user daemon-reload && systemctl --user enable --now spark-command-agent" >&2',
    `  echo "  4) sudo loginctl enable-linger ${lingerUser}" >&2`,
    "  exit 4",
    "fi",
    'echo "__AGENT_INSTALL_DONE__"',
  ].join("\n");
}

/** update-agent = same flow with --force redeploy of the bundle. */
export function buildUpdateAgentScript(opts) {
  return buildInstallAgentScript({ ...opts, force: true });
}
