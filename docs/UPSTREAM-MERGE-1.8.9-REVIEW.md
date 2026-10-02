# sparkControl ← sparkDash 1.8.9 — Changes Review

**Scope of this document:** exactly the delta introduced by merge commit `be67442`
(`git diff ab3886d..be67442`, where `ab3886d` = pre-merge fork `main`). Nothing else.

**Numbers:** 134 files, +11,993 / −1,053 — 65 added, 68 modified, 1 renamed
(`server/energy/__tests__/FleetEnergyTracker.test.js` → `server/sparks/__tests__/fleet-energy.test.js`).
No fork files were deleted by the merge (the 7 legacy node panels were already gone before it).

Sources of truth: the diff itself, plus `docs/REMOTE-ACCESS.md`, `docs/PROGRAM.md` (now tracked).

---

## 1. New UI

### 1.1 Overview page (`src/components/OverviewPage/`)

| Change | Component / file | What the user sees |
|---|---|---|
| **Fleet LLM Token Totals card** | `FleetTokenTotals.tsx` (new) | Cumulative prompt / cached / prefill / generated tokens per model across the fleet, with a time-range picker (All time, Today, Last 7/14 days, Last month). Off by default. |
| **Overview search + status filter** | `OverviewPage.tsx` (`showOverviewSearch`) | Text filter on spark name plus `online/offline` status filter; a `hiddenWorkerCount` hint appears when workers are filtered out by `hideWorkers`. |
| **hideWorkers filtering** | `OverviewPage.tsx` + `useSnapshot.ts` | Worker-role sparks drop off Overview cards and the tab bar; an open worker tab stays. |
| **Fleet Energy card upgrade** | `FleetEnergyCard.tsx` | Adds coverage-window labels (`coverage24hWindowMs` / `coverage31dWindowMs`), per-node **Last 24h by node** kWh rows (bar scaled to largest node), error + loading states. Gated by `showFleetEnergy`. |
| **Backend labels** | `src/shared/llmBackends.js` | Cards/panels label engines consistently: vLLM, llama.cpp, sgLang, ds4, EXL3, **q27**, **TensorFold**. |

### 1.2 Node console (`src/components/SparkPage/console/`)

The fork's four-channel console absorbed the upstream panel work (the legacy
`GpuPanel/LlmPanel/RamPanel/StoragePanel/NetworkPanel/TailscalePanel/SparkHeader`
were deleted before the merge and stay deleted):

| Channel | Change | Source |
|---|---|---|
| **CH·01 Resources** (`ScResources.tsx`) | **Per-GPU breakdown** — when a host has >1 NVIDIA card: one `GpuDeviceRow` per card (index, short name, throttle chip, usage/temp trends, draw/limit, VRAM) from `gpu.gpus[]`. Single-GPU units unchanged (aggregate view). | `SystemCollector.multiGpu.test.js` |
| | **NVRM OOM row** — `NV_ERR_NO_MEMORY` count since boot (kernel journal scan, 60 s cache), shown only when > 0. *(Ported from closed upstream PR `feat/nv-err-no-memory` during resolution.)* | `SystemCollector.nvErr.test.js` |
| **CH·02 Serving** (`ScServing.tsx`) | **`LlmTrendChart`** — 14-day decode tok/s trend for the selected port. | new |
| | **`LlmTokenTotals`** — same token-totals widget as Overview but scoped to this node+port. | new |
| | Backend-aware labels (TensorFold/q27) and "busy but silent" clocks (`busySinceAt` / `lastOutputAt`) in the activity readout. | `LlmProbe.js` |
| **CH·03 Tests** (`ScTests.tsx`) | **Share-image split button** — `BenchCopyButton`: label copies the text summary; caret offers *Copy as text / Copy as image*. Image = 1200×675 dark-palette card (brand, unit, model, engine + exposure badges, per-level rows). Honors `benchShareImage` setting; falls back to PNG download where the clipboard can't take images. | `benchShareCard.ts`, `shareImage.ts` |
| | **Remote bench** — a **Remote** button opens host + port (+ TLS) fields (persisted); nothing is probed until a bench runs against it. Loopback-only remote engines are reached through an **SSH local forward** held for the job. | `llmTunnel.js` |
| | Custom prefill size input (256–300k, plus presets) via the shared `PrefillBenchDialog`. | `PrefillBench.js` |

### 1.3 Dialogs & settings

* **BenchmarkDialog / PrefillBenchDialog** — both use `BenchCopyButton` (share card).
* **AddSparkDialog** — local onboarding ("**This host**" needs no LAN IP/SSH) and the new
  capability-matrix test result (`ConnectivityResult`): per-service **pass / fail / skipped**
  with recovery hints; every *enabled* capability must pass to save.
* **SettingsDialog** — six new toggles:
  `hideWorkers`, `showOverviewSearch`, `showFleetEnergy`, `showFleetExceptions`,
  `showLlmTokenTotals`, `benchShareImage` (default **on**).

### 1.4 Formatting helpers (new shared)

`src/shared/formatBytes.ts` and `formatDuration.ts` — byte rates roll over at 1024
(`1023.95 KiB/s` → `1.0 MB/s`, never `1024.0`), durations roll over at 60
(`119.5 s` → `2m 0s`, never `1m 60s`). Used by panels, dialogs and the share card.

### 1.5 Test infrastructure (new)

`src/testing/{fixtures,render,setup}.tsx` — shared render/cleanup harness
(`IS_REACT_ACT_ENVIRONMENT`, body reset, density attribute cleanup); wired through
`vitest.config.ts` (`setupFiles`, `restoreMocks`, `clearMocks`).

---

## 2. New functionality (backend)

### 2.1 LLM token ledger (`server/llmtokens/`)

* Durable per-model ledger of **prompt / cached / generated** tokens in per-UTC-day
  buckets (35-day retention), persisted to `config/llm-token-totals.json`
  (gitignored, `LLM_TOKEN_JSON_PATH` overridable), written atomically.
* **API:** `GET /api/llm-token-totals?range=all|today|7d|14d|month`
  (`server/llmtokens/LlmTokenRuntime.js`).
* Probes expose lifetime counters: `totalPromptTokens`, `totalCachedTokens`,
  `totalOutputTokens`, plus `lastOutputAt` / `busySinceAt` ("engine busy, no rate yet").
* Cache-split sources per backend: vLLM `vllm:prefix_cache_hits_total`, SGLang
  `total_cached_tokens` / `sglang:cached_tokens_total{cache_source="device"}`,
  llama.cpp `n_prompt_tokens_cache`, TensorFold `/health`, ds4/q27 computed+cached counters.
* Live-rate robustness: SGLang reads `realtime_tokens_total` (finish-only counters no
  longer latch a stale prefill rate); TensorFold + q27 generation tokens read from
  cumulative counters (`readServerGenerationTokens`).

### 2.2 Multi-GPU hosts (`server/collectors/SystemCollector.js`)

* `nvidia-smi --query-gpu=…,index,name,uuid` → per-card parse (`_parseGpuLines`),
  aggregate fold (`_aggregateGpuDevices`: hottest temp, busiest usage, summed power).
* **New payload:** `gpu.gpus[]` (`src/api/types.ts → GpuDevice`: `index, name, uuid,
  temperature, usage, power, vram, throttle, processes[]`).
* Compute-apps cache keyed **PID + GPU uuid** (a layer-split PID is summed across cards);
  per-card VRAM from `--query-gpu=memory.*`; GB10 (no memory numbers) inherits the aggregate.

### 2.3 New backends & probe fixes (`server/collectors/LlmProbe.js`)

* **TensorFold** — detected via `/v1/models` ownership; live tok/s from `/health`.
* **q27** — detected via ownership or `q27_*` Prometheus series.
* Bench/Showcase streaming uses a dedicated undici `Agent` (no 300 s headers/body idle
  cut) + `closeLlmStreamAgent()` on shutdown; CRLF split across SSE chunks is normalized;
  fetch errors map to short UI strings (`describeStreamFetchError`).
* Decode bench: 5 new code-bench concurrencies (3/5/10/12), work budget raised to **262k**
  tokens (`validateDecodeBudget`); prefill budget 600k → both enforce **HTTP 429**.

### 2.4 SSH layer (`server/collectors/ssh.js`, `llmTunnel.js`)

* **ControlMaster reuse** — one authenticated socket per spark+user+credential
  (salted sha256 socket under a 0700 `/tmp` dir), readiness probe before parallel
  pollers, invalidation on transport failure. Env: `SSH_CONTROL_PERSIST_SECONDS`
  (default 60, clamped 0–3600; legacy `SSH_CONTROL_PERSIST` still honored);
  `SSH_MULTIPLEX=0` disables (sshd `MaxSessions 1` hosts). ~217 logins/min → 1 socket.
* **`sshCommandSpec()`** — shared argv builder; `extraSshArgs` / `multiplex:false`
  (tunnels own their connection); `options.stdin` piping preserved (clock sudo).
* **`llmTunnel.js`** — resolves bench HTTP targets; loopback-only remote engines get an
  `ssh -N -L` local forward held for the job duration (`benchHttpTarget`).

### 2.5 Auth & hardening (`server/auth.js` — new, `startupPreflight.js` — new)

* Bearer-token auth from `SPARKDASH_TOKEN` (or `DASHBOARD_TOKEN`), timing-safe compare,
  also accepted as `?token=` query; **`app.use(createAuthMiddleware())`** on the HTTP API
  and `authorizeUpgrade` on the `/ws` upgrade (fork's manual noServer routing kept).
* **Fail-closed policy:** non-loopback bind without a token → mutations 403, WS refused,
  unless `SPARKDASH_ALLOW_OPEN_REMOTE=1` (open + warning; **this is the current
  deployment's mode**, see §6).
* `GET /api/health` now returns `authMode` (`loopback-open` / `bearer` /
  `required-missing`) plus the fork's secrets-key-readability warning.
* Boot preflight (`inspectStartupPreflight`) logs bind/auth/config-writability/secrets/
  SSH-identity/local-collector state; **fatal errors exit 1** (unwritable config dir).
* Registry durability (fork behavior) is now also enforced on the upstream side and
  covered by `SparkRegistry.durability.test.js`; `removeSpark` deletes both the stored
  password **and** per-port LLM API keys; out-of-band `llmPorts` renames migrate an
  orphaned key at load (`_reconcileLlmApiKeysAtLoad`).

### 2.6 Fleet energy (`server/energy/FleetEnergyTracker.js`)

* Snapshot adds `coverage24hWindowMs` (24 h) and `coverage31dWindowMs` (31 d) so clients
  don't assume window length, and per-node `nodeEnergy24hKwh` / `nodeEnergy31dKwh`
  (null without coverage / after membership change).
* Persisted to `config/fleet-energy.json` (atomic, 0600); runtime in
  `FleetEnergyRuntime.js` with per-domain freshness gating
  (`_metricCollectionSuccessful` per gpu/cpu from collector success tags).

### 2.7 Worker derived labels

`SparkMonitor` option `resolveHeadModelId` — worker cards show the head's **live model id**
(display-only, never written to config); falls back to the worker's own probe when the
head is unknown/offline (`worker-derived-label.test.js`).

### 2.8 Ops & deploy (new, tracked)

`scripts/{deploy,ensure-runtime,rollback,watchdog}.sh`, `deploy/*.plist` (macOS
launchd), `docs/PROGRAM.md`, `docs/REMOTE-ACCESS.md`,
`SPARKDASH-REMEDIATION-MERGE-SUMMARY-2026-09-07.md`.
Note: fork `.gitignore`'s `docs/` rule does **not** untrack these two upstream docs —
they are tracked; anything else under `docs/` stays ignored.

---

## 3. Settings & environment additions

**Settings (`PUT /api/settings`, clamped):** `hideWorkers`, `showFleetEnergy`,
`showFleetExceptions`, `showOverviewSearch`, `showLlmTokenTotals`, `benchShareImage`.

**Env:** `SPARKDASH_TOKEN` / `DASHBOARD_TOKEN` (bearer), `SPARKDASH_ALLOW_OPEN_REMOTE`
(default `1`), `SSH_CONTROL_PERSIST_SECONDS`, `LLM_TOKEN_JSON_PATH`,
`FLEET_ENERGY_JSON_PATH`, build-arg `VITE_HISTORY_HOURS` (frontend history retention).

**New state files (gitignored):** `config/llm-token-totals.json`,
`config/.fleet-energy.json.*.tmp`.

---

## 4. Changed responses / behaviors (integration notes)

| Surface | Before | After |
|---|---|---|
| Bench `POST …/llm/bench`, `…/prefill-bench` with empty body | validated later / 400 | **429** "exceeds the 262144/600000-token work budget" (quota unchanged: 20 starts/min, 3 s cooldown) |
| `POST /api/sparks(/:id)/test` | parallel `ssh/llm/comfy` booleans | **`capabilities[]`** (id/label/status pass-fail-skipped/recovery) + legacy `ssh/llm/comfy` fields kept; NAS-kind nodes skip LLM/Comfy as `skipped` |
| `GET /api/health` | fork diagnostics | + `authMode` |
| `metrics.gpu` | single aggregate only | aggregate **plus** `gpu.gpus[]` (shape of the aggregate unchanged) |
| SSE streams | Node global fetch (300 s idle cut) | undici `Agent` (no idle cut; caller `AbortSignal` still bounds) |
| Tokenless remote bind | not possible (fork bound loopback) | allowed only with `SPARKDASH_ALLOW_OPEN_REMOTE=1` (warning), otherwise fail-closed |

---

## 5. Verification matrix (UI → probe)

| To verify | Do |
|---|---|
| Token totals widgets | Settings → *Show LLM Token Totals* → Overview card; or any node → CH·02 (trend + totals). Raw: `curl localhost:5555/api/llm-token-totals?range=today` |
| Multi-GPU | A >1-card host → CH·01 per-card rows; `metrics.gpu.gpus[].length` |
| Share card | Any bench → Copy ▾ → *Copy as image* → paste into a local (not-HTTPS-remote) page → downloads PNG instead, with the menu saying so |
| Remote bench | CH·03 → *Remote* → `https://name.ts.net` + port → run Decode (SSH tunnel appears in `ss` on the sparkControl host for loopback-only engines) |
| Auth gate | With `SPARKDASH_TOKEN` set: `curl -X POST` without header → 401/403; WS → denied; browser: `localStorage.setItem("sparkdashToken", "<token>")` once |
| Rollover fixes | Any 1023.9 KiB/s rate → shows `1.0 MB/s`; any 119.5 s bench → `2m 0s` |
| Budget rejection | `curl -X POST …/llm/bench -d '{}'` → 429 |
| NVRM row | On a node with OOM lines in `journalctl -k` → CH·01 red `NV_ERR_NO_MEMORY` chip; hidden at 0 |
| Worker labels | Worker card on Overview shows head's live model id |
| Hide workers | Settings → *Hide worker nodes* → workers leave Overview + tab bar |

---

## 6. Deployment-relevant notes (this host)

* Current container runs **tokenless open remote** (`BIND_HOST=0.0.0.0`,
  `SPARKDASH_ALLOW_OPEN_REMOTE=1`): GET/WS/mutations all pass; preflight logs
  `auth=required-missing` + warning. To harden: set `SPARKDASH_TOKEN` in `.env`,
  `docker compose up -d`, and put the same token in the browser
  (`localStorage.setItem("sparkdashToken", …)`). Upstream's preferred path is SSH
  tunnel / authenticated reverse proxy / Tailscale Serve (`docs/REMOTE-ACCESS.md`).
* Two pre-existing, non-fatal log lines from the new load-time reconcile:
  `[SparkRegistry] spark qnap-nas LLM key/port mismatch: keyed=<> missing=<8888>`.
* The old `SPARKDASH_ALLOW_OPEN_REMOTE` compose default is what keeps the open bind
  running; setting a token makes the warning disappear without config changes.
