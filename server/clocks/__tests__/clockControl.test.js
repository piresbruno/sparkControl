/**
 * Clock control unit tests — parser, builders, desired-state roundtrip,
 * reconcile semantics. Exec is faked; no process spawns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CLOCK_HELPER_SCRIPT,
  buildApplyCommand,
  buildClockStatusCommand,
  buildInstallClockScript,
  getClocksState,
  parseClockStatus,
  parseInstallMarker,
  recordApply,
  reconcileSpark,
} from "../clockControl.js";

/** GB10-shaped status output (values verified on this machine). */
const GB10_STATUS = [
  "2418, 2418, 3003, 2190",
  "---",
  ...Array(20).fill("2808000"),
  "---",
  "2808000",
  "---",
  "338000",
  "---",
  "yes",
].join("\n");

function tmpStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spark-clocks-test-")), "state.json");
}

/** Use a fresh state file for the duration of fn; restore env afterwards. */
function withTmpState(fn) {
  const statePath = tmpStatePath();
  process.env.SPARKDASH_CLOCKS_STATE_PATH = statePath;
  return fn()
    .catch((err) => {
      delete process.env.SPARKDASH_CLOCKS_STATE_PATH;
      fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
      throw err;
    })
    .then((v) => {
      delete process.env.SPARKDASH_CLOCKS_STATE_PATH;
      fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
      return v;
    });
}

test("buildClockStatusCommand: 5 dash-separated sections, unprivileged", () => {
  const s = buildClockStatusCommand();
  const parts = s.split("\n");
  assert.equal(parts.filter((l) => l === "echo ---").length, 4);
  assert.match(s, /clocks\.applications\.graphics,clocks\.default_applications\.graphics,clocks\.max\.sm,clocks\.current\.sm/);
  assert.match(s, /\/sys\/devices\/system\/cpu\/cpu\[0-9\]\*\/cpufreq; do cat "\$d\/scaling_max_freq" 2>\/dev\/null \|\| cat "\$d\/max_perf/);
  assert.match(s, /cpuinfo_max_freq/);
  assert.match(s, /cpuinfo_min_freq/);
  assert.match(s, /test -x \/usr\/local\/bin\/spark-clock/);
  assert.ok(!s.includes("sudo"), "status probe must be unprivileged");
});

test("parseClockStatus: full GB10 sample", () => {
  const st = parseClockStatus(GB10_STATUS);
  assert.equal(st.helperInstalled, true);
  assert.deepEqual(st.gpu, {
    appClockMHz: 2418,
    defaultAppClockMHz: 2418,
    maxSmMHz: 3003,
    currentSmMHz: 2190,
    locked: false,
  });
  assert.equal(st.cpu.maxPerfKhzList.length, 20);
  assert.deepEqual(st.cpu, { maxPerfKhzList: Array(20).fill(2808000), hwMaxKhz: 2808000, hwMinKhz: 338000 });
});

test("parseClockStatus: locked when app clock differs from default app clock", () => {
  const st = parseClockStatus(GB10_STATUS.replace("2418, 2418, 3003, 2190", "1500, 2418, 3003, 1500"));
  assert.equal(st.gpu.appClockMHz, 1500);
  assert.equal(st.gpu.defaultAppClockMHz, 2418);
  assert.equal(st.gpu.locked, true);
});

test("parseClockStatus: N/A fields parse as null", () => {
  const st = parseClockStatus(
    ["N/A, N/A, 3003, N/A", "---", "2000000", "---", "2808000", "---", "338000", "---", "yes"].join("\n")
  );
  assert.deepEqual(st.gpu, {
    appClockMHz: null,
    defaultAppClockMHz: null,
    maxSmMHz: 3003,
    currentSmMHz: null,
    locked: false,
  });
  assert.equal(st.cpu.hwMaxKhz, 2808000);
});

test("parseClockStatus: empty GPU section → gpu null", () => {
  const st = parseClockStatus(["", "---", "2808000", "---", "2808000", "---", "338000", "---", "yes"].join("\n"));
  assert.equal(st.gpu, null);
  assert.ok(st.cpu);
});

test("parseClockStatus: no max_perf lines → cpu null", () => {
  const st = parseClockStatus(
    ["2418, 2418, 3003, 2190", "---", "", "---", "2808000", "---", "338000", "---", "no"].join("\n")
  );
  assert.equal(st.cpu, null);
  assert.equal(st.helperInstalled, false);
});

test("parseClockStatus: garbage cpu lines are skipped", () => {
  const st = parseClockStatus(
    [
      "2418, 2418, 3003, 2190",
      "---",
      "2808000",
      "n/a",
      "",
      "abc",
      "1500000",
      "---",
      "2808000",
      "---",
      "338000",
      "---",
      "yes",
    ].join("\n")
  );
  assert.deepEqual(st.cpu.maxPerfKhzList, [2808000, 1500000]);
});

test("buildApplyCommand: pre-checks, exact ops, order", () => {
  const s = buildApplyCommand({ gpu: { mode: "lock", mhz: 1500 }, cpu: { mode: "cap", khz: 2000000 } });
  const lines = s.split("\n");
  assert.match(lines[0], /^test -x \/usr\/local\/bin\/spark-clock/);
  assert.match(lines[1], /^sudo -n \/usr\/local\/bin\/spark-clock check/);
  assert.match(lines[2], /^sudo -n \/usr\/local\/bin\/spark-clock gpu-lock 1500$/);
  assert.match(lines[3], /^sudo -n \/usr\/local\/bin\/spark-clock cpu-max 2000000$/);
  const r = buildApplyCommand({ gpu: { mode: "reset" }, cpu: { mode: "reset" } });
  assert.match(r, /sudo -n \/usr\/local\/bin\/spark-clock gpu-reset\nsudo -n \/usr\/local\/bin\/spark-clock cpu-reset$/);
});

test("buildApplyCommand: rejects empty parts and non-integers", () => {
  assert.throws(() => buildApplyCommand({}), /at least one/);
  assert.throws(() => buildApplyCommand({ gpu: { mode: "lock", mhz: 0 } }), /positive integer/);
  assert.throws(() => buildApplyCommand({ gpu: { mode: "lock", mhz: 1.5 } }), /positive integer/);
  assert.throws(() => buildApplyCommand({ cpu: { mode: "cap", khz: -1 } }), /positive integer/);
  assert.throws(() => buildApplyCommand({ gpu: { mode: "turbo" } }), /gpu target/);
});

test("buildInstallClockScript: gate order, visudo gate, 0440, markers", () => {
  const s = buildInstallClockScript("pires");
  const order = [
    ["passwordless fast-path gate", s.indexOf("if sudo -n true 2>/dev/null; then")],
    ["helper b64 decode", s.indexOf("| base64 -d > /tmp/spark-clock.$$.tmp")],
    ["helper install 0755", s.indexOf("sudo -n install -m 0755 /tmp/spark-clock.$$.tmp /usr/local/bin/spark-clock")],
    ["sudoers b64 decode", s.indexOf("| base64 -d > /tmp/spark-clock-sudoers.$$")],
    ["visudo -cf gate", s.indexOf("sudo -n visudo -cf /tmp/spark-clock-sudoers.$$ >/dev/null")],
    ["sudoers install 0440", s.indexOf("sudo -n install -m 0440 /tmp/spark-clock-sudoers.$$ /etc/sudoers.d/spark-clock")],
    ["smoke check", s.indexOf("sudo -n /usr/local/bin/spark-clock check")],
    ["ok marker", s.indexOf('echo "__CLOCK_INSTALL__:ok"')],
    ["fast path exit", s.indexOf("exit 0")],
    ["stdin password read", s.indexOf("PW=$(head -n 1 2>/dev/null || true)")],
    ["no-stored-password fail marker", s.indexOf("__CLOCK_INSTALL__:fail:this user has no passwordless sudo and no SSH password is stored")],
    ["single sudo -S call", s.indexOf("sudo -S -p '' /bin/sh -c \"install -m 0755 '$H' /usr/local/bin/spark-clock")],
    ["sudo-rejected fail marker", s.indexOf("__CLOCK_INSTALL__:fail:sudo rejected the stored SSH password")],
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i][1] > order[i - 1][1], `${order[i][0]} must come after ${order[i - 1][0]}`);
  }
  // Sudoers payload decodes to exactly the NOPASSWD line (trailing newline).
  const m = s.match(/printf '%s' ('[^']*'|[A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/spark-clock-sudoers\.\$\$/);
  assert.ok(m, "sudoers payload line present");
  const payload = m[1].startsWith("'") ? m[1].slice(1, -1).replaceAll("'\\''", "'") : m[1];
  assert.equal(
    Buffer.from(payload, "base64").toString("utf8"),
    "pires ALL=(root) NOPASSWD: /usr/local/bin/spark-clock\n"
  );
  // Password path: one sudo -S consuming the whole privileged payload; the
  // script text itself never embeds a password value.
  assert.match(s, /printf '%s\\n' "\$PW" \| sudo -S -p '' \/bin\/sh -c/);
  assert.match(s, /visudo -cf '\$S' >\/dev\/null/);
  assert.match(s, /install -m 0440 '\$S' \/etc\/sudoers\.d\/spark-clock/);
  assert.ok(!/PW=[^$]/.test(s.replace("PW=$(head -n 1 2>/dev/null || true)", "")), "no literal password in script text");
});

test("buildInstallClockScript: sshUser lands in sudoers payload + manual hint", () => {
  const s = buildInstallClockScript("pires");
  const sudoersLine = "pires ALL=(root) NOPASSWD: /usr/local/bin/spark-clock";
  const b64 = Buffer.from(sudoersLine + "\n").toString("base64");
  assert.ok(s.includes(b64), "encoded sudoers line present");
  assert.ok(s.includes(`echo "  2) echo '${sudoersLine}' | sudo tee`), "manual hint embeds the user");
});

test("buildInstallClockScript: rejects unsafe users", () => {
  for (const bad of ["", "a b", "a;b", "x$(id)", "../etc", "a\nb", "-root"]) {
    assert.throws(() => buildInstallClockScript(bad), /invalid SSH user/);
  }
  for (const good of ["pires", "spark_user", "svc-user", "Admin", "deploy$"]) {
    assert.doesNotThrow(() => buildInstallClockScript(good));
  }
});

test("parseInstallMarker: ok / fail / missing", () => {
  assert.deepEqual(parseInstallMarker("step ok\n__CLOCK_INSTALL__:ok"), {
    ok: true,
    reason: null,
    output: "step ok\n__CLOCK_INSTALL__:ok",
  });
  const fail = parseInstallMarker("__CLOCK_INSTALL__:fail:sudoers validation");
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, "sudoers validation");
  const none = parseInstallMarker("random output");
  assert.equal(none.ok, false);
  assert.match(none.reason, /no install marker/);
});

test("desired state: roundtrip with tmp state path", () => {
  return withTmpState(async () => {
    assert.deepEqual(getClocksState("spark-a"), {
      desired: { gpu: null, cpu: null },
      lastApplied: { gpu: null, cpu: null, at: null },
    });
    recordApply("spark-a", { gpu: { mode: "lock", mhz: 1500 }, cpu: { mode: "cap", khz: 2000000 } });
    const after = getClocksState("spark-a");
    assert.deepEqual(after.desired, { gpu: { mode: "lock", mhz: 1500 }, cpu: { mode: "cap", khz: 2000000 } });
    assert.deepEqual(after.lastApplied.gpu, { mode: "lock", mhz: 1500 });
    assert.deepEqual(after.lastApplied.cpu, { mode: "cap", khz: 2000000 });
    assert.ok(!Number.isNaN(Date.parse(after.lastApplied.at)), "at is ISO");

    // A reset apply overwrites the lock intent; other domain untouched.
    recordApply("spark-a", { gpu: { mode: "reset" } });
    const after2 = getClocksState("spark-a");
    assert.deepEqual(after2.desired.gpu, { mode: "reset" });
    assert.deepEqual(after2.desired.cpu, { mode: "cap", khz: 2000000 });
    assert.deepEqual(after2.lastApplied.gpu, { mode: "reset" });

    // Isolates sparks.
    assert.deepEqual(getClocksState("spark-b").desired, { gpu: null, cpu: null });
    const onDisk = JSON.parse(fs.readFileSync(process.env.SPARKDASH_CLOCKS_STATE_PATH, "utf8"));
    assert.deepEqual(onDisk["spark-a"].desired.gpu, { mode: "reset" });
  });
});

/** Fake deps for reconcile tests. */
function fakeDeps({ sparks = {}, statusOut = GB10_STATUS, onExec } = {}) {
  const calls = [];
  const exec = async (spark, cmd, opts) => {
    calls.push({ sparkId: spark.id, cmd, opts });
    if (onExec) return onExec({ spark, cmd, opts, call: calls.length });
    if (cmd.startsWith("nvidia-smi")) return statusOut;
    return "";
  };
  return { deps: { exec, getSpark: (id) => sparks[id] ?? null }, calls };
}

test("reconcile: skips missing, nas, and empty desired", () => {
  return withTmpState(async () => {
    const { deps, calls } = fakeDeps({ sparks: { nas: { id: "nas", kind: "nas" } } });
    await reconcileSpark("missing", deps);
    await reconcileSpark("nas", deps); // registered but nothing desired
    assert.equal(calls.length, 0, "no exec for missing/nas/empty-desired");
  });
});

test("reconcile: applies desired parts and stamps lastApplied", () => {
  return withTmpState(async () => {
    recordApply("sp1", { cpu: { mode: "cap", khz: 2000000 } });
    const { deps, calls } = fakeDeps({ sparks: { sp1: { id: "sp1", kind: "spark" } } });
    await reconcileSpark("sp1", deps);
    // Two execs: status probe + apply.
    assert.equal(calls.length, 2);
    assert.match(calls[0].cmd, /^nvidia-smi/);
    assert.match(calls[1].cmd, /spark-clock cpu-max 2000000$/);
    assert.equal(calls[1].opts.timeoutMs, 20000);
    const st = getClocksState("sp1");
    assert.deepEqual(st.desired, { gpu: null, cpu: { mode: "cap", khz: 2000000 } }, "desired unchanged");
    assert.deepEqual(st.lastApplied.cpu, { mode: "cap", khz: 2000000 });
    assert.ok(st.lastApplied.at);
  });
});

test("reconcile: skips when helper not installed", () => {
  return withTmpState(async () => {
    recordApply("sp2", { gpu: { mode: "lock", mhz: 1500 } });
    const { deps, calls } = fakeDeps({
      sparks: { sp2: { id: "sp2", kind: "spark" } },
      statusOut: GB10_STATUS.replace(/\nyes$/, "\nno"),
    });
    await reconcileSpark("sp2", deps);
    assert.equal(calls.length, 1, "only the status probe ran");
    assert.match(calls[0].cmd, /^nvidia-smi/);
    const st = getClocksState("sp2");
    assert.deepEqual(st.lastApplied.gpu, { mode: "lock", mhz: 1500 }, "prior lastApplied untouched by the skip");
  });
});

test("reconcile: single-flight dedupes concurrent triggers", () => {
  return withTmpState(async () => {
    recordApply("sp3", { cpu: { mode: "cap", khz: 1500000 } });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const { deps, calls } = fakeDeps({
      sparks: { sp3: { id: "sp3", kind: "spark" } },
      onExec: async ({ cmd }) => {
        if (cmd.startsWith("nvidia-smi")) {
          await gate; // park the first status probe
          return GB10_STATUS;
        }
        return "";
      },
    });
    const p1 = reconcileSpark("sp3", deps);
    const p2 = reconcileSpark("sp3", deps);
    assert.equal(p1, p2, "same promise returned while in flight");
    release();
    await p1;
    assert.equal(calls.length, 2, "one status + one apply despite two triggers");
  });
});

test("reconcile: failure keeps desired and does not reject", () => {
  return withTmpState(async () => {
    recordApply("sp4", { gpu: { mode: "lock", mhz: 2000 } });
    const origLog = console.log;
    const logs = [];
    console.log = (...a) => logs.push(a.join(" "));
    try {
      const { deps } = fakeDeps({
        sparks: { sp4: { id: "sp4", kind: "spark" } },
        onExec: async ({ cmd }) => {
          if (cmd.startsWith("nvidia-smi")) return GB10_STATUS;
          throw new Error("nvidia-smi: not permitted");
        },
      });
      await reconcileSpark("sp4", deps); // must not throw
    } finally {
      console.log = origLog;
    }
    const st = getClocksState("sp4");
    assert.deepEqual(st.desired.gpu, { mode: "lock", mhz: 2000 }, "desired kept for next transition");
    assert.deepEqual(st.lastApplied.gpu, { mode: "lock", mhz: 2000 }, "lastApplied untouched by the failure");
  });
});

test("helper script: shell-valid shape and covers all subcommands", () => {
  assert.match(CLOCK_HELPER_SCRIPT, /^#!\/bin\/sh/);
  for (const sub of ["check)", "gpu-lock)", "gpu-reset)", "cpu-max)", "cpu-reset)"]) {
    assert.ok(CLOCK_HELPER_SCRIPT.includes(sub), sub);
  }
  assert.match(CLOCK_HELPER_SCRIPT, /nvidia-smi -lgc "\$2"/);
  assert.match(CLOCK_HELPER_SCRIPT, /nvidia-smi -rgc/);
  assert.match(CLOCK_HELPER_SCRIPT, /echo "\$2" > "\$d\/scaling_max_freq"/);
  assert.match(CLOCK_HELPER_SCRIPT, /cat "\$d\/cpuinfo_max_freq" > "\$d\/scaling_max_freq"/);
  // max_perf is NOT written: on GB10 its write reverts scaling_max_freq.
  assert.ok(!/echo "\$2" > "\$d\/max_perf/.test(CLOCK_HELPER_SCRIPT));
});
