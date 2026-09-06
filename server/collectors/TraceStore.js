/**
 * TraceStore (A1) — SQLite-backed store for Analysis trace entries.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) — zero new deps.
 * DB file: config/traces.sqlite (config volume → survives restarts).
 * Tests: pass ":memory:" (or a temp path) to the constructor.
 *
 * Schema: `traces` with `seq INTEGER PRIMARY KEY AUTOINCREMENT` driving
 * `?since=` polling (monotonic across restarts and after clear()). Indexes on
 * ts, (sparkId, port), source. WAL journal mode. Retention: 1 week — purged
 */
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import { TRACE_MAX_REQ_BODY, TRACE_MAX_RES_BODY, TRACES_DB_PATH } from "../config.js";

export const TRACE_MAX_REQ = TRACE_MAX_REQ_BODY;
export const TRACE_MAX_RES = TRACE_MAX_RES_BODY;

/** One week in ms — retention horizon. */
export const TRACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_DB_PATH = TRACES_DB_PATH;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  ts INTEGER NOT NULL,
  sparkId TEXT,
  port INTEGER,
  source TEXT,
  method TEXT,
  path TEXT,
  query TEXT,
  model TEXT,
  stream INTEGER,
  status INTEGER,
  ttftMs INTEGER,
  durMs INTEGER,
  promptTokens INTEGER,
  completionTokens INTEGER,
  tokensEstimated INTEGER,
  finishReason TEXT,
  error TEXT,
  reqBody TEXT,
  resText TEXT
);
CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts);
CREATE INDEX IF NOT EXISTS idx_traces_spark_port ON traces(sparkId, port);
CREATE INDEX IF NOT EXISTS idx_traces_source ON traces(source);
`;

/** Columns returned by list() — lean (no bodies). */
const LEAN_COLS =
  "seq, id, ts, sparkId, port, source, method, path, query, model, stream, status, ttftMs, durMs, promptTokens, completionTokens, tokensEstimated, finishReason, error";
/** All columns including bodies — get()/record internals. */
const FULL_COLS = `${LEAN_COLS}, reqBody, resText`;

/** String cap helper — returns null for null/undefined, else UTF-8-byte-capped text. */
function capText(value, maxBytes) {
  if (value == null) return null;
  const s = String(value);
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let cut = buf.subarray(0, maxBytes);
  // Trim to a clean UTF-8 boundary: drop trailing partial multi-byte sequences.
  while (cut.length > 0) {
    try {
      return cut.toString("utf8");
    } catch {
      cut = cut.subarray(0, cut.length - 1);
    }
  }
  return "";
}

export class TraceStore {
  /** @param {{dbPath?: string}} [opts] */
  constructor(opts = {}) {
    this._dbPath = opts.dbPath || DEFAULT_DB_PATH;
    try {
      fs.mkdirSync(path.dirname(this._dbPath), { recursive: true });
    } catch {
      /* exists */
    }
    this._db = new DatabaseSync(this._dbPath);
    this._init();
    this._retentionTimer = null;
  }
  /** Delete entries older than the retention horizon. @returns {number} removed rows */
  _purge() {
    const cutoff = Date.now() - TRACE_RETENTION_MS;
    try {
      return this._db.prepare("DELETE FROM traces WHERE ts < ?").run(cutoff).changes;
    } catch (err) {
      console.error(`[traceStore] purge failed (${this._dbPath}):`, err.message);
      return 0;
    }
  }

  _init() {
    try {
      this._db.exec("PRAGMA journal_mode=WAL");
      this._db.exec(SCHEMA);
      this._purge();
    } catch (err) {
      // Unwritable store (e.g. root-owned config/ in a dev checkout): run
      // read-degraded rather than crash the server. record() failures are
      // swallowed the same way.
      console.error(`[traceStore] init degraded (${this._dbPath}):`, err.message);
    }
  }
  /** Hourly retention sweep. Safe to call once; stop() clears it. */
  startRetentionTimer() {
    if (this._retentionTimer) return;
    this._retentionTimer = setInterval(() => {
      try {
        this._purge();
      } catch (err) {
        console.error("[traceStore] retention purge failed:", err.message);
      }
    }, 60 * 60 * 1000);
    this._retentionTimer.unref?.();
  }

  stop() {
    if (this._retentionTimer) {
      clearInterval(this._retentionTimer);
      this._retentionTimer = null;
    }
    try {
      this._db.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * Insert one trace entry. Fields not provided stay NULL. Bodies are capped
   * to TRACE_MAX_REQ_BODY / TRACE_MAX_RES_BODY (UTF-8 bytes).
   * @param {Partial<{
   *   id: string, ts: number, sparkId: string, port: number, source: string,
   *   method: string, path: string, query: string, model: string,
   *   stream: boolean, status: number|null, ttftMs: number|null,
   *   durMs: number|null, promptTokens: number|null, completionTokens: number|null,
   *   tokensEstimated: boolean, finishReason: string|null, error: string|null,
   *   reqBody: string|null, resText: string|null,
   * }>} entry
   * @returns {{seq: number}} inserted row seq
   */
  record(entry) {
    const e = entry || {};
    const id = e.id || crypto.randomUUID();
    try {
      const res = this._db
        .prepare(
          `INSERT INTO traces
            (id, ts, sparkId, port, source, method, path, query, model, stream, status,
             ttftMs, durMs, promptTokens, completionTokens, tokensEstimated, finishReason,
             error, reqBody, resText)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          Number.isFinite(e.ts) ? Math.round(e.ts) : Date.now(),
          e.sparkId ?? null,
          Number.isFinite(e.port) ? Math.round(e.port) : null,
          e.source ?? null,
          e.method ?? null,
          e.path ?? null,
          e.query ?? null,
          e.model ?? null,
          e.stream ? 1 : 0,
          Number.isFinite(e.status) ? e.status : null,
          Number.isFinite(e.ttftMs) ? Math.round(e.ttftMs) : null,
          Number.isFinite(e.durMs) ? Math.round(e.durMs) : null,
          Number.isFinite(e.promptTokens) ? Math.round(e.promptTokens) : null,
          Number.isFinite(e.completionTokens) ? Math.round(e.completionTokens) : null,
          e.tokensEstimated ? 1 : 0,
          e.finishReason ?? null,
          e.error != null ? capText(e.error, 1024) : null,
          e.reqBody != null ? capText(e.reqBody, TRACE_MAX_REQ) : null,
          e.resText != null ? capText(e.resText, TRACE_MAX_RES) : null
        );
      return { seq: Number(res.lastInsertRowid) };
    } catch (err) {
      console.error("[traceStore] record failed:", err.message);
      return { seq: 0 };
    }
  }

  /**
   * List lean entries (no bodies). Filters combine with AND.
   * @param {{sparkId?: string, port?: number, source?: string, method?: string,
   *          since?: number, limit?: number}} [opts]
   * @returns {{traces: Array<object>, lastSeq: number}}
   */
  list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.sparkId != null && opts.sparkId !== "") {
      where.push("sparkId = ?");
      params.push(opts.sparkId);
    }
    if (Number.isFinite(opts.port)) {
      where.push("port = ?");
      params.push(Math.round(opts.port));
    }
    if (opts.source != null && opts.source !== "" && opts.source !== "all") {
      where.push("source = ?");
      params.push(opts.source);
    }
    if (opts.method != null && opts.method !== "") {
      where.push("method = ?");
      params.push(String(opts.method).toUpperCase());
    }
    if (Number.isFinite(opts.since)) {
      where.push("seq > ?");
      params.push(Math.round(opts.since));
    }
    const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? Math.round(opts.limit) : 200, 1), 1000);
    const sql = `SELECT ${LEAN_COLS} FROM traces${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY seq DESC LIMIT ${limit}`;
    const rows = this._db.prepare(sql).all(...params);
    // lastSeq = max seq currently stored (not just of this page) so live
    // followers never re-read rows already seen.
    const max = this._db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM traces").get();
    return { traces: rows.map(_rowToEntry), lastSeq: max?.m ?? 0 };
  }

  /** Full entry (with bodies) by id, or null. */
  get(id) {
    if (typeof id !== "string" || !id) return null;
    const row = this._db.prepare(`SELECT ${FULL_COLS} FROM traces WHERE id = ?`).get(id);
    return row ? _rowToEntry(row) : null;
  }

  /** Current max seq (for `?since=` bootstrapping). */
  maxSeq() {
    const max = this._db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM traces").get();
    return max?.m ?? 0;
  }

  /** Delete all rows. @returns {number} removed rows */
  clear() {
    return this._db.prepare("DELETE FROM traces").run().changes;
  }
}

/** Convert an integer row into the API entry shape (booleans restored). */
function _rowToEntry(row) {
  const out = { ...row };
  out.stream = Boolean(row.stream);
  out.tokensEstimated = Boolean(row.tokensEstimated);
  return out;
}

/** Singleton for the dashboard process. */
let _singleton = null;

/** @returns {TraceStore} */
export function getTraceStore() {
  if (!_singleton) _singleton = new TraceStore();
  return _singleton;
}

/** Close + forget the singleton (server shutdown / tests). */
export function closeTraceStore() {
  if (_singleton) {
    _singleton.stop();
    _singleton = null;
  }
}

