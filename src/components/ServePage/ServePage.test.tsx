import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServePage } from "./ServePage";
import type { ServeRecipe, ServeState } from "../../api/types";

vi.mock("../../api/client", () => ({
  listServeRecipes: vi.fn(),
  registerServeRecipe: vi.fn(),
  scanServeRecipes: vi.fn(),
  refreshServeRecipe: vi.fn(),
  deleteServeRecipe: vi.fn(),
  serveDeploymentAction: vi.fn(),
  serveState: vi.fn(),
  serveLogs: vi.fn(),
  setLlmApiKey: vi.fn(),
}));

import {
  listServeRecipes,
  serveDeploymentAction,
  serveState,
  serveLogs,
} from "../../api/client";

const recipe = (over: Partial<ServeRecipe> = {}): ServeRecipe => ({
  id: "glm-abcdef",
  sparkId: "spark-1",
  path: "/home/me/recipes/GLM-5.3-Flash-EXL3-2x-DGX-Sparks",
  label: "glm tp2",
  entry: "start.sh",
  meta: {
    port: 8081,
    model: "org/GLM",
    modelFallback: null,
    dflashModel: null,
    servedName: "GLM-5.3-Flash-EXL3",
    headIp: "10.0.0.1",
    workerIp: "10.0.0.2",
    workerUser: null,
    nnodes: 2,
    tp: 2,
    readyTimeoutS: 3600,
    maxModelLen: null,
    image: "ghcr.io/x/y:tag",
    containers: { CONTAINER_HEAD: "glm-head", CONTAINER_WORKER: "glm-worker" },
    containersByEntry: { "start.sh": { CONTAINER_HEAD: "glm-head", CONTAINER_WORKER: "glm-worker" } },
    secretPresence: { VLLM_API_KEY: true },
    entry: "start.sh",
    variants: [{ rel: "start-tp4.sh", name: "tp4" }],
    class: "repo",
    verbs: ["start", "stop", "status", "logs"],
  },
  versions: { gitHead: "cafe1234567890", dirtyBuild: false, probedAt: Date.now() },
  files: ["start.sh"],
  orphaned: false,
  probeError: null,
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const state = (over: Partial<ServeState> = {}): ServeState => ({
  recipeId: "glm-abcdef",
  sparkId: "spark-1",
  path: "/home/me/recipes/GLM-5.3-Flash-EXL3-2x-DGX-Sparks",
  label: "glm tp2",
  variant: null,
  port: 8081,
  servedName: "GLM-5.3-Flash-EXL3",
  model: "org/GLM",
  topology: { nnodes: 2, tp: 2, workerIp: "10.0.0.2", workerSparkId: "dgx-2" },
  version: { gitHead: "cafe1234567890", dirtyBuild: false, probedAt: Date.now() },
  orphaned: false,
  probeError: null,
  ranks: { CONTAINER_HEAD: "running", CONTAINER_WORKER: "running" },
  engine: { health: 200, modelsRaw: null, dockerError: null },
  state: "healthy",
  drift: { drift: false },
  ...over,
});

const sparks = [
  { id: "spark-1", name: "DGX 1", kind: "spark", online: true, lanIp: "10.0.0.1", llmApiKeyPorts: [] },
  { id: "dgx-2", name: "DGX 2", kind: "spark", online: true, lanIp: "10.0.0.2", llmApiKeyPorts: [] },
] as never;

beforeEach(() => {
  vi.mocked(listServeRecipes).mockResolvedValue({ recipes: [recipe()] });
  vi.mocked(serveState).mockResolvedValue({ states: [state()], at: Date.now() });
  vi.mocked(serveLogs).mockResolvedValue({ log: "line one" });
  vi.mocked(serveDeploymentAction).mockResolvedValue({ jobId: "job-1" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ServePage — cluster deployments table", () => {
  it("renders a deployment row with state, endpoints, and verbs", async () => {
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    // the label renders once per section (deployments row + recipes row)
    await waitFor(() => expect(screen.getAllByText("glm tp2").length).toBeGreaterThan(0));
    // topology + port + served model
    expect(screen.getAllByText("TP2 · 2 nodes").length).toBeGreaterThan(0);
    // port shows in the port cell + endpoints + recipes meta (many places)
    expect(screen.getAllByText(/8081/).length).toBeGreaterThan(1);
    expect(screen.getByText("GLM-5.3-Flash-EXL3")).toBeTruthy();
    // healthy join from state poll
    expect(screen.getAllByText("healthy").length).toBeGreaterThan(0);
    // endpoints: direct + proxy rows
    expect(screen.getByText("http://10.0.0.1:8081/v1")).toBeTruthy();
    expect(screen.getAllByText(/\/llm\/spark-1\/8081\/v1/).length).toBeGreaterThan(0);
    // live row: stop + restart present, start hidden
    expect(screen.getByText("■ stop")).toBeTruthy();
    expect(screen.queryByText("▶ start")).toBeNull();
  });

  it("■ stop arms on first click and fires on the second", async () => {
    const user = userEvent.setup();
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    const stop = await screen.findByText("■ stop");
    await user.click(stop);
    expect(screen.getByText("confirm stop")).toBeTruthy();
    expect(serveDeploymentAction).not.toHaveBeenCalled();
    await user.click(screen.getByText("confirm stop"));
    await waitFor(() =>
      expect(serveDeploymentAction).toHaveBeenCalledWith("glm-abcdef", "stop", {})
    );
  });

  it("a placement 409 from start opens the blocked dialog with remediations + force", async () => {
    const user = userEvent.setup();
    // stopped state → ▶ start visible
    vi.mocked(serveState).mockResolvedValue({
      states: [state({ state: "stopped", ranks: { CONTAINER_HEAD: "absent" } })],
      at: Date.now(),
    });
    const blockedErr = Object.assign(new Error('model "org/GLM" is not on spark-1'), {
      status: 409,
      payload: {
        blocked: true,
        placement: { status: "sync", remediations: [{ kind: "sync", sparkId: "spark-1" }] },
      },
    });
    vi.mocked(serveDeploymentAction).mockRejectedValueOnce(blockedErr);
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    await user.click(await screen.findByText("▶ start"));
    expect(await screen.findByText("Weights not on the node")).toBeTruthy();
    expect(screen.getByText(/modelctl sync-local org\/GLM/)).toBeTruthy();
    await user.click(screen.getByText("Pull from HF anyway (force)"));
    await waitFor(() =>
      expect(serveDeploymentAction).toHaveBeenCalledWith("glm-abcdef", "start", { force: true })
    );
    // dialog gone
    await waitFor(() => expect(screen.queryByText("Weights not on the node")).toBeNull());
  });

  it("drift chip renders with rebuild nuance", async () => {
    vi.mocked(serveState).mockResolvedValue({
      states: [state({ drift: { drift: true, rebuild: true } })],
      at: Date.now(),
    });
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    expect(await screen.findByText("drift · rebuild")).toBeTruthy();
  });

  it("warmup flag renders healthy · warmup, key chip reflects engine .env presence", async () => {
    vi.mocked(serveState).mockResolvedValue({
      states: [state({ warmup: true })],
      at: Date.now(),
    });
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    // StateChip renders in both sections for a live recipe — check one.
    expect((await screen.findAllByText("healthy · warmup")).length).toBeGreaterThan(0);
    // VLLM_API_KEY presence in .env, no proxy key → warn chip
    expect(await screen.findByText(/key · engine key/)).toBeTruthy();
  });

  it("expands the row into the log console (driver first, engine tab switches)", async () => {
    const user = userEvent.setup();
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    await screen.findByText("TP2 · 2 nodes"); // CH·01 row present
    await user.click(screen.getByText("▸ logs"));
    expect(await screen.findByText("line one")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^engine/ }));
    // rank tabs appear from the joined ranks
    expect(await screen.findByRole("button", { name: "worker" })).toBeTruthy();
  });

  it("unstarted recipe offers ▶ start and hides live-only affordances", async () => {
    vi.mocked(serveState).mockResolvedValue({
      states: [state({ state: "unstarted", port: 8081, ranks: null, engine: null })],
      at: Date.now(),
    });
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    expect(await screen.findByText("▶ start")).toBeTruthy();
    expect(screen.queryByText("■ stop")).toBeNull();
    // endpoints hidden for unstarted
    expect(screen.queryByText("http://10.0.0.1:8081/v1")).toBeNull();
  });

  it("orphaned recipes show node-removed and no actions", async () => {
    vi.mocked(listServeRecipes).mockResolvedValue({ recipes: [recipe({ orphaned: true })] });
    vi.mocked(serveState).mockResolvedValue({
      states: [state({ state: "orphan", orphaned: true })],
      at: Date.now(),
    });
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    expect(await screen.findByText("node removed")).toBeTruthy();
    expect(screen.queryByText("■ stop")).toBeNull();
    expect(screen.queryByText("▶ start")).toBeNull();
  });
});
