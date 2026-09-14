import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ScResources } from "./ScResources";
import type { SparkSnapshot } from "../../../api/types";

const spark = {
  id: "spark-1", name: "DGX1", kind: "spark", online: true, llmPort: 8888, llmPorts: [8888],
  disabledDevices: [], disabledInterfaces: [],
  hardware: {},
  metrics: {
    gpu: {
      temperature: 42, usage: 10, power: { draw: 20, limit: 120 },
      vram: { used: 94449, total: 119543, percentage: 79, available: 25094 },
      processes: [{ pid: 988754, name: "VLLM::Worker_TP0_EP0", vramMB: 94449 }],
    },
    cpu: null, ram: null, storage: [], network: null, unifiedMemory: null, llm: [],
  },
} as unknown as SparkSnapshot;

describe("GPU processes panel (live snapshot shape)", () => {
  it("renders an accessible module with name, pid and VRAM", () => {
    const { container } = render(
      <ScResources spark={spark} temperatureUnit="celsius" tailscaleOn={false} headSparkName={null} workerHeadId={null} />
    );
    const panel = container.querySelector('[aria-label="GPU processes"]');
    expect(panel).toBeTruthy();
    const text = panel!.textContent ?? "";
    expect(text).toContain("VLLM::Worker_TP0_EP0");
    expect(text).toContain("988754");
    expect(text).toMatch(/94\s*449\s*MB/);
    expect(panel!.querySelector(".seg__fill")).toBeTruthy();
  });
  it("hides the module when there are no processes", () => {
    const none = { ...spark, metrics: { ...spark.metrics, gpu: { ...spark.metrics.gpu, processes: [] } } } as SparkSnapshot;
    const { container } = render(
      <ScResources spark={none} temperatureUnit="celsius" tailscaleOn={false} headSparkName={null} workerHeadId={null} />
    );
    expect(container.querySelector('[aria-label="GPU processes"]')).toBeNull();
  });
});
