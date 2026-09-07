import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { activeIdFromPath, useRoute } from "./useRoute";
import { OVERVIEW_ID, ANALYSIS_ID, MODELS_ID } from "../constants";

describe("activeIdFromPath", () => {
  it("maps / to Overview", () => {
    expect(activeIdFromPath("/")).toBe(OVERVIEW_ID);
    expect(activeIdFromPath("")).toBe(OVERVIEW_ID);
  });

  it("maps /analysis and /analysis with query strings to ANALYSIS_ID", () => {
    expect(activeIdFromPath("/analysis")).toBe(ANALYSIS_ID);
    expect(activeIdFromPath("/analysis?spark=spark-1&port=8099")).toBe(ANALYSIS_ID);
    expect(activeIdFromPath("/analysis?")).toBe(ANALYSIS_ID);
  });

  it("maps /models to MODELS_ID", () => {
    expect(activeIdFromPath("/models")).toBe(MODELS_ID);
    expect(activeIdFromPath("/models?x=1")).toBe(MODELS_ID);
  });

  it("maps /spark/:id to the decoded id", () => {
    expect(activeIdFromPath("/spark/spark-1")).toBe("spark-1");
    expect(activeIdFromPath("/spark/spark%201")).toBe("spark 1");
  });

  it("returns null for unknown paths (caller decides)", () => {
    expect(activeIdFromPath("/unknown")).toBeNull();
    expect(activeIdFromPath("/spark")).toBeNull();
  });
});

describe("useRoute().navigate", () => {
  it("null (overview back-link) resolves to the OVERVIEW_ID sentinel, not raw null", () => {
    // Raw null + displaySparks[0] fallback rendered the first node's
    // console at "/" until the next WS snapshot (PR #5 review).
    const setActiveId = vi.fn();
    window.history.pushState(null, "", "/spark/dgx1");
    const { result } = renderHook(() => useRoute(setActiveId));
    act(() => result.current(null));
    expect(setActiveId).toHaveBeenCalledWith(OVERVIEW_ID);
    expect(window.location.pathname).toBe("/");
  });

  it("real ids still map to their routes", () => {
    const setActiveId = vi.fn();
    const { result } = renderHook(() => useRoute(setActiveId));
    act(() => result.current("dgx2"));
    expect(setActiveId).toHaveBeenCalledWith("dgx2");
    expect(window.location.pathname).toBe("/spark/dgx2");
    act(() => result.current(ANALYSIS_ID));
    expect(window.location.pathname).toBe("/analysis");
    act(() => result.current(MODELS_ID));
    expect(setActiveId).toHaveBeenLastCalledWith(MODELS_ID);
  });
});
