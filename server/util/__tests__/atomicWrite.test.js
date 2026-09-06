import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../atomicWrite.js";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
});

test("atomicWrite creates parent dirs and writes content", () => {
  const file = path.join(tmp, "nested", "dir", "out.json");
  atomicWrite(file, '{"a":1}\n');
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}\n');
});

test("atomicWrite replaces existing content atomically (no temp residue)", () => {
  const file = path.join(tmp, "f.txt");
  atomicWrite(file, "one");
  atomicWrite(file, "two");
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  const leftovers = fs.readdirSync(tmp).filter((f) => f !== "f.txt");
  assert.deepEqual(leftovers, [], "no temp files left behind");
});

test("atomicWrite applies the given mode", () => {
  const file = path.join(tmp, "secret.txt");
  atomicWrite(file, "x", 0o600);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});
