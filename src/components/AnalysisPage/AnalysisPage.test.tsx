import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnalysisPage } from "./AnalysisPage";
import type { Settings, LlmActiveItem } from "../../api/types";

// Mock the api client — the page is a consumer of these fns.
// The factory replaces the whole module: every fn the page imports must be here.
vi.mock("../../api/client", () => ({
  listTraces: vi.fn(),
  getTrace: vi.fn(),
  clearTraces: vi.fn(),
  fetchSparks: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  listLlmActive: vi.fn(),
  listLlmClients: vi.fn(),
  cancelInflight: vi.fn(),
  stopAllLlm: vi.fn(),
  getTraceStats: vi.fn(),
  flushLlmClient: vi.fn(),
}));

import {
  listTraces,
  getTrace,
  clearTraces,
  fetchSparks,
  fetchSettings,
  updateSettings,
  listLlmActive,
  listLlmClients,
  cancelInflight,
  stopAllLlm,
  getTraceStats,
  flushLlmClient,
} from "../../api/client";

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
  // A4 rev-2 columns.
  clientIp: "127.0.0.1",
  clientUa: "vitest",
  clientId: "abc123def456",
  clientHost: "box.local",
  toolsReq: ["search_web"],
  toolsUsed: [{ name: "search_web", count: 2 }],
  cachedTokens: 128,
  bodyTruncated: false,
  ...over,
});

const activeItem = (over: Partial<Record<string, unknown>> = {}): LlmActiveItem => ({
  source: "proxy",
  id: "req-proxy-1",
  sparkId: "spark-2",
  port: 8100,
  model: "glm-4",
  path: "/v1/chat/completions",
  stream: true,
  startedAt: Date.now() - 5000,
  elapsedMs: 5000,
  cancelable: true as const,
  clientId: "cli098765432",
  clientLabel: null,
  progress: { tokensSoFar: 42, estimate: true },
  ...over,
});

const clientEntry = (over: Partial<Record<string, unknown>> = {}) => ({
  clientId: "cli098765432",
  clientIp: "10.0.30.173",
  clientUa: "vitest",
  clientHost: "box.local",
  label: null,
  inflightCount: 1,
  inflight: [
    {
      id: "req-proxy-1",
      path: "/v1/chat/completions",
      model: "glm-4",
      stream: true,
      startedAt: Date.now() - 5000,
      elapsedMs: 5000,
      tokensEst: 42,
    },
  ],
  ...over,
});

const statRow = (key: string, over: Partial<Record<string, unknown>> = {}) => ({
  key,
  requests: 4,
  promptTokens: 800,
  completionTokens: 400,
  cachedTokens: 200,
  errors: 1,
  avgTtftMs: 110,
  avgDurMs: 900,
  ...over,
});

/** Full Settings fixture (mirrors SettingsDialog.test baseSettings). */
const baseSettings = (over: Partial<Settings> = {}): Settings =>
  ({
    pollIntervalMs: 2000,
    defaultLlmPort: 8888,
    autoHideOffline: false,
    temperatureUnit: "celsius",
    benchDebugTraces: false,
    density: "compact",
    traceCapture: true,
    traceCaptureBodies: true,
    traceProxyAllowedOrigins: [],
    proxyMaxInflightPerPort: 8,
    traceMaxReqBody: 4 * 1024 * 1024,
    traceMaxResBody: 4 * 1024 * 1024,
    traceRetentionDays: 7,
    clientLabels: {},
    modelctl: {
      nasRoot: "/mnt/nas/llm-models",
      nasHostSparkId: null,
      remoteBin: "modelctl",
      source: "git+https://github.com/piresbruno/modelctl",
    },
    agent: { tokenConfigured: false },
    ...over,
  } as Settings);

const statsResponse = {
  totals: {
    requests: 12,
    promptTokens: 1200,
    completionTokens: 600,
    cachedTokens: 300,
    errors: 2,
    avgTtftMs: 123,
    avgDurMs: 950,
  },
  byClient: [statRow("cli098765432")],
  byModel: [statRow("m1")],
  byPath: [statRow("/v1/chat/completions")],
  byTool: [statRow("get_weather")],
  byHour: [statRow("2026-09-05T12")],
};

beforeEach(() => {
  vi.mocked(fetchSparks).mockResolvedValue({
    sparks: [{ id: "spark-1", name: "Spark One", lanIp: "127.0.0.1", isLocal: true, ssh: { host: "127.0.0.1", user: "root", auth: "key" as const }, llmPorts: [8099, 9000], llmPort: 8099 }],
  });
  vi.mocked(listTraces).mockResolvedValue({ traces: [trace()], lastSeq: 1 });
  vi.mocked(getTrace).mockResolvedValue(trace({ reqBody: '{"messages":[{"role":"user","content":"hi"}]}', resText: "Hello" }));
  vi.mocked(clearTraces).mockResolvedValue({ success: true });
  vi.mocked(fetchSettings).mockResolvedValue(baseSettings());
  vi.mocked(updateSettings).mockResolvedValue(baseSettings());
  vi.mocked(listLlmActive).mockResolvedValue({ items: [activeItem()] });
  vi.mocked(listLlmClients).mockResolvedValue({ clients: [clientEntry()], dashboardClients: 2 });
  vi.mocked(cancelInflight).mockResolvedValue({ success: true });
  vi.mocked(stopAllLlm).mockResolvedValue({ showcase: 1, decodeBench: 2, prefillBench: 0, proxy: 3 });
  vi.mocked(getTraceStats).mockResolvedValue(statsResponse);
  vi.mocked(flushLlmClient).mockResolvedValue({ success: true, cancelled: 2 });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
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
    await waitFor(() => expect(screen.getAllByTitle("POST /v1/chat/completions").length).toBeGreaterThan(0));
    await user.click(screen.getAllByTitle("POST /v1/chat/completions")[0]);
    await waitFor(() => expect(getTrace).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "request" }).length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "response" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "timing" })).toBeTruthy();
  });

  it("shows A4 client/tool/cache fields in the detail modal timing tab", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getAllByTitle("POST /v1/chat/completions").length).toBeGreaterThan(0));
    await user.click(screen.getAllByTitle("POST /v1/chat/completions")[0]);
    await waitFor(() => expect(getTrace).toHaveBeenCalledWith("t1"));
    await user.click(screen.getByRole("button", { name: "timing" }));
    await waitFor(() => expect(screen.getByText("Cached tokens")).toBeTruthy());
    expect(screen.getByText("Tools (requested)")).toBeTruthy();
    expect(screen.getByText("Tools (used)")).toBeTruthy();
    expect(screen.getByText("Body truncated")).toBeTruthy();
    expect(screen.getByText("Client IP")).toBeTruthy();
    expect(screen.getByText("127.0.0.1")).toBeTruthy();
    expect(screen.getByText("Hostname")).toBeTruthy();
    expect(screen.getByText("box.local")).toBeTruthy();
    expect(screen.getByText("User agent")).toBeTruthy();
    expect(screen.getByText("vitest")).toBeTruthy();
    expect(screen.getAllByTitle("127.0.0.1 · box.local").length).toBeGreaterThan(0);
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
    vi.mocked(fetchSettings).mockResolvedValue(baseSettings({ traceCapture: false }));
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText(/Trace capture is off/)).toBeTruthy());
  });

  it("renders the Live panel rows and Cancel calls cancelInflight", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText("Live & Clients")).toBeTruthy());
    await waitFor(() => expect(document.querySelector(".analysis-live__badge--proxy")).toBeTruthy());
    expect(document.querySelector(".analysis-live__row")?.textContent).toContain("glm-4");
    await user.click(screen.getByRole("button", { name: "Cancel req-proxy-1" }));
    await waitFor(() => expect(cancelInflight).toHaveBeenCalledWith("req-proxy-1"));
  });

  it("Stop all confirms and calls stopAllLlm with the spark filter", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchSettings).mockResolvedValue(baseSettings());
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText("Live & Clients")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Stop all" }));
    await user.type(screen.getByPlaceholderText("stopall"), "stopall");
    await user.click(screen.getByLabelText("I understand this cannot be undone from the dashboard."));
    await user.click(screen.getByRole("button", { name: "Confirm stop-all" }));
    await waitFor(() =>
      expect(stopAllLlm).toHaveBeenCalledWith({ sparkId: undefined, reason: "stop-all (ui)" })
    );
    await waitFor(() => expect(screen.getByText(/Stopped: 1 showcase, 2 decode bench/)).toBeTruthy());
  });

  it("clients table renders with dashboard count and Flush confirms then calls flushLlmClient", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText("2 dashboard tab(s) connected")).toBeTruthy());
    expect(screen.getByLabelText("Label for cli098765432")).toBeTruthy();
    expect(screen.getByText("10.0.30.173 · box.local")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Flush" }));
    await user.type(screen.getByPlaceholderText("flush"), "flush");
    await user.click(screen.getByLabelText("I understand this cannot be undone from the dashboard."));
    await user.click(screen.getByRole("button", { name: "Confirm flush" }));
    await waitFor(() => expect(flushLlmClient).toHaveBeenCalledWith("cli098765432"));
    await waitFor(() => expect(screen.getByText(/Flushed 2 in-flight/)).toBeTruthy());
  });

  it("inline label edit saves via updateSettings clientLabels", async () => {
    const user = userEvent.setup();
    // Seed a second label — the PUT must carry the whole merged map, not a
    // single-key body (PUT /api/settings shallow-merges and would clobber).
    vi.mocked(fetchSettings).mockResolvedValue(
      baseSettings({ clientLabels: { aaaaaaaaaaaa: "Other box" } })
    );
    vi.mocked(updateSettings).mockResolvedValue(
      baseSettings({ clientLabels: { aaaaaaaaaaaa: "Other box", cli098765432: "GPU box" } })
    );
    render(<AnalysisPage />);
    const input = await screen.findByLabelText("Label for cli098765432");
    await user.type(input, "GPU box");
    await user.tab();
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        clientLabels: { aaaaaaaaaaaa: "Other box", cli098765432: "GPU box" },
      })
    );
  });
  it("Summary tab renders cards, breakdown tables and histogram from getTraceStats", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText("Live & Clients")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "summary" }));
    await waitFor(() =>
      expect(getTraceStats).toHaveBeenCalledWith(
        expect.objectContaining({ sparkId: undefined, since: expect.any(Number) })
      )
    );
    await waitFor(() => expect(screen.getByText("By client")).toBeTruthy());
    expect(screen.getByText("By model")).toBeTruthy();
    expect(screen.getByText("By tool")).toBeTruthy();
    expect(screen.getByText("By path")).toBeTruthy();
    expect(screen.getByText("get_weather")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy(); // cache hit 300/1200
    expect(screen.getByText("17%")).toBeTruthy(); // errors 2/12
  });

  it("clicking a client row in Summary switches to Traces with the clientId filter", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await user.click(screen.getByRole("button", { name: "summary" }));
    await waitFor(() => expect(screen.getByText("By client")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Filter traces by client cli098765432" }));
    await waitFor(() =>
      expect(listTraces).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: "cli098765432" }))
    );
    await waitFor(() => expect(screen.getByText("Live & Clients")).toBeTruthy());
  });

  it("search input triggers listTraces with q after debounce", async () => {
    const user = userEvent.setup();
    render(<AnalysisPage />);
    await waitFor(() => expect(listTraces).toHaveBeenCalled());
    await user.type(screen.getByLabelText("Search traces"), "error");
    await waitFor(
      () => expect(listTraces).toHaveBeenLastCalledWith(expect.objectContaining({ q: "error" })),
      { timeout: 1500 }
    );
  });

  it("trace table shows Client and Tools columns", async () => {
    render(<AnalysisPage />);
    await waitFor(() => expect(screen.getByText("abc123de")).toBeTruthy());
    expect(screen.getByText("search_web")).toBeTruthy();
  });
});
