/**
 * Serving hero — feedback for the "busy but silent" window: a long prefill
 * reports no rate until it completes, so the pill carries the busy duration
 * and the generation dial carries the output age.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as client from "../../../api/client";

vi.mock("../../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof client>()),
  servingStatus: vi.fn(async () => null),
  servingStop: vi.fn(async () => ({ ok: true })),
}));

import { ScServing } from "./ScServing";
import type { LlmMetrics, SparkSnapshot } from "../../../api/types";

function llmMetrics(over: Partial<LlmMetrics> = {}): LlmMetrics {
  return {
    available: true,
    backend: "vllm",
    modelId: "GLM-5.3-Flash-EXL3",
    modelPath: null,
    contextLength: 700000,
    gpuMemoryUtilization: 0.9,
    slotsActive: 2,
    slotsTotal: 2,
    generationTps: 0,
    prefillTps: 0,
    totalOutputTokens: 6586,
    kvCacheUsage: 0.42,
    requestsRunning: 2,
    requestsWaiting: 0,
    ...over,
  } as LlmMetrics;
}

function sparkWith(llm: LlmMetrics, gpuUsage: number): SparkSnapshot {
  return {
    id: "spark-1",
    name: "DGX1",
    lanIp: "10.0.10.4",
    llmPort: 8081,
    llmPorts: [8081],
    metrics: { llm: [llm], gpu: { usage: gpuUsage } },
  } as unknown as SparkSnapshot;
}

function renderServing(llm: LlmMetrics, gpuUsage = 96) {
  return render(
    <ScServing
      spark={sparkWith(llm, gpuUsage)}
      llmOn
      role="standalone"
      llmPorts={[8081]}
      primaryPort={8081}
      onAddPort={vi.fn()}
      onRemovePort={vi.fn()}
      onServeNew={vi.fn()}
      comfyOn={false}
      workerHeadId={null}
      headSparkName={null}
    />
  );
}

const settle = () => act(async () => { await Promise.resolve(); });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ScServing — busy but silent engine", () => {
  it("shows how long the engine has been busy and how long it has been silent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T20:00:00Z"));
    // 2 requests running, no rate for 2m 14s, no output observed.
    const { container } = renderServing(
      llmMetrics({ busySinceAt: Date.now() - 134_000, lastOutputAt: null })
    );
    await settle();

    expect(container.textContent).toContain("processing · 2m 14s · 2 req · 0.0 tok/s");
    expect(container.textContent).toContain("no output 2m 14s");
  });

  it("counts silence from the last output when the engine produced tokens earlier", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T20:00:00Z"));
    const { container } = renderServing(
      llmMetrics({ busySinceAt: Date.now() - 360_000, lastOutputAt: Date.now() - 45_000 })
    );
    await settle();

    // Busy 6m, but output stopped 45s ago — the newer timestamp wins.
    expect(container.textContent).toContain("processing · 6m · 2 req · 0.0 tok/s");
    expect(container.textContent).toContain("no output 45s");
  });

  it("shows no clocks on an idle engine", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T20:00:00Z"));
    const { container } = renderServing(
      llmMetrics({ requestsRunning: 0, slotsActive: 0, busySinceAt: null, lastOutputAt: null }),
      20
    );
    await settle();

    expect(container.textContent).toContain("waiting · 0 req · 0.0 tok/s");
    expect(container.textContent).not.toContain("no output");
    expect(container.textContent).not.toMatch(/waiting · \d+[sm]/);
  });
});
