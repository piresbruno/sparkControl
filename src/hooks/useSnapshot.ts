import { useEffect, useRef, useState, useCallback } from "react";
import type { SparkSnapshot, WsSnapshot } from "../api/types";
import { ingestSnapshots } from "./metricsStore";
import { OVERVIEW_ID, ANALYSIS_ID, MODELS_ID, SERVE_ID } from "../constants";

/** Sentinel tab ids (not real sparks) — never reset by snapshot guards. */
const SENTINEL_IDS = new Set([OVERVIEW_ID, ANALYSIS_ID, MODELS_ID, SERVE_ID]);

const WS_URL = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
const RECONNECT_DELAY = 2000;

/**
 * useSnapshot — connects to the WebSocket and exposes live spark data plus
 * telemetry health: { sparks, activeId, setActiveId, activeSpark, connected,
 * lastValidSnapshotAt, snapshotError, snapshotGeneratedAt, refreshInterval }.
 *
 * `connected` means valid telemetry is flowing — a live transport AND a
 * cleanly parsed snapshot frame with no active error. `lastValidSnapshotAt`
 * survives disconnects so the UI can show the age of the data on screen.
 */
export function useSnapshot() {
  const [sparks, setSparks] = useState<SparkSnapshot[]>([]);
  /** Transport liveness: true from connect (or any received frame) until close. */
  const [wsAlive, setWsAlive] = useState(false);
  const [lastValidSnapshotAt, setLastValidSnapshotAt] = useState<number | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotGeneratedAt, setSnapshotGeneratedAt] = useState<number | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<string | null>(OVERVIEW_ID);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** When false, onclose must not schedule reconnect (unmount / intentional close). */
  const shouldReconnect = useRef(true);

  // ─── Connect ─────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!shouldReconnect.current) return;

    const state = wsRef.current?.readyState;
    // Avoid duplicate sockets while OPEN or still CONNECTING
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsAlive(true);
      console.log("[ws] connected");
    };

    ws.onmessage = (ev) => {
      // Receiving any frame proves the transport is alive, even before onopen fires.
      setWsAlive(true);
      let msg: WsSnapshot;
      try {
        msg = JSON.parse(ev.data) as WsSnapshot;
      } catch {
        setSnapshotError("The server sent malformed telemetry data.");
        return;
      }
      if (msg.type !== "snapshot" || !Array.isArray(msg.sparks)) {
        setSnapshotError("The server sent invalid telemetry data.");
        return;
      }
      setSnapshotError(null);
      setLastValidSnapshotAt(Date.now());
      setSnapshotGeneratedAt(typeof msg.generatedAt === "number" ? msg.generatedAt : null);
      setRefreshInterval(typeof msg.refreshInterval === "number" ? msg.refreshInterval : null);
      // Feed the central history store (8b) before notifying React state.
      ingestSnapshots(msg.sparks);
      setSparks(msg.sparks);
      // Default to the Overview tab; keep the current selection if it
      // is still valid (Overview is always valid).
      setActiveId((prev) => {
        if (prev != null && SENTINEL_IDS.has(prev)) return prev;
        if (prev && msg.sparks.some((s) => s.id === prev)) return prev;
        return OVERVIEW_ID;
      });
    };

    ws.onclose = () => {
      setWsAlive(false);
      wsRef.current = null;
      if (!shouldReconnect.current) return;
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  // ─── Lifecycle ───────────────────────────────────────────
  useEffect(() => {
    shouldReconnect.current = true;
    connect();
    return () => {
      shouldReconnect.current = false;
      clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [connect]);

  // ─── Derived state ──────────────────────────────────────
  const activeSpark = sparks.find((s) => s.id === activeId) || null;
  /** Valid telemetry is flowing: live transport + parsed snapshot + no error. */
  const connected = wsAlive && snapshotError === null && lastValidSnapshotAt !== null;

  return {
    sparks,
    connected,
    activeId,
    setActiveId,
    activeSpark,
    lastValidSnapshotAt,
    snapshotError,
    snapshotGeneratedAt,
    refreshInterval,
  };
}
