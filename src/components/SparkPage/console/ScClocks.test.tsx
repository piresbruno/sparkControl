/**
 * ScClocks panel tests — jsdom (no arm64 Chromium for browser verification
 * on this host). The contract assertions run every dropdown option through
 * the REAL shared route validator (src/shared/clockTarget.js) — the same
 * function the POST route uses — so a UI request that would answer 400
 * fails here first.
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
import { parseClockApplyRequest } from "../../../shared/clockTarget.js";
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
  it("renders GPU/CPU dropdowns + install banner from live state; no manual inputs", async () => {
    vi.mocked(fetchSparkClocks).mockResolvedValue(clocksFixture());
    const { container } = render(<ScClocks spark={sparkFixture()} />);

    expect(await screen.findByText("Default app clock 2418")).toBeTruthy();
    expect(screen.getByText(/now 2190 MHz · max 3003 MHz/)).toBeTruthy();
    expect(screen.getByText(/cap 1.98 GHz/)).toBeTruthy();
    expect(screen.getByText(/hw 0.34 GHz–2.81 GHz/)).toBeTruthy();
    expect(screen.getByText("Install clock control")).toBeTruthy();
    // Dropdown-only: manual number inputs are gone.
    expect(container.querySelector('input[type="number"]')).toBeNull();
  });

  it("every CPU dropdown option posts a body the route validator accepts", async () => {
    vi.mocked(fetchSparkClocks).mockResolvedValue(clocksFixture());
    vi.mocked(setSparkClocks).mockResolvedValue(clocksFixture());
    const user = userEvent.setup();
    render(<ScClocks spark={sparkFixture()} />);
    await screen.findByText("Default app clock 2418");

    const select = screen.getByLabelText("CPU preset");
    const cases: Array<[string, object]> = [
      ["2000000", { cpu: { mode: "cap", khz: 2000000 } }],
      ["2200000", { cpu: { mode: "cap", khz: 2200000 } }],
      ["2400000", { cpu: { mode: "cap", khz: 2400000 } }],
      ["max", { cpu: { mode: "reset" } }],
    ];
    for (const [value, expectedParts] of cases) {
      vi.mocked(setSparkClocks).mockClear();
      await user.selectOptions(select, value);
      await vi.waitFor(() => expect(setSparkClocks).toHaveBeenCalledTimes(1));
      const body = vi.mocked(setSparkClocks).mock.calls[0][1];
      // Contract: the exact body the panel sends must pass the route validator.
      expect(parseClockApplyRequest(body)).toEqual(expectedParts);
    }
  });

  it("every GPU dropdown option posts a body the route validator accepts", async () => {
    vi.mocked(fetchSparkClocks).mockResolvedValue(clocksFixture());
    vi.mocked(setSparkClocks).mockResolvedValue(clocksFixture());
    const user = userEvent.setup();
    render(<ScClocks spark={sparkFixture()} />);
    await screen.findByText("Default app clock 2418");

    const select = screen.getByLabelText("GPU preset");
    const cases: Array<[string, object]> = [
      ["2000", { gpu: { mode: "lock", mhz: 2000 } }],
      ["2200", { gpu: { mode: "lock", mhz: 2200 } }],
      ["2400", { gpu: { mode: "lock", mhz: 2400 } }],
      ["max", { gpu: { mode: "reset" } }],
    ];
    for (const [value, expectedParts] of cases) {
      vi.mocked(setSparkClocks).mockClear();
      await user.selectOptions(select, value);
      await vi.waitFor(() => expect(setSparkClocks).toHaveBeenCalledTimes(1));
      const body = vi.mocked(setSparkClocks).mock.calls[0][1];
      expect(parseClockApplyRequest(body)).toEqual(expectedParts);
    }
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
