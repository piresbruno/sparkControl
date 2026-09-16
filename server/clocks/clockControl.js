/**
 * Clock control for DGX Spark nodes — GPU `-lgc` / CPU `max_perf` underclocking.
 *
 * Pure builders + parser + desired-state + reconcile; exec is injected (DI,
 * same pattern as jobs/remoteJobs.js) so unit tests never spawn processes.
 *
 * Privilege model: every transport (agent job-run, execOnLocalHost setpriv,
 * sshExec) runs as the node's SSH user with no TTY, so privileged work goes
 * through `/usr/local/bin/spark-clock` (installed once per node by
 * buildInstallClockScript) via `sudo -n`, backed by a NOPASSWD sudoers entry
 * gated by `visudo -cf`.
 *
 * State: config/spark-clocks.json (SPARKDASH_CLOCKS_STATE_PATH overrides),
 * one entry per sparkId: { desired: {gpu,cpu}, lastApplied: {gpu,cpu,at} }.
 * `desired` is re-applied on every false→true online transition (reconcile).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "../util/atomicWrite.js";
import { shellQuote } from "../util/shellQuote.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

/** State file path (lazy so tests can point SPARKDASH_CLOCKS_STATE_PATH at a tmpdir). */
export function clocksStatePath() {
  return process.env.SPARKDASH_CLOCKS_STATE_PATH || path.join(ROOT, "config", "spark-clocks.json");
}

const CLOCK_BIN = "/usr/local/bin/spark-clock";

/**
 * Privileged helper installed to /usr/local/bin/spark-clock on nodes.
 * Runs as root via `sudo -n`; subcommands cover check / GPU lock+reset /
 * CPU cap+reset. The `cpu[0-9]*` glob cannot match the top-level
 * /sys/devices/system/cpu/cpufreq policy dir (requires a digit after "cpu").
 */
export const CLOCK_HELPER_SCRIPT = `#!/bin/sh
# spark-clock — GPU/CPU clock control for sparkControl (runs as root via sudo).
set -u
usage() { echo "usage: spark-clock check|gpu-lock MHZ|gpu-reset|cpu-max KHZ|cpu-reset" >&2; exit 64; }
[ $# -ge 1 ] || usage
case "$1" in
  check) exit 0 ;;
  gpu-lock)
    [ $# -eq 2 ] || usage
    case "$2" in ''|*[!0-9]*) echo "spark-clock: MHz must be a positive integer" >&2; exit 64;; esac
    exec nvidia-smi -lgc "$2"
    ;;
  gpu-reset) [ $# -eq 1 ] || usage; exec nvidia-smi -rgc ;;
  cpu-max)
    [ $# -eq 2 ] || usage
    case "$2" in ''|*[!0-9]*) echo "spark-clock: kHz must be a positive integer" >&2; exit 64;; esac
    for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do
      # scaling_max_freq is the knob the cpufreq core enforces. Do NOT also
      # write max_perf here: on GB10 its write is accepted but re-derives the
      # policy from firmware and reverts scaling_max_freq (verified).
      [ -f "$d/scaling_max_freq" ] || continue
      echo "$2" > "$d/scaling_max_freq" || { echo "spark-clock: failed writing $d/scaling_max_freq" >&2; exit 1; }
    done
    ;;
  cpu-reset)
    [ $# -eq 1 ] || usage
    for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do
      [ -f "$d/scaling_max_freq" ] || continue
      cat "$d/cpuinfo_max_freq" > "$d/scaling_max_freq" || { echo "spark-clock: failed resetting $d/scaling_max_freq" >&2; exit 1; }
    done
    ;;
  *) usage ;;
esac
`;

/** Unprivileged 5-section status probe (GPU csv / max_perf list / hw max / hw min / helper presence). */
export function buildClockStatusCommand() {
  return [
    "nvidia-smi --query-gpu=clocks.applications.graphics,clocks.default_applications.graphics,clocks.max.sm,clocks.current.sm --format=csv,noheader,nounits 2>/dev/null",
    "echo ---",
    "for d in /sys/devices/system/cpu/cpu[0-9]*/cpufreq; do cat \"$d/scaling_max_freq\" 2>/dev/null || cat \"$d/max_perf\" 2>/dev/null; done",
    "echo ---",
    "cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null || true",
    "echo ---",
    "cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq 2>/dev/null || true",
    "echo ---",
    "test -x " + CLOCK_BIN + " && echo yes || echo no",
  ].join("\n");
}

/** Parse an nvidia-smi numeric field; treat [N/A] / empty as null (same semantics as SystemCollector._parseSmiNumber — copied, not imported, to keep this module pure). */
function parseSmiNumber(value) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t || /^\[?n\/a\]?$/i.test(t)) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse buildClockStatusCommand output.
 * @returns {{
 *   helperInstalled: boolean,
 *   gpu: { appClockMHz: number|null, defaultAppClockMHz: number|null, maxSmMHz: number|null, currentSmMHz: number|null, locked: boolean } | null,
 *   cpu: { maxPerfKhzList: number[], hwMaxKhz: number|null, hwMinKhz: number|null } | null,
 * }}
 */
export function parseClockStatus(out) {
  const lines = String(out ?? "").split(/\r?\n/);
  const sections = [[]];
  for (const line of lines) {
    if (line.trim() === "---") sections.push([]);
    else sections[sections.length - 1].push(line);
  }
  const sec = (i) => sections[i] ?? [];

  // GPU: first non-empty CSV row of section 0.
  let gpu = null;
  const gpuRow = sec(0).map((l) => l.trim()).find(Boolean);
  if (gpuRow) {
    const f = gpuRow.split(",");
    const appClockMHz = parseSmiNumber(f[0]);
    const defaultAppClockMHz = parseSmiNumber(f[1]);
    gpu = {
      appClockMHz,
      defaultAppClockMHz,
      maxSmMHz: parseSmiNumber(f[2]),
      currentSmMHz: parseSmiNumber(f[3]),
      locked: appClockMHz != null && defaultAppClockMHz != null && appClockMHz !== defaultAppClockMHz,
    };
  }

  // CPU: kHz list from section 1; hw bounds from sections 2/3.
  const maxPerfKhzList = sec(1)
    .map((l) => parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n));
  const firstInt = (idx) => {
    for (const line of sec(idx)) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const cpu = maxPerfKhzList.length > 0
    ? { maxPerfKhzList, hwMaxKhz: firstInt(2), hwMinKhz: firstInt(3) }
    : null;

  const helperInstalled = sec(4).some((l) => l.trim() === "yes");
  return { helperInstalled, gpu, cpu };
}

function assertPositiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * Build the privileged apply script. At least one part required.
 * Numbers are route-validated integers; shellQuote keeps transport uniform.
 * @param {{ gpu?: { mode: "lock", mhz: number } | { mode: "reset" }, cpu?: { mode: "cap", khz: number } | { mode: "reset" } }} parts
 */
export function buildApplyCommand(parts) {
  const ops = [];
  if (parts.gpu) {
    if (parts.gpu.mode === "lock") {
      const mhz = assertPositiveInt(parts.gpu.mhz, "gpu.mhz");
      ops.push(`sudo -n ${CLOCK_BIN} gpu-lock ${shellQuote(mhz)}`);
    } else if (parts.gpu.mode === "reset") {
      ops.push(`sudo -n ${CLOCK_BIN} gpu-reset`);
    } else {
      throw new Error("gpu target must be {mode:'lock',mhz} or {mode:'reset'}");
    }
  }
  if (parts.cpu) {
    if (parts.cpu.mode === "cap") {
      const khz = assertPositiveInt(parts.cpu.khz, "cpu.khz");
      ops.push(`sudo -n ${CLOCK_BIN} cpu-max ${shellQuote(khz)}`);
    } else if (parts.cpu.mode === "reset") {
      ops.push(`sudo -n ${CLOCK_BIN} cpu-reset`);
    } else {
      throw new Error("cpu target must be {mode:'cap',khz} or {mode:'reset'}");
    }
  }
  if (ops.length === 0) throw new Error("clock apply needs at least one of gpu/cpu");
  return [
    `test -x ${CLOCK_BIN} || { echo "clock helper missing — run Install clock control first" >&2; exit 127; }`,
    // Probe the helper itself, not `sudo -n true`: nodes may grant NOPASSWD
    // for spark-clock only (exactly what the installer sets up).
    `sudo -n ${CLOCK_BIN} check 2>/dev/null || { echo "passwordless sudo for ${CLOCK_BIN} required — run Install clock control first" >&2; exit 126; }`,
    ...ops,
  ].join("\n");
}

/**
 * One-off installer script (idempotent; validates sudoers via visudo -cf
 * before installing). Two paths:
 *  - passwordless sudo (sudo -n true succeeds): privileged steps run directly;
 *  - otherwise ONE password line is read from stdin and fed to a single
 *    `sudo -S -p ''` call that performs every privileged step (no reliance on
 *    sudo's timestamp cache). The password never enters the script text, argv
 *    or output — the caller pipes it over stdin.
 * Ends with __CLOCK_INSTALL__:ok | fail:<reason> markers.
 */
export function buildInstallClockScript(sshUser) {
  if (!/^[a-z_][a-z0-9_-]*\$?$/i.test(String(sshUser || ""))) {
    throw new Error(`invalid SSH user: ${JSON.stringify(sshUser)}`);
  }
  const user = String(sshUser);
  const helperB64 = Buffer.from(CLOCK_HELPER_SCRIPT, "utf8").toString("base64");
  const sudoers = `${user} ALL=(root) NOPASSWD: ${CLOCK_BIN}\n`;
  const sudoersB64 = Buffer.from(sudoers, "utf8").toString("base64");
  const manual = [
    `echo "  1) write the spark-clock helper to ${CLOCK_BIN} (mode 0755)"`,
    `echo "  2) echo '${sudoers.trim()}' | sudo tee /etc/sudoers.d/spark-clock && sudo chmod 0440 /etc/sudoers.d/spark-clock"`,
  ];
  // Privileged payload for the password path: tmp names embed the outer shell
  // PID (digits/slashes only), so expanding $H/$S inside a double-quoted sh -c
  // string is quoting-safe. One sudo call does everything.
  const pwPayload = [
    "install -m 0755 '$H' " + CLOCK_BIN,
    "visudo -cf '$S' >/dev/null",
    "install -m 0440 '$S' /etc/sudoers.d/spark-clock",
    "rm -f '$H' '$S'",
    CLOCK_BIN + " check",
  ].join(" && ");
  return [
    "set -u",
    "if sudo -n true 2>/dev/null; then",
    `printf '%s' ${shellQuote(helperB64)} | base64 -d > /tmp/spark-clock.$$.tmp`,
    `sudo -n install -m 0755 /tmp/spark-clock.$$.tmp ${CLOCK_BIN} || { echo "__CLOCK_INSTALL__:fail:helper install"; exit 1; }`,
    "rm -f /tmp/spark-clock.$$.tmp",
    `printf '%s' ${shellQuote(sudoersB64)} | base64 -d > /tmp/spark-clock-sudoers.$$`,
    `sudo -n visudo -cf /tmp/spark-clock-sudoers.$$ >/dev/null || { echo "__CLOCK_INSTALL__:fail:sudoers validation"; rm -f /tmp/spark-clock-sudoers.$$; exit 1; }`,
    `sudo -n install -m 0440 /tmp/spark-clock-sudoers.$$ /etc/sudoers.d/spark-clock || { echo "__CLOCK_INSTALL__:fail:sudoers install"; rm -f /tmp/spark-clock-sudoers.$$; exit 1; }`,
    "rm -f /tmp/spark-clock-sudoers.$$",
    `sudo -n ${CLOCK_BIN} check || { echo "__CLOCK_INSTALL__:fail:smoke test"; exit 1; }`,
    'echo "__CLOCK_INSTALL__:ok"',
    "exit 0",
    "fi",
    "# No NOPASSWD — fall back to one sudo password supplied on stdin.",
    "PW=$(head -n 1 2>/dev/null || true)",
    'if [ -z "$PW" ]; then',
    'echo "__CLOCK_INSTALL__:fail:this user has no passwordless sudo and no SSH password is stored — install manually:"',
    ...manual,
    "exit 126",
    "fi",
    'H="/tmp/spark-clock.$$.tmp"',
    'S="/tmp/spark-clock-sudoers.$$" || true',
    `printf '%s' ${shellQuote(helperB64)} | base64 -d > "$H"`,
    `printf '%s' ${shellQuote(sudoersB64)} | base64 -d > "$S"`,
    `if printf '%s\\n' "$PW" | sudo -S -p '' /bin/sh -c "${pwPayload}"; then`,
    'echo "__CLOCK_INSTALL__:ok"',
    "else",
    'rm -f "$H" "$S"',
    'echo "__CLOCK_INSTALL__:fail:sudo rejected the stored SSH password (or sudo failed) — install manually:"',
    ...manual,
    "exit 126",
    "fi",
  ].join("\n");
}

/**
 * Parse the trailing __CLOCK_INSTALL__ marker from installer output.
 * @returns {{ ok: boolean, reason: string|null, output: string }}
 */
export function parseInstallMarker(out) {
  const text = String(out ?? "");
  const idx = text.lastIndexOf("__CLOCK_INSTALL__:");
  if (idx < 0) return { ok: false, reason: text.trim() ? "no install marker in output" : "no output", output: text };
  const tail = text.slice(idx + "__CLOCK_INSTALL__:".length).trim();
  if (tail === "ok") return { ok: true, reason: null, output: text };
  const reason = tail.startsWith("fail:") ? tail.slice(5) : tail || "install failed";
  return { ok: false, reason, output: text };
}

// ─── Desired state ────────────────────────────────────────

function normalizeEntry(e) {
  return {
    desired: { gpu: e?.desired?.gpu ?? null, cpu: e?.desired?.cpu ?? null },
    lastApplied: {
      gpu: e?.lastApplied?.gpu ?? null,
      cpu: e?.lastApplied?.cpu ?? null,
      at: e?.lastApplied?.at ?? null,
    },
  };
}

function loadClocksState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(clocksStatePath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveClocksState(all) {
  atomicWrite(clocksStatePath(), JSON.stringify(all, null, 2) + "\n");
}

/** Normalized { desired, lastApplied } for one spark (nulls when absent). */
export function getClocksState(sparkId) {
  return normalizeEntry(loadClocksState()[sparkId]);
}

/**
 * Persist a successful apply: overwrite desired + lastApplied for the
 * domains present in `parts` and stamp lastApplied.at.
 * @param {{ gpu?: object, cpu?: object }} parts targets actually applied
 */
export function recordApply(sparkId, parts) {
  const all = loadClocksState();
  const entry = normalizeEntry(all[sparkId]);
  for (const domain of ["gpu", "cpu"]) {
    if (parts[domain] !== undefined) {
      entry.desired[domain] = parts[domain];
      entry.lastApplied[domain] = parts[domain];
    }
  }
  entry.lastApplied.at = new Date().toISOString();
  all[sparkId] = entry;
  saveClocksState(all);
  return entry;
}

/** Whether the spark has any desired clock target worth re-applying. */
function hasDesired(entry) {
  return entry.desired.gpu != null || entry.desired.cpu != null;
}

// ─── Reconcile (re-apply desired clocks on online transitions) ───────────

/** Per-spark single-flight: concurrent triggers share one run. */
const inflightReconcile = new Map();

/**
 * Re-apply the spark's remembered desired clocks. Never rejects; resolves
 * silently when there is nothing to do (missing/nas spark, empty desired,
 * helper not installed) and logs (keeping desired for the next transition)
 * when the apply fails.
 * @param {string} sparkId
 * @param {{ exec: (spark: object, cmd: string, opts?: object) => Promise<string>, getSpark: (id: string) => object|null }} deps
 */
export function reconcileSpark(sparkId, deps) {
  const existing = inflightReconcile.get(sparkId);
  if (existing) return existing;
  const run = (async () => {
    try {
      const spark = deps.getSpark(sparkId);
      if (!spark || spark.kind === "nas") return;
      const entry = getClocksState(sparkId);
      if (!hasDesired(entry)) return;
      const parts = {};
      if (entry.desired.gpu != null) parts.gpu = entry.desired.gpu;
      if (entry.desired.cpu != null) parts.cpu = entry.desired.cpu;
      // Feature-detect the helper before sudo (status probe is unprivileged).
      const statusOut = await deps.exec(spark, buildClockStatusCommand(), { timeoutMs: 10_000 });
      if (!parseClockStatus(statusOut).helperInstalled) return;
      await deps.exec(spark, buildApplyCommand(parts), { timeoutMs: 20_000 });
      const stamped = normalizeEntry(getClocksState(sparkId));
      for (const domain of ["gpu", "cpu"]) {
        if (parts[domain] !== undefined) stamped.lastApplied[domain] = parts[domain];
      }
      stamped.lastApplied.at = new Date().toISOString();
      const all = loadClocksState();
      all[sparkId] = stamped;
      saveClocksState(all);
    } catch (err) {
      console.log(`[clocks] reconcile failed for ${sparkId}: ${err?.message || err}`);
    } finally {
      inflightReconcile.delete(sparkId);
    }
  })();
  inflightReconcile.set(sparkId, run);
  return run;
}
