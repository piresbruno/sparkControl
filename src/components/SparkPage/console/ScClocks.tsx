/**
 * CH·01 Clocks — underclock control for the node: GPU `nvidia-smi -lgc`
 * (lock/reset) and CPU cpufreq `max_perf` (cap/reset), applied through the
 * dashboard-installed privileged helper (`sudo -n /usr/local/bin/spark-clock`).
 *
 * Unlike the WS-fed console modules, clock state comes from a dedicated slow
 * endpoint: fetched on mount and polled every 5 s while the node is online,
 * paused (interval cleared) when it flips offline. Renders nothing on NAS
 * nodes. The dashboard remembers the desired clocks and re-applies them on
 * every false→true online transition (reboot recovery).
 */
import { useCallback, useEffect, useState } from "react";
import type { SparkClocks, SparkSnapshot } from "../../../api/types";
import { fetchSparkClocks, installClockControl, setSparkClocks } from "../../../api/client";
import { ScChip, ScModule, ScSubpanel } from "./ScKit";

const POLL_MS = 5000;
const GPU_PRESETS_MHZ = [1000, 1500, 2000, 2500];
const CPU_PRESETS_GHZ = [1, 1.5, 2, 2.5];

/** kHz → "2.00 GHz". */
function fmtGhz(khz: number | null | undefined): string {
  if (khz == null || !Number.isFinite(khz)) return "—";
  return `${(khz / 1e6).toFixed(2)} GHz`;
}

/** Structured apiFetch errors carry the route's JSON on `.payload`. */
function errorPayload(err: unknown): { error?: string; output?: string } | null {
  const p = (err as { payload?: unknown } | null)?.payload;
  return p && typeof p === "object" ? (p as { error?: string; output?: string }) : null;
}

type SetClocksBody = {
  gpu?: { mhz?: number; reset?: boolean };
  cpu?: { maxPerfKhz?: number; reset?: boolean };
};

export function ScClocks({ spark }: { spark: SparkSnapshot }) {
  const [clocks, setClocks] = useState<SparkClocks | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gpuMhz, setGpuMhz] = useState("1500");
  const [cpuGhz, setCpuGhz] = useState("1.5");

  const refresh = useCallback(async () => {
    try {
      setClocks(await fetchSparkClocks(spark.id));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [spark.id]);

  // Poll only while the node is online; re-arms on the offline→online flip.
  useEffect(() => {
    if (spark.kind === "nas" || !spark.online) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [spark.kind, spark.online, refresh]);

  async function apply(body: SetClocksBody) {
    setBusy(true);
    setActionError(null);
    try {
      setClocks(await setSparkClocks(spark.id, body));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setBusy(true);
    setActionError(null);
    setInstallOutput(null);
    try {
      await installClockControl(spark.id);
      await refresh();
    } catch (err) {
      // 502 body carries the script output (manual sudo commands on no-sudo).
      setInstallOutput(errorPayload(err)?.output || (err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  if (spark.kind === "nas") return null;

  const gpu = clocks?.gpu ?? null;
  const cpu = clocks?.cpu ?? null;
  const desired = clocks?.desired ?? null;
  const lastAt = clocks?.lastApplied?.at ?? null;

  // "Dashboard will re-apply X on next boot" hints: desired vs live node state.
  const hints: string[] = [];
  if (desired?.gpu?.mode === "lock" && gpu?.appClockMHz != null && gpu.appClockMHz !== desired.gpu.mhz) {
    hints.push(`GPU lock ${desired.gpu.mhz} MHz will be re-applied on next boot`);
  }
  const cpuNow = cpu && cpu.maxPerfKhzList.length > 0 ? Math.min(...cpu.maxPerfKhzList) : null;
  const cpuMixed =
    cpu && cpu.maxPerfKhzList.length > 1 && Math.min(...cpu.maxPerfKhzList) !== Math.max(...cpu.maxPerfKhzList);
  if (desired?.cpu?.mode === "cap" && cpuNow != null && cpuNow !== desired.cpu.khz) {
    hints.push(`CPU cap ${fmtGhz(desired.cpu.khz)} will be re-applied on next boot`);
  }

  const parsedMhz = parseInt(gpuMhz, 10);
  const gpuValid = Number.isFinite(parsedMhz) && parsedMhz >= 200;
  const parsedKhz = Math.round(parseFloat(cpuGhz) * 1e6);
  const cpuValid = Number.isFinite(parsedKhz) && parsedKhz > 0;

  return (
    <ScModule label="Clocks">
      {spark.online && clocks && !clocks.helperInstalled ? (
        <div className="subpanel" style={{ marginBottom: "var(--space-3)" }}>
          <div className="spread" style={{ alignItems: "center" }}>
            <span className="bus-hint">
              Privileged helper not installed on this node — clock control needs
              <code> /usr/local/bin/spark-clock</code> + a sudoers entry.
            </span>
            <button type="button" className="key key--primary" disabled={busy} onClick={() => void install()}>
              {busy ? "Installing…" : "Install clock control"}
            </button>
          </div>
          {installOutput ? (
            <pre
              style={{
                marginTop: "var(--space-2)",
                maxHeight: 180,
                overflow: "auto",
                fontSize: "var(--fs-10)",
                whiteSpace: "pre-wrap",
              }}
            >
              {installOutput}
            </pre>
          ) : null}
        </div>
      ) : null}

      {!spark.online ? (
        <div className="bus-hint">node offline — clock state unavailable</div>
      ) : clocks == null && loadError != null ? (
        <div className="bus-hint" title={loadError}>
          clock state unavailable · {loadError}
        </div>
      ) : (
        <>
          {/* ── GPU lock ─────────────────────────────────────────────── */}
          {clocks?.supported.gpu && gpu ? (
            <ScSubpanel
              title={<span className="mlabel">GPU</span>}
              right={
                <span className="row" style={{ gap: 6 }}>
                  {gpu.locked ? (
                    <ScChip tone="accent" title={lastAt ? `applied ${lastAt}` : undefined}>
                      Locked @ {gpu.appClockMHz ?? "?"} MHz
                    </ScChip>
                  ) : (
                    <ScChip title={lastAt ? `last apply ${lastAt}` : undefined}>
                      Default app clock {gpu.defaultAppClockMHz ?? "N/A"}
                    </ScChip>
                  )}
                  <span className="bus-line font-tabular">
                    now {gpu.currentSmMHz ?? "—"} MHz · max {gpu.maxSmMHz ?? "—"} MHz
                  </span>
                </span>
              }
            >
              <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {GPU_PRESETS_MHZ.map((mhz) => (
                  <button
                    key={mhz}
                    type="button"
                    className="key"
                    style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
                    disabled={busy}
                    onClick={() => {
                      setGpuMhz(String(mhz));
                      void apply({ gpu: { mhz } });
                    }}
                  >
                    {mhz}
                  </button>
                ))}
                <input
                  type="number"
                  min={200}
                  max={gpu.maxSmMHz ?? undefined}
                  step={50}
                  inputMode="numeric"
                  style={{ width: 88 }}
                  value={gpuMhz}
                  disabled={busy}
                  onChange={(e) => setGpuMhz(e.target.value)}
                  title={`Lock the GPU graphics clock (≤ ${gpu.maxSmMHz ?? "?"} MHz)`}
                />
                <button
                  type="button"
                  className="key key--primary"
                  disabled={busy || !gpuValid}
                  onClick={() => void apply({ gpu: { mhz: parsedMhz } })}
                >
                  Lock
                </button>
                <button
                  type="button"
                  className="key"
                  disabled={busy}
                  title="Unlock: nvidia-smi -rgc"
                  onClick={() => void apply({ gpu: { reset: true } })}
                >
                  Reset
                </button>
                {desired?.gpu ? (
                  <ScChip title={lastAt ? `last apply ${lastAt}` : "dashboard-managed"}>
                    managed {desired.gpu.mode === "lock" ? `lock ${desired.gpu.mhz} MHz` : "reset"}
                  </ScChip>
                ) : null}
              </div>
            </ScSubpanel>
          ) : null}

          {/* ── CPU cap ──────────────────────────────────────────────── */}
          {clocks?.supported.cpu && cpu ? (
            <ScSubpanel
              title={<span className="mlabel">CPU</span>}
              right={
                <span className="row" style={{ gap: 6 }}>
                  {cpuMixed ? <ScChip tone="warn">mixed</ScChip> : null}
                  <span className="bus-line font-tabular" title={lastAt ? `last apply ${lastAt}` : undefined}>
                    cap {fmtGhz(cpuNow)}
                  </span>
                  <span className="bus-hint">
                    hw {fmtGhz(cpu.hwMinKhz)}–{fmtGhz(cpu.hwMaxKhz)}
                  </span>
                </span>
              }
            >
              <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {CPU_PRESETS_GHZ.map((ghz) => (
                  <button
                    key={ghz}
                    type="button"
                    className="key"
                    style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
                    disabled={busy}
                    onClick={() => {
                      setCpuGhz(ghz.toFixed(ghz % 1 ? 1 : 0));
                      void apply({ cpu: { maxPerfKhz: Math.round(ghz * 1e6) } });
                    }}
                  >
                    {ghz.toFixed(ghz % 1 ? 1 : 0)} GHz
                  </button>
                ))}
                <input
                  type="number"
                  min={0.1}
                  max={cpu.hwMaxKhz != null ? cpu.hwMaxKhz / 1e6 : undefined}
                  step={0.1}
                  inputMode="decimal"
                  style={{ width: 88 }}
                  value={cpuGhz}
                  disabled={busy}
                  onChange={(e) => setCpuGhz(e.target.value)}
                  title={`Cap every core's max_perf (≤ ${fmtGhz(cpu.hwMaxKhz)})`}
                />
                <button
                  type="button"
                  className="key key--primary"
                  disabled={busy || !cpuValid}
                  onClick={() => void apply({ cpu: { maxPerfKhz: parsedKhz } })}
                >
                  Cap
                </button>
                <button
                  type="button"
                  className="key"
                  disabled={busy}
                  title="Write cpuinfo_max_freq back to every core"
                  onClick={() => void apply({ cpu: { reset: true } })}
                >
                  Reset (full speed)
                </button>
                {desired?.cpu ? (
                  <ScChip title={lastAt ? `last apply ${lastAt}` : "dashboard-managed"}>
                    managed {desired.cpu.mode === "cap" ? `cap ${fmtGhz(desired.cpu.khz)}` : "reset"}
                  </ScChip>
                ) : null}
              </div>
            </ScSubpanel>
          ) : null}

          {!clocks?.supported.gpu && !clocks?.supported.cpu ? (
            <div className="bus-hint">no clock-control surface detected on this node</div>
          ) : null}
        </>
      )}

      {actionError ? <div className="bus-hint" style={{ color: "var(--color-danger)" }}>{actionError}</div> : null}
      {hints.map((h) => (
        <div key={h} className="bus-hint">
          ⟳ {h}
        </div>
      ))}
    </ScModule>
  );
}
