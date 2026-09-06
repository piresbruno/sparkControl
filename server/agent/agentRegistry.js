/**
 * agentRegistry (C3) — Map sparkId → live agent connection.
 *
 *  - isConnected(sparkId) / send(sparkId, msg) / request(sparkId, msg, timeoutMs)
 *  - request() pairs a `resp {reqId, ok, payload|error}` reply via a Map of
 *    pending resolvers (10 s default timeout)
 *  - connection/disconnection events → SparkMonitor transport switch
 *
 * The agent authenticates on the FIRST message (hello) before anything else is
 * accepted; invalid handshake → close 4001 (bad token) / 4002 (unknown spark) /
 * 4003 (proto mismatch).
 */
import crypto from "crypto";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class AgentRegistry {
  constructor() {
    /** @type {Map<string, {ws: import("ws").WebSocket, agentVersion: string, connectedAt: number}>} */
    this.connections = new Map();
    /** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout}>} reqId → pending */
    this._pending = new Map();
    /** @type {Set<(sparkId: string) => void>} */
    this._connectListeners = new Set();
    /** @type {Set<(sparkId: string) => void>} */
    this._disconnectListeners = new Set();
  }

  onConnect(fn) {
    this._connectListeners.add(fn);
    return () => this._connectListeners.delete(fn);
  }

  onDisconnect(fn) {
    this._disconnectListeners.add(fn);
    return () => this._disconnectListeners.delete(fn);
  }

  isConnected(sparkId) {
    const conn = this.connections.get(sparkId);
    return Boolean(conn && conn.ws.readyState === 1);
  }

  agentVersion(sparkId) {
    return this.connections.get(sparkId)?.agentVersion || null;
  }

  send(sparkId, msg) {
    const conn = this.connections.get(sparkId);
    if (!conn || conn.ws.readyState !== 1) return false;
    conn.ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Send and await the matching resp (by reqId).
   * @returns {Promise<{ok: boolean, payload?: unknown, error?: string}>}
   */
  request(sparkId, msg, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const reqId = `req-${crypto.randomBytes(6).toString("hex")}`;
    const wire = { ...msg, reqId };
    if (!this.send(sparkId, wire)) {
      return Promise.resolve({ ok: false, error: "agent not connected" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqId);
        resolve({ ok: false, error: `agent request timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      this._pending.set(reqId, { resolve, timer });
    });
  }

  /** Deliver a resp frame to a pending request (called by the WS endpoint). */
  _resolvePending(reqId, msg) {
    const pending = this._pending.get(reqId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this._pending.delete(reqId);
    pending.resolve(msg);
    return true;
  }

  /**
   * Validate + register a freshly connected socket.
   * @returns {number|null} close code on rejection (4001/4002/4003), null on success
   */
  register(ws, { sparkId, token, proto, agentVersion }, expectedToken, expectedSparkIds) {
    if (token !== expectedToken) return 4001;
    if (!expectedSparkIds.has(sparkId)) return 4002;
    if (proto !== 1) return 4003;
    // One connection per spark: a new hello replaces a zombie connection.
    const existing = this.connections.get(sparkId);
    if (existing) {
      try {
        existing.ws.close(4000, "replaced by new connection");
      } catch {
        /* ignore */
      }
    }
    this.connections.set(sparkId, { ws, agentVersion: agentVersion || "unknown", connectedAt: Date.now() });
    for (const fn of this._connectListeners) {
      try {
        fn(sparkId, agentVersion);
      } catch {
        /* listener errors never break the registry */
      }
    }
    return null;
  }

  /** Drop a connection (socket close) and emit the disconnect event. */
  unregister(ws) {
    for (const [sparkId, conn] of this.connections.entries()) {
      if (conn.ws === ws) {
        this.connections.delete(sparkId);
        for (const fn of this._disconnectListeners) {
          try {
            fn(sparkId);
          } catch {
            /* ignore */
          }
        }
        return sparkId;
      }
    }
    return null;
  }
}

/** Dashboard singleton. */
let _registry = null;

export function getAgentRegistry() {
  if (!_registry) _registry = new AgentRegistry();
  return _registry;
}
