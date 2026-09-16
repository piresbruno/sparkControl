/**
 * ScClocks render tests — jsdom fallback for the console panel (no arm64
 * Chromium available for browser verification on this host).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../../api/client", () => ({
  fetchSparkClocks: vi.fn(),
  setSparkClocks: vi.fn(),
  installClockControl: vi.fn(),
}));

import { fetchSparkClocks, setSparkClocks } from "../../../api/client";
import { ScClocks } from "./ScClocks";
import type { SparkClocks, SparkSnapshot } from "../../../api/types";

function clocksFixture(over: Partial<SparkClocks> = {}): SparkClocks {
  return {
    sparkId: "spark-1",
    online: true,
    helperInstalled: false,
    supported: { gpu: true, cpu: true },
    gpu: { appClockMHz: 2418, defaultAppClockMHz: 2418, maxSmMHz: 3003, currentSmMHz: 2190, locked: false },
    cpu: { maxPerfKhzList: Array(20).fill(1976000), hwMaxKhz: 2808000, hwMinKhz: 338000 },
    desired: { gpu: null, cpu: null },
    lastApplied: { gpu: null, cpu: null, at: null },
    ...over,
  } as SparkClocks;
}
function sparkFixture(): SparkSnapshot {
  return {
    id: "spark-1",
    name: "DGX 1",
    kind: "spark",
    online: true,
  } as unknown as SparkSnapshot;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ScClocks", () => {
  it("renders GPU/CPU rows + install banner from live state; Cap posts preset", async () => {
    vi.mocked(fetchSparkClocks).mockResolvedValue(clocksFixture());
    vi.mocked(setSparkClocks).mockResolvedValue(clocksFixture());
    const user = userEvent.setup();
    const { container } = render(<ScClocks spark={sparkFixture()} />);

    expect(await screen.findByText("Default app clock 2418")).toBeTruthy();
    expect(screen.getByText(/now 2190 MHz · max 3003 MHz/)).toBeTruthy();
    expect(screen.getByText(/cap 1.98 GHz/)).toBeTruthy();
    expect(screen.getByText(/hw 0.34 GHz–2.81 GHz/)).toBeTruthy();
    expect(screen.getByText("Install clock control")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "1.5 GHz" }));
    await vi.waitFor(() => {
      expect(setSparkClocks).toHaveBeenCalledWith("spark-1", { cpu: { maxPerfKhz: 1500000 } });
    });
    // NAS renders nothing
    const { container: nasContainer } = render(
      <ScClocks spark={{ ...sparkFixture(), kind: "nas" } as SparkSnapshot} />
    );
    expect(nasContainer.childElementCount).toBe(0);
    expect(container).toBeTruthy();
  });

  it("shows Locked chip + re-apply hint when desired diverges from node state", async () => {
    vi.mocked(fetchSparkClocks).mockResolvedValue(
      clocksFixture({
        helperInstalled: true,
        gpu: { appClockMHz: 1500, defaultAppClockMHz: 2418, maxSmMHz: 3003, currentSmMHz: 1500, locked: true },
        cpu: { maxPerfKhzList: Array(20).fill(2808000), hwMaxKhz: 2808000, hwMinKhz: 338000 },
        desired: { gpu: { mode: "lock", mhz: 1500 }, cpu: { mode: "cap", khz: 2000000 } },
        lastApplied: { gpu: { mode: "lock", mhz: 1500 }, cpu: { mode: "cap", khz: 2000000 }, at: "2026-09-16T02:10:00.000Z" },
      })
    );
    render(<ScClocks spark={sparkFixture()} />);
    expect(await screen.findByText("Locked @ 1500 MHz")).toBeTruthy();
    expect(screen.getByText(/CPU cap 2.00 GHz will be re-applied on next boot/)).toBeTruthy();
    expect(screen.queryByText("Install clock control")).toBeNull();
  });
});
