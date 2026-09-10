/**
 * Active prefill benchmark for a node, polled so the Tests channel can show
 * "running" feedback outside the bench dialog (which only polls its own
 * benchId, and only while open).
 *
 * Adaptive cadence: fast while a run is in flight (the dialog polls at
 * 800 ms), slow when idle so a bench started from another tab or the legacy
 * LLM panel still surfaces without hammering the endpoint.
 */
import { useEffect, useState } from "react";
import { listPrefillBench } from "../../../api/client";
import type { PrefillBenchJob } from "../../../api/types";

const RUNNING_POLL_MS = 1000;
const IDLE_POLL_MS = 10_000;

export function useActivePrefillBench(
  sparkId: string,
  port: number | null
): PrefillBenchJob | null {
  const [active, setActive] = useState<PrefillBenchJob | null>(null);

  useEffect(() => {
    if (port == null) {
      setActive(null);
      return;
    }
    const llmPort = port;
    let cancelled = false;
    let timer: number | undefined;

    const schedule = (ms: number) => {
      timer = window.setTimeout(() => void tick(), ms);
    };

    async function tick() {
      try {
        const data = await listPrefillBench(sparkId, llmPort);
        if (cancelled) return;
        setActive(data.active ?? null);
        schedule(data.active?.status === "running" ? RUNNING_POLL_MS : IDLE_POLL_MS);
      } catch {
        // Transient failure (node offline, server restart): back off to the
        // idle cadence and keep whatever state we had. The chip self-heals on
        // the next successful poll.
        if (!cancelled) schedule(IDLE_POLL_MS);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sparkId, port]);

  return active;
}
