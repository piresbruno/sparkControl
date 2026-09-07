/**
 * Serving lifecycle (start/stop/status) for the console Serving channel.
 * Mirrors ModelsPage polling conventions: status every 5s, jobs every 1s
 * (jobs polling lives in ScModels).
 */
import { useCallback, useEffect, useState } from "react";
import { servingStatus, servingStop } from "../../../api/client";
import type { ServingStatus } from "../../../api/types";

const STATUS_POLL_MS = 5000;

export function useServingLifecycle(sparkId: string | undefined, enabled: boolean) {
  const [status, setStatus] = useState<ServingStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!sparkId || !enabled) return;
    try {
      setStatus(await servingStatus(sparkId));
    } catch {
      setStatus((s) => s ?? { sparkId, running: "unknown" });
    }
  }, [sparkId, enabled]);

  useEffect(() => {
    if (!sparkId || !enabled) {
      setStatus(null);
      return;
    }
    void refresh();
    const t = window.setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => window.clearInterval(t);
  }, [sparkId, enabled, refresh]);

  /** Stop the supervised server (scriptId omitted → server default script). */
  const stop = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!sparkId) return { ok: false, error: "No target node" };
    setBusy(true);
    try {
      const res = await servingStop({ sparkId });
      await refresh();
      return { ok: Boolean(res.success), error: res.success ? undefined : "stop failed" };
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    } finally {
      setBusy(false);
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
