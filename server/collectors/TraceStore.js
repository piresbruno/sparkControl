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
import { getSettings } from "../settings.js";

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
  resText TEXT,
  clientIp TEXT,
  clientUa TEXT,
  clientId TEXT,
  toolsReq TEXT,
  toolsUsed TEXT,
  cachedTokens INTEGER,
  bodyTruncated INTEGER
);
CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts);
CREATE INDEX IF NOT EXISTS idx_traces_spark_port ON traces(sparkId, port);
CREATE INDEX IF NOT EXISTS idx_traces_source ON traces(source);
`;

/** Columns returned by list() — lean (no bodies). */
const LEAN_COLS =
  "seq, id, ts, sparkId, port, source, method, path, query, model, stream, status, ttftMs, durMs, promptTokens, completionTokens, tokensEstimated, finishReason, error, clientIp, clientUa, clientId, toolsReq, toolsUsed, cachedTokens, bodyTruncated";
/** All columns including bodies — get()/record internals. */
const FULL_COLS = `${LEAN_COLS}, reqBody, resText`;

/**
 * rev-2 columns (A4): existing DBs get these via _migrate(); fresh DBs get
 * them from SCHEMA directly.
 */
const REV2_COLUMNS = [
  { name: "clientIp", ddl: "TEXT" },
  { name: "clientUa", ddl: "TEXT" },
  { name: "clientId", ddl: "TEXT" },
  { name: "toolsReq", ddl: "TEXT" },
  { name: "toolsUsed", ddl: "TEXT" },
  { name: "cachedTokens", ddl: "INTEGER" },
  { name: "bodyTruncated", ddl: "INTEGER" },
];

/** Row bounds shared by list()/stats()/search (inline literals before A4). */
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_ROWS = 1000;

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
  /**
   * @param {{dbPath?: string, maxReqBody?: number, maxResBody?: number,
   *          retentionDays?: number}} [opts] — numeric overrides (tests);
   *          when absent, the traceMaxReqBody / traceMaxResBody /
   *          traceRetentionDays settings knobs apply live.
   */
  constructor(opts = {}) {
    this._dbPath = opts.dbPath || DEFAULT_DB_PATH;
    this._maxReqOverride = Number.isFinite(opts.maxReqBody) ? opts.maxReqBody : null;
    this._maxResOverride = Number.isFinite(opts.maxResBody) ? opts.maxResBody : null;
    this._retentionDaysOverride = Number.isFinite(opts.retentionDays) ? opts.retentionDays : null;
    try {
      fs.mkdirSync(path.dirname(this._dbPath), { recursive: true });
    } catch {
      /* exists */
    }
    this._db = new DatabaseSync(this._dbPath);
    this._init();
    this._retentionTimer = null;
  }
  _maxReqBytes() {
    if (this._maxReqOverride != null) return this._maxReqOverride;
    const v = Number(getSettings().traceMaxReqBody);
    return Number.isFinite(v) && v > 0 ? v : TRACE_MAX_REQ;
  }
  _maxResBytes() {
    if (this._maxResOverride != null) return this._maxResOverride;
    const v = Number(getSettings().traceMaxResBody);
    return Number.isFinite(v) && v > 0 ? v : TRACE_MAX_RES;
  }
  _retentionMs() {
    if (this._retentionDaysOverride != null) return this._retentionDaysOverride * 86_400_000;
    const v = Number(getSettings().traceRetentionDays);
    return Number.isFinite(v) && v > 0 ? v * 86_400_000 : TRACE_RETENTION_MS;
  }
  /** Delete entries older than the retention horizon. @returns {number} removed rows */
  _purge() {
    const cutoff = Date.now() - this._retentionMs();
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
      this._migrate();
      this._purge();
    } catch (err) {
      // Unwritable store (e.g. root-owned config/ in a dev checkout): run
      // read-degraded rather than crash the server. record() failures are
      // swallowed the same way.
      console.error(`[traceStore] init degraded (${this._dbPath}):`, err.message);
    }
  }

  /**
   * rev-2 migration: existing DBs get the client/tool/cache columns in
   * place; fresh DBs already have them from SCHEMA, so every ALTER is a
   * no-op there. A failed ALTER re-throws into the degraded-mode catch —
   * intentionally loud, because a half-migrated table makes every
   * subsequent record() INSERT fail silently.
   */
  _migrate() {
    const have = new Set(
      this._db.prepare("PRAGMA table_info(traces)").all().map((c) => c.name)
    );
    for (const { name, ddl } of REV2_COLUMNS) {
      if (have.has(name)) continue;
      try {
        this._db.exec(`ALTER TABLE traces ADD COLUMN ${name} ${ddl}`);
      } catch (err) {
        console.error(`[traceStore] migration failed adding ${name}:`, err.message);
        throw err;
      }
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
   * to the traceMaxReqBody / traceMaxResBody settings knobs (UTF-8 bytes;
   * constructor overrides win). toolsReq/toolsUsed arrays are JSON-encoded.
   * @param {Partial<{
   *   id: string, ts: number, sparkId: string, port: number, source: string,
   *   method: string, path: string, query: string, model: string,
   *   stream: boolean, status: number|null, ttftMs: number|null,
   *   durMs: number|null, promptTokens: number|null, completionTokens: number|null,
   *   tokensEstimated: boolean, finishReason: string|null, error: string|null,
   *   reqBody: string|null, resText: string|null,
   *   clientIp: string|null, clientUa: string|null, clientId: string|null,
   *   toolsReq: string[]|null, toolsUsed: Array<{name: string, count: number}>|null,
   *   cachedTokens: number|null, bodyTruncated: boolean,
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
             error, reqBody, resText, clientIp, clientUa, clientId, toolsReq, toolsUsed,
             cachedTokens, bodyTruncated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          e.reqBody != null ? capText(e.reqBody, this._maxReqBytes()) : null,
          e.resText != null ? capText(e.resText, this._maxResBytes()) : null,
          e.clientIp != null ? capText(e.clientIp, 256) : null,
          e.clientUa != null ? capText(e.clientUa, 256) : null,
          e.clientId ?? null,
          Array.isArray(e.toolsReq) && e.toolsReq.length > 0 ? JSON.stringify(e.toolsReq) : null,
          Array.isArray(e.toolsUsed) && e.toolsUsed.length > 0 ? JSON.stringify(e.toolsUsed) : null,
          Number.isFinite(e.cachedTokens) ? Math.round(e.cachedTokens) : null,
          e.bodyTruncated ? 1 : 0
        );
      return { seq: Number(res.lastInsertRowid) };
    } catch (err) {
      console.error("[traceStore] record failed:", err.message);
      return { seq: 0 };
    }
  }

  /**
   * List lean entries (no bodies). Filters combine with AND. `q` is a
   * server-side LIKE over the stored bodies (escaping %/_/\); bodies stay
   * unselected — SQL filters on non-selected columns fine.
   * @param {{sparkId?: string, port?: number, source?: string, method?: string,
   *          clientId?: string, since?: number, q?: string, limit?: number}} [opts]
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
    if (opts.clientId != null && opts.clientId !== "") {
      where.push("clientId = ?");
      params.push(opts.clientId);
    }
    if (Number.isFinite(opts.since)) {
      where.push("seq > ?");
      params.push(Math.round(opts.since));
    }
    if (opts.q != null && String(opts.q).length > 0) {
      const like = `%${String(opts.q).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
      where.push("(reqBody LIKE ? ESCAPE '\\' OR resText LIKE ? ESCAPE '\\')");
      params.push(like, like);
    }
    const limit = Math.min(
      Math.max(Number.isFinite(opts.limit) ? Math.round(opts.limit) : DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_ROWS
    );
    const sql = `SELECT ${LEAN_COLS} FROM traces${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY seq DESC LIMIT ${limit}`;
    const rows = this._db.prepare(sql).all(...params);
    // lastSeq = max seq currently stored (not just of this page) so live
    // followers never re-read rows already seen.
    const max = this._db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM traces").get();
    return { traces: rows.map(_rowToEntry), lastSeq: max?.m ?? 0 };
  }

  /**
   * Aggregated stats (A4). since/until are epoch-ms bounds on ts (unlike the
   * seq-based `since` in list()). byTool aggregates toolsUsed JSON in JS over
   * the filtered rows, bounded by MAX_LIST_ROWS.
   * @param {{sparkId?: string, since?: number, until?: number}} [opts]
   * @returns {{totals: object, byClient: Array, byModel: Array, byPath: Array,
   *            byTool: Array, byHour: Array}}
   */
  stats(opts = {}) {
    const where = [];
    const params = [];
    if (opts.sparkId != null && opts.sparkId !== "") {
      where.push("sparkId = ?");
      params.push(opts.sparkId);
    }
    if (Number.isFinite(opts.since)) {
      where.push("ts >= ?");
      params.push(Math.round(opts.since));
    }
    if (Number.isFinite(opts.until)) {
      where.push("ts <= ?");
      params.push(Math.round(opts.until));
    }
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

    const AGG = `COUNT(*) AS requests,
      COALESCE(SUM(promptTokens), 0) AS promptTokens,
      COALESCE(SUM(completionTokens), 0) AS completionTokens,
      COALESCE(SUM(cachedTokens), 0) AS cachedTokens,
      COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
      AVG(ttftMs) AS avgTtftMs,
      AVG(durMs) AS avgDurMs`;
    const round = (v) => (v != null ? Math.round(v) : null);

    const group = (key) =>
      this._db
        .prepare(`SELECT ${key} AS key, ${AGG} FROM traces${whereSql} GROUP BY ${key} ORDER BY requests DESC`)
        .all(...params)
        .filter((r) => r.key != null)
        .map((r) => ({ ...r, avgTtftMs: round(r.avgTtftMs), avgDurMs: round(r.avgDurMs) }));

    const totalsRow = this._db.prepare(`SELECT ${AGG} FROM traces${whereSql}`).get(...params) || {};

    // byTool: parse toolsUsed JSON in JS over the bounded filtered window.
    const toolRows = this._db
      .prepare(
        `SELECT toolsUsed FROM traces${whereSql}${whereSql ? " AND" : " WHERE"} toolsUsed IS NOT NULL ORDER BY seq DESC LIMIT ${MAX_LIST_ROWS}`
      )
      .all(...params);
    const toolAgg = new Map(); // name → { requests, count }
    for (const r of toolRows) {
      let arr = null;
      try {
        arr = JSON.parse(r.toolsUsed);
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        if (!t || typeof t.name !== "string") continue;
        const cur = toolAgg.get(t.name) || { requests: 0, count: 0 };
        cur.requests += 1;
        cur.count += Number.isFinite(t.count) ? t.count : 1;
        toolAgg.set(t.name, cur);
      }
    }

    return {
      totals: {
        requests: totalsRow.requests || 0,
        promptTokens: totalsRow.promptTokens || 0,
        completionTokens: totalsRow.completionTokens || 0,
        cachedTokens: totalsRow.cachedTokens || 0,
        errors: totalsRow.errors || 0,
        avgTtftMs: round(totalsRow.avgTtftMs),
        avgDurMs: round(totalsRow.avgDurMs),
      },
      byClient: group("clientId"),
      byModel: group("model"),
      byPath: group("path"),
      byTool: [...toolAgg.entries()]
        .map(([key, v]) => ({ key, requests: v.requests, count: v.count }))
        .sort((a, b) => b.requests - a.requests),
      byHour: this._db
        .prepare(`SELECT (ts / 3600000) AS key, ${AGG} FROM traces${whereSql} GROUP BY key ORDER BY key ASC`)
        .all(...params)
        .map((r) => ({ ...r, avgTtftMs: round(r.avgTtftMs), avgDurMs: round(r.avgDurMs) })),
    };
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
  out.bodyTruncated = Boolean(row.bodyTruncated);
  for (const key of ["toolsReq", "toolsUsed"]) {
    if (typeof out[key] === "string" && out[key].length > 0) {
      try {
        out[key] = JSON.parse(out[key]);
      } catch {
        out[key] = null;
      }
    }
  }
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

