import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnalysisPage } from "./AnalysisPage";

// Mock the api client — the page is a consumer of these fns.
vi.mock("../../api/client", () => ({
  listTraces: vi.fn(),
  getTrace: vi.fn(),
  clearTraces: vi.fn(),
  fetchSparks: vi.fn(),
}));

import { listTraces, getTrace, clearTraces, fetchSparks } from "../../api/client";

const trace = (over: Partial<Record<string, unknown>> = {}) => ({
  seq: 1,
  id: "t1",
  ts: Date.parse("2026-09-05T12:00:00Z"),
  sparkId: "spark-1",
  port: 8099,
  source: "proxy",
  method: "POST",
  path: "/v1/chat/completions",
  query: null,
  model: "m1",
  stream: true,
  status: 200,
  ttftMs: 12,
  durMs: 100,
  promptTokens: 5,
  completionTokens: 2,
  tokensEstimated: false,
  finishReason: "stop",
  error: null,
  ...over,
});

beforeEach(() => {
  vi.mocked(fetchSparks).mockResolvedValue({
    sparks: [{ id: "spark-1", name: "Spark One", lanIp: "127.0.0.1", isLocal: true, ssh: { host: "127.0.0.1", user: "root", auth: "key" as const }, llmPorts: [8099, 9000], llmPort: 8099 }],
  });
  vi.mocked(listTraces).mockResolvedValue({ traces: [trace()], lastSeq: 1 });
  vi.mocked(getTrace).mockResolvedValue(trace({ reqBody: '{"messages":[{"role":"user","content":"hi"}]}', resText: "Hello" }));
  vi.mocked(clearTraces).mockResolvedValue({ success: true });
  (globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
    json: async () => ({ traceCapture: true }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AnalysisPage", () => {
  it("renders rows from the mocked client", async () => {
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText("spark-1:8099")).toBeTruthy());
    expect(screen.getByText("m1")).toBeTruthy();
  });

  it("opens the detail modal and shows tabs on row click", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText(/chat\/completions/)).toBeTruthy());
    await user.click(screen.getAllByTitle("POST /v1/chat/completions")[0]);
    await waitFor(() => expect(getTrace).toHaveBeenCalledWith("t1"));
        await waitFor(() => expect(screen.getAllByRole("button", { name: "request" }).length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "response" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "timing" })).toBeTruthy();
  });

  it("source chips drive the listTraces filter", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await waitFor(() => expect(listTraces).toHaveBeenCalled());
    await user.click(screen.getAllByRole("button", { name: "bench" })[0]);
    await waitFor(() => expect(listTraces).toHaveBeenLastCalledWith(expect.objectContaining({ source: "bench" })));
  });

  it("Clear calls clearTraces and reloads", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await waitFor(() => expect(listTraces).toHaveBeenCalled());
    await user.click(screen.getAllByRole("button", { name: "Clear" })[0]);
    await waitFor(() => expect(clearTraces).toHaveBeenCalled());
  });

  it("shows the capture-off banner when traceCapture is false", async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
      json: async () => ({ traceCapture: false }),
    });
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText(/Trace capture is off/)).toBeTruthy());
  });
});
