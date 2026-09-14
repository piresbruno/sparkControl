/**
 * llmProxy (A2) — built-in reverse proxy in front of cluster LLM engines.
 *
 * Factory with DI for tests: createLlmProxy({ registry, secrets, settings,
 * traceStore, inflight }) returns an Express Router. Mounted at "/llm" BEFORE
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
 *  - Upstream errors recorded with status:null and answered 502. 600 s idle
 *    timeout between upstream bytes; no overall timeout.
 *  - A4: every request registers in the in-flight registry (visible via
 *    /api/llm/active, cancellable by id); a downstream (client) abort destroys
 *    the upstream socket; cancels record traces as `cancelled (<reason>)`;
 *    optional per-spark/port concurrency cap answers 429.
 *  - CORS off by default; optional exact-origin allowlist (echo origin +
 *    enumerated Allow-Headers/Methods; OPTIONS → 204 locally, allowlisted
 *    origins only). Never `*`.
 *  - Never handles WebSocket upgrades (upgrades bypass Express routing; the
 *    /agent-ws + /ws endpoints own their paths).
 */
import http from "http";
import crypto from "crypto";
import { Router } from "express";
import { isAllowedTargetHost } from "../validate.js";
import { llmProbeHost } from "../collectors/llmHost.js";
import { TRACE_MAX_REQ_BODY, TRACE_MAX_RES_BODY } from "../config.js";
import { createInflightRegistry } from "./inflightRegistry.js";
import { resolveHostname } from "./clientHost.js";

/** Idle timeout between upstream bytes (connect included). */
const IDLE_TIMEOUT_MS = 600_000;

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

/** Stable pseudo-client id: first 12 hex chars of sha256(ip + "\n" + UA). */
function _clientId(ip, ua) {
  return crypto
    .createHash("sha256")
    .update(`${ip ?? ""}\n${ua ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

/** Tool names from a chat-completions / messages request body (OpenAI
 * tools[].function.name or Anthropic tools[].name). */
function _toolNames(parsed) {
  const tools = parsed?.tools;
  if (!Array.isArray(tools)) return null;
  const names = [];
  for (const t of tools) {
    const n = t?.function?.name ?? t?.name;
    if (typeof n === "string" && n) names.push(n);
  }
  return names.length > 0 ? names : null;
}

/**
 * @param {{
 *   registry: { getSpark(id: string): object | null },
 *   secrets?: { getLlmKey(sparkId: string, port: number): string | null },
 *   settings: () => ({ traceCapture?: boolean, traceCaptureBodies?: boolean,
 *                      traceProxyAllowedOrigins?: string[],
 *                      proxyMaxInflightPerPort?: number }),
 *   traceStore: { record(entry: object): unknown },
 *   inflight?: ReturnType<typeof import("./inflightRegistry.js").createInflightRegistry>,
 * }} deps
 * @returns {Router}
 */
export function createLlmProxy({ registry, secrets, settings, traceStore, inflight = createInflightRegistry() }) {
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
    // Per-request body caps from live settings (A4); config consts are the
    // fallback for DI tests that pass a bare knobs object.
    const maxReqBody =
      Number.isFinite(cfg.traceMaxReqBody) && cfg.traceMaxReqBody > 0
        ? cfg.traceMaxReqBody
        : TRACE_MAX_REQ_BODY;
    const maxResBody =
      Number.isFinite(cfg.traceMaxResBody) && cfg.traceMaxResBody > 0
        ? cfg.traceMaxResBody
        : TRACE_MAX_RES_BODY;

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

    // ─── In-flight tracking (A4) ─────────────────────────
    const clientIp = req.ip || req.socket?.remoteAddress || null;
    const clientUa =
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, 256)
        : null;
    // Client hostname (PTR) — kicked off once per request; LLM requests are
    // long-lived so the lookup usually settles before the trace is recorded.
    const clientHostPromise = resolveHostname(clientIp);
    const clientHostCapped = () =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 1000);
        clientHostPromise.then(
          (v) => {
            clearTimeout(t);
            resolve(v);
          },
          () => {
            clearTimeout(t);
            resolve(null);
          }
        );
      });
    const clientId = _clientId(clientIp, clientUa);
    const inflightId = inflight.register({
      sparkId,
      port,
      path: upstreamPathOnly,
      method: req.method,
      startedAt: start,
      clientIp,
      clientUa,
      clientId,
    });
    // Concurrency cap per spark/port (0 disables). The count is
    // self-inclusive, so the check is strictly greater-than.
    const inflightCap = Number.isFinite(cfg.proxyMaxInflightPerPort)
      ? cfg.proxyMaxInflightPerPort
      : 0;
    if (inflightCap > 0 && inflight.list({ sparkId, port }).length > inflightCap) {
      inflight.unregister(inflightId);
      return res.status(429).json({ error: "in-flight cap exceeded", retryAfterMs: 2000 });
    }

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
    let reqTools = null;
    req.on("data", (chunk) => {
      if (reqBytes < maxReqBody) {
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
    inflight.attach(inflightId, upstreamReq);

    // Downstream-abort propagation (A4): a dropped client socket (tab close,
    // fetch cancel) destroys the upstream request so the engine stops
    // decoding. NB: on Node ≥15 `req` "close" fires when the request message
    // completes (not on socket drop) — `res` "close" is the abort signal, and
    // the `finished` guard skips the normal-completion case.
    res.on("close", () => {
      if (!finished && !res.writableEnded) {
        inflight.cancel(inflightId, "client disconnect");
      }
    });

    // Patch model/stream onto the live entry + extract requested tools once
    // the body is known.
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.concat(reqChunks).toString("utf8"));
      } catch {
        /* truncated or non-JSON body — leave as-is */
      }
      const e = inflight.get(inflightId);
      if (e && parsed && typeof parsed === "object") {
        if (typeof parsed.model === "string") e.model = parsed.model;
        e.stream = parsed.stream === true;
      }
      reqTools = _toolNames(parsed);
    });

    // Forward the raw body straight through (works for bodyless methods too).
    req.pipe(upstreamReq);

    function onResponse(upRes) {
      responseHeadersAt = Date.now();
      bumpIdle();
      const isSSE = /text\/event-stream/i.test(String(upRes.headers["content-type"] || ""));
      const liveEntry = inflight.get(inflightId);
      if (liveEntry) liveEntry.stream = isSSE;

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
      let usedTools = null; // name → count, aggregated from SSE events

      upRes.on("data", (chunk) => {
        bumpIdle();
        if (ttftMs == null) ttftMs = Date.now() - start;
        if (resBytes < maxResBody) {
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
          if (sseText.length > maxResBody) sseText = "";
        }
        if (liveEntry) {
          if (ttftMs != null && liveEntry.ttftMs == null) liveEntry.ttftMs = ttftMs;
          liveEntry.contentLen = contentLen;
          liveEntry.deltaCount = deltaCount;
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
          const toolCalls = choice?.delta?.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const n = tc?.function?.name;
              if (typeof n === "string" && n) {
                usedTools = usedTools || new Map();
                usedTools.set(n, (usedTools.get(n) || 0) + 1);
              }
            }
          }
          if (obj?.type === "content_block_start" && obj?.content_block?.type === "tool_use") {
            const n = obj.content_block.name;
            if (typeof n === "string" && n) {
              usedTools = usedTools || new Map();
              usedTools.set(n, (usedTools.get(n) || 0) + 1);
            }
          }
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
        inflight.unregister(inflightId);
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
        inflight.unregister(inflightId);
        try {
          res.end();
        } catch {
          /* socket gone */
        }
      });

      upRes.pipe(res);

      async function _record({ status, ttftMs: t, error }) {
        const cancelledBy = inflight.get(inflightId)?.cancelledBy ?? null;
        if (cancelledBy) error = `cancelled (${cancelledBy})`;
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
        let cachedTokens = null;
        if (lastUsage) {
          promptTokens = Number.isFinite(lastUsage.prompt_tokens) ? lastUsage.prompt_tokens : null;
          completionTokens = Number.isFinite(lastUsage.completion_tokens) ? lastUsage.completion_tokens : null;
          const oai = lastUsage.prompt_tokens_details?.cached_tokens;
          const ant = lastUsage.cache_read_input_tokens;
          if (Number.isFinite(oai)) cachedTokens = Math.round(oai);
          else if (Number.isFinite(ant)) cachedTokens = Math.round(ant);
        } else if (stream) {
          // Usage absent on a streamed completion → estimate from deltas.
          completionTokens = deltaCount > 0 ? deltaCount : contentLen > 0 ? 1 : 0;
          tokensEstimated = true;
        }

        const clientHost = await clientHostCapped();
        traceStore.record({
          ts: start,
          sparkId,
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
          clientIp,
          clientUa,
          clientId,
          clientHost,
          toolsReq: reqTools,
          toolsUsed: usedTools ? [...usedTools].map(([name, count]) => ({ name, count })) : null,
          cachedTokens,
          bodyTruncated: reqBytes >= maxReqBody || resBytes >= maxResBody,
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
      const cancelledBy = inflight.get(inflightId)?.cancelledBy ?? null;
      inflight.unregister(inflightId);
      const msg = cancelledBy
        ? `cancelled (${cancelledBy})`
        : err?.code
          ? `${err.code}: ${err.message}`
          : err?.message || "upstream request failed";
      if (!capture) {
        if (!res.headersSent) res.status(502).json({ error: msg });
        return;
      }
      // Recover model/stream from the request tee — cancelled/failed
      // requests should still be attributable in the Analysis views.
      let reqModel = null;
      let reqStream = false;
      try {
        const parsed = JSON.parse(Buffer.concat(reqChunks).toString("utf8"));
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.model === "string") reqModel = parsed.model;
          reqStream = parsed.stream === true;
        }
      } catch {
        /* truncated or non-JSON body */
      }
      const payload = {
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
        model: reqModel,
        stream: reqStream,
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
        clientIp,
        clientUa,
        clientId,
        toolsReq: reqTools,
        toolsUsed: null,
        cachedTokens: null,
        bodyTruncated: reqBytes >= maxReqBody,
      };
      // Error traces must not delay the 502 — attach the hostname async.
      void clientHostCapped().then((clientHost) => traceStore.record({ ...payload, clientHost }));
      if (!res.headersSent) res.status(502).json({ error: msg });
    }
  }
}
