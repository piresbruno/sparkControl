import { useEffect, useMemo, useRef, useState } from "react";
import type { SparkSnapshot } from "../../api/types";

/** One active exception, keyed per spark+kind so "since" tracking survives re-renders. */
type Alert = { key: string; spark: SparkSnapshot; label: string; severity: "critical" | "warning" };

/**
 * Active fleet exceptions, derived from the live snapshot set (upstream 3e73254):
 *  - `<id>:offline`  — host unreachable (critical)
 *  - `<id>:throttle` — GPU clock/thermal throttle active, with nvidia-smi detail (critical)
 *  - `<id>:disk`     — any filesystem at/above 90% (warning)
 *  - `<id>:llm`      — LLM monitoring on, ports configured, none available (warning)
 *  - `<id>:tailnet`  — tailnet probe on and the tailnet is unavailable/offline (warning)
 */
function derive(sparks: SparkSnapshot[]): Alert[] {
  const alerts: Alert[] = [];
  for (const spark of sparks) {
    if (!spark.online)
      alerts.push({ key: `${spark.id}:offline`, spark, label: "Host unreachable", severity: "critical" });
    if (spark.metrics.gpu?.throttle?.active)
      alerts.push({
        key: `${spark.id}:throttle`,
        spark,
        label: `GPU throttled: ${spark.metrics.gpu.throttle.detail}`,
        severity: "critical",
      });
    if (spark.metrics.storage.some((disk) => disk.percentage >= 90))
      alerts.push({ key: `${spark.id}:disk`, spark, label: "Storage at or above 90%", severity: "warning" });
    if (spark.llmMonitoring !== false && spark.metrics.llm.length > 0 && spark.metrics.llm.every((llm) => !llm.available))
      alerts.push({ key: `${spark.id}:llm`, spark, label: "LLM unavailable", severity: "warning" });
    if (spark.tailscaleMonitoring && spark.metrics.tailscale && (!spark.metrics.tailscale.available || spark.metrics.tailscale.online === false))
      alerts.push({ key: `${spark.id}:tailnet`, spark, label: "Tailnet unavailable", severity: "warning" });
  }
  return alerts;
}

/**
 * Overview strip listing every active fleet exception, with how long each has
 * been active. Hidden when nothing is wrong — absence of exceptions is the
 * normal state and needs no panel.
 */
export function FleetAlertStrip({
  sparks,
  onSelect,
}: {
  sparks: SparkSnapshot[];
  onSelect?: (id: string) => void;
}) {
  const alerts = useMemo(() => derive(sparks), [sparks]);
  const firstSeen = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const active = new Set(alerts.map((alert) => alert.key));
    for (const alert of alerts) if (!firstSeen.current.has(alert.key)) firstSeen.current.set(alert.key, Date.now());
    for (const key of firstSeen.current.keys()) if (!active.has(key)) firstSeen.current.delete(key);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [alerts]);

  if (alerts.length === 0) return null;

  return (
    <section className="panel p-3" aria-labelledby="fleet-alerts-title">
      <h2 id="fleet-alerts-title" className="text-xs font-semibold text-text-strong">
        Active fleet exceptions · {alerts.length}
      </h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {alerts.map((alert) => (
          <li key={alert.key}>
            <button
              type="button"
              onClick={() => onSelect?.(alert.spark.id)}
              className={`min-h-11 rounded border px-3 py-2 text-left text-xs ${
                alert.severity === "critical"
                  ? "border-danger/50 text-danger"
                  : "border-warning/50 text-warning"
              }`}
            >
              <strong>{alert.spark.name}</strong> · {alert.label} ·{" "}
              {Math.max(0, Math.floor((now - (firstSeen.current.get(alert.key) ?? now)) / 60_000))}m
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
