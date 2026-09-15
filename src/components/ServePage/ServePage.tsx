/**
 * Serve (cluster) — the plan's §1.4 two-section page:
 *
 *   CH·01 DEPLOYMENTS — cluster table: recipe × node(s) × port × state ×
 *     endpoints (DIRECT/PROXY/key) × start/restart/stop (3 s arm) with an
 *     expandable driver/engine log console. Polls /api/serve/state @5 s.
 *     Starting an absent-model recipe 409s {blocked, placement} → dialog
 *     with the remediation list + explicit "pull from HF anyway" (force).
 *   CH·02 RECIPES — registered folders (node + path = identity): probe meta
 *     (class/port/variants/containers/git), re-probe, unregister (GC), and
 *     the register form (optional scan-for-start.sh helper).
 *
 * Recipes are OPAQUE folders the user owns on the node — this page never
 * edits them. Control rides the recipe's own verbs; truth is the server
 * probe join (server/serving/deployments.js joinServeState).
 *
 * Reuses the console kit (.spark-console + ScModule/ScChip/ScCopy/ScLed/
 * ScSubpanel/ScChHead), the Toasts convention, and the ConfirmShutdown
 * dialog structure (portal + useModalPresence + modal-sheet).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MctlJob, Placement, PlacementCapacityWarn, ServeMatrixResponse, ServeRecipe, ServeState, SparkSnapshot } from "../../api/types";
import {
  deleteServeRecipe,
  getJob,
  listServeRecipes,
  refreshServeRecipe,
  registerServeRecipe,
  scanServeRecipes,
  serveDeploymentAction,
  serveLogs,
  serveMatrix,
  serveState,
  setLlmApiKey,
  startJob,
} from "../../api/client";
import { useModalPresence } from "../../hooks/useModalPresence";
import { ScChip, ScChHead, ScCopy, ScLed, ScModule, ScSubpanel } from "../SparkPage/console/ScKit";
import { tokenizeLogLine } from "../SparkPage/console/consoleUtils";
import { ToastStack, useToasts, type PushToast } from "../../ui/Toasts";
import "../../styles/console.css";
import "../../styles/serve.css";

const STATE_POLL_MS = 5000;
const LOG_POLL_MS = 5000;

interface ServePageProps {
  sparks: SparkSnapshot[];
  onNavigate: (id: string | null) => void;
}

/** apiFetch errors carry {status, payload} for structured REST errors. */
interface HttpError {
  message: string;
  status?: number;
  payload?: {
    blocked?: boolean;
    placement?: Placement;
    topology?: { nnodes: number; computeNodes: number };
    capacity?: PlacementCapacityWarn | null;
    contention?: boolean;
    warnings?: string[];
  };
}

function httpError(err: unknown): HttpError {
  const e = err as Error & { status?: number; payload?: HttpError["payload"] };
  return { message: e?.message || String(err), status: e?.status, payload: e?.payload };
}

function isLive(st?: ServeState): boolean {
  return Boolean(st && ["starting", "healthy", "healthy-keyed", "up", "stopping"].includes(st.state));
}

export function ServePage({ sparks, onNavigate }: ServePageProps) {
  const { toasts, pushToast } = useToasts();
  const [recipes, setRecipes] = useState<ServeRecipe[] | null>(null);
  const [states, setStates] = useState<Record<string, ServeState>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [blocked, setBlocked] = useState<{ recipe: ServeRecipe; error: string; placement: Placement | null; warnings?: string[] } | null>(null);
  const [topologyBlocked, setTopologyBlocked] = useState<{ recipe: ServeRecipe; error: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [keyDialog, setKeyDialog] = useState<{ sparkId: string; port: number } | null>(null);
  const [recipesErr, setRecipesErr] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadRecipes = useCallback(async (refresh = false) => {
    try {
      const res = await listServeRecipes(refresh);
      if (!alive.current) return;
      setRecipes(res.recipes);
      setRecipesErr(null);
    } catch (err) {
      if (!alive.current) return;
      setRecipesErr(httpError(err).message);
    }
  }, []);

  const pollStates = useCallback(async () => {
    try {
      const res = await serveState();
      if (!alive.current) return;
      const map: Record<string, ServeState> = {};
      for (const s of res.states) map[s.recipeId] = s;
      setStates(map);
    } catch {
      /* table keeps the last join; per-row errors surface on refresh */
    }
  }, []);

  useEffect(() => {
    void loadRecipes();
    void pollStates();
    const t = window.setInterval(() => void pollStates(), STATE_POLL_MS);
    return () => window.clearInterval(t);
  }, [loadRecipes, pollStates]);

  const sparkName = useCallback((id: string) => sparks.find((s) => s.id === id)?.name || id, [sparks]);

  const runAction = useCallback(
    async (recipe: ServeRecipe, verb: "start" | "stop" | "restart", body: { variant?: string | null; force?: boolean } = {}) => {
      setBusy((prev) => ({ ...prev, [recipe.id]: true }));
      try {
        const res = await serveDeploymentAction(recipe.id, verb, body);
        pushToast(
          verb === "start"
            ? `start requested — ${recipe.label || recipe.path.split("/").pop()} (driver job detached; watch the row)`
            : `${verb} requested`,
          "ok"
        );
        // P3 warnings (capacity math / transfer contention) — advisory only.
        for (const w of res.warnings || []) pushToast(`warn: ${w}`);
        await pollStates();
      } catch (err) {
        const e = httpError(err);
        if (e.payload?.blocked) {
          setBlocked({ recipe, error: e.message, placement: e.payload.placement ?? null, warnings: e.payload.warnings || [] });
        } else if (e.payload?.topology) {
          setTopologyBlocked({ recipe, error: e.message });
        } else {
          pushToast(`${verb} failed: ${e.message}`);
        }
      } finally {
        setBusy((prev) => {
          const n = { ...prev };
          delete n[recipe.id];
          return n;
        });
      }
    },
    [pollStates, pushToast]
  );

  return (
    <div className="dashboard-shell">
      <div className="spark-console serve-page">
        <ScChHead
          code="CH·01"
          title="Deployments"
          note="cluster serve control · recipes own their lifecycle — this page only runs their verbs"
          aside={
            <button
              type="button"
              className="key"
              style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
              onClick={() => {
                void loadRecipes(true);
                void pollStates();
              }}
            >
              ⟳ refresh
            </button>
          }
        />
        <ScModule label="Deployments" className="mb-4">
          <DeploymentsTable
            recipes={recipes}
            states={states}
            busy={busy}
            sparks={sparks}
            sparkName={sparkName}
            recipesErr={recipesErr}
            expanded={expanded}
            setExpanded={setExpanded}
            onStart={(r) => void runAction(r, "start")}
            onRestart={(r) => void runAction(r, "restart")}
            onStop={(r) => void runAction(r, "stop")}
            onKey={(sparkId, port) => setKeyDialog({ sparkId, port })}
            onNavigateNode={onNavigate}
          />
        </ScModule>

        <ScChHead
          code="CH·02"
          title="Recipes"
          note="folders on nodes — registered read-only; edit content on the node (git), never here"
        />
        <ScModule label="Recipe library">
          <RecipesPanel
            recipes={recipes}
            states={states}
            sparks={sparks}
            sparkName={sparkName}
            onChanged={() => void loadRecipes()}
            pushToast={pushToast}
          />
        </ScModule>

        <ScChHead
          code="CH·03"
          title="Placement"
          note="model × node matrix from modelctl inventories · transfers run as jobs (sync NAS→node, push over the fabric)"
        />
        <ScModule label="Model placement">
          <MatrixPanel sparks={sparks} onChanged={() => void loadRecipes()} pushToast={pushToast} />
        </ScModule>
      </div>
      <ToastStack toasts={toasts} />
      {blocked && (
        <BlockedDialog
          onClose={() => setBlocked(null)}
          info={blocked}
          sparks={sparks}
          onChanged={() => {
            void loadRecipes();
            void pollStates();
          }}
          pushToast={pushToast}
          onForce={() => {
            const r = blocked.recipe;
            setBlocked(null);
            void runAction(r, "start", { force: true });
          }}
        />
      )}
      {topologyBlocked && (
        <TopologyDialog
          info={topologyBlocked}
          onClose={() => setTopologyBlocked(null)}
        />
      )}
      {keyDialog && (
        <ApiKeyDialog
          info={keyDialog}
          onClose={() => setKeyDialog(null)}
          onSaved={() => {
            setKeyDialog(null);
            void loadRecipes();
            void pollStates();
          }}
          pushToast={pushToast}
        />
      )}
    </div>
  );
}

// ─── CH·01 deployments table ───────────────────────────────

function DeploymentsTable({
  recipes,
  states,
  busy,
  sparks,
  sparkName,
  recipesErr,
  expanded,
  setExpanded,
  onStart,
  onRestart,
  onStop,
  onKey,
  onNavigateNode,
}: {
  recipes: ServeRecipe[] | null;
  states: Record<string, ServeState>;
  busy: Record<string, boolean>;
  sparks: SparkSnapshot[];
  sparkName: (id: string) => string;
  recipesErr: string | null;
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  onStart: (r: ServeRecipe) => void;
  onRestart: (r: ServeRecipe) => void;
  onStop: (r: ServeRecipe) => void;
  onKey: (sparkId: string, port: number) => void;
  onNavigateNode: (id: string | null) => void;
}) {
  if (recipes === null) return <div className="empty-note">loading recipes…</div>;
  if (recipesErr) return <div className="empty-note">recipe list failed: {recipesErr}</div>;
  if (recipes.length === 0) {
    return (
      <div className="empty-note">
        No recipes registered yet — register a recipe folder below (CH·02), e.g. a git clone of a serve
        recipe on one of the Sparks.
      </div>
    );
  }
  return (
    <div>
      <div className="st-head" role="row">
        <span>Recipe</span>
        <span>Nodes</span>
        <span>Port</span>
        <span>State</span>
        <span>Model</span>
        <span className="st-col--hide">Endpoints</span>
        <span>Actions</span>
      </div>
      {recipes.map((r) => {
        const st = states[r.id];
        const port = st?.port ?? null;
        const spark = sparks.find((s) => s.id === r.sparkId);
        return (
          <div key={r.id}>
            <div className={`st-row${expanded === r.id ? " is-expanded" : ""}`} role="row">
              <div className="st-row__main">
                <span className="st-name" title={r.path}>{r.label || r.path.split("/").pop()}</span>
                <span className="st-sub" title={r.path}>{r.path}</span>
                {r.probeError && <span className="st-sub" style={{ color: "var(--color-danger)" }}>probe: {r.probeError}</span>}
              </div>
              <div className="st-row__main">
                <button
                  type="button"
                  className="key"
                  style={{ padding: 0, border: "none", background: "none", cursor: "pointer", fontFamily: "var(--mono)", fontSize: "var(--fs-12)", fontWeight: 700, color: "var(--color-text-strong)" }}
                  onClick={() => onNavigateNode(r.sparkId)}
                  title="Open node page"
                >
                  {sparkName(r.sparkId)}
                </button>
                {st?.topology?.workerSparkId && <span className="st-sub">+ {sparkName(st.topology.workerSparkId)}</span>}
                <span className="st-sub">
                  {st?.topology?.nnodes ? `TP${st.topology.tp ?? "?"} · ${st.topology.nnodes} node${st.topology.nnodes > 1 ? "s" : ""}` : ""}
                  {st?.variant ? ` · ${st.variant}` : ""}
                </span>
              </div>
              <div className="st-sub">{port ?? "—"}</div>
              <div className="st-state">
                <StateChip st={st} sparkOnline={spark?.online} />
                {st?.drift?.drift && (
                  <ScChip tone="warn" title={st.drift.rebuild ? "build files changed — the next restart rebuilds the image (recipe stamp)" : "recipe git HEAD moved since this run"}>
                    drift{st.drift.rebuild ? " · rebuild" : ""}
                  </ScChip>
                )}
              </div>
              <div className="st-row__main">
                <span className="st-name" title={st?.model || ""}>{st?.servedName || st?.model || "—"}</span>
                {st?.servedIdMatch === false && (
                  <span className="st-sub" style={{ color: "var(--color-warning)" }}>served id ≠ recipe</span>
                )}
              </div>
              <div className="st-endpoints st-col--hide">
                {port !== null && isLive(st) && (
                  <>
                    <EndpointCell spark={spark} port={port} kind="direct" />
                    <EndpointCell spark={spark} port={port} kind="proxy" onTraces={() => { window.location.href = `/analysis?spark=${encodeURIComponent(r.sparkId)}&port=${port}`; }} />
                    {st?.servedName && (
                      <EndpointCell spark={spark} port={port} kind="cluster" servedName={st.servedName} />
                    )}
                    <KeyChip spark={spark} port={port} onClick={() => onKey(r.sparkId, port)} engineHasKey={Boolean(r.meta?.secretPresence?.VLLM_API_KEY)} />
                  </>
                )}
                {port === null && st && st.state !== "unstarted" && <span className="st-sub">PORT unset in .env</span>}
              </div>
              <RowActions r={r} st={st} busy={Boolean(busy[r.id])} onStart={onStart} onRestart={onRestart} onStop={onStop} expanded={expanded === r.id} setExpanded={setExpanded} />
            </div>
            {expanded === r.id && (
              <div className="st-detail">
                <LogConsole recipe={r} st={st} sparkName={sparkName} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RowActions({
  r,
  st,
  busy,
  onStart,
  onRestart,
  onStop,
  expanded,
  setExpanded,
}: {
  r: ServeRecipe;
  st?: ServeState;
  busy: boolean;
  onStart: (r: ServeRecipe) => void;
  onRestart: (r: ServeRecipe) => void;
  onStop: (r: ServeRecipe) => void;
  expanded: boolean;
  setExpanded: (id: string | null) => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const armStop = () => {
    if (armed) {
      window.clearTimeout(timer.current);
      setArmed(false);
      onStop(r);
      return;
    }
    setArmed(true);
    timer.current = window.setTimeout(() => setArmed(false), 3000);
  };
  const running = isLive(st);
  const canStart = !st || ["unstarted", "stopped", "failed", "foreign"].includes(st.state);
  if (r.orphaned) return <div className="st-actions"><span className="st-sub">node removed</span></div>;
  return (
    <div className="st-actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="key"
        style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
        onClick={() => setExpanded(expanded ? null : r.id)}
        title="Driver + engine logs"
      >
        {expanded ? "▾ logs" : "▸ logs"}
      </button>
      {busy ? (
        <ScChip>working…</ScChip>
      ) : (
        <>
          {running && (
            <button
              type="button"
              className="key key--danger"
              style={{ padding: "1px 8px", fontSize: "var(--fs-10)", ...(armed ? { background: "color-mix(in srgb, var(--color-danger) 18%, transparent)" } : null) }}
              onClick={armStop}
              title="Stop via the recipe's own stop verb (TERM driver first)"
            >
              {armed ? "confirm stop" : "■ stop"}
            </button>
          )}
          {running && (
            <button type="button" className="key" style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }} onClick={() => onRestart(r)} title="Recipe restart verb (may rebuild the image if files changed)">
              ⟳
            </button>
          )}
          {canStart && (
            <button type="button" className="key key--primary" style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }} onClick={() => onStart(r)} title="Run ./start.sh start (placement-checked)">
              ▶ start
            </button>
          )}
        </>
      )}
    </div>
  );
}

function StateChip({ st, sparkOnline }: { st?: ServeState; sparkOnline?: boolean }) {
  if (!st) return <ScChip>…</ScChip>;
  const led =
    st.state === "healthy" || st.state === "healthy-keyed"
      ? "success"
      : st.state === "starting" || st.state === "up" || st.state === "stopping"
        ? "accent"
        : st.state === "failed" || st.state === "orphan" || st.state === "foreign"
          ? "danger"
          : "off";
  const label =
    st.state === "healthy"
      ? st.warmup
        ? "healthy · warmup"
        : "healthy"
      : st.state === "healthy-keyed"
        ? "healthy · key"
        : st.state === "foreign"
          ? "port busy — other engine"
          : st.state;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <ScLed state={led} />
      <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-11)", fontWeight: 700, color: "var(--color-text-strong)" }}>{label}</span>
      {st.state === "unknown" && sparkOnline === false && <span className="st-sub">node offline</span>}
      {st.state === "foreign" && st.servedId && (
        <span className="st-sub" title="another engine answers this port">≠ {st.servedId}</span>
      )}
    </span>
  );
}

function EndpointCell({
  spark,
  port,
  kind,
  servedName,
  onTraces,
}: {
  spark?: SparkSnapshot;
  port: number;
  kind: "direct" | "proxy" | "cluster";
  servedName?: string | null;
  onTraces?: () => void;
}) {
  const direct = spark?.lanIp ? `http://${spark.lanIp}:${port}/v1` : null;
  const proxy = `${window.location.origin}/llm/${spark?.id}/${port}/v1`;
  const cluster =
    servedName && spark?.id
      ? `${window.location.origin}/llm/cluster/${encodeURIComponent(servedName)}/v1`
      : null;
  const url = kind === "direct" ? direct : kind === "proxy" ? proxy : cluster;
  if (!url) return null;
  return (
    <div className="st-endpoint">
      <span className="mlabel" style={{ flexShrink: 0 }}>
        {kind === "direct" ? "direct" : kind === "proxy" ? "proxy" : "cluster"}
        {kind === "proxy" && onTraces && (
          <button
            type="button"
            onClick={onTraces}
            title="Open Analysis traces for this port"
            style={{ all: "unset", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 9, fontWeight: 800, color: "var(--color-accent)", border: "1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)", borderRadius: 4, padding: "0 5px", marginLeft: 5 }}
          >
            traces
          </button>
        )}
      </span>
      <span className="st-endpoint__url" title={url}>{url}</span>
      <ScCopy text={url} title={`Copy ${kind} endpoint`} />
    </div>
  );
}

function KeyChip({
  spark,
  port,
  onClick,
  engineHasKey,
}: {
  spark?: SparkSnapshot;
  port: number;
  onClick: () => void;
  engineHasKey: boolean;
}) {
  const proxyKey = Boolean(spark?.llmApiKeyPorts?.includes(port));
  const state = proxyKey ? "proxy on" : engineHasKey ? "engine key" : "no key";
  const tone = proxyKey ? "accent" : engineHasKey ? "warn" : "default";
  return (
    <button type="button" onClick={onClick} title="Manage the dashboard proxy-injection key (engine auth lives in the recipe .env)">
      <ScChip tone={tone}>key · {state} ✎</ScChip>
    </button>
  );
}

// ─── log console (driver + engine ranks) ───────────────────

function LogConsole({ recipe, st, sparkName }: { recipe: ServeRecipe; st?: ServeState; sparkName: (id: string) => string }) {
  const [tab, setTab] = useState<"driver" | "engine">("driver");
  const [rank, setRank] = useState<string>("head");
  const [lines, setLines] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const sinceRef = useRef<string | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);
  const autoScroll = useRef(true);

  const rankKeys = st?.ranks ? Object.keys(st.ranks) : ["CONTAINER_HEAD"];

  const load = useCallback(async () => {
    try {
      if (tab === "driver") {
        const res = await serveLogs(recipe.id, { kind: "driver", bytes: 9000 });
        setInfo(res.error || (res.jobId ? `job ${res.jobId}` : null));
        setLines((res.log || "").split("\n").filter((l) => l.length > 0));
        sinceRef.current = null;
      } else {
        // Engine: `docker logs -t` prefixes ISO timestamps → cursor on the
        // newest stamp for --since; a Set keeps the boundary re-delivery out.
        const res = await serveLogs(recipe.id, { kind: "engine", rank, tail: 200, since: sinceRef.current });
        setInfo(res.error || (res.container ? `container ${res.container}` : null));
        const incoming = (res.log || "").split("\n").filter((l) => l.length > 0);
        const lastStamp = incoming.length ? incoming[incoming.length - 1].match(/^\S+/)?.[0] : null;
        if (incoming.length) setLines((prev) => [...prev, ...incoming].slice(-600));
        sinceRef.current = lastStamp ?? sinceRef.current;
      }
    } catch (err) {
      setInfo(httpError(err).message);
    }
  }, [tab, rank, recipe.id]);

  useEffect(() => {
    setLines([]);
    setInfo(null);
    sinceRef.current = null;
    void load();
    const t = window.setInterval(() => void load(), LOG_POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && autoScroll.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div>
      <div className="st-tabs">
        <button type="button" className={`st-tab${tab === "driver" ? " is-active" : ""}`} onClick={() => setTab("driver")}>
          driver {st?.job ? `· ${st.job.status}` : ""}
        </button>
        <button type="button" className={`st-tab${tab === "engine" ? " is-active" : ""}`} onClick={() => setTab("engine")}>
          engine
        </button>
        {tab === "engine" &&
          rankKeys.map((rk) => (
            <button key={rk} type="button" className={`st-tab${rank === keyRank(rk) ? " is-active" : ""}`} onClick={() => setRank(keyRank(rk))}>
              {keyRank(rk)}
              {st?.ranks?.[rk] && st.ranks[rk] !== "running" ? ` · ${st.ranks[rk]}` : ""}
            </button>
          ))}
        <span className="pill-note" style={{ marginLeft: "auto" }}>
          {tab === "driver"
            ? "launch progress (pull → rsync → warm load)"
            : rank === "head"
              ? `engine logs · ${sparkName(recipe.sparkId)}`
              : `engine logs · ${st?.topology?.workerSparkId ? sparkName(st.topology.workerSparkId) : "peer (via head hop)"}`}
        </span>
        {info && <span className="st-sub">{info}</span>}
      </div>
      <pre
        ref={boxRef}
        className="trace-body__pre serve-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.length === 0 ? (
          <span className="log-dim">no output yet.</span>
        ) : (
          lines.map((line, i) => (
            <span key={i}>
              {tokenizeLogLine(line).map((tok, j) => (
                <span key={j} className={tok.cls ?? undefined}>
                  {tok.text}
                </span>
              ))}
              {i < lines.length - 1 ? "\n" : null}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}

/** CONTAINER_HEAD/CONTAINER_NAME → "head"; CONTAINER_WORKER2 → "worker2". */
function keyRank(containerKey: string): string {
  if (containerKey === "CONTAINER_HEAD" || containerKey === "CONTAINER_NAME") return "head";
  return containerKey.replace("CONTAINER_", "").toLowerCase();
}

// ─── CH·02 recipes panel ───────────────────────────────────

function RecipesPanel({
  recipes,
  states,
  sparks,
  sparkName,
  onChanged,
  pushToast,
}: {
  recipes: ServeRecipe[] | null;
  states: Record<string, ServeState>;
  sparks: SparkSnapshot[];
  sparkName: (id: string) => string;
  onChanged: () => void;
  pushToast: PushToast;
}) {
  const [adding, setAdding] = useState(false);
  if (!recipes) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      {recipes.length === 0 && <div className="empty-note">Nothing registered — every deployment row above maps to a folder here.</div>}
      {recipes.map((r) => {
        const st = states[r.id];
        return (
          <div key={r.id} className="st-row" style={{ gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1.4fr) auto", borderTop: "1px solid var(--color-grid)" }} role="row">
            <div className="st-row__main">
              <span className="st-name">{r.label || r.path.split("/").pop()}</span>
              <span className="st-sub" title={r.path}>{sparkName(r.sparkId)} · {r.path}</span>
            </div>
            <div className="st-row__main">
              <span className="st-sub">
                {r.meta
                  ? `${r.meta.class} · ${r.meta.entry || "?"}${r.meta.variants?.length ? ` +${r.meta.variants.length} variant${r.meta.variants.length > 1 ? "s" : ""}` : ""} · :${r.meta.port ?? "?"}`
                  : r.orphaned
                    ? "orphaned — node removed"
                    : "not probed"}
              </span>
              <span className="st-sub">
                {r.versions?.gitHead ? `git ${r.versions.gitHead.slice(0, 8)}${r.versions.dirtyBuild ? " · build files dirty" : ""}` : "no git"}
                {r.meta?.model ? ` · ${r.meta.model}` : ""}
              </span>
              {st && isLive(st) && (
                <span className="st-sub">
                  live in CH·01 · <StateChip st={st} />
                </span>
              )}
            </div>
            <div className="st-actions">
              <RefreshButton recipe={r} onChanged={onChanged} pushToast={pushToast} />
              <DeleteButton recipe={r} st={st} onChanged={onChanged} pushToast={pushToast} />
            </div>
          </div>
        );
      })}
      {!adding ? (
        <div>
          <button type="button" className="key key--primary" onClick={() => setAdding(true)}>
            + register recipe folder
          </button>
        </div>
      ) : (
        <RegisterForm sparks={sparks} onDone={() => { setAdding(false); onChanged(); }} pushToast={pushToast} />
      )}
    </div>
  );
}

function RefreshButton({ recipe, onChanged, pushToast }: { recipe: ServeRecipe; onChanged: () => void; pushToast: PushToast }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="key"
      style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await refreshServeRecipe(recipe.id);
          onChanged();
        } catch (err) {
          pushToast(`refresh failed: ${httpError(err).message}`);
        } finally {
          setBusy(false);
        }
      }}
      title="Re-probe the folder (git HEAD, .env, variants)"
    >
      {busy ? "…" : "⟳ probe"}
    </button>
  );
}

function DeleteButton({ recipe, st, onChanged, pushToast }: { recipe: ServeRecipe; st?: ServeState; onChanged: () => void; pushToast: PushToast }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const arm = () => {
    if (armed) {
      setArmed(false);
      void (async () => {
        try {
          await deleteServeRecipe(recipe.id);
          pushToast("unregistered (the folder on the node is untouched)", "ok");
          onChanged();
        } catch (err) {
          pushToast(`remove failed: ${httpError(err).message}`);
        }
      })();
      return;
    }
    setArmed(true);
    timer.current = window.setTimeout(() => setArmed(false), 5000);
  };
  return (
    <button
      type="button"
      className={`key${armed ? " key--danger" : ""}`}
      style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
      onClick={arm}
      title={isLive(st) ? "deployment is live — stop it first" : "Unregister (folder untouched on the node)"}
    >
      {armed ? "confirm remove" : "✕ unregister"}
    </button>
  );
}

function RegisterForm({ sparks, onDone, pushToast }: { sparks: SparkSnapshot[]; onDone: () => void; pushToast: PushToast }) {
  const candidates = sparks.filter((s) => s.kind !== "nas");
  const [sparkId, setSparkId] = useState(candidates[0]?.id || "");
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [scanDir, setScanDir] = useState("");
  const [found, setFound] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  if (candidates.length === 0) {
    return <div className="empty-note">No compute nodes registered — add a Spark/GPU host first.</div>;
  }
  return (
    <ScSubpanel title="Register recipe folder" right={<ScChip>read-only probe</ScChip>}>
      <div className="reg-form">
        <label className="field">
          <span className="field__label">Node</span>
          <select value={sparkId} onChange={(e) => setSparkId(e.target.value)}>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Path on node (absolute)</span>
          <input type="text" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/me/recipes/GLM-5.3-Flash-EXL3-2x-DGX-Sparks" />
        </label>
        <label className="field">
          <span className="field__label">Label (optional)</span>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="glm-5.3 tp2" />
        </label>
        <div className="st-actions">
          <button
            type="button"
            className="key"
            style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
            disabled={busy || !scanDir}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await scanServeRecipes(sparkId, scanDir);
                setFound(res.folders);
                if (res.folders.length === 0) pushToast("no start.sh folders under that dir");
              } catch (err) {
                pushToast(`scan failed: ${httpError(err).message}`);
              } finally {
                setBusy(false);
              }
            }}
            title="List folders containing start.sh under a directory"
          >
            scan…
          </button>
          <button
            type="button"
            className="key key--primary"
            style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
            disabled={busy || !sparkId || !path.startsWith("/")}
            onClick={async () => {
              setBusy(true);
              try {
                await registerServeRecipe({ sparkId, path: path.trim(), label: label.trim() || undefined });
                pushToast(`registered ${path}`, "ok");
                onDone();
              } catch (err) {
                pushToast(`register failed: ${httpError(err).message}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "…" : "▶ register"}
          </button>
          <button type="button" className="key" style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }} onClick={onDone}>
            cancel
          </button>
        </div>
      </div>
      <label className="field">
        <span className="field__label">Scan dir (optional — find recipe folders)</span>
        <input type="text" value={scanDir} onChange={(e) => setScanDir(e.target.value)} placeholder="/home/me/recipes" />
      </label>
      {found.length > 0 && (
        <div className="model-rows">
          {found.map((f) => (
            <button key={f} type="button" className="model-row" onClick={() => setPath(f)}>
              <span className="model-row__name">{f.split("/").pop()}</span>
              <span className="model-row__meta">{f}</span>
              <span className="tag-serving">start.sh</span>
            </button>
          ))}
        </div>
      )}
      <span className="pill-note">
        The folder stays yours: sparkControl probes it read-only (.env, variants, git HEAD) and runs its own
        verbs — it never edits, uploads, or takes ownership. Start runs <code>./start.sh start</code> as a
        detached recipe-run job (pulls/rsync/warm load included).
      </span>
    </ScSubpanel>
  );
}

// ─── blocked dialog (placement 409) ────────────────────────

/**
 * One remediation: start the modelctl transfer job and follow it to a terminal
 * state (existing job kinds: sync = NAS→node, push = peer→node over CX7).
 * Re-checks placement on success so the block clears itself.
 */
function RemediationJob({
  rem,
  sparks,
  sparkName,
  onDone,
  pushToast,
}: {
  rem: { kind: "sync" | "push"; sparkId: string; targetSparkId?: string; model?: string };
  sparks: SparkSnapshot[];
  sparkName: (id: string) => string;
  onDone: () => void;
  pushToast: PushToast;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<MctlJob | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const label =
    rem.kind === "sync"
      ? `sync ${rem.model || ""} · NAS → ${sparkName(rem.targetSparkId || rem.sparkId)}`
      : `push ${rem.model || ""} · ${sparkName(rem.sparkId)} → ${sparkName(rem.targetSparkId || "")} (fabric)`;

  const start = async () => {
    try {
      const res =
        rem.kind === "sync"
          ? await startJob({ kind: "sync", model: rem.model, sparkId: rem.targetSparkId || rem.sparkId })
          : await startJob({ kind: "push", model: rem.model, sparkId: rem.sparkId, targetSparkId: rem.targetSparkId });
      setJobId(res.jobId);
    } catch (err) {
      pushToast(`transfer failed to start: ${httpError(err).message}`);
    }
  };

  useEffect(() => {
    if (!jobId) return;
    let dead = false;
    const tick = async () => {
      try {
        const j = await getJob(jobId);
        if (dead) return;
        setJob(j);
        if (j.status !== "running") {
          onDone();
          if (j.status === "completed") pushToast(`${rem.kind} finished`, "ok");
          else pushToast(`${rem.kind} ${j.status}${j.exitCode != null ? ` (exit ${j.exitCode})` : ""}`);
        }
      } catch {
        /* transient */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 4000);
    return () => {
      dead = true;
      window.clearInterval(t);
    };
  }, [jobId, rem.kind, onDone, pushToast]);

  return (
    <div className="st-endpoint">
      <button type="button" className="key key--primary" style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }} onClick={() => void start()} disabled={Boolean(jobId && !job?.endedAt)}>
        {jobId ? "↻ again" : "▶ run"}
      </button>
      <span className="st-sub" style={{ whiteSpace: "normal" }}>
        {label}
        {job ? ` · ${job.status}${job.status === "running" ? "…" : ""}` : ""}
      </span>
      {job?.logTail ? (
        <span className="st-sub" style={{ whiteSpace: "normal" }} title={job.logTail}>
          {job.logTail.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 90) || ""}
        </span>
      ) : null}
      {job && !sparks.length ? null : null}
    </div>
  );
}

function BlockedDialog({
  info,
  sparks,
  onChanged,
  pushToast,
  onClose,
  onForce,
}: {
  info: { recipe: ServeRecipe; error: string; placement: Placement | null; warnings?: string[] };
  sparks: SparkSnapshot[];
  onChanged: () => void;
  pushToast: PushToast;
  onClose: () => void;
  onForce: () => void;
}) {
  const { mounted, visible } = useModalPresence(true);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
  if (!mounted) return null;
  const p = info.placement;
  const sparkName = (id: string) => sparks.find((sp) => sp.id === id)?.name || id;
  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} onClick={onClose}>
      <div className="modal-sheet max-w-md" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-sheet__header flex items-center gap-2" style={{ color: "var(--color-warning)" }}>
          <span className="text-sm font-semibold">Weights not on the node</span>
        </div>
        <div className="modal-sheet__body space-y-3">
          <p className="text-xs text-muted" style={{ whiteSpace: "pre-wrap" }}>{info.error}</p>
          {info.warnings && info.warnings.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {info.warnings.map((w, i) => (
                <span key={i} className="st-sub" style={{ color: "var(--color-warning)" }}>⚠ {w}</span>
              ))}
            </div>
          )}
          {p && p.remediations.length > 0 ? (
            <div className="sub-card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="field__label">Fix placement ({p.status})</span>
              {p.remediations.map((rem, i) => (
                <RemediationJob
                  key={`${rem.kind}-${rem.sparkId}-${i}`}
                  rem={rem}
                  sparks={sparks}
                  sparkName={sparkName}
                  onDone={onChanged}
                  pushToast={pushToast}
                />
              ))}
              <span className="pill-note">
                Transfers run as modelctl jobs. When the weights are present, start again — the recipe will
                then skip its own download (its cache logic). This dialog never edits the recipe's .env.
              </span>
            </div>
          ) : (
            <p className="pill-note">
              No NAS/peer source found for this model ({p?.status || "unavailable"}) — the recipe would pull
              it from Hugging Face itself (may run a long time).
            </p>
          )}
        </div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>Close</button>
            <button type="button" className="bench-btn bench-btn--danger" onClick={onForce}>Pull from HF anyway (force)</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Variant needs more nodes than the fleet has (P3) — hard refusal, no bypass. */
function TopologyDialog({ info, onClose }: { info: { recipe: ServeRecipe; error: string }; onClose: () => void }) {
  const { mounted, visible } = useModalPresence(true);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
  if (!mounted) return null;
  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} onClick={onClose}>
      <div className="modal-sheet max-w-md" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-sheet__header flex items-center gap-2" style={{ color: "var(--color-danger)" }}>
          <span className="text-sm font-semibold">Topology too big for this cluster</span>
        </div>
        <div className="modal-sheet__body space-y-3">
          <p className="text-xs text-muted" style={{ whiteSpace: "pre-wrap" }}>{info.error}</p>
          <p className="pill-note">
            Adding the missing nodes (Overview → +) unlocks this variant. This refusal cannot be forced —
            the recipe would fail mid-launch.
          </p>
        </div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" className="bench-btn bench-btn--primary" onClick={onClose}>OK</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── CH·03 placement matrix ────────────────────────────────

const MATRIX_POLL_MS = 30_000;

function MatrixPanel({
  sparks,
  onChanged,
  pushToast,
}: {
  sparks: SparkSnapshot[];
  onChanged: () => void;
  pushToast: PushToast;
}) {
  const [mx, setMx] = useState<ServeMatrixResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await serveMatrix();
      if (alive.current) {
        setMx(res);
        setErr(null);
      }
    } catch (e) {
      if (alive.current) setErr(httpError(e).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), MATRIX_POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const computes = sparks.filter((sp) => sp.kind !== "nas");
  const sparkName = (id: string) => sparks.find((sp) => sp.id === id)?.name || id;
  const rows = (mx?.models || []).filter(
    (r) => !query || r.name.toLowerCase().includes(query.toLowerCase()) || (r.repository || "").toLowerCase().includes(query.toLowerCase())
  );

  if (computes.length === 0) return <div className="empty-note">No compute nodes.</div>;
  if (err) return <div className="empty-note">matrix failed: {err}</div>;
  if (!mx) return <div className="empty-note">loading placement…</div>;

  return (
    <div style={{ ["--mt-n" as string]: mx.nodes.length }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter models…"
          className="mono"
          style={{ flex: "0 0 220px", border: "1px solid var(--color-border)", borderRadius: 6, background: "var(--color-surface-elevated)", color: "var(--color-text)", padding: "2px 8px", fontSize: "var(--fs-11)" }}
        />
        <span className="pill-note">{mx.models.length} models</span>
        <button type="button" className="key" style={{ marginLeft: "auto", padding: "1px 8px", fontSize: "var(--fs-10)" }} onClick={() => void load()}>
          ⟳ refresh
        </button>
      </div>
      <div className="mt-head" role="row">
        <span>Model</span>
        <span>NAS</span>
        {mx.nodes.map((n) => (
          <span key={n.sparkId} title={n.name}>{n.name}</span>
        ))}
        <span>Actions</span>
      </div>
      {rows.length === 0 && <div className="empty-note">Nothing matches.</div>}
      {rows.map((r) => {
        const missing = mx.nodes.filter((n) => r.nodes[n.sparkId] !== "current");
        // per-missing-node remediation (NAS has it → sync; a peer holds it → push)
        const canSync = r.nas === "active";
        const peerOf = (targetId: string) => mx.nodes.find((n) => n.sparkId !== targetId && r.nodes[n.sparkId] === "current");
        return (
          <div key={r.key} className="mt-row" role="row">
            <div className="st-row__main">
              <span className="st-name" title={r.repository || r.name}>{r.name}</span>
              <span className="st-sub">
                {r.repository || "—"}
                {r.bytes != null ? ` · ${(r.bytes / 1e9).toFixed(1)} GB` : ""}
                {r.runtime ? ` · ${r.runtime}` : ""}
              </span>
            </div>
            <div>{r.nas === "active" ? <ScChip tone="accent">in store</ScChip> : <ScChip>absent</ScChip>}</div>
            {mx.nodes.map((n) => (
              <div key={n.sparkId}>
                {r.nodes[n.sparkId] === "current" ? (
                  r.servedOn.includes(n.sparkId) ? (
                    <ScChip tone="live" title="served by a live recipe deployment">served</ScChip>
                  ) : (
                    <ScChip tone="accent">present</ScChip>
                  )
                ) : (
                  <ScChip>absent</ScChip>
                )}
              </div>
            ))}
            <div className="st-actions">
              {missing.length === 0 ? (
                <span className="st-sub">everywhere</span>
              ) : (
                missing.map((n) => {
                  const peer = peerOf(n.sparkId);
                  const rem = canSync
                    ? { kind: "sync" as const, sparkId: n.sparkId, targetSparkId: n.sparkId, model: r.name }
                    : peer
                      ? { kind: "push" as const, sparkId: peer.sparkId, targetSparkId: n.sparkId, model: r.name }
                      : null;
                  return rem ? (
                    <RemediationJob
                      key={`${r.key}-${n.sparkId}`}
                      rem={rem}
                      sparks={sparks}
                      sparkName={sparkName}
                      onDone={() => {
                        void load();
                        onChanged();
                      }}
                      pushToast={pushToast}
                    />
                  ) : (
                    <span key={n.sparkId} className="st-sub" title="not in the NAS store and no node holds it">
                      {sparkName(n.sparkId)}: no source
                    </span>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
      <span className="pill-note">
        sync = modelctl sync-local from the NAS store; push = modelctl push between nodes over the fabric
        (runs on the holder). Capacity vs free space is checked before a serve start, not here.
      </span>
    </div>
  );
}

// ─── proxy key dialog (D6) ─────────────────────────────────

function ApiKeyDialog({
  info,
  onClose,
  onSaved,
  pushToast,
}: {
  info: { sparkId: string; port: number };
  onClose: () => void;
  onSaved: () => void;
  pushToast: PushToast;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const { mounted, visible } = useModalPresence(true);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
  if (!mounted) return null;
  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} onClick={onClose}>
      <div className="modal-sheet max-w-md" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-sheet__header flex items-center gap-2">
          <span className="text-sm font-semibold">Proxy API key · {info.sparkId} :{info.port}</span>
        </div>
        <div className="modal-sheet__body space-y-3">
          <p className="text-xs text-muted">
            This key is what the dashboard proxy injects into <code>/llm/{info.sparkId}/{info.port}/*</code>{" "}
            clients. It does NOT change engine auth — the server-side Bearer comes from the recipe{" "}
            <code>.env</code> VLLM_API_KEY (editable only on the node).
          </p>
          <label className="field">
            <span className="field__label">Bearer token (blank = clear)</span>
            <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="sk-…" />
          </label>
        </div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" className="bench-btn bench-btn--ghost" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="bench-btn bench-btn--primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await setLlmApiKey(info.sparkId, info.port, value.trim());
                  pushToast(value.trim() ? "proxy key stored" : "proxy key cleared", "ok");
                  onSaved();
                } catch (err) {
                  pushToast(`save failed: ${httpError(err).message}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "…" : value.trim() ? "Store key" : "Clear key"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export type { ServeState, ServeRecipe };
