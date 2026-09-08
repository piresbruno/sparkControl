import type {
  DecodeBenchJob,
  DecodeBenchListResponse,
  HermesBatchUpdateResponse,
  HermesUpdatesResponse,
  LlmMetrics,
  LlmDailyResponse,
  Settings,
  ShowcaseListResponse,
  ShowcaseSessionState,
  ShowcaseStartRequest,
  ShowcaseStartResponse,
  SparkConfig,
  SparkTestResponse,
  StartDecodeBenchRequest,
  PrefillBenchJob,
  PrefillBenchListResponse,
  StartPrefillBenchRequest,
  TraceEntry,
  TraceListResponse,
  JobKind,
  MctlJob,
  ModelctlStatus,
  NasModel,
  Placement,
  ServingScript,
  ServingStatus,
  InventoryResponse,
  NasQueueEntry,
  ModelctlRelease,
  NasDoctorResponse,
  NasCatalogResponse,
  NasModelDetail,
  NasDeletePlan,
} from "./types";

const BASE = "";

// ─── Generic fetch wrapper ────────────────────────────────
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  // Only set Content-Type for requests that actually carry a body. Setting it
  // on GET/DELETE was a no-op but could trigger an unnecessary CORS preflight
  // (OPTIONS) in some proxy setups.
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...headers, ...(opts?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Sparks CRUD ─────────────────────────────────────────
export function fetchSparks(): Promise<{ sparks: SparkConfig[] }> {
  return apiFetch("/api/sparks");
}

/** Latest metrics snapshot for one Spark (includes per-port LLM modelId). */
export function fetchSparkMetrics(id: string): Promise<{
  metrics?: { llm?: LlmMetrics[] };
}> {
  return apiFetch(`/api/sparks/${id}/metrics`);
}

/** Daily busy tok/s rollups for one Spark LLM port. */
export function fetchLlmDaily(
  id: string,
  port: number,
  days = 14
): Promise<LlmDailyResponse> {
  const q = new URLSearchParams({ port: String(port), days: String(days) });
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/llm/daily?${q.toString()}`);
}

export function addSpark(config: SparkConfig): Promise<{ success: boolean; spark: SparkConfig }> {
  return apiFetch("/api/sparks", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function updateSpark(
  id: string,
  patch: Partial<SparkConfig>
): Promise<{ success: boolean; spark: SparkConfig }> {
  return apiFetch(`/api/sparks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteSpark(id: string): Promise<{ success: boolean; removed: SparkConfig }> {
  return apiFetch(`/api/sparks/${id}`, { method: "DELETE" });
}

/** Persist tab bar order (array of spark ids). */
export function reorderSparks(
  order: string[]
): Promise<{ success: boolean; sparks: SparkConfig[] }> {
  return apiFetch("/api/sparks/order", {
    method: "PUT",
    body: JSON.stringify({ order }),
  });
}

/** Save SSH password only (works while the host is offline). */
export function setSparkPassword(
  id: string,
  password: string
): Promise<{ success: boolean; spark: SparkConfig; hasPassword: boolean }> {
  return apiFetch(`/api/sparks/${id}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

// ─── Test connectivity ────────────────────────────────────
/** Test a registered Spark by id */
export function testSpark(id: string): Promise<SparkTestResponse> {
  return apiFetch(`/api/sparks/${id}/test`, { method: "POST" });
}

/** Ephemeral test — does not persist a Spark or start a monitor */
export function testSparkConfig(config: Omit<SparkConfig, "id"> & { id?: string }): Promise<SparkTestResponse> {
  return apiFetch("/api/sparks/test", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/** Cancel a ComfyUI job (interrupt running and/or remove from queue). */
export function cancelComfyJob(
  sparkId: string,
  promptId: string
): Promise<{ success: boolean; ok?: boolean; method?: string; message?: string }> {
  return apiFetch(`/api/sparks/${encodeURIComponent(sparkId)}/comfy/cancel`, {
    method: "POST",
    body: JSON.stringify({ promptId }),
  });
}

// ─── Disabled storage devices ─────────────────────────────
export function updateDisabledDevices(
  id: string,
  disabledDevices: string[]
): Promise<{ success: boolean; disabledDevices: string[] }> {
  return apiFetch(`/api/sparks/${id}/disabled-devices`, {
    method: "PUT",
    body: JSON.stringify({ disabledDevices }),
  });
}

// ─── Disabled network interfaces ──────────────────────────
export function updateDisabledInterfaces(
  id: string,
  disabledInterfaces: string[]
): Promise<{ success: boolean; disabledInterfaces: string[] }> {
  return apiFetch(`/api/sparks/${id}/disabled-interfaces`, {
    method: "PUT",
    body: JSON.stringify({ disabledInterfaces }),
  });
}

// ─── Manual metric refresh ────────────────────────────────
export function refreshSparkMetric(
  id: string,
  domain: string
): Promise<{ success: boolean; domain: string }> {
  return apiFetch(`/api/sparks/${id}/refresh/${domain}`, { method: "POST" });
}

// ─── LLM decode benchmark ─────────────────────────────
/** Start an async decode bench (returns 202 job). */
export function startDecodeBench(
  id: string,
  body: StartDecodeBenchRequest
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getDecodeBench(
  id: string,
  benchId: string
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench/${benchId}`);
}

export function listDecodeBench(
  id: string,
  port?: number
): Promise<DecodeBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/bench${q}`);
}

export function cancelDecodeBench(
  id: string,
  benchId: string
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench/${benchId}`, {
    method: "DELETE",
  });
}

/** Clear finished benchmark history for a Spark (optionally one LLM port). */
export function clearDecodeBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/bench${q}`, { method: "DELETE" });
}

// ─── LLM prefill benchmark ────────────────────────────
export function startPrefillBench(
  id: string,
  body: StartPrefillBenchRequest
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getPrefillBench(
  id: string,
  benchId: string
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench/${benchId}`);
}

export function listPrefillBench(
  id: string,
  port?: number
): Promise<PrefillBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench${q}`);
}

export function cancelPrefillBench(
  id: string,
  benchId: string
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench/${benchId}`, {
    method: "DELETE",
  });
}

export function clearPrefillBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench${q}`, { method: "DELETE" });
}

// ─── LLM Prompt Showcase ──────────────────────────────
/** Start a concurrent prompt showcase (returns 202 session). */
export function startShowcase(
  id: string,
  body: ShowcaseStartRequest
): Promise<ShowcaseStartResponse> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Active session + finished history summaries. */
export function listShowcase(id: string): Promise<ShowcaseListResponse> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`);
}

export function getShowcase(
  id: string,
  sessionId: string,
  opts?: { since?: number }
): Promise<ShowcaseSessionState> {
  const q =
    opts?.since != null && Number.isFinite(opts.since)
      ? `?since=${encodeURIComponent(String(opts.since))}`
      : "";
  return apiFetch(`/api/sparks/${id}/llm/showcase/${sessionId}${q}`);
}

export function cancelShowcase(
  id: string,
  sessionId: string
): Promise<ShowcaseSessionState> {
  return apiFetch(`/api/sparks/${id}/llm/showcase/${sessionId}`, {
    method: "DELETE",
  });
}

/** Clear finished showcase history for a Spark. */
export function clearShowcaseHistory(
  id: string
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`, { method: "DELETE" });
}

// ─── LLM probe ports (per Spark) ─────────────────────────
/** Replace all LLM ports for a Spark (hot update). */
export function updateLlmPorts(
  id: string,
  llmPorts: number[]
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports`, {
    method: "PUT",
    body: JSON.stringify({ llmPorts }),
  });
}

/** Add a single LLM port to a Spark (hot update). */
export function addLlmPort(
  id: string,
  port: number
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports`, {
    method: "POST",
    body: JSON.stringify({ port }),
  });
}

/** Remove an LLM port from a Spark (hot update). */
export function removeLlmPort(
  id: string,
  port: number
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports/${port}`, {
    method: "DELETE",
  });
}

/** Backward-compat: replace all ports via the legacy single-port endpoint. */
export function updateLlmPort(
  id: string,
  llmPort: number
): Promise<{ success: boolean; llmPort: number; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-port`, {
    method: "PUT",
    body: JSON.stringify({ llmPort }),
  });
}

/**
 * Set or clear an optional LLM API key for one port.
 * Pass apiKey "" to clear. Key is stored encrypted server-side and never returned.
 */
export function setLlmApiKey(
  id: string,
  port: number,
  apiKey: string
): Promise<{
  success: boolean;
  hasApiKey: boolean;
  llmApiKeyPorts: number[];
}> {
  return apiFetch(`/api/sparks/${id}/llm-ports/${port}/api-key`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

// ─── Hermes Agent ────────────────────────────────────
/** One-click `hermes update` via SSH on the Spark (background job; 202 when started). */
export function updateHermes(id: string): Promise<{ success: boolean; reason?: string }> {
  return apiFetch(`/api/sparks/${id}/hermes/update`, { method: "POST" });
}

/** Run `hermes update` on every Spark with Hermes Agent monitoring enabled. */
export function updateAllHermes(): Promise<HermesBatchUpdateResponse> {
  return apiFetch("/api/sparks/hermes/update-all", { method: "POST" });
}

/** Force an immediate `hermes update --check` on the Spark. */
export function checkHermes(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${id}/hermes/check`, { method: "POST" });
}

// ─── Power management ────────────────────────────────────
export interface PowerResult {
  success: boolean;
  message?: string;
  output?: string;
  mac?: string;
  broadcast?: string;
  error?: string;
}

export interface BatchPowerResult {
  success: boolean;
  results: {
    id: string;
    ok: boolean;
    error?: string;
    skipped?: boolean;
    mac?: string;
    broadcast?: string;
  }[];
}

/** Gracefully shut down a single Spark (host script: spark-shutdown). */
export function shutdownSpark(id: string): Promise<PowerResult> {
  return apiFetch(`/api/sparks/${id}/shutdown`, { method: "POST" });
}

/** Send a Wake-on-LAN magic packet to a single Spark. */
export function wakeSpark(id: string): Promise<PowerResult> {
  return apiFetch(`/api/sparks/${id}/wake`, { method: "POST" });
}

/** Shut down Sparks that are currently online. */
export function shutdownAllSparks(): Promise<BatchPowerResult> {
  return apiFetch("/api/sparks/shutdown-all", { method: "POST" });
}

/** Send WoL to all registered Sparks that have a MAC configured. */
export function wakeAllSparks(): Promise<BatchPowerResult> {
  return apiFetch("/api/sparks/wake-all", { method: "POST" });
}

// ─── Hermes update preview ───────────────────────────────
/** Per-Spark update preview (release + pending commits + resolved view). */
export function fetchHermesUpdates(id: string): Promise<HermesUpdatesResponse> {
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/hermes/updates`);
}

// ─── Global settings ──────────────────────────────────────
export function fetchSettings(): Promise<Settings> {
  return apiFetch("/api/settings");
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return apiFetch("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

// ─── Analysis traces (Part A) ─────────────────────────────
export function listTraces(params: {
  sparkId?: string;
  port?: number;
  source?: string;
  method?: string;
  since?: number;
  limit?: number;
} = {}): Promise<TraceListResponse> {
  const q = new URLSearchParams();
  if (params.sparkId) q.set("sparkId", params.sparkId);
  if (params.port != null) q.set("port", String(params.port));
  if (params.source && params.source !== "all") q.set("source", params.source);
  if (params.method) q.set("method", params.method);
  if (params.since != null) q.set("since", String(params.since));
  if (params.limit != null) q.set("limit", String(params.limit));
  const qs = q.toString();
  return apiFetch(`/api/traces${qs ? `?${qs}` : ""}`);
}

export function getTrace(id: string): Promise<TraceEntry> {
  return apiFetch(`/api/traces/${encodeURIComponent(id)}`);
}

export function clearTraces(): Promise<{ success: boolean }> {
  return apiFetch("/api/traces", { method: "DELETE" });
}

// ─── Model ops + serving (Part B) ─────────────────────────
export function listNasModels(opts?: { force?: boolean }): Promise<InventoryResponse> {
  return apiFetch(opts?.force ? "/api/models/nas?force=1" : "/api/models/nas");
}

export function listNodeModels(sparkId: string): Promise<InventoryResponse> {
  return apiFetch(`/api/sparks/${encodeURIComponent(sparkId)}/models`);
}

export function modelctlStatus(sparkId: string, force = false): Promise<ModelctlStatus> {
  return apiFetch(`/api/sparks/${encodeURIComponent(sparkId)}/modelctl${force ? "?force=1" : ""}`);
}

export function startJob(body: {
  kind: JobKind;
  repo?: string;
  name?: string;
  quantization?: string;
  revision?: string;
  sparkId?: string;
  model?: string;
  sourceSparkId?: string;
  targetSparkId?: string;
  /** queue kind only: validated downloads.yaml entries (server builds the YAML) */
  entries?: NasQueueEntry[];
  /** queue kind only: parallel modelctl jobs (1|2|4) */
  jobs?: number;
}): Promise<{ jobId: string; kind: JobKind; sparkId: string }> {
  return apiFetch("/api/jobs", { method: "POST", body: JSON.stringify(body) });
}

export function listJobs(): Promise<{ jobs: MctlJob[] }> {
  return apiFetch("/api/jobs");
}

export function getJob(jobId: string): Promise<MctlJob> {
  return apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelJob(jobId: string): Promise<MctlJob> {
  return apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

export function listServingScripts(): Promise<{ scripts: ServingScript[] }> {
  return apiFetch("/api/serving/scripts");
}

export function servingStart(body: {
  sparkId?: string;
  scriptId: string;
  modelName?: string;
  port: number;
  extraArgs?: string;
}): Promise<{ success: boolean; sparkId: string; scriptId: string; port: number }> {
  return apiFetch("/api/serving/start", { method: "POST", body: JSON.stringify(body) });
}

export function servingStop(body: { sparkId?: string; scriptId?: string } = {}): Promise<{ success: boolean; running: boolean }> {
  return apiFetch("/api/serving/stop", { method: "POST", body: JSON.stringify(body) });
}

export function servingStatus(sparkId?: string, scriptId?: string): Promise<ServingStatus> {
  const q = new URLSearchParams();
  if (sparkId) q.set("sparkId", sparkId);
  if (scriptId) q.set("scriptId", scriptId);
  const qs = q.toString();
  return apiFetch(`/api/serving/status${qs ? `?${qs}` : ""}`);
}

export function servingLog(sparkId?: string, scriptId?: string, bytes = 4000): Promise<{ sparkId: string; scriptId: string; log: string }> {
  const q = new URLSearchParams();
  if (sparkId) q.set("sparkId", sparkId);
  if (scriptId) q.set("scriptId", scriptId);
  q.set("bytes", String(bytes));
  return apiFetch(`/api/serving/log?${q.toString()}`);
}

export function servingPlacement(model: string, sparkId?: string): Promise<Placement> {
  const q = new URLSearchParams({ model });
  if (sparkId) q.set("sparkId", sparkId);
  return apiFetch(`/api/serving/placement?${q.toString()}`);
}

// ─── Agent (Part C) ───────────────────────────────────────
export function agentStatus(sparkId: string): Promise<{
  sparkId: string;
  agentEnabled: boolean;
  connected: boolean;
  transport: "agent" | "ssh";
  agentVersion: string | null;
}> {
  return apiFetch(`/api/sparks/${encodeURIComponent(sparkId)}/agent`);
}

export function rotateAgentToken(): Promise<{ success: boolean; tokenConfigured: boolean; notified: number }> {
  return apiFetch("/api/agent/token/rotate", { method: "POST" });
}

// ─── NAS node (kind "nas") ─────────────────────────────────
/** Latest modelctl GitHub release (server 15-min cache; never throws upstream). */
export function fetchModelctlRelease(): Promise<ModelctlRelease> {
  return apiFetch("/api/modelctl/release");
}

/** `modelctl doctor --json` on the NAS spark (server-cached 60 s; force=1 busts it). */
export function runNasDoctor(force = false): Promise<NasDoctorResponse> {
  return apiFetch(`/api/modelctl/doctor${force ? "?force=1" : ""}`);
}

/** catalog.json read on the NAS spark. */
export function fetchNasCatalog(): Promise<NasCatalogResponse> {
  return apiFetch("/api/modelctl/catalog");
}

/** path + serve-command + RUN.md excerpt for one active model. */
export function fetchNasModelDetail(model: string): Promise<NasModelDetail> {
  return apiFetch(`/api/modelctl/nas/${encodeURIComponent(model)}/detail`);
}

/** Dry-run delete plan (stdout of `modelctl delete NAME --root R`). */
export function fetchNasDeletePlan(model: string): Promise<NasDeletePlan> {
  return apiFetch(`/api/modelctl/nas/${encodeURIComponent(model)}/delete-plan`);
}
