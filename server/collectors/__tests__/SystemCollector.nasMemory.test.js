/**
 * Remote collector commands must tolerate hosts that lack optional binaries.
 * A NAS box has /proc/meminfo but no nvidia-smi: the last command in a joined
 * remote script decides the SSH exit status, so an unguarded `nvidia-smi` made
 * every unified-memory poll report "SSH failed" (exit 127, empty stderr) even
 * though the meminfo half succeeded.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { SystemCollector } from "../SystemCollector.js";
import { _setExecFile, _setSshpassAvailable } from "../ssh.js";

afterEach(() => {
  _setExecFile(null);
  _setSshpassAvailable(null);
});

const NAS_SPARK = {
  id: "nas-1",
  isLocal: false,
  kind: "nas",
  // Dummy credential: the execFile seam never spawns sshpass.
  ssh: { host: "10.0.10.26", user: "piresbruno", auth: "pass", password: "test-pw" },
};

test("unified-memory poll succeeds on a NAS host without nvidia-smi", async () => {
  _setSshpassAvailable(true);
  let command = null;
  _setExecFile((file, args, opts, cb) => {
    void file;
    void opts;
    command = args[args.length - 1];
    cb(null, "unused", "");
  });
  const collector = new SystemCollector(NAS_SPARK);
  await collector._getRemoteUnifiedMemory();
  assert.ok(command, "sshExec received the remote command");

  // Run the script the way sshd would, with every nvidia-smi renamed to a
  // binary that does not exist — the NAS case. grep/cat stay available, so the
  // only thing that can fail is the optional tool.
  const simulated = command.replace(/nvidia-smi/g, "nvidia-smi-not-installed");
  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync("/bin/sh", ["-c", simulated], { stdio: "pipe" }).toString();
  } catch (err) {
    status = err.status ?? 1;
    stdout = String(err.stdout ?? "");
  }

  assert.equal(status, 0, "remote script must exit 0 when the optional tool is missing");
  const [memOut, computeOut] = stdout.split("---");
  const totalKB = parseInt(memOut.match(/MemTotal:\s+(\d+)\s+kB/)[1], 10);
  assert.ok(totalKB > 0, "meminfo half still reported");
  assert.equal((computeOut ?? "").trim(), "", "compute-apps section empty, not an error");
});
