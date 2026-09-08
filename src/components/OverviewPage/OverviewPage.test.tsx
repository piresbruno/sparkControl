import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { OverviewPage } from "./OverviewPage";

vi.mock("../../api/client", () => ({
  shutdownAllSparks: vi.fn(),
  updateAllHermes: vi.fn(),
  wakeAllSparks: vi.fn(),
  modelctlStatus: vi.fn(),
  listNasModels: vi.fn(),
  listJobs: vi.fn(),
  fetchModelctlRelease: vi.fn(),
  fetchNasCatalog: vi.fn(),
}));

import {
  fetchModelctlRelease,
  fetchNasCatalog,
  listJobs,
  listNasModels,
  modelctlStatus,
} from "../../api/client";
import type { LlmMetrics, ModelctlStatus, SparkSnapshot } from "../../api/types";

const llm = (
  over: Partial<LlmMetrics> & { modelId?: string; backend?: string; available?: boolean }
): LlmMetrics =>
  ({
    available: true,
    backend: "vllm",
    modelId: "Qwen3-32B-Q4",
    generationTps: 12.5,
    prefillTps: 100,
    ...over,
  }) as LlmMetrics;

function snap(id: string, over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  const { metrics: overMetrics, ...rest } = over;
  return {
    id,
    name: over.name ?? id.toUpperCase(),
    online: true,
    uptime: 100,
    disabledDevices: [],
    disabledInterfaces: [],
    llmPort: 8888,
    llmPorts: [8888],
    hardware: {} as SparkSnapshot["hardware"],
    metrics: {
      gpu: {
        temperature: 40,
        usage: 10,
        power: { draw: 20, limit: 120 },
        vram: { used: 1000, total: 120000, percentage: 1, available: 100000 },
      },
      cpu: null,
      ram: null,
      storage: [],
      network: null,
      unifiedMemory: null,
      llm: [],
      ...overMetrics,
    } as SparkSnapshot["metrics"],
    ...rest,
  } as SparkSnapshot;
}

beforeEach(() => {
  vi.mocked(modelctlStatus).mockResolvedValue({
    installed: true,
    version: "0.13.0",
    uv: { installed: true, version: "0.5.0" },
  });
  vi.mocked(listNasModels).mockResolvedValue({ models: [] });
  vi.mocked(listJobs).mockResolvedValue({ jobs: [] });
  vi.mocked(fetchModelctlRelease).mockResolvedValue({
    latest: null,
    publishedAt: null,
    checkedAt: Date.now(),
  });
  vi.mocked(fetchNasCatalog).mockResolvedValue({ error: "no catalog" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OverviewPage worker attribution", () => {
  it("worker card shows head name, model served by the head, and modelctl version", async () => {
    const head = snap("h1", {
      name: "HeadSpark",
      role: "head",
      metrics: { llm: [llm({})] } as SparkSnapshot["metrics"],
    });
    const worker = snap("w1", {
      name: "WorkerOne",
      role: "worker",
      workerHeadId: "h1",
      modelctlEnabled: true,
    });
    render(<OverviewPage sparks={[head, worker]} temperatureUnit="celsius" />);

    // Head identity is visible on the worker card itself, not only a tooltip
    // (the head's own card title is the second match).
    await waitFor(() => expect(screen.getAllByText("HeadSpark").length).toBe(2));
    // Serving model comes from the head's engine probe — shown on the head's
    // own stat and attributed on the worker card (2 matches).
    expect(screen.getAllByText("Qwen3-32B-Q4").length).toBe(2);
    expect(screen.getAllByText("vLLM").length).toBe(2);
    // modelctl version fetched once for the opt-in worker only.
    await waitFor(() => expect(screen.getByText("v0.13.0")).toBeTruthy());
    expect(modelctlStatus).toHaveBeenCalledTimes(1);
    expect(modelctlStatus).toHaveBeenCalledWith("w1");
  });

  it("worker falls back to its own detection probe; shows not-installed when modelctl missing", async () => {
    vi.mocked(modelctlStatus).mockResolvedValue({
      installed: false,
      version: null,
      uv: { installed: false, version: null },
    });
    const worker = snap("w2", {
      name: "Solo",
      role: "worker",
      workerHeadId: null,
      workerLabel: "Team X",
      modelctlEnabled: true,
      llmPorts: [8181],
      metrics: {
        llm: [llm({ backend: "llama.cpp", modelId: "Mistral-7B" })],
      } as SparkSnapshot["metrics"],
    });
    render(<OverviewPage sparks={[worker]} temperatureUnit="celsius" />);

    // No registered head → the cluster label is shown instead.
    await waitFor(() => expect(screen.getByText("Team X")).toBeTruthy());
    expect(screen.getByText("Mistral-7B")).toBeTruthy();
    expect(screen.getByText("not installed")).toBeTruthy();
  });

  it("offline worker: card shows no stats and NO probe request is fired", async () => {
    const worker = snap("w3", {
      name: "Down",
      role: "worker",
      workerHeadId: null,
      modelctlEnabled: true,
      online: false,
    });
    render(<OverviewPage sparks={[worker]} temperatureUnit="celsius" />);
    await waitFor(() => expect(screen.getByText("Host unreachable")).toBeTruthy());
    // The real offline contract: the probe effect must never fire for
    // offline nodes (the stats grid isn't rendered at all, so asserting
    // absent version text would be vacuous).
    await new Promise((r) => setTimeout(r, 50));
    expect(modelctlStatus).not.toHaveBeenCalled();
  });

  it("probe response survives the next WS tick (fresh sparks array)", async () => {
    // Regression (PR #5 review): the effect's cleanup set cancelled=true on
    // every re-run and the requested-set blocked retries, so a response
    // landing after the next snapshot tick was permanently discarded —
    // cards stuck at "checking…" forever.
    let resolveProbe: (v: ModelctlStatus) => void = () => {};
    vi.mocked(modelctlStatus).mockReturnValue(
      new Promise((res) => {
        resolveProbe = res;
      })
    );
    const worker = snap("w4", { role: "worker", workerHeadId: "h1", modelctlEnabled: true });
    const head = snap("h1", { role: "head" });
    const { rerender } = render(
      <OverviewPage sparks={[head, worker]} temperatureUnit="celsius" />
    );
    await waitFor(() => expect(modelctlStatus).toHaveBeenCalledWith("w4"));
    // New tick: a brand-new array identity (what useSnapshot produces every
    // ~2s) re-runs the effect; then the slow probe finally lands.
    rerender(<OverviewPage sparks={[head, snap("w4", { role: "worker", workerHeadId: "h1", modelctlEnabled: true })]} temperatureUnit="celsius" />);
    resolveProbe({ installed: true, version: "0.13.0", uv: { installed: true, version: "0.5.0" } });
    await waitFor(() => expect(screen.getByText("v0.13.0")).toBeTruthy());
  });

  it("head card keeps showing its own served model and never fetches modelctl", async () => {
    const head = snap("h2", {
      name: "Boss",
      role: "head",
      metrics: { llm: [llm({ modelId: "Llama-70B" })] } as SparkSnapshot["metrics"],
    });
    render(<OverviewPage sparks={[head]} temperatureUnit="celsius" />);
    await waitFor(() => expect(screen.getByText("Llama-70B")).toBeTruthy());
    expect(modelctlStatus).not.toHaveBeenCalled();
  });
});

describe("OverviewPage NAS card", () => {
  const nasSnap = () =>
    snap("nas1", {
      name: "vault",
      kind: "nas",
      nasRoot: "/mnt/nas/llm-models",
      modelctlEnabled: true,
      metrics: {
        gpu: null,
        storage: [
          {
            device: "cifs",
            label: "/mnt/nas",
            used: 10 * 1024 * 1024, // MB → 10 TB
            total: 16.5 * 1024 * 1024,
            available: 6.5 * 1024 * 1024,
            percentage: 61,
            readSpeed: 0,
            writeSpeed: 0,
          },
        ],
      } as unknown as SparkSnapshot["metrics"],
    });

  it("shows store capacity + model count and NO VRAM bars", async () => {
    vi.mocked(listNasModels).mockResolvedValue({
      models: [
        { name: "a", runtime: "vllm", repository: "x/a", bytes: 1 },
        { name: "b", runtime: null, repository: null, bytes: null },
        { name: "c", runtime: null, repository: null, bytes: null },
      ],
    });
    render(<OverviewPage sparks={[nasSnap()]} temperatureUnit="celsius" />);
    await waitFor(() => expect(screen.getByText("3 models")).toBeTruthy());
    // Store gauge in TB voice from the mount matching nasRoot
    expect(screen.getByText("10.0 TB / 16.5 TB")).toBeTruthy();
    expect(screen.getByText("6.5 TB free")).toBeTruthy();
    expect(screen.getByTitle("Model-store node — serves nothing")).toBeTruthy();
    // No GPU/VRAM language anywhere on a store card
    expect(screen.queryByText(/VRAM/i)).toBeNull();
    expect(screen.queryByText(/Temperature/i)).toBeNull();
    expect(screen.queryByText(/Usage/i)).toBeNull();
    // the store node gets a modelctl probe
    await waitFor(() => expect(modelctlStatus).toHaveBeenCalledWith("nas1"));
  });

  it("amber update affordance navigates to the node page", async () => {
    vi.mocked(fetchModelctlRelease).mockResolvedValue({
      latest: "v0.18.0",
      publishedAt: null,
      checkedAt: Date.now(),
    });
    const onSelect = vi.fn();
    render(<OverviewPage sparks={[nasSnap()]} temperatureUnit="celsius" onSelectSpark={onSelect} />);
    const link = await screen.findByTitle(
      "A modelctl update is available — open the node page to run the update job"
    );
    expect(link.textContent).toContain("v0.18.0 · update →");
    link.click();
    expect(onSelect).toHaveBeenCalledWith("nas1");
  });

  it("running queue job surfaces on the card", async () => {
    vi.mocked(listJobs).mockResolvedValue({
      jobs: [
        {
          jobId: "j1",
          kind: "queue",
          name: "queue downloads (2)",
          sparkId: "nas1",
          status: "running",
          createdAt: Date.now(),
          startedAt: Date.now(),
          endedAt: null,
          exitCode: null,
          logTail: "staging deepseek 41%",
        },
      ] as never,
    });
    render(<OverviewPage sparks={[nasSnap()]} temperatureUnit="celsius" />);
    const pill = await screen.findByText("running");
    expect(pill.className).toContain("bench-status-pill--running");
    expect(screen.getByText("queue downloads (2)")).toBeTruthy();
  });
});
