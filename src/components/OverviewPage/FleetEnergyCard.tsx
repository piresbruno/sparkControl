import { useEffect, useState } from "react";
import { fetchFleetEnergy } from "../../api/client";
import type { FleetEnergy } from "../../api/types";

const DAY_MS = 86_400_000;
/** Re-read cadence for the tracker snapshot (the aggregation happens server-side). */
const REFRESH_MS = 10_000;

function number(value: number | null, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

/**
 * Fleet-wide estimated power draw, sourced from the tracker's rolling windows.
 *
 * Renders nothing until the tracker answers: when /api/fleet-energy is absent
 * (404) or failing, the card stays hidden instead of leaving an empty shell on
 * the Overview, and the next poll retries.
 */
export function FleetEnergyCard({
  nodeCount,
  nodeNames = {},
}: {
  nodeCount: number;
  nodeNames?: Record<string, string>;
}) {
  const [data, setData] = useState<FleetEnergy | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchFleetEnergy()
        .then((next) => {
          if (!cancelled) setData(next);
        })
        .catch(() => {
          // Endpoint missing/unreachable — degrade to hidden, keep polling.
          if (!cancelled) setData(null);
        });
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!data) return null;

  const coverage =
    nodeCount > 0 ? Math.min(100, (data.coverage24hMs / (DAY_MS * nodeCount)) * 100) : 0;
  const state = data.membershipChanged
    ? "Fleet membership changed. Restart sparkControl to establish a truthful new accounting scope."
    : data.freshNodeCount < nodeCount
      ? `Partial coverage: ${data.freshNodeCount}/${nodeCount} nodes currently fresh.`
      : data.energy24hKwh == null
        ? "Warming up — no complete energy interval recorded yet."
        : null;
  const nodeRows = Object.entries(data.nodeEnergy24hKwh ?? {})
    .filter((entry): entry is [string, number] => entry[1] != null)
    .sort((a, b) => b[1] - a[1]);
  const nodeMaxKwh = Math.max(1e-9, ...nodeRows.map(([, kwh]) => kwh));
  const lastNonNullBar = (() => {
    for (let i = data.hourlyWatts24h.length - 1; i >= 0; i--) {
      if (data.hourlyWatts24h[i] != null) return i;
    }
    return -1;
  })();

  return (
    <section className="panel p-4" aria-labelledby="fleet-energy-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="fleet-energy-title" className="text-sm font-semibold text-text-strong">
            Fleet Energy
          </h2>
          <p className="text-[10px] text-muted">
            Estimated, not wall-metered · 24h coverage {coverage.toFixed(1)}%
          </p>
        </div>
        <span className="text-xs text-muted">
          {data.freshNodeCount}/{nodeCount} fresh
        </span>
      </div>
      {state && (
        <p className="mt-3 rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
          {state}
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-[10px] text-muted">Current</div>
          <strong className="font-tabular text-sm">{number(data.currentWatts30s, 0)} W</strong>
        </div>
        <div>
          <div className="text-[10px] text-muted">24 hours</div>
          <strong className="font-tabular text-sm">{number(data.energy24hKwh)} kWh</strong>
        </div>
        <div>
          <div className="text-[10px] text-muted">31 days</div>
          <strong className="font-tabular text-sm">{number(data.energy31dKwh)} kWh</strong>
        </div>
        <div title="Wh per output token over the last 24 hours">
          <div className="text-[10px] text-muted">Efficiency</div>
          <strong className="font-tabular text-sm">
            {number(data.whPerOutputToken24h, 4)} Wh/token
          </strong>
        </div>
      </div>
      {nodeRows.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Last 24h by node</div>
          <div className="mt-1 space-y-1">
            {nodeRows.map(([id, kwh]) => (
              <div key={id} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 truncate text-muted" title={nodeNames[id] ?? id}>
                  {nodeNames[id] ?? id}
                </span>
                <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(3, ((kwh ?? 0) / nodeMaxKwh) * 100)}%` }}
                  />
                </span>
                <span className="w-20 text-right font-tabular" title={`${nodeNames[id] ?? id}: 24h estimated energy`}>
                  {(kwh ?? 0).toFixed(2)} kWh
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3">
        <div
          className="flex h-16 items-end gap-px"
          aria-label="Hourly estimated watts for the last 24 hours, with gaps shown empty"
        >
          {data.hourlyWatts24h.map((watts, index, values) => {
            const max = Math.max(1, ...values.filter((value): value is number => value != null));
            return (
              <span
                key={index}
                className={`min-w-0 flex-1 ${index === lastNonNullBar ? "bg-accent" : "bg-accent/60"}`}
                style={{ height: watts == null ? 0 : `${Math.max(4, (watts / max) * 100)}%` }}
                title={watts == null ? "No complete coverage" : `${watts.toFixed(0)} W`}
              />
            );
          })}
        </div>
        <div className="mt-1 flex justify-between font-tabular text-[10px] text-muted" aria-hidden="true">
          <span>-24h</span>
          <span>-12h</span>
          <span>now</span>
        </div>
      </div>
    </section>
  );
}
