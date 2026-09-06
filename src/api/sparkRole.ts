import type { SparkRole } from "./types";

/** Resolve cluster role from config/snapshot fields (supports legacy workerNode-only). */
export function resolveSparkRole(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
}): SparkRole {
  if (spark.role === "head" || spark.role === "worker" || spark.role === "standalone") {
    return spark.role;
  }
  return spark.workerNode ? "worker" : "standalone";
}

/**
 * Whether this Spark should probe/show the local LLM API.
 * Workers: never. Head: always. Standalone: llmMonitoring (default true).
 */
export function isLlmMonitoringEnabled(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
  llmMonitoring?: boolean | null;
}): boolean {
  const role = resolveSparkRole(spark);
  if (role === "worker") return false;
  if (role === "head") return true;
  return spark.llmMonitoring !== false;
}

/**
 * Part D: whether this spark probes engines at all (detection cadence for
 * workers). Overview cards use this to show the actually-running model.
 * Workers: llmPorts present. Head: always. Standalone: llmPorts present
 * (llmMonitoring only controls the full panels, not identification).
 */
export function isLlmDetectionEnabled(spark: {
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
  llmPorts?: number[] | null;
  llmPort?: number | null;
}): boolean {
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length > 0
    ? spark.llmPorts
    : Number.isInteger(spark.llmPort)
      ? [spark.llmPort as number]
      : [];
  return ports.length > 0;
}
