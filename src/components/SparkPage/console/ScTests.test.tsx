/**
 * Tests channel — prefill bench feedback outside the dialog: a chip reports an
 * in-flight run (polled) and the action switches to "open", since the server
 * rejects a second concurrent bench for the same Spark.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import * as client from "../../../api/client";

vi.mock("../../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof client>()),
  listPrefillBench: vi.fn(),
}));

import { ScTests } from "./ScTests";
import type {
  PrefillBenchJob,
  PrefillBenchListResponse,
} from "../../../api/types";

function job(over: Partial<PrefillBenchJob> = {}): PrefillBenchJob {
  return {
    benchId: "b1",
    sparkId: "spark-1",
    status: "running",
    startedAt: 1000,
    completedAt: null,
    config: { port: 8888, modelId: null, contextSizes: [4096, 8192] },
    progress: {
      currentContext: 8192,
      completedLevels: 1,
      totalLevels: 2,
      message: "Prefilling 8k…",
    },
    results: [
      {
        targetTokens: 4096,
        promptTokens: 4102,
        promptChars: 16000,
        prefillTps: 745.3,
        ttftMs: 1200,
        ttftContentMs: null,
        completionTokens: 8,
        durationMs: 1300,
        model: "m1",
        error: null,
      },
    ],
    error: null,
    durationMs: 0,
    ...over,
  };
}

function listResponse(active: PrefillBenchJob | null): PrefillBenchListResponse {
  return {
    active,
    last: active,
    history: active ? [active] : [],
    defaults: { allowedContextSizes: [4096, 8192], defaultContextSizes: [4096, 8192] },
  };
}

const flushMount = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(client.listPrefillBench).mockResolvedValue(listResponse(job()));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ScTests — prefill bench feedback", () => {
  it("shows a running chip with progress, then clears it when the run ends", async () => {
    const { container } = render(
      <ScTests
        sparkId="spark-1"
        primaryPort={8888}
        modelId="m1"
        contextLength={32768}
        llmAvailable
      />
    );
    await flushMount();

    const chip = container.querySelector(".bench-status-pill--running");
    expect(chip?.textContent).toContain("running · 1/2 · 8k · 745 tok/s");
    expect(chip?.getAttribute("title")).toBe(
      "Prefilling 8k…\n4k · 745.3 tok/s · TTFT 1.20s"
    );
    expect(screen.getByRole("button", { name: "Open prefill bench" })).toBeTruthy();

    // Poll (running cadence) reports the run finished.
    vi.mocked(client.listPrefillBench).mockResolvedValue(
      listResponse(job({ status: "completed", completedAt: 2000, durationMs: 1000 }))
    );
    await advance(1000);

    expect(container.querySelector(".bench-status-pill--running")).toBeNull();
    expect(screen.getByRole("button", { name: "▶ Run prefill bench" })).toBeTruthy();
  });

  it("ignores poll failures and keeps the last known state", async () => {
    const { container } = render(
      <ScTests
        sparkId="spark-1"
        primaryPort={8888}
        modelId="m1"
        contextLength={32768}
        llmAvailable
      />
    );
    await flushMount();
    expect(container.querySelector(".bench-status-pill--running")?.textContent).toContain(
      "running · 1/2"
    );

    vi.mocked(client.listPrefillBench).mockRejectedValue(new Error("node offline"));
    await advance(1000);

    expect(container.querySelector(".bench-status-pill--running")?.textContent).toContain(
      "running · 1/2"
    );
  });
});
