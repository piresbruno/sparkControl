/**
 * Store-root visibility for NAS nodes: the model-store root (kind "nas",
 * spark.nasRoot) is usually a plain directory of a larger filesystem or a
 * network mount, so it never appears as its own lsblk/`df -l` line and the
 * NAS cards could not match it (store space showed "— / —"). Both collectors
 * must surface the root's containing filesystem under the root path label.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
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
  nasRoot: "/mnt/llms",
  ssh: { host: "10.0.10.26", user: "piresbruno", auth: "pass", password: "test-pw" },
};

const DF_LOCAL = [
  "Filesystem Type 1B-blocks Used Available Use% Mounted on",
  "/dev/nvme0n1p2 ext4 996000000000 220000000000 725000000000 23% /",
].join("\n");

test("remote NAS: store root gets its own df pass and label", async () => {
  _setSshpassAvailable(true);
  let command = null;
  _setExecFile((file, args, opts, cb) => {
    void file;
    void opts;
    command = args[args.length - 1];
    // Second df (store root): an NFS mount that `df -l` would never list.
    const dfStore = [
      "Filesystem Type 1B-blocks Used Available Use% Mounted on",
      "10.0.10.100:/share/RAID nfs4 18000000000000 11160000000000 6840000000000 62% /mnt/llms",
    ].join("\n");
    cb(null, `${DF_LOCAL}\n${dfStore}`, "");
  });

  const disks = await new SystemCollector(NAS_SPARK)._getRemoteStorage();

  assert.match(command, /df -B1 -T \/mnt\/llms/, "second df targets the store root");
  assert.equal(disks.length, 2, "both df headers dropped, one entry per filesystem");
  const store = disks.find((d) => d.label === "/mnt/llms");
  assert.ok(store, "store root present under its configured path label");
  assert.equal(store.used, Math.round(11160000000000 / 1024 / 1024));
  assert.equal(store.total, Math.round(18000000000000 / 1024 / 1024));
  assert.equal(store.percentage, 62);
});

test("remote NAS: store-root df repeating a listed mount is deduped", async () => {
  _setSshpassAvailable(true);
  _setExecFile((file, args, opts, cb) => {
    void file;
    void args;
    void opts;
    // Store root / → the same mount the inventory df already reported.
    cb(null, `${DF_LOCAL}\nFilesystem Type 1B-blocks Used Available Use% Mounted on\n/dev/nvme0n1p2 ext4 996000000000 220000000000 725000000000 23% /`, "");
  });

  const disks = await new SystemCollector(NAS_SPARK)._getRemoteStorage();
  assert.equal(disks.filter((d) => d.label === "/").length, 1, "no duplicate mount entry");
});

test("remote non-NAS: no store-root df appended", async () => {
  _setSshpassAvailable(true);
  let command = null;
  _setExecFile((file, args, opts, cb) => {
    void file;
    void opts;
    command = args[args.length - 1];
    cb(null, DF_LOCAL, "");
  });

  const disks = await new SystemCollector({ ...NAS_SPARK, kind: "spark" })._getRemoteStorage();
  assert.ok(!command.includes("; df -B1 -T"), "store df only for kind nas");
  assert.deepEqual(disks.map((d) => d.label), ["/"]);
});

test("remote NAS: missing store root degrades to the mount inventory", async () => {
  _setSshpassAvailable(true);
  _setExecFile((file, args, opts, cb) => {
    void file;
    void args;
    void opts;
    // df on a nonexistent path prints nothing (stderr suppressed).
    cb(null, DF_LOCAL, "");
  });

  const disks = await new SystemCollector(NAS_SPARK)._getRemoteStorage();
  assert.deepEqual(disks.map((d) => d.label), ["/"]);
});

test("local NAS: store root statfs'd even when not an lsblk mountpoint", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spark-store-"));
  try {
    const collector = new SystemCollector({ id: "local-nas", isLocal: true, kind: "nas", nasRoot: tmpRoot });
    const disks = await collector.collectStorage();
    const store = disks.find((d) => d.label === tmpRoot);
    assert.ok(store, "store entry present under the configured root label");
    assert.ok(store.total > 0, "statfs reported a real filesystem size");

    // Same root on a non-NAS spark: no store entry appended.
    const plain = new SystemCollector({ id: "local-spark", isLocal: true, kind: "spark", nasRoot: tmpRoot });
    const plainDisks = await plain.collectStorage();
    assert.ok(!plainDisks.some((d) => d.label === tmpRoot), "no store entry without kind nas");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("local NAS: missing store root skips the entry without failing the poll", async () => {
  const collector = new SystemCollector({
    id: "local-nas",
    isLocal: true,
    kind: "nas",
    nasRoot: "/nonexistent-store-root-xyz",
  });
  const disks = await collector.collectStorage();
  assert.ok(Array.isArray(disks), "poll still returns the mount inventory");
  assert.ok(!disks.some((d) => d.label === "/nonexistent-store-root-xyz"));
});
