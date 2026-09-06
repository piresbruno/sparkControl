/**
 * llmProxy (A2) — built-in reverse proxy in front of cluster LLM engines.
 *
 * Factory with DI for tests: createLlmProxy({ registry, secrets, settings,
 * traceStore }) returns an Express Router. Mounted at "/llm" BEFORE
 * express.json() so the raw request body can be tee'd (capped accumulator)
 * while being piped straight through — the proxy never buffers the whole body.
 *
 * Behavior contract (plan A2):
 *  - 404 unknown sparkId; 400 non-integer/out-of-range port (1–65535);
 *    403 when the resolved target host is not allowed (isAllowedTargetHost).
 *  - Auth injection: client Authorization header always wins; else the stored
 *    per-port LLM key is injected as `Authorization: Bearer <key>`.
 *  - Forward via http.request: same method/path/query; hop-by-hop headers
 *    stripped; host set to the target.
 *  - Streaming (text/event-stream) and non-streaming pass through uncapped;
 *    stored resText is capped (TRACE_MAX_RES_BODY). ttftMs = first upstream
 *    byte (SSE) or time-to-response-headers (non-SSE). usage/finish_reason
 *    parsed; when usage is absent on a streamed completion, completionTokens
 *    = content-delta count with tokensEstimated=true (prompt never estimated).
 *  - Recording only when settings.traceCapture is on; successful GETs to
 *    probe-style paths (/health, /metrics, …) are never recorded.
 *  - Upstream errors recorded with status:null and answered 502. 300 s idle
 *    timeout between upstream bytes; no overall timeout.
 *  - CORS off by default; optional exact-origin allowlist (echo origin +
 *    enumerated Allow-Headers/Methods; OPTIONS → 204 locally, allowlisted
 *    origins only). Never `*`.
 *  - Never handles WebSocket upgrades (upgrades bypass Express routing; the
 *    /agent-ws + /ws endpoints own their paths).
 */
import http from "http";
import { Router } from "express";
import { isAllowedTargetHost } from "../validate.js";
import { llmProbeHost } from "../collectors/llmHost.js";
import { TRACE_MAX_REQ_BODY, TRACE_MAX_RES_BODY } from "../config.js";

/** Idle timeout between upstream bytes (connect included). */
const IDLE_TIMEOUT_MS = 300_000;

/** Probe-style paths whose successful GETs are not recorded. */
const PROBE_PATHS = new Set([
  "/health",
  "/metrics",
  "/slots",
  "/props",
  "/v1/models",
  "/server_info",
  "/get_server_info",
]);

/**
 * @param {{
 *   registry: { getSpark(id: string): object | null },
 *   secrets?: { getLlmKey(sparkId: string, port: number): string | null },
 *   settings: () => ({ traceCapture?: boolean, traceCaptureBodies?: boolean,
 *                      traceProxyAllowedOrigins?: string[] }),
 *   traceStore: { record(entry: object): unknown },
 * }} deps
 * @returns {Router}
 */
export function createLlmProxy({ registry, secrets, settings, traceStore }) {
  const router = Router();

  router.all("/:sparkId/:port/*splat", handler);
  router.all("/:sparkId/:port", handler);

  return router;

  async function handler(req, res) {
    const start = Date.now();
    const sparkId = req.params.sparkId;
    const spark = registry.getSpark(sparkId);
    if (!spark) {
      return res.status(404).json({ error: `Unknown spark: ${sparkId}` });
    }
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }
    const host = llmProbeHost(spark);
    if (!host) {
      return res.status(403).json({ error: "Spark has no reachable LLM host" });
    }
    if (!isAllowedTargetHost(host)) {
      return res.status(403).json({ error: `Target host not allowed: ${host}` });
    }

    const cfg = settings() || {};
    const capture = cfg.traceCapture !== false; // default true
    const captureBodies = cfg.traceCaptureBodies !== false; // default true

    // ─── CORS (default OFF; exact-origin allowlist only) ──
    const allowlist = Array.isArray(cfg.traceProxyAllowedOrigins)
      ? cfg.traceProxyAllowedOrigins
      : [];
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    const originAllowed = origin !== "" && allowlist.includes(origin);
    if (originAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS" && originAllowed) {
      return res.status(204).end();
    }

    // ─── Upstream request ─────────────────────────────────
    const prefix = `/${sparkId}/${port}`;
    const suffix = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url;
    const upstreamPath = suffix || "/";
    const qIdx = upstreamPath.indexOf("?");
    const upstreamPathOnly = qIdx >= 0 ? upstreamPath.slice(0, qIdx) : upstreamPath;
    const upstreamQuery = qIdx >= 0 ? upstreamPath.slice(qIdx + 1) : "";

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];
    delete headers["transfer-encoding"];
    if (!headers.authorization) {
      let apiKey = null;
      if (secrets?.getLlmKey) {
        apiKey = secrets.getLlmKey(sparkId, port);
      } else if (spark.llmApiKeys && typeof spark.llmApiKeys === "object") {
        apiKey = spark.llmApiKeys[String(port)] ?? spark.llmApiKeys[port] ?? null;
      }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    }
    headers.host = `${host}:${port}`;

    // Capped request-body tee (never buffers the whole body).
    const reqChunks = [];
    let reqBytes = 0;
    req.on("data", (chunk) => {
      if (reqBytes < TRACE_MAX_REQ_BODY) {
        reqChunks.push(chunk);
        reqBytes += chunk.length;
      }
    });

    let upstreamReq;
    try {
      upstreamReq = http.request(
        { host, port, method: req.method, path: upstreamPath, headers },
        (upRes) => onResponse(upRes)
      );
    } catch (err) {
      return finishError(err);
    }

    let finished = false;
    let responseHeadersAt = null;

    // Idle timeout — reset on every upstream byte; covers the connect phase.
    let idleTimer = setTimeout(() => {
      upstreamReq.destroy(new Error(`upstream idle timeout after ${IDLE_TIMEOUT_MS / 1000}s`));
    }, IDLE_TIMEOUT_MS);
    const bumpIdle = () => {
      if (idleTimer) {
        idleTimer.refresh();
      }
    };

    upstreamReq.on("error", (err) => finishError(err));

    // Forward the raw body straight through (works for bodyless methods too).
    req.pipe(upstreamReq);

    function onResponse(upRes) {
      responseHeadersAt = Date.now();
      bumpIdle();
      const isSSE = /text\/event-stream/i.test(String(upRes.headers["content-type"] || ""));

      // Pass upstream headers through, minus hop-by-hop fields Node manages.
      const outHeaders = { ...upRes.headers };
      delete outHeaders.connection;
      delete outHeaders["transfer-encoding"];
      res.writeHead(upRes.statusCode || 502, outHeaders);

      // Response tee: client gets chunks as they arrive (uncapped); the
      // stored copy is capped.
      const resChunks = [];
      let resBytes = 0;
      let ttftMs = null;
      // SSE accumulation state
      let sseText = "";
      let contentLen = 0; // UTF-8 bytes of concatenated delta.content
      let deltaCount = 0;
      let lastUsage = null;
      let finishReason = null;

      upRes.on("data", (chunk) => {
        bumpIdle();
        if (ttftMs == null) ttftMs = Date.now() - start;
        if (resBytes < TRACE_MAX_RES_BODY) {
          resChunks.push(chunk);
          resBytes += chunk.length;
        }
        if (isSSE) {
          sseText += chunk.toString("utf8");
          let idx;
          while ((idx = sseText.indexOf("\n\n")) >= 0) {
            const event = sseText.slice(0, idx);
            sseText = sseText.slice(idx + 2);
            _consumeSseEvent(event);
          }
          // Guard the parse buffer itself (a pathological engine without
          // blank lines must not grow unbounded).
          if (sseText.length > TRACE_MAX_RES_BODY) sseText = "";
        }
      });

      function _consumeSseEvent(event) {
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = obj?.choices?.[0];
          const deltaContent = choice?.delta?.content;
          if (typeof deltaContent === "string" && deltaContent.length > 0) {
            contentLen += Buffer.byteLength(deltaContent, "utf8");
            deltaCount += 1;
          }
          if (choice?.finish_reason != null) finishReason = choice.finish_reason;
          if (obj?.usage && typeof obj.usage === "object") lastUsage = obj.usage;
        }
      }

      upRes.on("end", () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        finished = true;
        _record({
          status: upRes.statusCode || 0,
          ttftMs: ttftMs ?? (responseHeadersAt ? responseHeadersAt - start : null),
        });
        res.end();
      });
      upRes.on("error", (err) => {
        // Response stream broke mid-flight (client reset, upstream reset).
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (!finished) {
          finished = true;
          _record({ status: upRes.statusCode || null, error: err.message });
        }
        try {
          res.end();
        } catch {
          /* socket gone */
        }
      });

      upRes.pipe(res);

      function _record({ status, ttftMs: t, error }) {
        if (!capture) return;
        // GET-noise exclusion: successful GETs to probe-style paths.
        if (!error && req.method === "GET" && (status || 0) < 400 && PROBE_PATHS.has(upstreamPathOnly)) {
          return;
        }
        const durMs = Date.now() - start;
        let reqText = null;
        let resText = null;
        let model = null;
        let stream = false;
        if (captureBodies) {
          reqText = Buffer.concat(reqChunks).toString("utf8");
          resText = Buffer.concat(resChunks).toString("utf8");
          try {
            const parsed = JSON.parse(reqText);
            if (parsed && typeof parsed === "object") {
              model = typeof parsed.model === "string" ? parsed.model : null;
              stream = parsed.stream === true;
            }
          } catch {
            /* non-JSON or truncated body — model/stream unknown */
          }
          if (!stream && !isSSE) {
            try {
              const parsed = JSON.parse(resText);
              if (!model && typeof parsed?.model === "string") model = parsed.model;
            } catch {
              /* non-JSON response */
            }
          }
        } else if (reqBytes > 0) {
          // Bodies off: still parse model/stream from the capped tee buffer.
          try {
            const parsed = JSON.parse(Buffer.concat(reqChunks).toString("utf8"));
            if (parsed && typeof parsed === "object") {
              model = typeof parsed.model === "string" ? parsed.model : null;
              stream = parsed.stream === true;
            }
          } catch {
            /* ignore */
          }
        }
        // Non-streaming: usage/model come from the JSON body itself.
        if (!isSSE && lastUsage == null && resText) {
          try {
            const parsed = JSON.parse(resText);
            if (parsed && typeof parsed === "object" && parsed.usage && typeof parsed.usage === "object") {
              lastUsage = parsed.usage;
            }
          } catch {
            /* non-JSON response — no usage */
          }
        }
        if (isSSE) stream = true;

        let promptTokens = null;
        let completionTokens = null;
        let tokensEstimated = false;
        if (lastUsage) {
          promptTokens = Number.isFinite(lastUsage.prompt_tokens) ? lastUsage.prompt_tokens : null;
          completionTokens = Number.isFinite(lastUsage.completion_tokens) ? lastUsage.completion_tokens : null;
        } else if (stream) {
          // Usage absent on a streamed completion → estimate from deltas.
          completionTokens = deltaCount > 0 ? deltaCount : contentLen > 0 ? 1 : 0;
          tokensEstimated = true;
        }

        traceStore.record({
          ts: start,
          sparkId,
          port,
          source: "proxy",
          method: req.method,
          path: upstreamPathOnly,
          query: upstreamQuery || null,
          model,
          stream,
          status: error ? null : status,
          ttftMs: t,
          durMs,
          promptTokens,
          completionTokens,
          tokensEstimated,
          finishReason,
          error: error || null,
          reqBody: captureBodies ? reqText : null,
          resText: captureBodies ? resText : null,
        });
      }
    }

    function finishError(err) {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (finished) return;
      finished = true;
      const msg = err?.code ? `${err.code}: ${err.message}` : err?.message || "upstream request failed";
      if (!capture) {
        if (!res.headersSent) res.status(502).json({ error: msg });
        return;
      }
      traceStore.record({
        ts: start,
        sparkId,
        port,
        source: "proxy",
        method: req.method,
        path: (() => {
          const q = upstreamPath.indexOf("?");
          return q >= 0 ? upstreamPath.slice(0, q) : upstreamPath;
        })(),
        query: upstreamQuery || null,
        model: null,
        stream: false,
        status: null,
        ttftMs: null,
        durMs: Date.now() - start,
        promptTokens: null,
        completionTokens: null,
        tokensEstimated: false,
        finishReason: null,
        error: msg,
        reqBody: null,
        resText: null,
      });
      if (!res.headersSent) res.status(502).json({ error: msg });
    }
  }
}
