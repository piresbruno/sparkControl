import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NasPage } from "./NasPage";

vi.mock("../../api/client", () => ({
  fetchModelctlRelease: vi.fn(),
  fetchNasCatalog: vi.fn(),
  fetchNasDeletePlan: vi.fn(),
  fetchNasModelDetail: vi.fn(),
  listJobs: vi.fn(),
  listNasModels: vi.fn(),
  modelctlStatus: vi.fn(),
  runNasDoctor: vi.fn(),
  startJob: vi.fn(),
}));

import {
  fetchModelctlRelease,
  fetchNasCatalog,
  fetchNasDeletePlan,
  fetchNasModelDetail,
  listJobs,
  listNasModels,
  modelctlStatus,
  runNasDoctor,
  startJob,
} from "../../api/client";
import type { MctlJob, SparkSnapshot } from "../../api/types";

const NAS_ROOT = "/mnt/nas/llm-models";

function nasSnap(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  const { metrics: overMetrics, ...rest } = over;
  return {
    id: "nas1",
    name: "Vault",
    online: true,
    uptime: 100,
    disabledDevices: [],
    disabledInterfaces: [],
    llmPorts: [],
    hardware: {} as SparkSnapshot["hardware"],
    kind: "nas",
    nasRoot: NAS_ROOT,
    modelctlEnabled: true,
    metrics: {
      storage: [
        {
          device: "/dev/sda1",
          label: NAS_ROOT,
          used: 10 * 1024 * 1024, // 10 TB in MB
          total: 16.5 * 1024 * 1024,
          available: 6.5 * 1024 * 1024,
          percentage: 61,
        },
      ],
      ...overMetrics,
    } as SparkSnapshot["metrics"],
    ...rest,
  } as SparkSnapshot;
}

const job = (over: Partial<MctlJob>): MctlJob =>
  ({
    jobId: "j1",
    name: "job",
    kind: "queue",
    status: "running",
    sparkId: "nas1",
    port: null,
    createdAt: 0,
    logTail: "",
    ...over,
  }) as MctlJob;

beforeEach(() => {
  vi.mocked(listNasModels).mockResolvedValue({
    models: [
      {
        name: "qwen3-32b",
        runtime: "vllm",
        repository: "Qwen/Qwen3-32B",
        bytes: 148_700_000_000,
      },
    ],
    sparkId: "nas1",
  } as never);
  vi.mocked(fetchNasCatalog).mockResolvedValue({
    schema: 3,
    generation: 42,
    generatedAt: Date.now(),
    models: [],
  } as never);
  vi.mocked(runNasDoctor).mockResolvedValue({
    report: { checks: 9, passed: 9 },
    checkedAt: Date.now(),
    stale: false,
  } as never);
  vi.mocked(modelctlStatus).mockResolvedValue({
    installed: true,
    version: "0.18.0",
    uv: { installed: true, version: "0.5.0" },
  } as never);
  vi.mocked(fetchModelctlRelease).mockResolvedValue({
    latest: "v0.18.0",
    publishedAt: null,
    checkedAt: Date.now(),
  } as never);
  vi.mocked(listJobs).mockResolvedValue({ jobs: [] });
  vi.mocked(fetchNasModelDetail).mockResolvedValue({
    path: `${NAS_ROOT}/models/qwen3-32b`,
    serveCommand: `modelctl serve qwen3-32b --root ${NAS_ROOT}`,
    runMd: "# run notes",
  } as never);
  vi.mocked(fetchNasDeletePlan).mockResolvedValue({
    plan: "would free 148.7 GB · 3 objects unreferenced",
  } as never);
  vi.mocked(startJob).mockResolvedValue({ jobId: "new-job" } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage(spark = nasSnap()) {
  return render(
    <NasPage spark={spark} defaultNasRoot={NAS_ROOT} onEdit={() => {}} onNavigate={() => {}} />
  );
}

describe("NasPage — store + models", () => {
  it("renders store capacity, the catalog.json block, and the model table", async () => {
    renderPage();

    // Store capacity from the snapshot mount matching nasRoot (MB → TB voice)
    expect(await screen.findByText("10.0 TB")).toBeTruthy();
    // catalog.json read (schema/generation live in one <p>)
    expect(screen.getAllByText("catalog.json").length).toBeGreaterThan(0);
    await waitFor(() => expect(fetchNasCatalog).toHaveBeenCalled());
    const gen = await screen.findByText("42"); // generation
    expect(gen.closest("p")?.textContent).toContain("schema");

    // model row from listNasModels
    expect(screen.getByText("qwen3-32b")).toBeTruthy();
    expect(screen.getByText("Qwen/Qwen3-32B")).toBeTruthy();

    // doctor summary
    expect(screen.getByText(/9 checks · 9 ok/)).toBeTruthy();
  });

  it("delete is two-click: first click fetches the dry-run plan, second posts the nas-delete job", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText("qwen3-32b")); // open detail
    await waitFor(() => expect(fetchNasModelDetail).toHaveBeenCalledWith("qwen3-32b"));

    const del = await screen.findByRole("button", { name: /␡ Delete/ });
    await user.click(del);
    // Armed, not posted
    await waitFor(() => expect(fetchNasDeletePlan).toHaveBeenCalledWith("qwen3-32b"));
    expect(startJob).not.toHaveBeenCalled();
    expect(screen.getByText(/would free 148\.7 GB/)).toBeTruthy(); // dry-run preview
    expect((screen.getByRole("button", { name: /Confirm delete/ }) as HTMLButtonElement)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Confirm delete/ }));
    await waitFor(() => expect(startJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startJob).mock.calls[0][0]).toMatchObject({
      kind: "nas-delete",
      model: "qwen3-32b",
      sparkId: "nas1",
    });
  });

  it("disables Update/Delete for a model named in a running queue job", async () => {
    const user = userEvent.setup();
    vi.mocked(listJobs).mockResolvedValue({
      jobs: [job({ kind: "queue", name: "queue downloads (1)", logTail: "staging qwen3-32b into .modelctl-staging" })],
    });
    renderPage();

    // Row overlay shows the in-flight state
    expect(await screen.findByText("queue · staging")).toBeTruthy();
    await user.click(screen.getByText("qwen3-32b"));

    const update = (await screen.findByRole("button", {
      name: /↧ Update/,
    })) as HTMLButtonElement;
    const del = screen.getByRole("button", { name: /␡ Delete/ }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    expect(del.disabled).toBe(true);
    expect(screen.getByText(/job is pulling this model/)).toBeTruthy();
  });

  it("catalog-refresh button posts the catalog-refresh job", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: /⟳ Refresh catalog/ }));
    await waitFor(() => expect(startJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startJob).mock.calls[0][0]).toMatchObject({
      kind: "catalog-refresh",
      sparkId: "nas1",
    });
  });

  it("repair is two-click armed and posts repair-active", async () => {
    const user = userEvent.setup();
    // The store must have a finding for repair to arm — a clean report
    // disables the CTA (nothing to repair).
    vi.mocked(runNasDoctor).mockResolvedValue({
      report: [
        { status: "valid" },
        { status: "valid" },
        { status: "repairable_directory" },
      ],
      checkedAt: Date.now(),
      stale: false,
    } as never);
    renderPage();
    const repair = await screen.findByRole("button", { name: /⚒ Repair active refs/ });
    await user.click(repair);
    expect(startJob).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Confirm repair/ }));
    await waitFor(() => expect(startJob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startJob).mock.calls[0][0]).toMatchObject({
      kind: "repair-active",
      sparkId: "nas1",
    });
  });
});

describe("NasPage — polish round (pager, busy CTAs, doctor pill, progress)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const manyModels = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `model-${String(i + 1).padStart(2, "0")}`,
      runtime: "vllm",
      repository: `org/model-${i + 1}`,
      bytes: 1_000_000_000,
    }));

  it("paginates the models table: 10 rows per page and a working pager", async () => {
    vi.mocked(listNasModels).mockResolvedValue({ models: manyModels(23), sparkId: "nas1" } as never);
    const { container } = renderPage();
    await screen.findByText("model-01");
    const rows = container.querySelectorAll(".nas-table__row");
    expect(rows.length).toBe(10);
    expect(screen.getByText("page 1 / 3 · 23 models")).toBeTruthy();
    expect(screen.queryByText("model-11")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("model-11")).toBeTruthy();
    expect(screen.getByText("page 2 / 3 · 23 models")).toBeTruthy();
  });

  it("disables job CTAs while a node job is running", async () => {
    vi.mocked(listJobs).mockResolvedValue({
      jobs: [job({ kind: "download", name: "download org/model", logTail: "staging model 10%" })],
    });
    renderPage();
    const refresh = (await screen.findByRole("button", { name: /⟳ Refresh catalog/ })) as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    expect(refresh.title).toContain("one job runs at a time");
  });

  it("enables repair only when the doctor report has findings; disables when clean", async () => {
    // Array report with a repairable finding → repair armed-enabled.
    vi.mocked(runNasDoctor).mockResolvedValue({
      report: [{ status: "valid" }, { status: "repairable_directory" }],
      checkedAt: Date.now(),
      stale: false,
    } as never);
    const { unmount } = renderPage();
    const armed = (await screen.findByRole("button", { name: /⚒ Repair active refs/ })) as HTMLButtonElement;
    expect(armed.disabled).toBe(false);
    expect(screen.getByText("1 finding")).toBeTruthy();
    unmount();

    // All-valid array report → positively clean → repair disabled.
    vi.mocked(runNasDoctor).mockResolvedValue({
      report: [{ status: "valid" }, { status: "valid" }],
      checkedAt: Date.now(),
      stale: false,
    } as never);
    renderPage();
    const clean = (await screen.findByRole("button", { name: /⚒ Repair active refs/ })) as HTMLButtonElement;
    expect(clean.disabled).toBe(true);
  });

  it("renders an unreachable pill and a dim neutral line on doctor SSH failure", async () => {
    vi.mocked(runNasDoctor).mockResolvedValue({
      report: null,
      checkedAt: Date.now(),
      stale: false,
      error: "SSH command failed",
    } as never);
    const { container } = renderPage();
    expect(await screen.findByText("unreachable")).toBeTruthy();
    expect(screen.getByText(/check SSH reachability/)).toBeTruthy();
    // The alarming orange raw dump is gone.
    expect(container.querySelector(".log-warn")).toBeNull();
  });

  it("shows live download progress in the row, detail card and jobs strip", async () => {
    const user = userEvent.setup();
    vi.mocked(listJobs).mockResolvedValue({
      jobs: [job({ kind: "queue", name: "queue downloads (1)", logTail: "staging qwen3-32b 41%" })],
    });
    const { container } = renderPage();
    expect(await screen.findByText(/queue · staging · 41%/)).toBeTruthy();

    // Detail card progress bar (open the model).
    await user.click(screen.getByText("qwen3-32b"));
    const fills = await waitFor(() => {
      const f = container.querySelectorAll<HTMLDivElement>(".job-progress__fill");
      expect(f.length).toBeGreaterThanOrEqual(1);
      return f;
    });
    // Row, detail card and jobs strip captions share the last log line + pct;
    // every rendered progress fill must carry the parsed percent.
    const pcts = [...fills].map((f) => f.style.getPropertyValue("--pct"));
    expect(pcts).toContain("41%");
    expect(screen.getAllByText(/staging qwen3-32b 41% · 41%/).length).toBeGreaterThanOrEqual(1);
  });
});
