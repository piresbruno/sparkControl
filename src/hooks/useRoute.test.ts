import { describe, it, expect, vi } from "vitest";
import { activeIdFromPath } from "./useRoute";
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
