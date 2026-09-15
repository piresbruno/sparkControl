import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
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
  getJob: vi.fn(),
  serveMatrix: vi.fn(),
  startJob: vi.fn(),
}));

import {
  listServeRecipes,
  serveDeploymentAction,
  serveState,
  serveLogs,
  getJob,
  serveMatrix,
  startJob,
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

const matrixResp = () => ({
  nodes: [
    { sparkId: "spark-1", name: "DGX 1" },
    { sparkId: "dgx-2", name: "DGX 2" },
  ],
  models: [
    {
      key: "glm", name: "glm", runtime: "vllm", repository: "org/GLM", bytes: 1.76e11,
      nas: "active" as const, nodes: { "spark-1": "current" as const, "dgx-2": "absent" as const },
      servedOn: ["spark-1"],
    },
    {
      key: "qwen", name: "qwen", runtime: null, repository: "org/Qwen", bytes: 4e10,
      nas: "absent" as const, nodes: { "spark-1": "absent" as const, "dgx-2": "absent" as const },
      servedOn: [],
    },
  ],
  capacity: {},
  at: Date.now(),
});

beforeEach(() => {
  vi.mocked(listServeRecipes).mockResolvedValue({ recipes: [recipe()] });
  vi.mocked(serveState).mockResolvedValue({ states: [state()], at: Date.now() });
  vi.mocked(serveLogs).mockResolvedValue({ log: "line one" });
  vi.mocked(serveDeploymentAction).mockResolvedValue({ jobId: "job-1" });
  vi.mocked(getJob).mockResolvedValue({ jobId: "job-1", kind: "sync", name: "s", sparkId: "spark-a", status: "completed", createdAt: 1, startedAt: 1, endedAt: 2, exitCode: 0, logTail: "done" } as never);
  vi.mocked(startJob).mockResolvedValue({ jobId: "job-t", kind: "sync", sparkId: "spark-a" } as never);
  vi.mocked(serveMatrix).mockResolvedValue(matrixResp());
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
    // endpoints: direct + proxy + cluster (P4 gateway) rows
    expect(screen.getByText("http://10.0.0.1:8081/v1")).toBeTruthy();
    expect(screen.getByText(new RegExp("/llm/cluster/GLM-5.3-Flash-EXL3/v1$"))).toBeTruthy();
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

  it("a placement 409 opens the blocked dialog with runnable remediation + force", async () => {
    const user = userEvent.setup();
    vi.mocked(serveState).mockResolvedValue({
      states: [state({ state: "stopped", ranks: { CONTAINER_HEAD: "absent" } })],
      at: Date.now(),
    });
    const blockedErr = Object.assign(new Error('model "org/GLM" is not on spark-1'), {
      status: 409,
      payload: {
        blocked: true,
        placement: {
          status: "sync",
          remediations: [{ kind: "sync", sparkId: "spark-1", targetSparkId: "spark-1", model: "glm-store" }],
        },
      },
    });
    vi.mocked(serveDeploymentAction).mockRejectedValueOnce(blockedErr);
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    await user.click(await screen.findByText("▶ start"));
    expect(await screen.findByText("Weights not on the node")).toBeTruthy();
    // P3: the remediation is runnable, and carries the resolved store name
    expect(screen.getByText(/sync glm-store · NAS →/)).toBeTruthy();
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "▶ run" }));
    await waitFor(() =>
      expect(startJob).toHaveBeenCalledWith({ kind: "sync", model: "glm-store", sparkId: "spark-1" })
    );
    // force path still escapes
    await user.click(screen.getByText("Pull from HF anyway (force)"));
    await waitFor(() =>
      expect(serveDeploymentAction).toHaveBeenCalledWith("glm-abcdef", "start", { force: true })
    );
    await waitFor(() => expect(screen.queryByText("Weights not on the node")).toBeNull());
  });

  it("a topology 409 opens the hard refusal (no force path)", async () => {
    const user = userEvent.setup();
    vi.mocked(serveState).mockResolvedValue({
      states: [state({ state: "stopped", ranks: { CONTAINER_HEAD: "absent" } })],
      at: Date.now(),
    });
    vi.mocked(serveDeploymentAction).mockRejectedValueOnce(
      Object.assign(new Error("variant wants 4 nodes, cluster has 2 compute nodes"), {
        status: 409,
        payload: { topology: { nnodes: 4, computeNodes: 2 } },
      })
    );
    render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
    await user.click(await screen.findByText("▶ start"));
    expect(await screen.findByText("Topology too big for this cluster")).toBeTruthy();
    expect(screen.getByText(/cannot be forced/)).toBeTruthy();
    expect(screen.queryByText("Pull from HF anyway (force)")).toBeNull();
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

  describe("CH·03 placement matrix", () => {
    it("renders per-node columns with served/present/absent chips", async () => {
      render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
      expect(await screen.findByText("CH·03")).toBeTruthy();
      // glm: current+served on spark-1, absent on dgx-2; qwen absent everywhere
      expect(await screen.findByText("served")).toBeTruthy();
      expect(screen.getAllByText("absent").length).toBeGreaterThan(2);
      expect(screen.getByText("in store")).toBeTruthy();
      expect(screen.getByText(/176.0 GB/)).toBeTruthy();
    });

    it("runs a push remediation for a node missing a peer-held model", async () => {
      const user = userEvent.setup();
      vi.mocked(serveMatrix).mockResolvedValue({
        ...matrixResp(),
        models: [
          {
            key: "glm", name: "glm", runtime: "vllm", repository: "org/GLM", bytes: null,
            nas: "absent", nodes: { "spark-1": "current", "dgx-2": "absent" }, servedOn: [],
          },
        ],
      } as never);
      render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
      const run = await screen.findByRole("button", { name: "▶ run" });
      await user.click(run);
      await waitFor(() =>
        expect(startJob).toHaveBeenCalledWith({
          kind: "push", model: "glm", sparkId: "spark-1", targetSparkId: "dgx-2",
        })
      );
    });

    it("offers no-source when neither NAS nor a peer holds the model", async () => {
      vi.mocked(serveMatrix).mockResolvedValue({
        ...matrixResp(),
        models: [
          {
            key: "solo", name: "solo", runtime: null, repository: "org/Solo", bytes: null,
            nas: "absent", nodes: { "spark-1": "absent", "dgx-2": "absent" }, servedOn: [],
          },
        ],
      } as never);
      render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
      // one "no source" affordance per missing node (2 nodes here)
      expect((await screen.findAllByText(/no source/)).length).toBe(2);
      expect(screen.queryByRole("button", { name: "▶ run" })).toBeNull();
    });

    it("filters models by query", async () => {
      const user = userEvent.setup();
      render(<ServePage sparks={sparks} onNavigate={vi.fn()} />);
      await screen.findByText("served");
      await user.type(screen.getByPlaceholderText("filter models…"), "qwen");
      expect(screen.queryByText("served")).toBeNull();
    });
  });
});
