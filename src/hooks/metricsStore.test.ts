import { beforeEach, describe, expect, it } from "vitest";
import { _resetStore, getMetricHistorySamples, ingestSnapshots } from "./metricsStore";
import type { SparkSnapshot } from "../api/types";

/** Minimal snapshot: the store only reads id/online/metrics. */
function makeSpark(id = "s1", usage = 42): SparkSnapshot {
  return {
    id,
    name: id,
    online: true,
    kind: "spark",
    metrics: {
      gpu: { usage, temperature: 40 },
      cpu: null,
      ram: null,
      unifiedMemory: null,
      llm: [],
      comfy: null,
      tailscale: null,
    },
  } as unknown as SparkSnapshot;
}

describe("metricsStore timestamp contract", () => {
  beforeEach(_resetStore);

  it.each([1_000, 2_000, 5_000])("preserves a %sms source cadence", (interval) => {
    const spark = makeSpark();
    ingestSnapshots([spark], 10_000);
    const next = makeSpark(spark.id, 50);
    ingestSnapshots([next], 10_000 + interval);
    expect(getMetricHistorySamples(spark.id, "gpu.usage")).toEqual([
      { at: 10_000, value: 42 },
      { at: 10_000 + interval, value: 50 },
    ]);
  });

  it("replaces duplicate frames and retains real disconnect gaps", () => {
    ingestSnapshots([makeSpark("s1", 42)], 1_000);
    ingestSnapshots([makeSpark("s1", 55)], 1_000);
    ingestSnapshots([makeSpark("s1", 60)], 61_000);
    expect(getMetricHistorySamples("s1", "gpu.usage")).toEqual([
      { at: 1_000, value: 55 },
      { at: 61_000, value: 60 },
    ]);
  });

  it("ignores out-of-order frames instead of rewinding chart time", () => {
    ingestSnapshots([makeSpark("s1", 42)], 5_000);
    ingestSnapshots([makeSpark("s1", 99)], 4_000);
    expect(getMetricHistorySamples("s1", "gpu.usage")).toEqual([{ at: 5_000, value: 42 }]);
  });

  it("prunes samples older than the retention window", () => {
    ingestSnapshots([makeSpark("s1", 42)], 1_000);
    ingestSnapshots([makeSpark("s1", 43)], 2_000);
    // 1 h retention (HISTORY_MAX × 2 s) → both early samples fall away.
    ingestSnapshots([makeSpark("s1", 44)], 4_000_000);
    expect(getMetricHistorySamples("s1", "gpu.usage")).toEqual([{ at: 4_000_000, value: 44 }]);
  });
});
