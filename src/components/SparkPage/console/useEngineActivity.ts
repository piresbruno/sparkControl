/**
 * Derived engine activity for the Serving hero.
 * State machine (accepted design): queued → decoding → prefilling →
 * processing, with a ~5s hold of the last non-zero state to survive poll
 * gaps, plus the "GPU busy · engine silent" blind-spot flag.
 */
import { useEffect, useRef, useState } from "react";
import type { LlmMetrics } from "../../../api/types";
import { classifyActivity, type EngineActivity } from "./consoleUtils";

const HOLD_MS = 5000;

export function useEngineActivity(
  llm: LlmMetrics | null,
  gpuUsage: number | null | undefined
): EngineActivity | null {
  const raw = classifyActivity(llm, gpuUsage);
  const [activity, setActivity] = useState<EngineActivity | null>(raw);
  const lastReal = useRef<{ state: EngineActivity; at: number } | null>(null);

  useEffect(() => {
    if (raw == null) {
      lastReal.current = null;
      setActivity(null);
      return;
    }
    const now = Date.now();
    // decode/prefill/queued/gpu-silent are "real" signals — remember them.
    if (raw !== "processing" && raw !== "waiting") {
      lastReal.current = { state: raw, at: now };
      setActivity(raw);
      return;
    }
    // processing/waiting: keep the last real state while inside the hold.
    if (lastReal.current && now - lastReal.current.at < HOLD_MS) {
      setActivity(lastReal.current.state);
      const t = window.setTimeout(() => setActivity(classifyActivity(llm, gpuUsage)), HOLD_MS);
      return () => window.clearTimeout(t);
    }
    setActivity(raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, llm?.generationTps, llm?.prefillTps, gpuUsage]);

  return activity;
}
