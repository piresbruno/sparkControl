import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveMac, normalizeMac, buildMagicPacket } from "../wol.js";

test("normalizeMac lowercases and validates shape (keeps separators)", () => {
  assert.equal(normalizeMac("AA:BB:CC:DD:EE:FF"), "aa:bb:cc:dd:ee:ff");
  assert.equal(normalizeMac("  aa-bb-cc-dd-ee-ff "), "aa-bb-cc-dd-ee-ff");
  assert.equal(normalizeMac("nothex"), null);
  assert.equal(normalizeMac(""), null);
  assert.equal(normalizeMac(null), null);
});

test("effectiveMac prefers explicit override, then detected", () => {
  assert.equal(effectiveMac({ macAddress: "aa:bb:cc:dd:ee:01", detectedMacAddress: "aa:bb:cc:dd:ee:02" }), "aa:bb:cc:dd:ee:01");
  assert.equal(effectiveMac({ detectedMacAddress: "aa:bb:cc:dd:ee:02" }), "aa:bb:cc:dd:ee:02");
  assert.equal(effectiveMac({ macAddress: "bogus", detectedMacAddress: "aa:bb:cc:dd:ee:02" }), "aa:bb:cc:dd:ee:02");
  assert.equal(effectiveMac({}), null);
});

test("buildMagicPacket: 6×0xff sync + 16×MAC from a normalized mac", () => {
  const pkt = buildMagicPacket("aa:bb:cc:dd:ee:ff");
  assert.equal(pkt.length, 102);
  for (let i = 0; i < 6; i++) assert.equal(pkt[i], 0xff);
  for (let i = 6; i < 102; i += 6) {
    assert.deepEqual([...pkt.slice(i, i + 6)], [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  }
});
