/**
 * inflightRegistry (A4) — tracks live proxied LLM requests so the dashboard
 * can list them and cancel them by id while they are still generating.
 *
 * The registry is storage-agnostic: cancel() marks the entry with a reason
 * and destroys the upstream ClientRequest; the proxy's terminal paths own
 * trace recording and read `entry.cancelledBy` to turn the destroy-induced
 * socket error into a distinct `cancelled (<reason>)` trace marker.
 *
 * Factory + module singleton, matching the getTraceStore() style. Tests may
 * create isolated instances via createInflightRegistry().
 */
import { randomUUID } from "crypto";

export function createInflightRegistry() {
  /** id → entry; Map preserves insertion order, so list() is oldest-first. */
  const entries = new Map();

  /**
   * Register a proxied request before upstream dispatch.
   * @param {{ sparkId?: string, port?: number, path?: string, method?: string,
   *           model?: string | null, stream?: boolean | null, startedAt?: number,
   *           clientIp?: string | null, clientUa?: string | null,
   *           clientId?: string | null }} entry
   * @returns {string} inflight id
   */
  function register(entry = {}) {
    const id = randomUUID();
    entries.set(id, {
      id,
      sparkId: entry.sparkId ?? null,
      port: entry.port ?? null,
      path: entry.path ?? null,
      method: entry.method ?? null,
      model: entry.model ?? null,
      stream: entry.stream ?? null,
      startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : Date.now(),
      clientIp: entry.clientIp ?? null,
      clientUa: entry.clientUa ?? null,
      clientId: entry.clientId ?? null,
      // Live counters, patched by the proxy as response bytes arrive.
      deltaCount: 0,
      contentLen: 0,
      ttftMs: null,
      _upstreamReq: null,
      cancelledBy: null,
    });
    return id;
  }

  /** Attach the http.ClientRequest once created (cancel() destroys it). */
  function attach(id, upstreamReq) {
    const e = entries.get(id);
    if (e && !e._upstreamReq) e._upstreamReq = upstreamReq;
  }

  /** @returns {object | undefined} */
  function get(id) {
    return entries.get(id);
  }

  /**
   * Oldest-first snapshot; entries are live objects (counters mutate in place).
   * @param {{ sparkId?: string, port?: number, clientId?: string }} filter
   */
  function list(filter = {}) {
    const out = [];
    for (const e of entries.values()) {
      if (filter.sparkId != null && e.sparkId !== filter.sparkId) continue;
      if (filter.port != null && e.port !== filter.port) continue;
      if (filter.clientId != null && e.clientId !== filter.clientId) continue;
      out.push(e);
    }
    return out;
  }

  /** Drop a terminal entry (proxy terminal paths call this). */
  function unregister(id) {
    entries.delete(id);
  }

  /**
   * Mark the entry cancelled and destroy the upstream socket. The destroy
   * surfaces as an upstream error inside the proxy, which records the trace
   * with the `cancelled (<reason>)` marker and unregisters the entry.
   * @returns {boolean} false when the id is unknown or already terminal
   */
  function cancel(id, reason = "user") {
    const e = entries.get(id);
    if (!e || e.cancelledBy) return false;
    e.cancelledBy = reason;
    if (e._upstreamReq && !e._upstreamReq.destroyed) {
      e._upstreamReq.destroy(new Error(`cancelled by sparkControl (${reason})`));
    }
    return true;
  }

  /**
   * Cancel every entry matching the filter.
   * @returns {number} cancelled count
   */
  function cancelAll(filter = {}, reason = "stop-all") {
    let n = 0;
    for (const e of list(filter)) {
      if (cancel(e.id, reason)) n += 1;
    }
    return n;
  }

  return { register, attach, get, list, unregister, cancel, cancelAll };
}

/** Singleton for the dashboard process. */
let _singleton = null;

/** @returns {ReturnType<typeof createInflightRegistry>} */
export function getInflightRegistry() {
  if (!_singleton) _singleton = createInflightRegistry();
  return _singleton;
}

/** Forget the singleton (server shutdown / tests). */
export function closeInflightRegistry() {
  _singleton = null;
}
