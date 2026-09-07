import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstallAgentScript, buildUpdateAgentScript, AGENT_NODE_TARBALL_URL } from "../agentBootstrap.js";

test("install script: node check → tarball → config 0600 → systemd ladder", () => {
  const s = buildInstallAgentScript({
    dashboardUrl: "ws://d:5555/agent-ws",
    token: "a".repeat(64),
    sparkId: "dgx-2",
    sshUser: "piresbruno",
  });
  const order = [
    ["NODE_BIN assignment", s.indexOf('NODE_BIN="$(command -v node || true)"')],
    ["curl tarball", s.indexOf("curl -fsSL https://nodejs.org")],
    ["NODE_BIN HOME assignment", s.indexOf('NODE_BIN="$HOME/.sparkcontrol/agent/node/bin/node"')],
    ["exit on missing runtime", s.indexOf('ERROR: no usable node runtime found')],
    ["node --version run", s.indexOf('"$NODE_BIN" --version')],
    ["config.json write", s.indexOf("umask 077")],
    ["sudo -n systemctl enable --now", s.indexOf("sudo -n systemctl enable --now")],
    ["__AGENT_UNIT__none", s.indexOf("__AGENT_UNIT__none")],
    ["__AGENT_INSTALL_DONE__", s.indexOf("__AGENT_INSTALL_DONE__")],
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i][1] > order[i - 1][1], `${order[i][0]} must come after ${order[i - 1][0]}`);
  }
  assert.match(s, /"dashboardUrl":"ws:\/\/d:5555\/agent-ws"/);
  assert.match(s, /User=piresbruno/);
  assert.match(s, /loginctl enable-linger/);
});

test("update-agent forces the redeploy branch", () => {
  const s = buildUpdateAgentScript({
    dashboardUrl: "ws://d/agent-ws", token: "t", sparkId: "s", sshUser: "u",
  });
  assert.match(s, /\[ true = true \]/);
  const s2 = buildInstallAgentScript({
    dashboardUrl: "ws://d/agent-ws", token: "t", sparkId: "s", sshUser: "u",
  });
  assert.match(s2, /\[ false = true \]/);
});
