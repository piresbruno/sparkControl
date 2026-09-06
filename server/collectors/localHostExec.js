/**
 * execOnLocalHost — run a shell command on the LOCAL host machine (the node
 * the dashboard is installed on), not inside the dashboard's own runtime
 * (Docker container). Local Sparks must behave like SSH nodes: modelctl/uv
 * live in the host user's ~/.local/bin, the NAS root and model store are host
 * mounts, and job artifacts belong in the host user's ~/.sparkdash — none of
 * which exist inside the container.
 *
 * Convention shared with HermesProbe / TailscaleProbe / SystemCollector:
 * enter the host mount namespace via nsenter (HOST_PATHS.PROC/1/ns/mnt) and
 * drop to the configured host user via setpriv with HOME resolved from the
 * HOST passwd file. On a bare-host dev setup the same call degrades to the
 * current mount namespace / own identity (chooseLocalInvocation fallback).
 */
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { HOST_PATHS } from "../config.js";
import { chooseLocalInvocation } from "./HermesProbe.js";

/**
 * @param {object} spark spark snapshot (uses spark.ssh.user for identity)
 * @param {string} cmd shell script to run on the host
 * @param {{ timeoutMs?: number }} opts
 * @returns {Promise<string>} trimmed stdout; rejects on non-zero exit
 */
export function execOnLocalHost(spark, cmd, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10_000;
  const mntNs = fs.existsSync(path.join(HOST_PATHS.PROC, "1", "ns", "mnt"))
    ? path.join(HOST_PATHS.PROC, "1", "ns", "mnt")
    : null;
  let passwdText = "";
  try {
    passwdText = fs.readFileSync(
      mntNs ? path.join(HOST_PATHS.ROOT, "etc", "passwd") : "/etc/passwd",
      "utf8"
    );
  } catch {
    passwdText = "";
  }
  const inv = chooseLocalInvocation({
    mntNs,
    passwdText,
    currentUid: typeof process.getuid === "function" ? process.getuid() : -1,
    user: spark?.ssh?.user,
    cmd,
  });
  return new Promise((resolve, reject) => {
    execFile(
      inv.file,
      inv.args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(
            new Error(String(stderr || stdout || "").trim() || err.message)
          );
        }
        resolve(String(stdout).trim());
      }
    );
  });
}
