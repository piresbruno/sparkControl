# SERVE Plan — cluster-level Model Serving with Recipes

Status: proposal rev 3 (2026-09-15). Rev 2 was scoped to "use/refine recipes, never author them";
rev 3 cuts it further per user: **no recipe editing anywhere in the UI — start / stop / restart / logs only.**
Recipe folders (and their `.env`) are maintained by the user on the node, as today.
All line anchors verified against the working tree and `~/developer/recipes`.

## 0. Problem

Serving today is **node-scoped control, cluster-scoped intent**:

- Launch/stop live on the node page (`ScServing.tsx:809-939`, CH·02); no cluster view of what is served
  where — only `FleetAlertStrip.tsx:12,29-30` "LLM unavailable", derived from WS metrics, not serve state.
- The model store lives elsewhere (`/models` + `NasPage`); placement (`servingPlacement`, `Placement`,
  `listNodeModels`, `sync`/`push` job kinds) is implemented server-side with **zero UI callers**.
- Recipes as actually used (`~/developer/recipes`, MiaAI-Lab repos) are self-orchestrating git folders:
  `start.sh` dispatcher (`start|stop|restart|status|logs|download`), 131-knob `.env`, multinode
  **internally** (head ssh's worker `docker run -d --headless`, ships image, downloads+rsyncs 164 GiB),
  containers + `/health` as state, starts taking minutes→hours (`READY_TIMEOUT=3600`).
  The dashboard's current supervision (upload one bash, pidfile in `~/.sparkdash/runs`) fits none of that.

Verified structural defects:

| # | Defect | Evidence |
|---|--------|----------|
| D1 | Two supervision stacks; dashboard never sends agent `serve` frames — ops tunnel as one-shot `job-run` shell; log-ring fast-path (`index.js:1385`) almost always misses | `index.js:1131-1149`; `agent/src/main.js:148-244,432-434` |
| D2 | `defaultServingSpark()` → the `kind:"nas"` node wins today | `index.js:1172-1180`; `config/sparks.json` |
| D3 | One-run-per-node baked everywhere; status scans "the one running script" N+1, discovery loop bypasses agent | `index.js:1170,1300-1304,1334-1355` |
| D4 | No server-side serve state: nothing persists what runs where with what; provenance lost on restart | serving.js:214 |
| D5 | Script library global, disk-only, seed no-ops in Docker (`Dockerfile:51-59`); node-local `scriptPath` runs second-class (cap 32) | `index.js:1182-1184` |
| D6 | `setLlmApiKey` (`client.ts:366`) uncalled; `key on/off` chip read-only | UI map §8.11 |
| D7 | `sync` job uses global nasRoot; other paths per-node `nasRootFor(spark)` | `index.js:916-919` |

## 1. Design

### 1.1 Recipe = registered folder on a node (opaque engine)

No central content store, no editor. A **recipe record** in the dashboard points at a folder already on a
node — the user's git clone (`~/developer/recipes/GLM-5.3-Flash-EXL3-2x-DGX-Sparks`):

```
recipe  { id, sparkId, path, label?, entry? (default start.sh), variants? (auto-scan start*.sh, tp*/),
          meta: parsed read-only — PORT, CONTAINER_HEAD/WORKER, SERVED_MODEL_NAME, HEAD_IP/WORKER_IP,
          topology (single|multi, from NNODES/TP or variant), version = git HEAD if folder is a clone }
```

- Registration = pick node + absolute path (+ optional browse: "scan dir for start.sh"). At-boot and on
  demand, the dashboard runs a **probe script** (one exec) that lists entry files, greps `.env`/`.env.example`
  for the known keys, reads `git rev-parse HEAD` — read-only, never writes to the folder.
- `.env` stays authoritative and user-owned. The UI shows the parsed values as **read-only facts**
  (port, containers, served name, peer IPs) — enough to label and control, not to edit.
- Optional convenience (not core): "clone on node" one-shot (`git clone <url> [ref] <path>` as a job) —
  the folder remains the user's after that.

### 1.2 Deployment = desired-run record; lifecycle = the recipe's own verbs

```
deployment { id, recipeId, variant?, headSparkId, desired: running|stopped,
             jobId (last launch), startedWith: {version, pid?}, note, createdAt }
```

- **start / restart** = async job kind `recipe-run`: `cd <path> && ./<entry> [variant-entry] <verb>`.
  Detached via existing `remoteJobs` (survives dashboard restart, log ring, boot recovery) with serve-job
  exemptions: cancel = `stop` verb (never SIGKILL the driver), one-active-per-**folder** (not per-node),
  long deadline (`READY_TIMEOUT` respected; UI never claims hang at 15 s — today's `execForSpark` default).
- **stop** = one-shot exec `./start.sh stop` (fast: docker stop, tolerates already-stopped).
- **status (join, no ownership)**: probe truth only —
  `healthy` = WS `metrics.llm[PORT]` responds ∧ (served id == parsed `SERVED_MODEL_NAME` when known);
  `starting` = live `recipe-run` job; `stopped` = pid absent ∧ containers absent (one cheap `docker ps
  --filter name=<CONTAINER_HEAD>` via meta, or recipe `status` verb);
  `drift` = recipe git HEAD moved since `startedWith.version` (chip: "restart to apply");
  `unknown` = node offline. **Manually started or SSH-restarted engines still show correct state** —
  dashboard and shell are peers over the same folder.
- No env-injection layer in core. Rare overrides stay what they are today: edit `.env` on the node
  (the recipe documents precedence); the UI does not participate.

### 1.3 Logs: two streams, one console

1. **Driver log** — the `recipe-run` job output (preflight/pull/download/rsync/launch progress), live ring,
   kept after exit (job history per deployment).
2. **Engine log** — `docker logs --tail N` / `--since` on `CONTAINER_HEAD` (parsed from meta — never the
   recipe's following `logs` verb); **worker rank** = same on the peer container via its own agent/SSH
   (direct), falling back to the head's ssh hop only when the peer has no agent.
   Serve page tail = 5 s `--since <cursor>` incremental, existing `trace-body__pre` + `tokenizeLogLine`.

### 1.4 Serve section (`/serve`) — small by construction

Cluster table + actions + logs. Explicitly **no** recipe editor, params editor, dry-run, or file browser.

- **CH·01 DEPLOYMENTS** — recipe · variant/topology chip (TP2 · CX7 · single) · head (+ worker, from meta) ·
  port · served id · state + "up since"/elapsed · version (+ drift) · endpoint rows:
  DIRECT `http://<lanIp>:<PORT>/v1`, PROXY `/llm/<sparkId>/<port>/v1` (+ traces link), key chip (P3 wires
  set/clear, fixes D6) · actions: `▶ start` / `⟳ restart` / `■ stop` (3 s arm) · row expand: driver tail +
  engine console (head/worker switch). Poll `GET /api/serve/state` (fan-out, 5 s; offline rows `unknown`).
- **CH·02 RECIPES** — registered folders: node · path · parsed meta (port/containers/served name/NNODES) ·
  git HEAD + update date · variants found · badges: `running via deployment X` / `idle` ·
  `register` flow (node + path + browse-scan) · optional `clone on node…`. No editing.
- **CH·03 LAUNCH** — not a section: starting is one button per registered recipe row (recipe × head are
  already fixed by the folder's `.env`). Port collisions pre-checked against live deployments (from meta
  PORT) — warn only; recipe controls its own bind.
  → collapses into CH·01/02: **the page is two sections: Deployments + Recipes.**
- Node page surgery: remove launch panel + serving log from CH·02 (`ScServing.tsx:809-939`); heroes keep
  telemetry; `▶ Serve new model…` / `■ Stop` deep-link `/serve`. Migrate `ScServing.test.tsx:128-155`.

### 1.5 What stays deferred

- **Model bridge remediation** (`sync NAS→node` / `push` over CX7 / `download to NAS` one-clicks +
  placement matrix, capacity preflight) — the original ask's transfer half; server-side pieces already
  exist (`planPlacementFor` 409 flow, job kinds). Phase 3, additive to the same table.
- Three-layer param overlay / fabric autodetect / dry-run preview — cut with rev 3 (`.env` on disk wins).
- **servedName gateway** `/llm/cluster/<servedName>/v1` (replicas/failover) — Phase 4, optional.
- YAML-recipe dialect — import by "clone/put folder on node" already covers it if authors ship a wrapper;
  no interpreter.

## 2. Prior art (condensed)

**sparkctl**: deployment-as-desired-state + drift manifest + boot re-serve → adopted as
`startedWith.version` drift + boot re-probe (no auto-start default). Its recipes are declarative YAML its
engine compiles — not ours (opaque folders). **llama-swap**: config-as-control-plane, request-time swap —
rejected (long-lived services; conflicts with benches/traces). **modelctl cluster plan**: their roadmap
defers node agents/APIs/reconciliation = exactly sparkControl's lane; boundary: modelctl = data plane,
sparkControl = serving control plane; their inventory matrix + reservations feed Phase 3; capacity
caution: recipe `MODEL` ids land in the HF cache — the same cache `modelctl list --local` registers.

## 3. Phases

### Phase 0 — backend hygiene — S
1. Serve state dir unified (`~/.sparkcontrol/runs/`) + `adoptLegacy` pidfile scan (script-class runs keep
   working across upgrade); per-`(node,port)` multi-run; D2: cluster routes require explicit sparkId.
2. `GET /api/serve/state` fan-out endpoint (parallel, per-node timeout, 2 s cache, `unknown` rows).
3. `recipe-run` job kind in `remoteJobs`: per-folder lock, stop-verb cancel, long deadline, persist.
4. Dockerfile ships `serving/`; `.env.example` docs (D5). Acceptance: script-class serving unchanged on
   both transports; multi-run proven live; new job kind survives dashboard restart.

### Phase 1 — recipe registration + lifecycle — M
1. `server/serving/recipes.js`: register CRUD (`config/serve-recipes.json`), probe script builder
   (list entries, parse `.env`/`.env.example` keys, git HEAD, variants), read-only meta cache.
2. Routes: `GET/POST/DELETE /api/serve/recipes`, `POST /api/serve/recipes/scan {sparkId, dir}`,
   `GET /api/serve/recipes/:id` (fresh probe).
3. Deployments store (`config/serve-deployments.json`) + engine: start/restart (job), stop (exec),
   status join (WS ∪ job ∪ docker-probe), version drift, boot re-probe.
4. Logs: driver ring per deployment; engine tail builder (`docker logs --tail/--since`, head via
   `execForSpark`, worker via its own transport).
   Acceptance (live cluster): register GLM folder on spark-1 → probe shows PORT=8888, TP=2, containers,
   served id, git HEAD; `▶` → job tail streams pull/rsync/warmup phases → `healthy :8888`; `■` → verbs
   stop both; restart from **ssh shell** → UI still `healthy` (probe truth); kill dashboard mid-`starting`
   → row restores from job + probe after boot.

### Phase 2 — Serve section UI + node-page surgery — M
1. Sentinel wiring (`SERVE_ID`, route, tabs×3, BoltIcon); `ServePage` CH·01/02 per §1.4 reusing
   kit (`ScModule/ScChip/ScCopy` + `useToasts` + `useEngineActivity` + arm-pattern).
2. Log console (driver/engine tabs, head/worker switch, 5 s cursor tail).
3. Remove CH·02 launch panel + serving log from `ScServing`; deep-links; test migration.
4. `key on/off` chip → `setLlmApiKey` dialog where port exists (D6).
   Acceptance: full walk a–f on the live cluster; Overview cards and Serve table agree on same probe.

### Phase 3 — model bridge + placement (transfer half of the original ask) — M
1. Serve-table remediation rows from existing `planPlacementFor` 409 + `sync`/`push`/`download` job kinds
   (buttons on the existing 4 s tail pattern); `nasRootFor` consistency (D7).
2. Model×node matrix (orphaned `.models-split` CSS), shared `/models` ↔ Serve; capacity preflight with
   byte math (`reserve_free` idea from modelctl plan; GB10 unified-pool warning from recipe meta).
3. Topology awareness: recipes declaring NNODES>fleet ⇒ disabled row + exact delta; peer-inventory
   parallelization (planPlacement N+1).

### Phase 4 — servedName gateway (optional) — M
`/llm/cluster/<servedName>/v1` in `llmProxy`: probe-health round-robin + failover; `SERVED_MODEL_NAME`
already parsed in P1. Traces/auth semantics unchanged.

### Phase 5 — upstream (track only)
modelctl: `ROOT/recipes/NAME/` co-distribution proposal + adopt `cluster inventory --json` when their P1
lands (replaces per-node fan-out). Recipes: propose a tiny `recipe.json` discovery sidecar upstream
(port/containers/topology/variants declared, greps remain the fallback). No dependency on either.

## 4. Verification
- Server: node:test + DI — recipes probe/parse (fixtures: real GLM `.env.example`, a YAML-era script,
  a bare example-*.sh folder), deployment state machine (launch→job→probe→stop, drift, boot),
  `recipe-run` lifecycle vs fake agent, log builders. Gate ≥75 %.
- UI: vitest — table state matrix, arm-stop, log cursor tail; migrated ScServing asserts.
- E2E: Phase 1 acceptance walk on the live cluster with the real GLM recipe; manual-vs-dashboard
  restart race check; screenshots before/after node-page surgery.

## 5. Risks / open questions

| Risk | Mitigation |
|---|---|
| Probe-parsing assumptions break on a recipe using nonstandard keys | meta is advisory; lifecycle = verbs only (`start/stop/status` all just run in the folder); missing PORT ⇒ no endpoint rows, status falls back to recipe `status` verb text |
| Long jobs vs remoteJobs poll/cancel assumptions | P0.3: per-folder lock, stop-verb cancel, deadline from parsed `READY_TIMEOUT` (default 3600 s) |
| Dashboard stop while a `starting` job is still pulling | stop allowed; job marked interrupted; containers per docker reality; UI shows both facts, no fake "clean stopped" |
| Two dashboards / users same folder | out of scope (single-operator homelab); probe-derived truth minimizes damage |
| Agent-vs-SSH drift (D1) | script-class keeps job-run tunneling; repo-class verbs run anywhere — supervision parity by construction since recipes own their state |
| Recipes not on the node yet | registration requires an existing folder; `clone on node` convenience covers the gap (job, same transport) |

Open Qs (pre-P1): (1) worker engine-log tail direct-from-peer vs head ssh hop — propose direct when peer
agent connected; (2) deployment granularity — one deployment per recipe-folder assumed (a folder is one
topology); `start-tp4.sh`/`tp1` = variants of the same recipe, one live variant at a time per folder;
(3) drift chip action = `restart` only (never auto); (4) keep script-class launch UI on the node page as
well, or move everything to /serve? (proposal: move; node page keeps heroes + deep-link).
