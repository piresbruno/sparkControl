import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelsPage } from "./ModelsPage";

vi.mock("../../api/client", () => ({
  listNasModels: vi.fn(),
  listNodeModels: vi.fn(),
  modelctlStatus: vi.fn(),
  startJob: vi.fn(),
  listJobs: vi.fn(),
  cancelJob: vi.fn(),
  listServingScripts: vi.fn(),
  servingStart: vi.fn(),
  servingStop: vi.fn(),
  servingStatus: vi.fn(),
  servingLog: vi.fn(),
  fetchSparks: vi.fn(),
}));

import {
  listNasModels,
  listNodeModels,
  modelctlStatus,
  startJob,
  listJobs,
  listServingScripts,
  servingStatus,
  servingLog,
  servingStart,
  fetchSparks,
} from "../../api/client";

const sparkCfg = (id: string, name: string) => ({
  id,
  name,
  lanIp: "10.0.0.5",
  isLocal: false,
  ssh: { host: "10.0.0.5", user: "root", auth: "key" as const },
  modelctlEnabled: true,
  llmPorts: [8888],
});

beforeEach(() => {
  vi.mocked(fetchSparks).mockResolvedValue({ sparks: [sparkCfg("a", "Alpha"), sparkCfg("b", "Beta")] });
  vi.mocked(listNasModels).mockResolvedValue({
    models: [{ name: "m1", runtime: "gguf", repository: "o/m1", bytes: 10 ** 9 }],
  });
  vi.mocked(listNodeModels).mockImplementation(async (sparkId: string) =>
    sparkId === "a"
      ? { models: [{ name: "m1", runtime: "gguf", repository: "o/m1", bytes: null }] }
      : { models: [] }
  );
  vi.mocked(modelctlStatus).mockResolvedValue({
    installed: true,
    version: "0.13.0",
    uv: { installed: true, version: "0.5.0" },
  });
  vi.mocked(listJobs).mockResolvedValue({ jobs: [] });
  vi.mocked(listServingScripts).mockResolvedValue({
    scripts: [{ id: "example-vllm", description: "vLLM", defaultPort: 8080 }],
  });
  vi.mocked(servingStatus).mockResolvedValue({ sparkId: "a", running: false });
  vi.mocked(servingLog).mockResolvedValue({ sparkId: "a", scriptId: "example-vllm", log: "" });
});

afterEach(() => vi.restoreAllMocks());

describe("ModelsPage", () => {
  it("renders NAS catalog and node matrix badges", async () => {
    render(<ModelsPage />);
    await waitFor(() => expect(screen.getAllByText("m1").length).toBeGreaterThan(0));
    expect(screen.getAllByText("0.9").length).toBeGreaterThan(0); // 1e9 bytes → 0.9 GB
    await waitFor(() => expect(screen.getByText("present")).toBeTruthy());
    expect(screen.getAllByText(/absent/).length).toBeGreaterThan(0);
  });

  it("Sync button in an absent cell queues a sync job via startJob", async () => {
    const user = userEvent.setup();
    vi.mocked(startJob).mockResolvedValue({ jobId: "j1", kind: "sync", sparkId: "b" });
    render(<ModelsPage />);
    await waitFor(() => expect(screen.getAllByText(/absent/).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole("button", { name: "Sync" })[0]);
    await waitFor(() => expect(startJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "sync", sparkId: "b" })));
  });

  it("Push button sources from the peer that has the model", async () => {
    const user = userEvent.setup();
    vi.mocked(startJob).mockResolvedValue({ jobId: "j2", kind: "push", sparkId: "b" });
    render(<ModelsPage />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Push from Alpha" }).length).toBeGreaterThan(0));
    await user.click(screen.getAllByRole("button", { name: "Push from Alpha" })[0]);
    await waitFor(() =>
      expect(startJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "push", sparkId: "b", sourceSparkId: "a" }))
    );
  });

  it("modelctl availability badge renders version", async () => {
    render(<ModelsPage />);
    await waitFor(() => expect(screen.getAllByText("v0.13.0").length).toBeGreaterThan(0));
  });

  it("serving start posts script + port (defaultPort prefilled)", async () => {
    const user = userEvent.setup();
    vi.mocked(startJob).mockResolvedValue({ jobId: "j", kind: "sync", sparkId: "a" });
    const { container } = render(<ModelsPage />);
    // Wait for serving scripts + spark list to load, then pick the script.
    await waitFor(() => expect((screen.getAllByRole("combobox", { name: "Runs on" })[0] as HTMLSelectElement).options.length).toBeGreaterThan(0), { timeout: 3000 });
    const scriptSelect = await waitFor(() => {
      const el = screen.getAllByRole("combobox", { name: "Script" })[0] as HTMLSelectElement;
      const opts = Array.from(el.options).map((o) => o.value);
      if (!opts.includes("example-vllm")) throw new Error("scripts not loaded yet");
      return el;
    }, { timeout: 3000 });
    await user.selectOptions(scriptSelect, "example-vllm");
    const portInput = await waitFor(() => {
      const el = screen.getAllByPlaceholderText("port")[0] as HTMLInputElement;
      if (el.value !== "8080") throw new Error("port not prefilled yet");
      return el;
    }, { timeout: 3000 });
    await waitFor(() => {
      const startBtns = screen.getAllByRole("button", { name: "Start" }) as HTMLButtonElement[];
      expect(startBtns.some((b) => !b.disabled)).toBe(true);
    });
    const btn = await waitFor(() => {
      const b = screen.getAllByRole("button", { name: "Start" }) as HTMLButtonElement[];
      const enabled = b.filter((x) => !x.disabled);
      if (enabled.length === 0) throw new Error("start still disabled");
      return enabled[enabled.length - 1];
    }, { timeout: 3000 });
    await user.click(btn);
    // modelName empty → servingStart called without model
    await waitFor(() => expect(vi.mocked(servingStart).mock.calls.length).toBeGreaterThan(0), { timeout: 3000 });
    expect(vi.mocked(servingStart).mock.calls[0][0]).toMatchObject({ scriptId: "example-vllm", port: 8080 });
  });
});
