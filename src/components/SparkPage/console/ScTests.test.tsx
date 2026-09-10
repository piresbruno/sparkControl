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
      levelStartedAt: null,
      timeoutMs: null,
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

/**
 * Fresh object graph per call, like the real fetch (JSON parse) — React bails
 * out of re-rendering on identical references, which would freeze the clock.
 */
function respond(active: PrefillBenchJob | null) {
  vi.mocked(client.listPrefillBench).mockImplementation(async () =>
    structuredClone(listResponse(active))
  );
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
  vi.mocked(client.listPrefillBench).mockImplementation(async () => listResponse(job()));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ScTests — prefill bench feedback", () => {
  it("shows the in-flight size with a running clock and the last measured rate", async () => {
    // Level started 42s ago, aborted by the runner at 36m (256k cap).
    const levelStartedAt = Date.now() - 42_000;
    respond(
      job({
        progress: {
          ...job().progress,
          currentContext: 262144,
          levelStartedAt,
          timeoutMs: 2_157_152,
        },
      })
    );
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

    const chip = () => container.querySelector(".bench-status-pill--running");
    expect(chip()?.textContent).toContain("running · 1/2 · 256k · 42s · 745 tok/s");
    expect(chip()?.getAttribute("title")).toBe(
      "Prefilling 256k for 42s, cap 36m\n4k · 745.3 tok/s · TTFT 1.20s"
    );
    expect(screen.getByRole("button", { name: "Open prefill bench" })).toBeTruthy();

    // Poll ticks the clock, so a long level visibly progresses.
    await advance(1000);
    expect(chip()?.textContent).toContain("running · 1/2 · 256k · 43s");

    // Next poll (running cadence) reports the run finished.
    respond(job({ status: "completed", completedAt: 2000, durationMs: 1000 }));
    await advance(1000);

    expect(chip()).toBeNull();
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
