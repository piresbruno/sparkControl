# A4 Implementation Plan — validated against code (rev 2 spec + 4 scout audits)

Companion to `tasks/A4-llm-inflight-visibility-and-cancel.md`. Every spec claim was verified
against the actual tree (llmProxy.js, TraceStore.js, index.js, settings.js, DecodeBench.js,
PrefillBench.js, ShowcaseManager.js, AnalysisPage, client.ts, types.ts, all test harnesses).
Verdict: **spec is implementable as written with the 16 corrections below** — no structural
changes needed, no new dependencies, all line anchors confirmed.

## 0. Spec corrections (apply while implementing)

| # | Spec says | Reality | Action |
|---|---|---|---|
| 1 | §5.7 label edits via `PATCH /api/settings` | Only `PUT /api/settings` exists (index.js:433-445); `updateSettings(patch)` already accepts partials (settings.js:187-192) | Use PUT; no server change needed for partial patch |
| 2 | §6.4 cancelled client "sees a broken stream/502" | 502 only when destroyed **before response headers** (finishError path llmProxy.js:165→:359, `!res.headersSent` guard :368/:395). Post-headers destroy → `res.end()` (:258-262) = clean truncated stream | UI tooltip + §6 copy: "502 before first byte; truncated stream after" |
| 3 | §5.2.5 cancel marker flows through `upRes.on("error")` | Destroy **before headers** lands in `upstreamReq.on("error")`→`finishError` (:165, :359-396), not the upRes error path (:248). Raw `err.message` (ECONNRESET) is recorded in both — cancelled and genuine resets are indistinguishable unless the marker is written first | Write `cancelledBy` state **before** `upstreamReq.destroy()`; both terminal paths consume it |
| 4 | §5.2.2 live counters "update in-place on each data event" | SSE counters live in the `data` handler closure (:193-212) and `_consumeSseEvent` (:214-234); `_record` only sees them at completion (:331) | Patch registry entry inside the `data` handler, not `_record` |
| 5 | §5.6 4 MiB bodies via TraceStore knobs alone | **Double truncation**: llmProxy stops accumulating at 32 KiB/64 KiB config consts (:136 req, :196 res, :210 SSE buffer) *before* `capText` ever runs (record-time :183-185) | Knobs must reach llmProxy **per request** (it imports plain consts at :35 at module load — must read `settings()` live in `handler()`) |
| 6 | §5.3 stop-all returns per-source counts | Bench `cancel()` returns `publicJob` even for non-running jobs (DecodeBench.js:769-770, PrefillBench.js:500-501 idempotent no-op); showcase cancel of non-running session returns session | Count only actual `status === "running"` transitions; `null` = unknown/wrong-spark |
| 7 | §5.3 showcase "sessions Map holds everything" | True for streams (tokenCount/liveTokPerSec/peakTokPerSec, ShowcaseManager.js:393-412, _updateLiveMetrics :590-613), but `getActive` returns only `{sessionId,status}` (:275-281) and there is **no all-sparks enumerator** | `listActive(sparkId?)` is genuinely required; with no arg, iterate `sessions` (Map) directly |
| 8 | §5.6 migration guarded by PRAGMA check | Fits, but `_init()`'s catch (:108-113) **degrades silently** — half-migrated DB ⇒ every `record()` INSERT (names 7 new cols, :159-166) throws and is swallowed at :188-191 → **all traces silently lost** | Migration failures get a distinct loud `console.error`; post-migration column assertion |
| 9 | §5.6 list() "mirroring existing since/until branches" | `list()` has **no `until`** branch (only sparkId/port/source/method/since, :203-221); clamp is inline literals 200/1000 (:223) | `stats()` since/until is net-new; extract `MAX_LIST_ROWS = 1000` / default 200 shared consts |
| 10 | §5.4 Summary "tab" + poll "while visible" | No page tabs exist (only modal-internal chips, AnalysisPage.tsx:296/331-341); no visibility-gated polling exists anywhere in src | Summary = chip-switcher like the modal pills; visibility gate = net-new `visibilitychange` listener (or follow existing always-on convention and drop "while visible") |
| 11 | §5.4/§5.7 reuse confirm dialog pattern | `ConfirmShutdownDialog` hardcodes typed phrase `"poweroff"` + hardware-poweroff copy (ConfirmShutdownDialog.tsx:7,105-121,237) | Generalize props (phrase optional, custom copy) or clone the modal-overlay/bench-sheet skeleton |
| 12 | §5.6 `TRACE_MAX_REQ`/`TRACE_MAX_RES` replaced | Blast radius: config.js:69/:71/:140-141 → llmProxy.js:35/:136/:196/:210 → TraceStore.js:18-19/:184-185; test imports TraceStore.test.js:6 (byte-cap asserts :54-61) | Keep both exports (settings-derived) so record-time caps and tests keep working; proxy-side reads live settings |
| 13 | §5.6 clientLabels in settings | No free-form-map precedent (`_mergeModelctl` :130-143 is known-keys; origins is a typed array :111-117); `getSettings()` clones only known objects (:174-179) | New `_clampSettings` branch (keys = 12-hex, values = strings, shallow-copy) **+ clone in getSettings()** or returned objects alias module state |
| 14 | — | llmProxy.js:23-24 header comment says "300 s idle timeout"; `IDLE_TIMEOUT_MS = 600_000` (:38) | Fix stale comment in passing |
| 15 | §5.3 route placement after express.json | Confirmed exact: proxy at index.js:266-271, `express.json()` :273; managers are ESM singletons already imported in index.js (:23-31) | No change — plan proceeds as spec'd |
| 16 | §7 fake-upstream harness | Real http.Server with mode switch + 30 ms delayed SSE (:31-40) — but **no socket-close instrumentation** and the test `fetch` helper buffers until end (:119-141, no abort handle) | Harness needs: `res.on("close", …)` with `res.writableEnded` check, raw `http.request` client handle, longer delays |

## 1. Phases

Order = dependency order; each phase ships with its tests (repo convention: `node:test` + DI
for server, vitest for UI). No new npm dependencies at any point.

### Phase 1 — In-flight registry + proxy cancel (spec §5.1/§5.2, G1/G2/G4/G5)

Files: `server/proxy/inflightRegistry.js` (new), `server/proxy/llmProxy.js`,
`server/settings.js`, `server/index.js`.

1. `inflightRegistry.js`: factory matching `getTraceStore()` singleton style
   (TraceStore.js:262-276 as template). `register/get/list/cancel/cancelAll/unregister`;
   entry holds the live `upstreamReq`; `cancel()` = destroy + marker handoff + trace (via a
   `recordCancel` callback injected by llmProxy — the registry stays storage-agnostic).
   `list(sparkId, port)` and `cancelAll({sparkId?, clientId?})` filters (clientId filter is
   Phase-4-facing, add the parameter now).
2. `createLlmProxy({ registry, secrets, settings, traceStore, inflight })` — `inflight`
   optional for DI tests (llmProxy.js:61).
3. In `handler()` (llmProxy.js:69):
   - register after target validation with `{ sparkId, port, path: upstreamPathOnly, method,
     model: null, stream: null, startedAt: start (:70), clientIp, clientUa, clientId }`
     (identity fields computed once, reused by Phase 3's trace record);
   - patch `model`/`stream` when the body tee (:133-140) / response headers (:173) reveal them;
   - live counters (`deltaCount`/`contentLen`/`ttftMs`) updated **inside the data handler**
     (:193-212) per correction #4;
   - `req.on("close")` → `if (!finished) inflight.cancel(id, "client disconnect")` —
     `finished` is maintained at :152/:241/:255/:364-365 (guard is `req` "close" firing on
     normal end too);
   - unregister on all three terminal paths (`_record` call sites :242/:256, `finishError`
     :359-396) plus a safety unregister in the cancel path itself;
   - cancelled-marker state written **before** `destroy()` (correction #3), consumed by both
     terminal paths → `error: "cancelled (user)" | "cancelled (client disconnect)"`.
4. 429 cap: after register, `inflight.list(sparkId, port).length > settings().proxyMaxInflightPerPort`
   → 429 `{ error, retryAfterMs }` + unregister. New knob in DEFAULTS (settings.js:16 area) +
   `_clampSettings` branch (min 0; 0 = unlimited) following the defaultLlmPort pattern (:92-95).
5. Fix stale 300 s comment (:23-24) per correction #14.
6. Wire singleton in index.js next to `const traceStore = getTraceStore()` (:264) and pass
   into `createLlmProxy` (:266-271); add `DELETE /api/llm/inflight/:id` (404 when gone —
   mirror the `/api/jobs/:id/cancel` 404-first convention, index.js:767-773).

Tests (`proxy/__tests__/`): registry lifecycle unit test; llmProxy additions per §7 with the
harness upgrades from correction #16 (close listener, abort-capable client, slow-SSE delay).
Pin §6.2 behavior: non-streaming cancel → client gets error/truncation, upstream completes.

### Phase 2 — Unified active-load API + stop-all (spec §5.3, G3)

Files: `server/collectors/ShowcaseManager.js`, `server/index.js`.

1. `ShowcaseManager.listActive(sparkId?)`: running sessions with per-stream
   `{ tokenCount, liveTokPerSec, peakTokPerSec }` from the existing session/stream shape
   (:393-412); no-arg = iterate the `sessions` Map (correction #7).
2. `GET /api/llm/active?sparkId=` → union: proxy (registry.list), decode/prefill
   (`getActive(sparkId)` returns publicJob with `progress` — DecodeBench.js:453-458,
   PrefillBench.js:232-236), showcase (`listActive`). Item shape per spec §5.3.
3. `POST /api/llm/stop-all` body `{ sparkId?, reason? }`: showcase cancels via
   `cancel(sparkId, sessionId, reason)` per running session; bench cancels via existing
   `cancel(sparkId, benchId)`; registry `cancelAll`. **Counting**: increment only when the
   returned job/session status was `"running"` before the call (correction #6). Response
   `{ showcase, decodeBench, prefillBench, proxy }`.
4. Route placement after `express.json()` (:273) — confirmed no `/llm` passthrough collision.
   Cancels don't interact with start-time 409 guards (index.js:1662-1667, manager-level
   DecodeBench.js:692-696) — no changes needed there.

Tests (`server/__tests__/llmActive.test.js`): union shape with fake managers; stop-all counts
only running→cancelled transitions (seed a finished job and assert it is *not* counted).

### Phase 3 — TraceStore rev 2: migration, knobs, tools/cache capture (spec §5.6 storage, G6)

Files: `server/collectors/TraceStore.js`, `server/proxy/llmProxy.js`, `server/settings.js`,
`server/config.js`.

1. Migration in `_init()` (:103-113) between `exec(SCHEMA)` (:106) and `_purge()` (:107),
   exactly per the validated recipe: module-level `REV2_COLUMNS`
   (`clientIp TEXT, clientUa TEXT, clientId TEXT, toolsReq TEXT, toolsUsed TEXT,
   cachedTokens INTEGER, bodyTruncated INTEGER`); `PRAGMA table_info(traces)` via
   `prepare().all()`; conditional `ALTER TABLE ADD COLUMN`; the same 7 columns added to
   `SCHEMA` (:26-53) as single source of truth for fresh DBs; **distinct loud error logging**
   on ALTER failure (correction #8).
2. Four edit sites per column (correction #8/StoreValidator): SCHEMA, REV2_COLUMNS,
   `record()` INSERT list + args (:159-186 — capText for TEXT, `JSON.stringify||null` for
   tools arrays, 0/1 for INTEGER), `LEAN_COLS` (:56-57 — at least clientId/toolsUsed/
   cachedTokens/bodyTruncated or the list route can't render them). JSDoc :141-156.
3. Knobs: `traceMaxReqBody`/`traceMaxResBody` (default 4 MiB, ceiling 16 MiB enforced as
   clamp-with-reset in `_clampSettings` — settings.js pattern :92-95; note UI must show the
   **effective** value from the PUT response since clamping silently resets), 
   `traceRetentionDays` (default 7; `_purge()` :94 derives from it; `TRACE_RETENTION_MS`
   export kept, derived — its only importers are TraceStore.js:94 and its test :6).
   `TRACE_MAX_REQ`/`TRACE_MAX_RES` exports kept (correction #12) but record-time caps now
   read the live setting.
4. **Proxy-side cap plumbing** (correction #5): llmProxy computes per-request
   `maxReqBody`/`maxResBody` from `settings()` inside `handler()` (NOT module load) and uses
   them at :136, :196, :210. Without this the 4 MiB defaults are dead letters.
5. Extraction in `_consumeSseEvent` (:214-234) + body tee (:133-140): `toolsReq` from request
   body (`tools[].function.name` OpenAI / `tools[].name` Anthropic), `toolsUsed` aggregated
   `{name,count}` from `choices[].delta.tool_calls[].function.name` and Anthropic
   `content_block_start` tool_use, `cachedTokens` from
   `usage.prompt_tokens_details.cached_tokens` / `usage.cache_read_input_tokens` (null when
   absent). `bodyTruncated` = either cap hit.
6. `clientId` = first 12 hex of `sha256(clientIp + "\n" + clientUa)`; captured in handler()
   and shared with the registry entry (Phase 1).

Tests: old-DB fixture via raw `DatabaseSync` + pre-rev-2 SCHEMA + seeded row → reopen →
columns exist + row intact (TraceStore.test.js:113-124 reopen template; import
`node:sqlite` in the test). Tools/usage extraction via the SSE harness. Cap-knob tests.

### Phase 4 — Stats, search, clients endpoints (spec §5.6 API/§5.7 server, G6/G7)

Files: `server/collectors/TraceStore.js`, `server/index.js`.

1. `stats({ since?, until?, sparkId? })`: SQL GROUP BY over clientId/model/path; byTool =
   JS-side JSON parse over bounded lean rows; hourly `(ts/3600000)` buckets. Shape
   `{ totals, byClient, byModel, byPath, byTool, byHour }`, each
   `{ key, requests, promptTokens, completionTokens, errors, avgTtftMs, avgDurMs }`.
   Extract shared `MAX_LIST_ROWS = 1000` / default 200 constants (correction #9). `until`
   is net-new (list() never had it).
2. `list()` gains `clientId` WHERE branch (clone of :211-214) and optional `q` (server-side
   `LIKE` over `reqBody`/`resText` with `ESCAPE '\'`, `%`/`_` escaped — SQL-level filter on a
   lean-column SELECT, which is valid since WHERE may reference unselected columns).
3. Routes: `GET /api/traces/stats`, `clientId`/`q` params on GET /api/traces (:449-465),
   `GET /api/llm/clients` (registry grouped by clientId + `dashboardClients:
   wss.clients.size`; wss is in scope, broadcast helper at :2412-2429),
   `DELETE /api/llm/clients/:clientId` (flush via registry `cancelAll({clientId})`, traces
   marked `cancelled (flush client)`).

Tests: stats aggregation/clamp; search escaping; clients grouping + flush isolation.

### Phase 5 — UI: Live & Clients, Summary, search, columns (spec §5.4/§5.6/§5.7)

Files: `src/components/AnalysisPage/*`, `src/api/client.ts`, `src/api/types.ts`,
`src/index.css`, optionally `App.tsx`.

1. client.ts: `getTraceStats()`, `listLlmClients()`, `flushLlmClient()`, `cancelInflight()`,
   `stopAllLlm()` following `apiFetch` (:40-55) + `listTraces` URLSearchParams pattern
   (:453-468); `listTraces` gains `clientId`/`q`. types.ts: `TraceEntry` + 7 nullable fields
   (types.ts:915-936 conventions), stats/clients/active response types.
2. Live & Clients panel in AnalysisPage (page root ~:220, beside `.bench-results--analysis`
   :239-283): poll `GET /api/llm/active` every 2 s — **single shared interval** with the
   existing `FOLLOW_POLL_MS = 1500` follow-poll (correction: two timers double request
   pressure during saturation). Visibility gate is net-new (`visibilitychange`) — or match
   house style (always-on) and document it. Rows: source badge / spark / model / path /
   elapsed / token estimate / Cancel; header Stop-all behind a **generalized confirm**
   (prop-driven ConfirmShutdownDialog without the "poweroff" phrase, correction #11);
   clients table with inline label edit → **PUT** /api/settings `clientLabels` (correction
   #1), per-request Cancel, per-client Flush; dashboard WS count as informational line.
3. Summary chip-tab (net-new UI, modal-pill pattern :296/:331-341): time-range picker →
   stats; cards row + 4 breakdown tables + hourly histogram; client-row click filters the
   trace table. Trace table: Client + Tools columns (`t.model ?? "—"` guard convention);
   detail modal gains toolsReq/toolsUsed/cachedTokens/bodyTruncated. Search input → `q`.
   §6 limits in a tooltip (with corrected 502 semantics, correction #2).
4. CSS: extend the A5 section of index.css (:2433-2487) — new grid-template-columns for the
   extra table columns; `.bench-status-pill--cancelled` already exists (:1294). Do NOT add a
   css file; route through client.ts, not the raw `fetch("/api/settings")` at :108.
5. Optional header badge: mount in App.tsx right cluster (:271-282) fed by a poll hook beside
   `useSnapshot()` (:112); degrade silently on error.

Tests: extend `vi.mock("../../api/client", …)` factory (**every** new fn must be added —
factory replaces the module, correction/UI risk), userEvent + `toHaveBeenLastCalledWith`
style (AnalysisPage.test.tsx:56-87).

### Phase 6 — Verification

1. `npm test` (node --test, server/**) + `npm run test:ui` (vitest) — full suite green.
2. Smoke: boot server (`node server/index.js`), curl a fake upstream through `/llm/:spark/:port`,
   observe `GET /api/llm/active` entry → `DELETE /api/llm/inflight/:id` → upstream socket
   closed → trace `error: "cancelled (user)"` → `POST /api/llm/stop-all` counts.
   Migration smoke: copy an old-format `config/traces.sqlite` aside, boot, confirm columns +
   intact rows.
3. CHANGELOG entry (repo keeps one) + remove any throwaway scripts.

## 2. Risks (ranked)

1. **Silent trace loss on failed migration** (correction #8) — mitigate with loud logging +
   post-migration assertion. Highest-blast-radius item.
2. **Double truncation** defeats full-fidelity goals if Phase 3.4 is skipped (correction #5).
3. **Cancelled vs reset indistinguishable** in traces without pre-destroy markers
   (correction #3).
4. Two poll timers on one page during saturation (Phase 5.2) — share one interval.
5. node:sqlite needs Node ≥22.13 unflagged; Docker floats node:22-bookworm-slim (fine), but
   package.json has no `engines` field — optional one-line `">=22.13.0"` addition.
6. `clientLabels` aliasing module state if `getSettings()` clone is forgotten (correction #13).
7. Direct LAN clients (e.g. 10.0.30.173) stay invisible until the §11.2 lockdown switch —
   documented limitation, unchanged.

## 3. P2 backlog (unchanged from spec §11)

Engine-pressure badge (LlmProbe.js internals unverified — read first), lockdown switch,
cost accounting, percentiles, anomaly alerts (must fit `broadcastPayload`'s string-payload
model, index.js:2412-2429), conversation grouping (add `convId` to the same migration if
wanted **before** Phase 3 lands — one-time window), export, spec-decode charts.
