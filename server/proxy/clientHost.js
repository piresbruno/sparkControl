/**
 * clientHost (A6) — reverse-DNS hostname resolution for client IPs.
 *
 * Resolves PTR records for trace client IPs with a small TTL cache so the
 * /api/llm/clients poll and trace records don't hammer the resolver. All
 * failures resolve to `null` (LANs without local DNS are the norm — the UI
 * then shows the bare IP).
 *
 * - Positive results cached 10 min; failures (null) cached 10 min too.
 * - One in-flight promise per IP — concurrent callers share the lookup.
 * - `resolver` injectable for tests.
 */

/** Cache TTL for both hits and misses (ms). */
const TTL_MS = 10 * 60 * 1000;

/** "unknown" sentinel used by express/sock libraries for missing client IP. */
const UNKNOWN_SENTINELS = new Set(["", "unknown", "-"]);

const cache = new Map(); // ip -> { host: string|null, at: number }
const inflight = new Map(); // ip -> Promise<string|null>

/**
 * Resolve a client IP to a hostname via reverse DNS (PTR).
 * @param {string|null|undefined} ip
 * @param {{ timeoutMs?: number, resolver?: (ip: string) => Promise<string[]> }} [opts]
 * @returns {Promise<string|null>} first hostname, or null when unresolvable
 */
export function resolveHostname(ip, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 750;
  const resolver = opts.resolver || defaultResolver;

  if (typeof ip !== "string" || UNKNOWN_SENTINELS.has(ip.trim().toLowerCase())) {
    return Promise.resolve(null);
  }
  const key = ip;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return Promise.resolve(hit.host);
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const names = await withTimeout(resolver(key), timeoutMs);
      const host = Array.isArray(names) && typeof names[0] === "string" && names[0] ? names[0] : null;
      cache.set(key, { host, at: Date.now() });
      return host;
    } catch {
      cache.set(key, { host: null, at: Date.now() });
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Clear caches — tests only. */
export function _resetClientHostCache() {
  cache.clear();
  inflight.clear();
}

async function defaultResolver(ip) {
  const dns = await import("node:dns");
  return dns.promises.reverse(ip);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`resolve timeout (${ms}ms)`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}
