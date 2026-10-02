import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetStore, getMetricHistorySamples } from "./metricsStore";
import { useSnapshot } from "./useSnapshot";
import { makeSpark } from "../testing/fixtures";
import { cleanupRenders, flush, render } from "../testing/render";

/** Scriptable WebSocket: tests open it and deliver frames by hand. */
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  raw(data: string) {
    this.onmessage?.({ data });
  }
  close() {
    this.readyState = 3;
  }
  send() {}
}

/** Explicit view of the hook state the telemetry-health assertions read. */
interface ProbeState {
  connected: boolean;
  lastValidSnapshotAt: number | null;
  refreshInterval: number | null;
  snapshotGeneratedAt: number | null;
  snapshotError: string | null;
}

/** Exposes the hook's surface so assertions run against rendered state. */
let latest: ProbeState | null = null;

function HookProbe() {
  const snapshot = useSnapshot();
  latest = {
    connected: snapshot.connected,
    lastValidSnapshotAt: snapshot.lastValidSnapshotAt,
    refreshInterval: snapshot.refreshInterval,
    snapshotGeneratedAt: snapshot.snapshotGeneratedAt,
    snapshotError: snapshot.snapshotError,
  };
  return null;
}

describe("useSnapshot telemetry health", () => {
  afterEach(() => {
    cleanupRenders();
    latest = null;
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("stays disconnected until the first valid snapshot arrives", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<HookProbe />);
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeTruthy();

    act(() => socket.open());
    expect(latest!.connected).toBe(false);
    expect(latest!.lastValidSnapshotAt).toBeNull();

    act(() => socket.message({ type: "snapshot", sparks: [], refreshInterval: 2000 }));
    expect(latest!.connected).toBe(true);
    expect(latest!.lastValidSnapshotAt).toBeGreaterThan(0);
    expect(latest!.refreshInterval).toBe(2000);
    expect(latest!.snapshotError).toBeNull();
  });

  it("records the server generation time and keeps the series on it", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<HookProbe />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket.message({ type: "snapshot", sparks: [], refreshInterval: 2000, generatedAt: 1_700_000_000_000 }));
    expect(latest!.snapshotGeneratedAt).toBe(1_700_000_000_000);
  });

  it("surfaces malformed and invalid payloads instead of reporting healthy", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<HookProbe />);
    const socket = FakeWebSocket.instances[0];

    act(() => socket.raw("{not json"));
    expect(latest!.snapshotError).toMatch(/malformed/i);
    expect(latest!.connected).toBe(false);

    act(() => socket.message({ type: "snapshot" }));
    expect(latest!.snapshotError).toMatch(/invalid/i);
    expect(latest!.connected).toBe(false);

    act(() => socket.message({ type: "snapshot", sparks: [], refreshInterval: 2000 }));
    expect(latest!.snapshotError).toBeNull();
    expect(latest!.connected).toBe(true);
  });
});

class MockSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function RenderedProbe() {
  const snapshot = useSnapshot();
  return (
    <pre data-testid="probe">
      {JSON.stringify({
        connected: snapshot.connected,
        error: snapshot.snapshotError,
        last: snapshot.lastValidSnapshotAt,
        count: snapshot.sparks.length,
      })}
    </pre>
  );
}

function readProbe() {
  return JSON.parse(document.querySelector("[data-testid=probe]")!.textContent || "{}");
}

describe("useSnapshot connection lifecycle", () => {
  beforeEach(() => {
    _resetStore();
    MockSocket.instances = [];
    vi.stubGlobal("WebSocket", MockSocket);
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:5555" },
    });
  });

  afterEach(() => {
    cleanupRenders();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays disconnected until a valid snapshot, then recovers after disconnect and malformed data", async () => {
    render(<RenderedProbe />);
    const socket = MockSocket.instances[0];
    act(() => socket.open());
    await flush();
    expect(readProbe().connected).toBe(false);

    act(() => socket.emit({
      type: "snapshot",
      generatedAt: 50_000,
      refreshInterval: 2000,
      sparks: [makeSpark("alpha")],
    }));
    await flush();
    expect(readProbe()).toMatchObject({ connected: true, count: 1, error: null, last: 50_000 });
    expect(getMetricHistorySamples("alpha", "gpu.usage")[0]).toEqual({ at: 50_000, value: 42 });

    act(() => socket.close());
    await flush();
    expect(readProbe().connected).toBe(false);
    expect(readProbe().count).toBe(1);

    act(() => vi.advanceTimersByTime(2000));
    const next = MockSocket.instances[1];
    act(() => next.open());
    act(() => next.emit("not-json"));
    await flush();
    expect(readProbe().error).toContain("malformed");
    expect(readProbe().connected).toBe(false);

    act(() => next.emit({ type: "snapshot", generatedAt: 51_000, refreshInterval: 2000, sparks: [makeSpark("alpha")] }));
    await flush();
    expect(readProbe()).toMatchObject({ connected: true, error: null });
    expect(readProbe().last).toBeGreaterThanOrEqual(50_000);
  });
});
