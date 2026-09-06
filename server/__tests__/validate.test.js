import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidIPv4,
  isValidHostname,
  isValidHost,
  isAllowedTargetHost,
  isValidSshUser,
  isValidSparkId,
  validateSparkTarget,
  createRateLimiter,
  classifyHostScope,
} from "../validate.js";

test("isValidIPv4 accepts dotted quads, rejects junk", () => {
  assert.equal(isValidIPv4("10.0.10.4"), true);
  assert.equal(isValidIPv4("127.0.0.1"), true);
  assert.equal(isValidIPv4("256.1.1.1"), false);
  assert.equal(isValidIPv4("abc"), false);
  assert.equal(isValidIPv4(""), false);
});

test("isValidHostname accepts DNS names, rejects spaces", () => {
  assert.equal(isValidHostname("dgx2.lab"), true);
  assert.equal(isValidHostname("localhost"), true);
  assert.equal(isValidHostname("a b"), false);
  assert.equal(isValidHostname(""), false);
});

test("isValidHost = IPv4 or hostname", () => {
  assert.equal(isValidHost("10.0.0.5"), true);
  assert.equal(isValidHost("node.example"), true);
  assert.equal(isValidHost("not host"), false);
});

test("isAllowedTargetHost: private + loopback allowed, metadata blocked", () => {
  assert.equal(isAllowedTargetHost("10.0.10.5"), true);
  assert.equal(isAllowedTargetHost("127.0.0.1"), true);
  assert.equal(isAllowedTargetHost("192.168.1.1"), true);
  assert.equal(isAllowedTargetHost("169.254.169.254"), false, "cloud metadata");
  assert.equal(isAllowedTargetHost("100.64.0.1"), true, "CGNAT/tailnet range");
});

test("isValidSshUser charset", () => {
  assert.equal(isValidSshUser("piresbruno"), true);
  assert.equal(isValidSshUser("root"), true);
  assert.equal(isValidSshUser("a b"), false);
  assert.equal(isValidSshUser("x".repeat(65)), false);
});

test("isValidSparkId: reserved ids rejected", () => {
  assert.equal(isValidSparkId("spark-1"), true);
  assert.equal(isValidSparkId("__overview__"), false);
  assert.equal(isValidSparkId("__analysis__"), false);
  assert.equal(isValidSparkId("__models__"), false);
  assert.equal(isValidSparkId("a;b"), false);
});

test("validateSparkTarget reports lanIp/ssh problems", () => {
  assert.equal(validateSparkTarget({ lanIp: "10.0.0.5", ssh: { host: "10.0.0.5", user: "root" } }), null);
  const bad = validateSparkTarget({ lanIp: "bad ip", ssh: { host: "10.0.0.5", user: "root" } });
  assert.ok(typeof bad === "string" && bad.length > 0);
  const badUser = validateSparkTarget({ lanIp: "10.0.0.5", ssh: { host: "10.0.0.5", user: "bad user" } });
  assert.ok(typeof badUser === "string");
});

test("classifyHostScope buckets addresses", () => {
  assert.ok(classifyHostScope("127.0.0.1"));
  assert.ok(classifyHostScope("10.0.0.1"));
  assert.ok(classifyHostScope("example.com"));
});

test("createRateLimiter slides over the window", () => {
  const rl = createRateLimiter(2, 50);
  assert.equal(rl("k"), true);
  assert.equal(rl("k"), true);
  assert.equal(rl("k"), false, "third inside window blocked");
  // Different key independent.
  assert.equal(rl("other"), true);
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(rl("k"), true, "window elapsed → allowed again");
      resolve();
    }, 60);
  });
});
