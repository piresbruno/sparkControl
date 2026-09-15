# SERVE Plan — cluster-level Model Serving with Recipes

Status: proposal rev 4 (2026-09-15). Rev 3 scoped to **start/stop/restart/logs only — no recipe editing in
the UI; recipe folders (and `.env`) stay user-owned on nodes**. Rev 4 incorporates a two-axis adversarial
review (operational + architectural); both verdicts were "not implementable as written" — the 9 load-bearing
breaks are fixed below and marked **[R4]**. New tree evidence verified directly (remoteJobs.js:56,115-130,
342-358,388-396; SparkRegistry.js:86,203-226; recipe start.sh:1693-1711,1723-1734; config/sparks.json ports).

## 0. Problem

Serving today is **node-scoped control, cluster-scoped intent**:

- Launch/stop live on the node page (`ScServing.tsx:809-939`, CH·02); no cluster view of what is served
  where — only `FleetAlertStrip.tsx:12,29-30` "LLM unavailable", derived from WS metrics.
- The model store lives elsewhere (`/models` + `NasPage`); placement (`servingPlacement`, `Placement`,
  `listNodeModels`, `sync`/`push` job kinds) is implemented server-side with **zero UI callers**.
- Recipes as actually used (`~/developer/recipes`, MiaAI-Lab repos) are self-orchestrating git folders:
  `start.sh` dispatcher (`start|stop|restart|status|logs|download`), 131-knob `.env`, multinode
  **internally** (head ssh's worker `docker run -d --headless`, ships image, downloads + rsyncs 164 GiB),
  containers + `/health` as state, starts take minutes→hours (`READY_TIMEOUT=3600`, `start.sh:255`).
  Current supervision (upload one bash, pidfile `~/.sparkdash/runs`) fits none of that.

Structural defects (all evidence re-verified):

| # | Defect | Evidence |
|---|--------|----------|
| D1 | Two supervision stacks; dashboard never sends agent `serve` frames — ops tunnel as one-shot `job-run` shell; log-ring fast-path (`index.js:1385`) almost always misses | `index.js:1131-1149`; `agent/src/main.js:40-42,148-244,432-434` |
| D2 | `defaultServingSpark()` → the `kind:"nas"` node wins today | `index.js:1172-1180`; `config/sparks.json` |
| D3 | One-run-per-node baked everywhere; status scans "the one running script" N+1, discovery bypasses agent | `index.js:1170,1300-1304,1334-1355` |
| D4 | No server-side serve state: what runs where with what is unpersisted | serving.js:214 |
| D5 | Script library global, disk-only, seed no-ops in Docker (`Dockerfile:51-59`); node-local runs second-class (cap 32) | `index.js:1182-1184`; serving.js:94-116 |
| D6 | `setLlmApiKey` (`client.ts:366`) uncalled; `key on/off` chip read-only | UI map §8.11 |
| D7 | `sync` job uses global nasRoot; other paths per-node `nasRootFor(spark)` | `index.js:916-919` |
| D8 [R4] | Job-state persistence and cancel semantics assume short jobs: `MAX_PERSISTED_JOBS=30` global evict can drop a **running** job at persist; `cancelRemoteJob` marks `cancelled` even when the kill exec failed (10 s budget), and a driver that exits non-zero (e.g. container removed under it) records `failed`, never `cancelled/interrupted` | remoteJobs.js:56,115-130,342-358 |
| D9 [R4] | `removeSpark` cascades only sparks.json + secrets — derived stores (new serve-recipes/deployments) orphan on node delete; ids are user-supplied and reusable after delete | SparkRegistry.js:86,203-226 |

## 1. Design

### 1.1 Recipe = registered folder on a node (opaque engine)

No central content store, no editor. A **recipe record** points at a folder already on a node:

```
recipe  { id, sparkId, path(realpath, canonical), label?, entry? (default start.sh),
          variants? (auto-scan start*.sh, tp*/),
          meta: parsed read-only — PORT, container SET (§1.3), SERVED_MODEL_NAME, MODEL,
                HEAD_IP/WORKER_IP, NNODES/TP, READY_TIMEOUT, VLLM_API_KEY presence,
          version: git HEAD + dirty flags (Dockerfile/overlay), probe error list }
```

- Registration = pick node + absolute path (+ optional dir browse for `start.sh`). Probe runs ONE exec
  (agent/SSH): list entries, `git rev-parse HEAD`, `git status --porcelain -- Dockerfile overlay`
  **[R4]**, and parse `.env` (if present) ⊕ `.env.example` ⊕ **`VAR="${VAR:-default}"` lines scraped
  from each entry script** for the known key set **[R4 — .env alone is empty: CONTAINER_HEAD defaults live
  inside start.sh:297-298, tp4 uses 4 rank names (start-tp4.sh:306-309), Qwen-single uses CONTAINER_NAME]**.
  Read-only, never writes into the folder.
- **Identity [R4]**: unique on `(sparkId, canonical path)` — re-registering the same folder returns the
  existing record (no duplicate deployments on one folder). Node delete ⇒ `registry.on("remove")` marks
  referencing recipes/deployments **`orphaned`** (greyed, probe-skipped, GC button); re-add with same id ⇒
  rows silently re-point, first probe verifies (path + git HEAD) and flags `orphaned (identity changed?)`
  on mismatch.

### 1.2 Deployment = desired-run record; lifecycle = the recipe's own verbs

```
deployment { id, recipeId, variant?, desired: running|stopped,
             jobId + jobLogFile, startedWith: {version, dirtyFlags}, createdAt }
```

- **start / restart** = async job kind `recipe-run`: `cd <path> && ./<entry> [variant-entry] <verb>`.
- **Job-system integration [R4]** (rev 3 left this implicit; gate facts: `POST /api/jobs` 409s on ANY
  active job per node, index.js:941-943; MODEL_JOB_KINDS whitelist :735-740):
  - `recipe-run` is **exempt from `hasActiveJobForNode` in both directions** (its hours-long driver must
    not block modelctl jobs, and vice versa), with its own lock: **one active `recipe-run` per
    (sparkId, path)** — covers the duplicate-folder case. Cross-contention (recipe pull vs a modelctl
    sync on the same disk/network) is surfaced by the P3 preflight as a **warn + confirm**, not a lock.
  - Persistence: `MAX_PERSISTED_JOBS` evicts only terminal jobs — **running jobs pin their record**;
    `startedWith.jobFile = ~/.sparkcontrol/jobs/<id>.log` recorded on the deployment so the driver log
    survives eviction and dashboard restarts alike.
- **stop / cancel [R4]** — rev 3's "never SIGKILL the driver" created a late-launch race (start() is
  sequential: download → **launch_cluster** → wait_for_health, start.sh:1693-1711; a mid-download
  `./start.sh stop` finds no containers, returns "stopped", then the still-live driver launches both
  ranks minutes later) and a false-`failed` receipt (container removed under `wait_for_health` ⇒
  exit 1 ⇒ parsePollOutput = `failed`, remoteJobs.js:115-130). Corrected protocol:
  1. If a `recipe-run` driver is live: **SIGTERM driver first** (pidfile kill via adapted cancel command —
     TERM not KILL; a TERM'd driver cannot reach `launch_cluster`), then run `./start.sh stop`.
  2. `desired=stopped` is recorded BEFORE the kill; join rule: **desired=stopped ∧ live/terminal-failed
     job ⇒ `stopping`, never `failed`** (user intent beats job exit code); cleared when the probe shows
     containers absent.
  3. Stop with no live job: one-shot `./start.sh stop` (idempotent — `docker rm -f || log` per
     start.sh:1726-1734), budget raised (worker ssh hop can exceed the default 10 s; exec timeout
     parameterized from meta).
- **Status join (probe truth, no ownership)**:
  - `healthy` = WS `metrics.llm[PORT]` responds ∧ (served id == parsed `SERVED_MODEL_NAME` when known).
    **[R4] port coupling**: `metrics.llm` exists only for ports in `spark.llmPorts` (probes built per
    `_llmPorts()`, SparkMonitor.js:47-49; agent syncs from same list, main.js:352-356; live spark-1 =
    `[8081]`, GLM binds `8888`). Creating a deployment **registers meta.PORT into the head's llmPorts**
    (idempotent `POST /api/sparks/:id/llm-ports`, hot-reloads both transports' probes); removing the last
    deployment on a port offers port removal. Side benefit: hero bay, bench, proxy, traces all work on
    the port unchanged.
  - `starting` = live `recipe-run` job (elapsed + driver tail).
  - `stopped` = head containers absent (docker probe, §1.3) **∧ worker-rank container absent on its node
    [R4 — head-only probe missed the peer container]**.
  - `drift` = git HEAD moved OR Dockerfile/overlay dirty-flag changed since `startedWith` —
    chip distinguishes **`restart` vs `restart (image rebuild — recipe stamp, minutes)` [R4]**
    (start.sh:25,803-829 rebuilds once on stamp mismatch); plain `.env` edits intentionally show **no**
    chip (recipe-owner semantics; UI footnote).
  - `unknown` = node offline (never rendered as stopped).
  - Manual `ssh ./start.sh` start/restart ⇒ still correct: state comes from probes, containers are truth.
- **Placement advisory [R4]**: recipe start bypasses `/api/serving/start`'s 409+placement gate entirely
  (that gate only exists there and only with `modelName`, index.js:1226-1240) ⇒ a model already on the NAS
  would silently trigger a 164 GiB internet pull. Cheap pre-start check: parsed `MODEL` vs
  `modelctl.listNodeModels(head)` (best-effort, offline-tolerant) → advisory chip
  **"not on node — recipe will pull ~N GiB from HF"** + (P3) `sync NAS→node` / `push` one-clicks that
  set the recipe's own `SKIP_DOWNLOAD=1/SKIP_SYNC=1` **via the user editing `.env` or a one-shot
  `env`-prefix** (no `.env` mutation by the dashboard).

### 1.3 Logs and containers [R4 — container model fixed]

- **Container SET, not `CONTAINER_HEAD` from `.env`**: probe scrapes `CONTAINER_*` / `CONTAINER_NAME`
  `${VAR:-default}` lines from each variant entry → `{head: glm53-exl3-head, worker: glm53-exl3-worker}`
  (start.sh:297-298); tp4 ⇒ 4-rank set (start-tp4.sh:306-309); Qwen-single ⇒ `vllm-fn-tp1`. Each rank
  maps to a node: head-rank ⇒ deployment head; worker ranks ⇒ spark whose lanIp/cx7Ip matches
  `WORKER_IP`/peer IPs (registry match); **unmatched ⇒ rank probed via the head's own ssh hop exactly as
  the recipe does it** (start.sh status()), or skipped with `rank unmapped` note.
- Per-rank probe: `docker ps --format` + `docker inspect .State.Running` on the mapped node's transport
  (agent/SSH; isLocal head ⇒ `execOnLocalHost` nsenter path reaches host docker — verified, no
  docker.sock needed; caveat: non-root fallback user needs docker group).
- **Fallback when meta has no names** (process recipes — YAML-era, example scripts): recipe `status` verb
  output captured to a bounded field + probe-by-PORT; plan no longer forbids the verb — it is the
  degradation path, not the primary.
- **Driver log = the node file, read on demand** `tail -c <bytes> ~/.sparkcontrol/jobs/<id>.log`
  (same builder style as buildServeLogCommand); live view = that with a byte cursor. Rev 3's "job ring,
  kept after exit" was false: `agentDataRings` is 100 KB/30-min in-memory (index.js:256-281) and poll
  persists only a 4 KB tail (remoteJobs.js:127); node-side job logs prune at **7 days**
  (JOB_PRUNE_CMD :60-61) — UI shows both windows honestly.
- **Engine log** = `docker logs --tail N` / `--since <cursor>` per rank (never the blocking `logs` verb);
  5 s incremental tail, `trace-body__pre` + `tokenizeLogLine`.

### 1.4 Serve section (`/serve`)

No recipe editor, params editor, dry-run, file browser.

- **CH·01 DEPLOYMENTS** — recipe · variant/topology chip · head (+ peer ranks mapped) · port · served id ·
  state (`starting` elapsed / `healthy` / `stopping` / `stopped` / `drift` / `unknown`) · version ·
  placement-advisory chip · endpoint rows: DIRECT `http://<lanIp>:<PORT>/v1`, PROXY
  `/llm/<sparkId>/<port>/v1` (+ `/analysis?spark=&port=` traces link) · key chip **[R4]**: state =
  **probed enforcement** (`/v1/models` 401 test via node exec) + `.env` VLLM_API_KEY presence + dashboard
  proxy-injection key (`setLlmApiKey`, fixes D6) — three badges, mismatch warning; the dialog edits only
  the dashboard store (proxy injection); recipe auth remains `.env`'s business ·
  actions: `▶` / `⟳` / `■` (3 s arm) · row expand: driver tail + engine console (rank switch).
  Poll `GET /api/serve/state` (fan-out, 5 s).
- **CH·02 RECIPES** — registered folders: node · path · parsed meta (port/containers/served name/NNODES/
  READY_TIMEOUT) · git HEAD + dirty flags · variants · badges `running via <deployment>` / `idle` /
  `orphaned` · register flow (node + path + scan) · optional `clone on node…` (job).
- **[R4] Script-class scope decision (rev 3 Open Q4 resolved)**: `/serve` is **recipe-class only**;
  script-class (examples) keeps its existing node-page launch/stop panel untouched through P2 — removal
  would strand live runs (`ServingStatus`/`useServingLifecycle`/hero-bay stop are its only affordances;
  arch review P2 finding). Hygiene for script-class (D1 dual dirs, D3 multi-run) runs as a **parallel
  non-blocking track** (§3-P0b), including the honest status-contract migration: `/api/serving/status`
  gains a per-script list under `?all=1`, legacy single-run shape preserved (useServingLifecycle +
  ScServing hero = named migration sites). Deep-links `/spark/:id → /serve` both ways; unification of
  the two classes only revisited after P3.

- Node-page surgery (P2): CH·02 heroes gain a `Serve ▸` link for ports owned by a deployment (bay shows
  WS truth unchanged); nothing else removed.

## 2. Prior art

**sparkctl**: recipes as desired-state, drift manifest (generalized: HEAD + dirty flags), boot re-serve
(→ boot re-probe + explicit start, no silent auto-start). **llama-swap**: request-time swap — rejected
(long-lived recipe services; conflicts with benches/traces). **modelctl cluster plan**: defers node
agents/APIs/reconciliation = sparkControl's lane; boundary: modelctl = data plane, sparkControl = serving
control plane; their reservations/capacity feed P3. Recipe `MODEL` ids land in the HF cache — the same
cache `modelctl list --local` registers — which makes the §1.2 advisory cheap.

## 3. Phases

### Phase 0a — recipe critical path — S [R4 re-cut: P0 split; dir-unification no longer gates recipes]
1. `recipe-run` job kind: MODEL_JOB_KINDS entry, **per-(sparkId,path) serve lock, node-gate exemption
   both directions, running-persist pin, `env`-prefix passthrough, TERM-first cancel (§1.2)**.
2. `GET /api/serve/state` fan-out (per-node timeout, offline `unknown` rows, 2 s cache).
3. Dockerfile ships `serving/` (D5); `SPARKDASH_*` documented (`.env.example`).
   Acceptance: 30-min fake-`starting` job survives 100 synthetic job submits + a dashboard restart
   (pinned record, correct poll-resume); cancel of a live driver = TERM→stop-verb, row shows `stopping`.

### Phase 0b — script-class hygiene (parallel, non-blocking) — S
D1 dir unification `~/.sparkcontrol/runs` + **adoptLegacy scanning BOTH dirs with per-run runsDir records**
(so flipping builders never reports a live detached driver as stopped); D3 per-(node,port) multi-run with
`?all=1` status migration + legacy shape; D2 explicit-sparkId on new routes.
Acceptance: pre-upgrade `~/.sparkdash/runs/*.pid` live run still stops via UI after upgrade.

### Phase 1 — registration + lifecycle engine — M
1. `server/serving/recipes.js`: CRUD (`config/serve-recipes.json`, unique (sparkId,realpath), orphan
   events on registry "remove"), probe builder (§1.1 scrape rules), `.env`/`.env.example`/script parser,
   variants, git HEAD + dirty flags.
2. Routes: `GET/POST/DELETE /api/serve/recipes[/scan|:id]` (probe-on-read, TTL cache).
3. Deployments store (`config/serve-deployments.json`) + engine: start/restart (§1.2 job path), stop
   (§1.2 TERM-first), join (WS ∪ job ∪ docker-probe per rank), **llmPorts auto-register/unregister
   offer**, placement advisory, version drift, boot re-probe (state only; auto-start OFF default).
4. Logs: driver-file tail builder + docker-logs-per-rank builder (cursor `--since`).
   Acceptance (live cluster): register GLM → probe lists PORT=8888, container set {head,worker}, served
   id, TP=2, HEAD; `▶` auto-adds 8888 to spark-1 llmPorts, job tail streams preflight→pull→rsync→warmup;
   after load: `healthy :8888`; `■` mid-download: driver TERM'd, no late launch, `stopping`→`stopped`;
   manual ssh restart: UI agrees; dashboard restart mid-`starting`: row restores (pinned job + probe).

### Phase 2 — Serve section UI — M
1. Sentinel wiring (SERVE_ID, route×2, tabs×3, BoltIcon); `ServePage` CH·01/02 per §1.4 (kit reuse:
   ScModule/ScChip/ScCopy/useToasts/useEngineActivity, 3 s arm).
2. Log console (driver/engine tabs, rank switch, cursor tail); key chip tri-badges + setLlmApiKey dialog.
3. Node-page: `Serve ▸` deep-links only (script-class untouched, §1.4). Orphaned-row GC affordance.
   Acceptance: full walk on real GLM recipe; Overview cards vs Serve table agree (same probe objects);
   vitest: state matrix, arm-stop, key dialog, orphan GC.

### Phase 3 — model bridge + placement (transfer half of the original ask) — M
1. Advisory chip → one-click remediation: `modelctl sync-local NAS→head` / `push head→peer` (CX7) /
   `download→NAS`, all existing job kinds + 4 s tail; result re-runs placement check →
   suggests user set `SKIP_DOWNLOAD=1 SKIP_SYNC=1` in `.env` (guidance + copyable line; no `.env` write).
2. Model×node matrix (orphaned `.models-split` CSS), shared `/models` ↔ Serve; capacity preflight with
   byte math + **contention warn vs live recipe-run (P0a lock interplay)**; `nasRootFor` everywhere (D7).
3. Topology awareness: NNODES > fleet ⇒ disabled row + exact delta; peer-inventory parallelization.

### Phase 4 — servedName gateway (optional) — M
`/llm/cluster/<servedName>/v1` in `llmProxy`: probe-health round-robin + failover. `SERVED_MODEL_NAME`
already parsed P1. Traces/auth semantics unchanged.

### Phase 5 — upstream (track only)
modelctl: `ROOT/recipes/NAME/` co-distribution proposal; adopt `cluster inventory --json` when their P1
lands (replaces per-node fan-out). Recipes: propose a `recipe.json` sidecar upstream (port/container set/
topology declared) — script-scraping fallback stands meanwhile; zero adoption dependency.

## 4. Verification
- Server node:test + DI: probe/parse fixtures (real GLM `.env.example` + entry scripts incl. tp4 rank
  names; CONTAINER-less script; bare example-*.sh), deployment join state machine — **explicit stop-during-
  start, failed-exit-after-stop, eviction-pin, orphan/re-add cases**, `recipe-run` gate exemption both
  directions, llmPorts coupling (probe list before/after). Gate ≥75 %.
- 0b: legacy-pidfile stop-after-switch regression test.
- UI: vitest (§3 P2 list). E2E: §3 P1 acceptance walk live, 2 Sparks + NAS; screenshots.

## 5. Risks / open questions

| Risk | Mitigation |
|---|---|
| Probe-parsing assumptions break on exotic recipes | meta advisory only; lifecycle = verbs; no names ⇒ `status`-verb text + PORT-probe fallback (explicitly allowed, [R4]) |
| Hours-long driver vs job system | P0a pins persist, exempts gate, cursor-reads node file |
| Stop race | TERM-first (§1.2); desired=stopped wins over job terminal states |
| Recipe update mid-run | HEAD+dirty drift chip; rebuild-vs-restart distinguished; restart always manual |
| Port auto-registration surprise | registration logged in row ("port added by deployment"), removal offered with deployment; operator can pre-add ports manually and deployment reuses them |
| Two dashboards / same folder | out of scope (single-operator homelab); probe truth minimizes damage |
| nsenter'd host user lacks docker group on spark-1 | probe reports `docker: permission denied` rank row; recipe status-verb fallback |
| Key chip confusion (3 key sources) | tri-badge + explicit copy ("proxy injection ≠ engine auth") — engine key stays `.env`-owned |

Open Qs (pre-P1): (1) worker engine-log direct-from-peer vs head ssh hop — default direct when mapped+agent, else hop; (2) multiple deployments per folder (e.g. tp1 + tp4 variants never co-live — assumed one live variant per folder, enforced by (sparkId,path) lock); (3) whether placement-advisory should hard-block without a `MODEL`-meta parse (proposal: never block; homelab, HF pulls are legitimate).
