import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useSnapshot } from "./useSnapshot";

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

/** Exposes the hook's surface so assertions run against rendered state. */
let latest: ReturnType<typeof useSnapshot> | null = null;

function Probe() {
  latest = useSnapshot();
  return null;
}

describe("useSnapshot telemetry health", () => {
  afterEach(() => {
    cleanup();
    latest = null;
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("stays disconnected until the first valid snapshot arrives", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<Probe />);
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
    render(<Probe />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket.message({ type: "snapshot", sparks: [], refreshInterval: 2000, generatedAt: 1_700_000_000_000 }));
    expect(latest!.snapshotGeneratedAt).toBe(1_700_000_000_000);
  });

  it("surfaces malformed and invalid payloads instead of reporting healthy", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    render(<Probe />);
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
