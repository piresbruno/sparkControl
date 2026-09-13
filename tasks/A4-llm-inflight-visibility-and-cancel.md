# A4 — In-flight LLM request visibility & cancellation

Status: proposed · 2026-09-13 · Codename follows TraceStore (A1) / Analysis reverse proxy (A2) / bench traces (A3)

## 1. Background: the incident that motivates this

2026-09-13, ~11:30–11:46 UTC. GLM-5.3-Flash-EXL3 vLLM server (container `glm53-exl3-head` on dgx-1, TP-2 across two Sparks, `max_model_len` 700k, spec decoding on) was driven into saturation:

- Peak: 3 running + 4 waiting requests, GPU KV cache 74–88% full.
- Engine aggregate decode fell to 0.7–2.2 tok/s → ≤2.5 tok/s per request.
- Spec-decode acceptance collapsed (mean accepted length 4.0 → 2.4; per-position acceptance 0.000 beyond ~position 4) — drafted tokens mostly wasted.
- Since server boot: 453 requests, 47.9M prompt tokens (avg ≈106k prompt tokens/request).

Submitters found:

1. **sparkControl itself** (localhost) — the LLM proxy relaying dashboard UI traffic, plus bench/showcase features (`DecodeBench.js`, `PrefillBench.js`, `ShowcaseManager.js` all POST `/v1/chat/completions`). `ShowcaseManager` additionally forces full-length generation (`ignore_eos: true`, `min_tokens: session.maxTokens`, `stop: []`), i.e. every showcase stream runs to `maxTokens` no matter what.
2. **A direct LAN client** (`10.0.30.173`) POSTing to vLLM `:8081`, bypassing the proxy entirely.

The agent harness session that "started" the work was cancelled; nothing stopped, because the generations lived in the dashboard process and in vLLM. Recovery applied: `docker restart sparkControl` → running went 3→2 and the 4-request waiting queue emptied (all dashboard-owned). One streaming request was aborted by vLLM on client disconnect — **proving that closing the proxied socket cancels streaming server-side**. The direct LAN client kept submitting.

Constraints discovered during recovery:

- This vLLM build exposes **no abort/cancel REST route** (checked `/openapi.json`).
- The sparkControl container cannot kill sockets server-side (`ss -K` unavailable, no `CAP_NET_ADMIN`); the host has no passwordless sudo.
- The only in-place lever for proxied traffic is **closing the client-side upstream socket** from the dashboard process — which the proxy currently cannot do on demand.

## 2. Problem statement

1. **Proxy requests are invisible and unkillable while in flight.** `llmProxy.js` pipes browser → upstream and records a trace only after completion (`_record` on `upRes.end`/error). No in-flight map, no way to address a live request, and **no downstream-abort propagation** (a browser tab closing/cancelling leaves the upstream decoding to completion).
2. **No unified view of "what is currently generating against this Spark".** Bench jobs (`DecodeBenchManager.getActive`, `PrefillBenchManager.getActive`) and showcase sessions (`ShowcaseManager.sessions`) each track their own state; proxy traffic is nowhere. During the incident there was no single place to answer "who is loading this engine?".
3. **No global stop.** Stopping the load required restarting the whole dashboard container. Benches have `cancel(sparkId, id)`, showcase has `cancel(sparkId, sessionId, reason)` (plus auto-cancel on ~5s heartbeat timeout), but nothing aggregates them.
4. **No guardrails on proxied concurrency.** Benches/showcase mutually exclude via 409 checks; the proxy path has no cap, so a stray UI loop can saturate an engine unnoticed.

## 3. Goals

- G1: Every proxied LLM request is tracked in flight with enough metadata to identify it (spark, port, model, path, stream flag, started-at, streamed-token estimate) and **can be cancelled by id**.
- G2: Browser-side cancels propagate to the upstream socket (stop paying for dead requests).
- G3: One API returns the union of all active LLM work for a Spark (proxy + decode bench + prefill bench + showcase), and one endpoint stops it all ("big red button").
- G4: Cancels are recorded as first-class traces so the Analysis page shows *what was killed, when, by whom*.
- G5: Optional concurrency cap on proxied in-flight requests per spark/port (429 when exceeded).

## 4. Non-goals

- Adding an abort API to vLLM (that lives in the `GLM-5.3-Flash-EXL3-2x-DGX-Sparks` overlay repo; see §9).
- Controlling or even observing **direct clients that bypass the proxy** (e.g. `10.0.30.173`). Out of reach from the dashboard by design; documented limitation (§8).
- Authenticating the dashboard (separate concern; the server already warns it is unauthenticated on `0.0.0.0`).
- Cancelling requests on engines that are not OpenAI-chat-shaped (Comfy has its own cancel path already: `comfyCancelJob`).

## 5. Design

### 5.1 In-flight registry — new `server/proxy/inflightRegistry.js`

Small module, singleton accessor matching `getTraceStore()` style:

```js
// createInflightRegistry() → {
//   register(entry) → id        // entry: { sparkId, port, path, method, model, stream, startedAt }
//   get(id) → entry | undefined
//   list(sparkId?) → [entry]    // oldest-first; entry includes live counters (see 5.2)
//   cancel(id, reason) → bool   // destroys upstream socket, records trace
//   cancelAll(sparkId?, reason) → number
//   unregister(id) → void
// }
```

- Key: `randomUUID()` generated per proxied request.
- The entry holds a reference to the live `upstreamReq` (http.ClientRequest) so `cancel()` = `upstreamReq.destroy(new Error("cancelled by sparkControl"))`. This is the same mechanism the existing idle timeout uses (llmProxy.js:156–158) — no new shutdown semantics.
- DI-friendly: `createLlmProxy({ registry, secrets, settings, traceStore, inflight })` gains an optional `inflight` dependency for tests; `index.js` wires the singleton.

### 5.2 llmProxy.js changes

In `handler()` (llmProxy.js:69):

1. After target validation, `const inflightId = inflight.register({ sparkId, port, path: upstreamPathOnly, method: req.method, model: null, stream: null, startedAt: start })`. Model/stream are patched when the request body tee / response headers reveal them (body chunks already accumulate at llmProxy.js:133–140; SSE detection at :173).
2. Live counters: expose `deltaCount`/`contentLen` (already computed for SSE, :186–234) and `ttftMs` on the registry entry so the UI can show progress without a new scrape path. Update in-place on each `data` event.
3. **Downstream-abort propagation**: `req.on("close", () => { if (!finished) inflight.cancel(inflightId, "client disconnect") })`. This closes the upstream socket → vLLM aborts the streaming generation (incident-proven). NB: `req` "close" fires on normal end too; guard with `finished` (already maintained at :152, :241, :255, :364).
4. On terminal paths (`upRes.end` → `_record`, `upRes.on("error")`, `finishError`), always `inflight.unregister(inflightId)` — including via a `finally`-equivalent so no leak on early throws.
5. Cancelled requests are recorded as traces with a distinct marker: extend `_record` with `cancelledBy: null | "client disconnect" | "user" | "stop-all"` (reuse the existing `error` column semantics for storage: `error: "cancelled (user)"` — **no schema migration**). The `upRes.on("error")` path already catches the destroy-induced stream error (:248) and records it; add the marker before destroying.
6. G5 guardrail: after registration, if `inflight.list(sparkId, port).length > settings().proxyMaxInflightPerPort` (new settings knob, default `8`, `0` = unlimited) → `res.status(429).json({ error: "in-flight cap exceeded", retryAfterMs })` + unregister + destroy. Cap counts only proxy traffic.

### 5.3 Unified active-load API — new routes in `server/index.js`

Follow the existing `/api/...` conventions (cf. `/api/traces`, `/api/jobs/:id/cancel`):

- **`GET /api/llm/active?sparkId=`** → `{ items: [...] }` — union, each item:
  `{ source: "proxy" | "decode-bench" | "prefill-bench" | "showcase", id, sparkId, port, model, startedAt, elapsedMs, progress: { tokensSoFar?, estimate? }, cancelable: true }`
  - proxy: from the inflight registry.
  - decode-bench / prefill-bench: `decodeBenchManager.getActive(sparkId)` / `prefillBenchManager.getActive(sparkId)` (already exist; both expose `progress`).
  - showcase: add `ShowcaseManager.listActive(sparkId)` — the `sessions` Map already holds everything needed (status `running`, per-stream `tokens`, live rates).
- **`DELETE /api/llm/inflight/:id`** → cancels one proxied request (registry.cancel). 404 if gone.
- **`POST /api/llm/stop-all`** body `{ sparkId?, reason? }` → calls, for the spark (or all sparks if omitted): `showcaseManager.cancel(...)` for each running session, `decodeBenchManager.cancel(...)` / `prefillBenchManager.cancel(...)` for running jobs, `inflightRegistry.cancelAll(sparkId, "stop-all")`. Returns per-source counts `{ showcase: n, decodeBench: n, prefillBench: n, proxy: n }`. This is the button that would have ended the incident in one click.
- Route placement: AFTER `express.json()` (these are JSON admin routes; the raw-body tee only applies to the `/llm` passthrough, which stays mounted before it — index.js:266–273). No collision with the `/llm/:sparkId/:port/*` passthrough since admin routes live under `/api`.

### 5.4 UI — Analysis page "Live" panel

- New panel on the existing Analysis page (same surface as traces): polls `GET /api/llm/active` every 2s while visible; rows = source badge (proxy / decode / prefill / showcase), spark, model, path (proxy), elapsed, streamed-token estimate, **Cancel** button per row; header **Stop all** (confirm dialog; sends `POST /api/llm/active`-scoped stop-all with the current spark filter).
- Cancelled traces become visible in the existing trace list automatically (they carry `error: "cancelled (…)"`) — no new storage.
- Optional (cheap): a header badge "N generating" driven by the same poll so saturation is visible from any page.

### 5.5 Showcase-specific note

Showcase already auto-cancels when its UI heartbeat stops (~5s), so a closed tab ends a showcase. It does **not** protect against the incident pattern (tab left open) and its forced `ignore_eos`/`min_tokens` body remains correct for benchmarking — no change there; the fix is visibility + stop-all, not changing bench semantics.

## 6. Behavior notes & hard limits (document in UI tooltip)

1. **Streaming requests**: cancel closes the upstream socket → vLLM aborts generation server-side. Incident-verified.
2. **Non-streaming requests**: cancel closes the socket and discards the output, but vLLM has no abort API — the engine **keeps decoding to completion**. The trace will show `cancelled` even though the engine stayed busy until natural completion. Long non-streaming generations are the worst case; prefer streaming clients.
3. **Direct clients** bypassing the proxy are invisible and unkillable from sparkControl. The only levers are engine-side (restart) or network-side (firewall on the spark, out of scope).
4. Cancels do not queue "undo": a destroyed request is gone; the client sees a broken stream/502.

## 7. Testing plan (repo conventions: `node:test` + DI + fake upstream servers)

- `proxy/__tests__/inflightRegistry.test.js` (new): register/list/cancel/cancelAll lifecycle; unregister-on-terminal; cancel of unknown id → false.
- `proxy/__tests__/llmProxy.test.js` additions (extend the existing fake-upstream harness):
  - slow SSE upstream → `GET` entry visible in list with model/stream patched → `DELETE` → upstream server observes socket close, trace recorded with `error: "cancelled (user)"`, subsequent GET → 404, entry unregistered.
  - downstream (client) abort mid-SSE → upstream socket destroyed, trace `cancelled (client disconnect)`.
  - non-streaming POST cancel → client gets error/empty response, upstream still completes (assert fake upstream saw full body consumed) — pins documented behavior §6.2.
  - 429 cap: set knob low, exceed, assert 429 and that the extra upstream request never opens.
- `server/__tests__/serverBoot.test.js` (or new `llmActive.test.js`): `/api/llm/active` unions fake manager actives + registry; `/api/llm/stop-all` calls each manager's cancel (DI the managers or stub via module singletons the way `benchManagers.integration.test.js` does with child processes for the real ones).
- UI (vitest, Analysis page): Live panel renders rows from a mocked `/api/llm/active`, Cancel calls DELETE, Stop-all calls POST with the active spark filter.

## 8. Security note

`/api/llm/stop-all`, `DELETE /api/llm/inflight/:id`, and the cap knob are mutations on an **unauthenticated, LAN-exposed dashboard** that can already SSH into and power off Sparks (server logs warn about this). This spec does not add auth (non-goal §4) — same posture as the existing `/api/jobs/:id/cancel` and comfy cancel. If auth lands later, these routes join the protected set automatically.

## 9. Cross-project follow-up (out of scope here)

- **vLLM overlay repo** (`GLM-5.3-Flash-EXL3-2x-DGX-Sparks`): add an abort/cancel endpoint to the patched API server (request-id based). Once it exists, sparkControl's cancel path can upgrade from "destroy socket" (lossy for non-streaming) to a true engine abort for this engine class — feature-detect via the existing `/server_info`-style probe and fall back cleanly.
- Consider a "block direct LLM clients" switch later (iptables via the existing SSH job machinery) if direct-traffic incidents recur.

## 10. Files touched

| File | Change |
|---|---|
| `server/proxy/inflightRegistry.js` | **new** — registry (5.1) |
| `server/proxy/llmProxy.js` | register/unregister, live counters, downstream-close propagation, cancelledBy markers, 429 cap (5.2) |
| `server/index.js` | `GET /api/llm/active`, `DELETE /api/llm/inflight/:id`, `POST /api/llm/stop-all`, wire registry singleton (5.3) |
| `server/collectors/ShowcaseManager.js` | `listActive(sparkId)` read-only accessor (5.3) |
| `server/settings.js` | `proxyMaxInflightPerPort` knob (default 8, 0 = off) (5.2) |
| `src/components/AnalysisPage/*` | Live panel + cancel/stop-all wiring (5.4) |
| tests listed in §7 | new/extended |

No DB schema changes (cancel markers reuse the trace `error` field), no new dependencies.
