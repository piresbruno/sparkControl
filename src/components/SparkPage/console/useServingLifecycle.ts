/**
 * Serving lifecycle (start/stop/status) for the console Serving channel.
 * Status polls every 5 s; job polling lives in ScModels.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { servingStatus, servingStop } from "../../../api/client";
import type { ServingStatus } from "../../../api/types";

const STATUS_POLL_MS = 5000;

export function useServingLifecycle(sparkId: string | undefined, enabled: boolean) {
  const [status, setStatus] = useState<ServingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  /** Latest status — readable from `stop` without re-subscribing. */
  const statusRef = useRef<ServingStatus | null>(null);
  const setStatusTracked = useCallback((s: ServingStatus | null) => {
    statusRef.current = s;
    setStatus(s);
  }, []);
  /** The node these callbacks are bound to; a response for another node is dropped. */
  const currentIdRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!sparkId || !enabled) return;
    const expected = sparkId;
    try {
      const s = await servingStatus(sparkId);
      if (currentIdRef.current === expected) setStatusTracked(s);
    } catch {
      if (currentIdRef.current !== expected) return;
      // No status yet for this node → "unknown (offline)" (never null).
      setStatusTracked(statusRef.current ?? { sparkId: expected, running: "unknown" });
    }
  }, [sparkId, enabled, setStatusTracked]);

  useEffect(() => {
    currentIdRef.current = sparkId && enabled ? sparkId : undefined;
    if (!sparkId || !enabled) {
      setStatusTracked(null);
      return;
    }
    void refresh();
    const t = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => window.clearInterval(t);
  }, [sparkId, enabled, refresh, setStatusTracked]);

  /**
   * Stop the supervised server. Passes the script the STATUS endpoint detected
   * as running — omitting it makes the server fall back to scripts[0], which
   * with >1 serve-script stops the wrong engine while reporting success.
   */
  const stop = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!sparkId) return { ok: false, error: "No target node" };
    setBusy(true);
    try {
      const res = await servingStop({ sparkId, scriptId: statusRef.current?.scriptId });
      return { ok: Boolean(res.success), error: res.success ? undefined : "stop failed" };
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [sparkId, refresh]);

  return { status, busy, stop, refresh };
}

/** "running since 14:02" / "stopped" / "unknown (offline)" voice (ModelsPage pattern). */
export function servingSince(status: ServingStatus | null): string {
  if (!status) return "";
  if (status.running === true && status.startedAt) {
    return new Date(status.startedAt).toLocaleTimeString();
  }
  if (status.running === true) return "running";
  if (status.running === "unknown") return "unknown (offline)";
  return "stopped";
}
