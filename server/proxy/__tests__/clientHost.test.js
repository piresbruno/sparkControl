/**
 * A6 clientHost tests: reverse-DNS resolution with cache semantics —
 * positive/negative caching and single-flight dedupe via an injected resolver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHostname, _resetClientHostCache } from "../clientHost.js";

test("resolves an IP to the first PTR hostname", async () => {
  _resetClientHostCache();
  let calls = 0;
  const host = await resolveHostname("10.0.30.173", {
    resolver: async () => {
      calls++;
      return ["box.local", "box.lan"];
    },
  });
  assert.equal(host, "box.local");
  assert.equal(calls, 1);
});

test("success is cached: second call does not hit the resolver", async () => {
  _resetClientHostCache();
  let calls = 0;
  const opts = {
    resolver: async () => {
      calls++;
      return ["box.local"];
    },
  };
  assert.equal(await resolveHostname("10.0.30.10", opts), "box.local");
  assert.equal(await resolveHostname("10.0.30.10", opts), "box.local");
  assert.equal(calls, 1);
});

test("failure caches null: second call does not retry", async () => {
  _resetClientHostCache();
  let calls = 0;
  const opts = {
    resolver: async () => {
      calls++;
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    },
  };
  assert.equal(await resolveHostname("10.9.9.9", opts), null);
  assert.equal(await resolveHostname("10.9.9.9", opts), null);
  assert.equal(calls, 1);
});

test("concurrent calls share one in-flight lookup", async () => {
  _resetClientHostCache();
  let calls = 0;
  const opts = {
    // Deferred resolver: all callers arrive before the lookup settles.
    resolver: () =>
      new Promise((resolve) => {
        calls++;
        setTimeout(() => resolve(["shared.local"]), 20);
      }),
  };
  const [a, b, c] = await Promise.all([
    resolveHostname("10.0.30.20", opts),
    resolveHostname("10.0.30.20", opts),
    resolveHostname("10.0.30.20", opts),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, "shared.local");
  assert.equal(b, "shared.local");
  assert.equal(c, "shared.local");
});

test("null, empty, and unknown IPs short-circuit to null without resolving", async () => {
  _resetClientHostCache();
  let calls = 0;
  const opts = {
    resolver: async () => {
      calls++;
      return ["never.local"];
    },
  };
  assert.equal(await resolveHostname(null, opts), null);
  assert.equal(await resolveHostname("", opts), null);
  assert.equal(await resolveHostname("unknown", opts), null);
  assert.equal(calls, 0);
});

test("slow resolver hits the timeout and yields null", async () => {
  _resetClientHostCache();
  const host = await resolveHostname("10.0.30.30", {
    timeoutMs: 20,
    resolver: () => new Promise((resolve) => setTimeout(() => resolve(["late.local"]), 500)),
  });
  assert.equal(host, null);
});


test("cache is bounded: more distinct IPs than MAX_CACHE evicts the oldest", async () => {
  _resetClientHostCache();
  const opts = { resolver: async (ip) => [`h-${ip}`] };
  // 1001 distinct IPs (cap is 1000) — every lookup is a cache miss by design.
  for (let i = 1; i <= 1001; i++) {
    await resolveHostname(`10.0.${Math.floor(i / 250)}.${i % 250}`, opts);
  }
  // The very first IP must have been evicted, so it re-resolves.
  let calls = 0;
  const host = await resolveHostname("10.0.0.1", {
    resolver: async () => {
      calls++;
      return ["box.local"];
    },
  });
  assert.equal(calls, 1, "earliest entry evicted, so it re-resolves");
  assert.equal(host, "box.local");
});
