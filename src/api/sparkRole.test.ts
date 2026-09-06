import { describe, it, expect } from "vitest";
import { resolveSparkRole, isLlmMonitoringEnabled } from "./sparkRole";

describe("sparkRole helpers", () => {
  it("role resolution: explicit role wins; legacy workerNode=false → standalone", () => {
    expect(resolveSparkRole({ role: "head", workerNode: false } as never)).toBe("head");
    expect(resolveSparkRole({ workerNode: false } as never)).toBe("standalone");
  });
  it("worker without ports has monitoring disabled", () => {
    expect(isLlmMonitoringEnabled({ role: "worker", workerNode: true, llmPorts: [] } as never)).toBe(false);
  });
  it("head has monitoring enabled", () => {
    expect(isLlmMonitoringEnabled({ role: "head", workerNode: false, llmPorts: [8888] } as never)).toBe(true);
  });
});

import { isLlmDetectionEnabled } from "./sparkRole";

describe("isLlmDetectionEnabled (Part D)", () => {
  it("worker with llmPorts → detection on", () => {
    expect(isLlmDetectionEnabled({ role: "worker", workerNode: true, llmPorts: [8181] })).toBe(true);
  });
  it("worker without ports → off", () => {
    expect(isLlmDetectionEnabled({ role: "worker", workerNode: true, llmPorts: [] })).toBe(false);
  });
  it("head without explicit ports falls back to llmPort", () => {
    expect(isLlmDetectionEnabled({ role: "head", llmPort: 8888 })).toBe(true);
  });
  it("no ports at all → off", () => {
    expect(isLlmDetectionEnabled({ role: "standalone" })).toBe(false);
  });
});
