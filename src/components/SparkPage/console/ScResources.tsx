/**
 * CH·01 Resources — v3 "instrument console" channel.
 * Gauge bank (Mem / Temp / GPU), bus strip (storage · network · tailnet),
 * worker→head attribution, and the expert-layer disclosure that keeps the
 * legacy GpuPanel/RamPanel/StoragePanel/NetworkPanel/TailscalePanel reachable.
 *
 * All values come from `spark.metrics` (refreshed by the WS snapshot every
 * ~1 s — never re-fetched here); hist series tails come from metricsStore.
 * NOTE on units: the collectors emit `unifiedMemory`, `ram` and `storage`
 * sizes in MB and `network` speeds in bytes/s (see SystemCollector.js), so we
 * widen MB → bytes before the consoleUtils byte-based formatters.
 */
import { type MouseEvent, type ReactNode } from "react";
import type { SparkSnapshot } from "../../../api/types";
import { resolveSparkRole } from "../../../api/sparkRole";
import { useMetricsHistoryTail } from "../../../hooks/metricsStore";
import { ScDisclosure, ScHist, ScLed, ScModule, ScSeg } from "./ScKit";
import { fmtGB, fmtInt, fmtTBorGB } from "./consoleUtils";

const MB = 1024 * 1024;

interface ScResourcesProps {
  spark: SparkSnapshot;
  temperatureUnit: "celsius" | "fahrenheit";
  tailscaleOn: boolean;
  /** null = configs not loaded yet; string = head spark name (worker attribution) */
  headSparkName: string | null;
  workerHeadId: string | null;
  onNavigate?: (id: string | null) => void;
  /** Legacy expert panels, composed by SparkPage. */
  children?: ReactNode;
}

/** Mirror of NetworkPanel.formatSpeed — adaptive B/KB/MB/GB per second. */
function fmtSpeed(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return "—";
  if (bytesPerSec >= 1024 ** 3) return `${(bytesPerSec / 1024 ** 3).toFixed(1)} GB/s`;
  if (bytesPerSec >= MB) return `${(bytesPerSec / MB).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/** "/mnt/nvme-data" → "nvme-data"; falls back to the device name. */
function shortMount(label: string | null | undefined, fallback: string): string {
  const segs = (label ?? "").split("/").filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : fallback;
}

/** "1.9 TB"-style pair sharing one unit where possible (mockup bus-line voice). */
function fmtPairMB(usedMb: number, totalMb: number): string {
  const used = usedMb * MB;
  const total = totalMb * MB;
  const u = fmtTBorGB(used);
  const t = fmtTBorGB(total);
  const [uNum, uUnit] = [u.replace(/ (TB|GB)$/, ""), u.endsWith("TB") ? "TB" : "GB"];
  if (t.endsWith(uUnit)) return `${uNum} / ${t.replace(/ (TB|GB)$/, "")} ${uUnit}`;
  return `${u} / ${t}`;
}

export function ScResources({
  spark,
  temperatureUnit,
  tailscaleOn,
  headSparkName,
  workerHeadId,
  onNavigate,
  children,
}: ScResourcesProps) {
  const { metrics } = spark;
  const role = resolveSparkRole(spark);

  // Hist tails (metricsStore keys — appended on every WS ingest).
  const gpuTempHist = useMetricsHistoryTail(spark.id, "gpu.temp");
  const cpuTempHist = useMetricsHistoryTail(spark.id, "cpu.temp");
  const usageHist = useMetricsHistoryTail(spark.id, "gpu.usage");

  // ── Mem gauge ──────────────────────────────────────────────────────────
  // DGX Spark reports the GB10 pool as unifiedMemory; plain hosts only have
  // ram. Both carry { used, total, percentage } in MB. The sparkline trends
  // whichever metric the gauge actually shows (they diverge on GB10 hosts).
  const um = metrics.unifiedMemory;
  const ram = metrics.ram;
  const memFromUm = um != null && um.total > 0;
  const memHist = useMetricsHistoryTail(
    spark.id,
    memFromUm ? "unifiedMemory.percentage" : "ram.percentage"
  );
  const mem = memFromUm ? um : ram != null && ram.total > 0 ? ram : null;
  const memPct = mem?.percentage ?? null;
  const memWarn = memPct != null && memPct >= 85;
  const memUsedGb = mem ? fmtGB(mem.used * MB).replace(/ (GB|MB)$/, "") : "—";
  const memTotalGb = mem ? fmtGB(mem.total * MB) : null;

  // ── Temp gauge (GPU-first, CPU fallback; thresholds mirror GpuPanel/RamPanel) ──
  const gpuTemp = metrics.gpu?.temperature ?? null;
  const cpuTemp = metrics.cpu?.temperature ?? null;
  const temp = gpuTemp ?? cpuTemp;
  const tempFromGpu = gpuTemp != null;
  const tempHist = tempFromGpu ? gpuTempHist : cpuTempHist;
  const warnT = tempFromGpu ? 65 : 85;
  const dangerT = tempFromGpu ? 85 : 95;
  const displayTemp =
    temp == null
      ? null
      : Math.round(temperatureUnit === "fahrenheit" ? (temp * 9) / 5 + 32 : temp);
  const tempUnit = temperatureUnit === "fahrenheit" ? "°F" : "°C";
  const tempState =
    temp == null ? null : temp > dangerT ? "hot" : temp > warnT ? "warm" : "nominal";
  const tempTone: "warning" | "success" | "neutral" =
    tempState === "hot" || tempState === "warm" ? "warning" : "success";

  // ── GPU usage gauge ────────────────────────────────────────────────────
  const usage = metrics.gpu?.usage ?? null;
  const power = metrics.gpu?.power ?? null;
  const gpuTitle = power
    ? `GPU — ${fmtInt(power.draw)}/${fmtInt(power.limit)} W`
    : "GPU";

  // ── Bus: storage ───────────────────────────────────────────────────────
  const disabledDevices = spark.disabledDevices ?? [];
  const devices = (Array.isArray(metrics.storage) ? metrics.storage : []).filter(
    (d) => !d.disabled && !disabledDevices.includes(d.device) && !disabledDevices.includes(d.label)
  );
  const stUsed = devices.reduce((a, d) => a + (d.used ?? 0), 0);
  const stTotal = devices.reduce((a, d) => a + (d.total ?? 0), 0);
  const stPct = stTotal > 0 ? Math.round((stUsed / stTotal) * 100) : 0;
  const roomiest =
    devices.length > 0 ? devices.reduce((a, d) => ((d.available ?? 0) >= (a.available ?? 0) ? d : a)) : null;

  // ── Bus: network ───────────────────────────────────────────────────────
  const net = metrics.network;
  const ifaces = (net?.interfaces ?? []).filter(
    (i) => !i.disabled && !(spark.disabledInterfaces ?? []).includes(i.name)
  );
  const iface =
    (net?.primaryInterface != null
      ? ifaces.find((i) => i.name === net.primaryInterface)
      : undefined) ??
    ifaces.find((i) => i.operstate === "up") ??
    ifaces[0] ??
    null;
  const linkMbps = net?.linkSpeedMbps ?? null;
  const linkLabel =
    linkMbps != null && linkMbps > 0
      ? linkMbps >= 1000
        ? `${linkMbps / 1000}GbE`
        : `${linkMbps}MbE`
      : null;

  // ── Bus: tailnet ───────────────────────────────────────────────────────
  const ts = metrics.tailscale ?? null;
  const tsAvailable = Boolean(ts?.available);
  const tsUp = Boolean(tsAvailable && ts?.online);
  const tsExpiryDays =
    ts?.keyExpiry != null ? Math.round((Date.parse(ts.keyExpiry) - Date.now()) / 86_400_000) : NaN;
  const tsHint = !tailscaleOn
    ? "monitoring off"
    : ts == null || !ts.available
      ? ts?.error
        ? `no data · ${ts.error}`
        : "no data"
      : ts.online
        ? [
            "on tailnet",
            ts.relay && ts.relay !== "-" ? `via ${ts.relay}` : "direct",
            Number.isFinite(tsExpiryDays) && tsExpiryDays >= 0 ? `expire ${tsExpiryDays} d` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : `down · ${ts.backendState ?? "unreachable"}`;

  function goHead(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    onNavigate?.(workerHeadId ?? null);
  }

  return (
    <>
      {/* ── Gauge bank ─────────────────────────────────────────────────── */}
      <ScModule label="Gauges">
        <div className="gauge-grid" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          {/* Mem */}
          <div className={`gauge${memWarn ? " gauge--warn" : ""}`}>
            <div className="gauge__top">
              <span className="mlabel">Mem</span>
              <span className="gauge__value">
                {memUsedGb}
                <small>{memTotalGb ? ` /${memTotalGb}` : " no data"}</small>
              </span>
            </div>
            <ScSeg pct={memPct ?? 0} tone={memWarn ? "warning" : "accent"} />
            <div className="gauge__foot">
              <span>{mem ? `${memPct}%` : "—"}</span>
              <ScHist values={Array.from(memHist)} w={84} h={14} tone={memWarn ? "warning" : "accent"} />
            </div>
          </div>

          {/* Temp */}
          <div className={`gauge${tempState === "hot" ? " gauge--danger" : tempState === "warm" ? " gauge--warn" : ""}`}>
            <div className="gauge__top">
              <span className="mlabel">{tempFromGpu ? "Temp" : "CPU"}</span>
              <span className="gauge__value">
                {displayTemp ?? "—"}
                <small>{displayTemp != null ? ` ${tempUnit}` : " no data"}</small>
              </span>
            </div>
            <ScSeg pct={temp == null ? 0 : Math.min(100, temp)} tone={temp == null ? "neutral" : tempTone} />
            <div className="gauge__foot">
              <span className="row" style={{ gap: 5 }}>
                {temp == null ? (
                  "—"
                ) : (
                  <>
                    <ScLed state={tempState === "nominal" ? "success" : tempState === "hot" ? "danger" : "accent"} />
                    {tempState}
                  </>
                )}
              </span>
              <ScHist
                values={Array.from(tempHist)}
                w={84}
                h={14}
                tone={tempHist.length >= 2 ? (tempTone === "warning" ? "warning" : "success") : "neutral"}
              />
            </div>
          </div>

          {/* GPU */}
          <div className="gauge" title={gpuTitle}>
            <div className="gauge__top">
              <span className="mlabel">GPU</span>
              <span className="gauge__value">
                {usage != null ? fmtInt(usage) : "—"}
                <small>{usage != null ? " %" : " no data"}</small>
              </span>
            </div>
            <ScSeg pct={usage ?? 0} tone={usage != null && usage >= 95 ? "warning" : "accent"} />
            <div className="gauge__foot">
              <span>{power ? `${fmtInt(power.draw)}/${fmtInt(power.limit)} W` : usage != null ? `${fmtInt(usage)}%` : "—"}</span>
              <ScHist values={Array.from(usageHist)} w={84} h={14} tone="accent" />
            </div>
          </div>
        </div>

        {/* Worker attribution */}
        {role === "worker" ? (
          <div className="bus-hint" style={{ marginTop: "var(--space-3)" }}>
            Worker of{" "}
            {headSparkName != null ? (
              <a
                className="xref"
                href="#"
                title={workerHeadId ?? undefined}
                onClick={goHead}
              >
                {headSparkName} ↗
              </a>
            ) : (
              "resolving…"
            )}
          </div>
        ) : null}
      </ScModule>

      {/* ── Bus strip: storage · network · tailnet ─────────────────────── */}
      <ScModule label="Bus">
        <div className="bus-strip">
          <div>
            <div className="spread" style={{ alignItems: "baseline" }}>
              <span className="mlabel">Storage</span>
              <span className="bus-line">{devices.length > 0 ? fmtPairMB(stUsed, stTotal) : "—"}</span>
            </div>
            <ScSeg pct={stPct} tone={stPct >= 85 ? "warning" : "neutral"} />
            <span className="bus-hint">
              {roomiest
                ? `${fmtTBorGB((roomiest.available ?? 0) * MB)} free · ${shortMount(roomiest.label, roomiest.device)}`
                : devices.length > 0
                  ? `${devices.length} devices`
                  : "no data"}
            </span>
          </div>

          <div>
            <div className="spread" style={{ alignItems: "baseline" }}>
              <span className="mlabel">
                Network{linkLabel ? <span className="chip"> {linkLabel}</span> : null}
              </span>
              <span className="bus-line">{iface?.name ?? "—"}</span>
            </div>
            <span className="bus-line">
              {iface
                ? `↓ ${fmtSpeed(iface.rxSpeed)} · ↑ ${fmtSpeed(iface.txSpeed)}`
                : "no data"}
            </span>
          </div>

          <div>
            <div className="spread" style={{ alignItems: "baseline" }}>
              <span className="mlabel">
                Tailnet{" "}
                {tailscaleOn ? (
                  <span className={tsUp ? "chip chip--live" : "chip"}>{tsUp ? "up" : "down"}</span>
                ) : null}
              </span>
              <span className="row" style={{ gap: 6 }}>
                {tsUp ? <ScLed state="live" /> : null}
                <span className="bus-line" style={tsUp ? undefined : { opacity: 0.5 }}>
                  {tailscaleOn && ts?.tailscaleIp ? ts.tailscaleIp : "—"}
                </span>
              </span>
            </div>
            <span
              className="bus-hint"
              title={ts?.error ?? (ts?.health?.length ? ts.health.join(" · ") : undefined)}
            >
              {tsHint}
            </span>
          </div>
        </div>
      </ScModule>

      {/* ── Expert layer: legacy panels stay reachable ─────────────────── */}
      <ScDisclosure title="Expert panels: GPU, RAM, storage, network, tailnet">
        {children ?? null}
      </ScDisclosure>
    </>
  );
}
