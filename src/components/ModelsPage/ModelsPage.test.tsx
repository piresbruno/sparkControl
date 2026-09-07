import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelsPage } from "./ModelsPage";

vi.mock("../../api/client", () => ({
  listNasModels: vi.fn(),
  listJobs: vi.fn(),
  startJob: vi.fn(),
  modelctlStatus: vi.fn(),
  fetchSparks: vi.fn(),
}));

import { listNasModels, listJobs, startJob, modelctlStatus, fetchSparks } from "../../api/client";

beforeEach(() => {
  vi.mocked(fetchSparks).mockResolvedValue({
    sparks: [
      {
        id: "nas",
        name: "NASHost",
        lanIp: "10.0.0.5",
        isLocal: false,
        ssh: { host: "10.0.0.5", user: "root", auth: "key" as const },
        modelctlEnabled: true,
      },
    ],
  });
  vi.mocked(listNasModels).mockResolvedValue({
    models: [
      { name: "qwen3-32b-q4", runtime: "exl3", repository: "unquantized/Qwen3-32B", bytes: 1.2 * 1024 ** 3 * 1000 },
      { name: "glm-4.5-air", runtime: "vllm", repository: "zai-org/GLM-4.5-Air", bytes: null },
    ],
  });
  vi.mocked(listJobs).mockResolvedValue({ jobs: [] });
  vi.mocked(startJob).mockResolvedValue({ jobId: "j1", kind: "download" } as never);
  vi.mocked(modelctlStatus).mockResolvedValue({
    installed: true,
    version: "0.13.0",
    uv: { installed: true, version: "0.5.0" },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ModelsPage — NAS catalog only", () => {
  it("renders the catalog table with runtime chips, repo, size, and delete per row", async () => {
    render(<ModelsPage />);
    await waitFor(() => expect(screen.getByText("qwen3-32b-q4")).toBeTruthy());
    expect(screen.getByText("exl3")).toBeTruthy();
    expect(screen.getByText("vllm")).toBeTruthy();
    expect(screen.getByText("unquantized/Qwen3-32B")).toBeTruthy();
    expect(screen.getByText("1200.0")).toBeTruthy(); // 1.2 TB
    expect(screen.getAllByRole("button", { name: "Delete" }).length).toBe(2);
    // Summary chip reflects the catalog
    expect(screen.getByText(/2 models/)).toBeTruthy();
  });

  it("download form posts a download job with repo/name/quant/revision", async () => {
    const user = userEvent.setup();
    render(<ModelsPage />);
    const toggle = await screen.findByRole("button", { name: /Download from Hugging Face/ });
    await user.click(toggle);
    await user.type(screen.getByLabelText("HF repo (org/model)"), "org/newmodel");
    await user.type(screen.getByLabelText("Name (optional)"), "newmodel-q4");
    await user.type(screen.getByLabelText("Quantization"), "Q4_K_M");
    await user.click(screen.getByRole("button", { name: /^Download$/ }));
    await waitFor(() =>
      expect(startJob).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "download",
          repo: "org/newmodel",
          name: "newmodel-q4",
          quantization: "Q4_K_M",
        })
      )
    );
  });

  it("delete runs on the NAS host machine via the nas-delete job kind", async () => {
    const user = userEvent.setup();
    vi.mocked(startJob).mockResolvedValue({ jobId: "j2", kind: "nas-delete" } as never);
    render(<ModelsPage />);
    await waitFor(() => expect(screen.getByText("qwen3-32b-q4")).toBeTruthy());
    await user.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    await waitFor(() =>
      expect(startJob).toHaveBeenCalledWith(expect.objectContaining({ kind: "nas-delete", model: "qwen3-32b-q4" }))
    );
  });

  it("no per-node matrix, no node select, no serving controls", async () => {
    render(<ModelsPage />);
    await waitFor(() => expect(screen.getByText(/NAS catalog/)).toBeTruthy());
    expect(screen.queryByText(/present/)).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Runs on" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Script" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Push from/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("server-side inventory error surfaces in the empty state", async () => {
    vi.mocked(listNasModels).mockResolvedValue({ models: [], error: "nasRoot not configured" });
    render(<ModelsPage />);
    await waitFor(() => expect(screen.getByText("nasRoot not configured")).toBeTruthy());
  });
});
