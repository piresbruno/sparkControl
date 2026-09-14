/**
 * SparkActions — truthful agent status (C7):
 *  - connected  → version chip, no CTA
 *  - enabled but disconnected → warning chip + install button
 *  - disabled → muted chip
 * and the install flow polls the job until a terminal state.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as client from "../../api/client";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof client>()),
  shutdownSpark: vi.fn(),
  wakeSpark: vi.fn(),
  startJob: vi.fn(),
  getJob: vi.fn(),
}));

import { SparkActions } from "./SparkActions";
import type { MctlJob, SparkSnapshot } from "../../api/types";

function spark(over: Partial<SparkSnapshot> = {}): SparkSnapshot {
  return {
    id: "sp1",
    name: "DGX1",
    online: true,
    transport: "ssh",
    agentEnabled: true,
    agentVersion: null,
    ...over,
  } as SparkSnapshot;
}

const baseJob = (over: Partial<MctlJob> = {}): MctlJob => ({
  jobId: "j1",
  kind: "install-agent",
  name: "install agent",
  exitCode: null,
  sparkId: "sp1",
  status: "running",
  createdAt: Date.now(),
  startedAt: Date.now(),
  endedAt: null,
  logTail: "",
  ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SparkActions — agent status chips", () => {
  it("connected agent shows the version chip and no install CTA", () => {
    render(<SparkActions spark={spark({ transport: "agent", agentVersion: "1.2.3" })} />);
    expect(screen.getByText("Agent v1.2.3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install agent" })).toBeNull();
    expect(screen.queryByText("Agent offline")).toBeNull();
  });

  it("enabled but disconnected shows the offline chip plus the install button", () => {
    render(<SparkActions spark={spark()} />);
    expect(screen.getByText("Agent offline")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install agent" })).toBeTruthy();
    expect(screen.queryByText(/Agent v/)).toBeNull();
  });

  it("disabled agent shows the muted chip and no install CTA", () => {
    render(<SparkActions spark={spark({ agentEnabled: false })} />);
    expect(screen.getByText("Agent off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install agent" })).toBeNull();
  });
});

describe("SparkActions — install flow", () => {
  it("polls the job and reports progress then success", async () => {
    const user = userEvent.setup();
    vi.mocked(client.startJob).mockResolvedValue({
      jobId: "j1",
      kind: "install-agent",
      sparkId: "sp1",
    });
    // getJob (called ~1 s after the click) blocks on a gate the test opens —
    // "Installing…" holds until released, then the completed job (the agent's
    // first hello) flips the message.
    let releaseJob: () => void = () => {};
    const jobGate = new Promise<void>((resolve) => (releaseJob = resolve));
    vi.mocked(client.getJob).mockImplementation(async () => {
      await jobGate;
      return baseJob({ status: "completed" });
    });
    render(<SparkActions spark={spark()} />);

    await user.click(screen.getByRole("button", { name: "Install agent" }));
    expect((await screen.findAllByText("Installing…")).length).toBeGreaterThan(0);
    releaseJob();
    await screen.findByText("Agent connected", undefined, { timeout: 3000 });
    expect(client.startJob).toHaveBeenCalledWith({ kind: "install-agent", sparkId: "sp1" });
  });

  it("surfaces the job's lastError on failure", async () => {
    const user = userEvent.setup();
    vi.mocked(client.startJob).mockResolvedValue({
      jobId: "j1",
      kind: "install-agent",
      sparkId: "sp1",
    });
    vi.mocked(client.getJob).mockResolvedValue(
      baseJob({ status: "failed", lastError: "no node runtime on host" })
    );
    render(<SparkActions spark={spark()} />);

    await user.click(screen.getByRole("button", { name: "Install agent" }));
    await waitFor(() => expect(screen.getByText("no node runtime on host")).toBeTruthy());
  });
});
