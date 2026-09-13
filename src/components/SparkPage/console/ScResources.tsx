/**
 * CH·01 Resources — v3 "instrument console" channel.
 * Gauge bank mirroring the overview spark card (VRAM / GPU / CPU), bus strip
 * (storage · network · tailnet) and worker→head attribution.
 *
 * All values come from `spark.metrics` (refreshed by the WS snapshot every
 * ~1 s — never re-fetched here); hist series tails come from metricsStore.
 * NOTE on units: the collectors emit `unifiedMemory`, `ram` and `storage`
 * sizes in MB and `network` speeds in bytes/s (see SystemCollector.js), so we
 * widen MB → bytes before the consoleUtils byte-based formatters.
 */
import { type MouseEvent } from "react";
import type { SparkSnapshot } from "../../../api/types";
import { resolveSparkRole } from "../../../api/sparkRole";
import { useMetricsHistoryTail } from "../../../hooks/metricsStore";
import {
  ScHist,
  ScLed,
  ScModule,
  ScSeg,
  gaugeCell,
  histTone,
  worstTone,
  type GaugeTone,
} from "./ScKit";
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
}

/** Adaptive B/KB/MB/GB per second. */
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
}: ScResourcesProps) {
  const { metrics } = spark;
  const role = resolveSparkRole(spark);
  // Hist tails (metricsStore keys — appended on every WS ingest). Same keys
  // the overview cards trend.
  const vramHist = useMetricsHistoryTail(spark.id, "unifiedMemory.percentage");
  const ramHist = useMetricsHistoryTail(spark.id, "ram.percentage");
  const usageHist = useMetricsHistoryTail(spark.id, "gpu.usage");
  const cpuUsageHist = useMetricsHistoryTail(spark.id, "cpu.usage");

  // ── VRAM gauge — overview-card voice (used /total top, full pair foot) ─
  // Discrete VRAM first, GB10 unified pool as fallback; MB (see unit note).
  const vram = metrics.gpu?.vram ?? null;
  const um = metrics.unifiedMemory;
  const vramUsed = vram?.used ?? um?.used ?? 0;
  const vramTotal = vram?.total ?? um?.total ?? 0;
  const vramPct = vram?.percentage ?? um?.percentage ?? 0;
  const vramTone: GaugeTone = vramPct > 85 ? "danger" : vramPct > 60 ? "warning" : "accent";
  const vramUsedLabel = vramTotal > 0 ? fmtGB(vramUsed * MB).replace(/ (GB|MB)$/, "") : "—";
  const vramTotalLabel = vramTotal > 0 ? fmtGB(vramTotal * MB) : null;

  // ── Host RAM gauge — the overview renders this on plain hosts only ─────
  const hostRam = spark.kind === "host" ? metrics.ram : null;
  const rUsed = hostRam?.used ?? 0;
  const rTotal = hostRam?.total ?? 0;
  const rPct = rTotal > 0 ? Math.round((rUsed / rTotal) * 100) : 0;
  const ramTone: GaugeTone = rPct > 85 ? "danger" : rPct > 60 ? "warning" : "accent";

  // ── GPU gauge — temp headline, usage bar; tone follows the worse of the
  // two so neither condition hides behind the other (overview grouping).
  const gpuTemp = metrics.gpu?.temperature ?? null;
  const usage = metrics.gpu?.usage ?? null;
  const power = metrics.gpu?.power ?? null;
  const gpuTitle = power ? `GPU — ${fmtInt(power.draw)}/${fmtInt(power.limit)} W` : "GPU";
  const displayTemp =
    gpuTemp == null
      ? null
      : Math.round(temperatureUnit === "fahrenheit" ? (gpuTemp * 9) / 5 + 32 : gpuTemp);
  const tempUnit = temperatureUnit === "fahrenheit" ? "°F" : "°C";
  const tempTone: GaugeTone =
    gpuTemp == null
      ? "success"
      : gpuTemp > 85
        ? "danger"
        : gpuTemp > 65
          ? "warning"
          : gpuTemp > 40
            ? "accent"
            : "success";
  const usageTone: GaugeTone =
    (usage ?? 0) > 85 ? "danger" : (usage ?? 0) > 60 ? "warning" : "accent";
  const gpuTone = worstTone(tempTone, usageTone);
  const smClock = metrics.gpu?.throttle?.smClockMHz ?? null;
  const gpuClockLabel = smClock ? ` · ${(smClock / 1000).toFixed(1)} GHz` : "";

  // ── CPU gauge — temp headline, usage bar, draw/tdp + clock foot ────────
  const cpuUsage = metrics.cpu?.usage ?? 0;
  const cpuTempRaw = metrics.cpu?.temperature ?? 0;
  const cpuTempTone: GaugeTone =
    cpuTempRaw > 95 ? "danger" : cpuTempRaw > 85 ? "warning" : cpuTempRaw > 50 ? "accent" : "success";
  const cpuUsageTone: GaugeTone = cpuUsage > 85 ? "danger" : cpuUsage > 60 ? "warning" : "accent";
  const cpuTone = worstTone(cpuTempTone, cpuUsageTone);
  const cpuDisplayTemp =
    cpuTempRaw > 0 && temperatureUnit === "fahrenheit"
      ? Math.round((cpuTempRaw * 9) / 5 + 32)
      : cpuTempRaw;
  const cpuClockLabel = metrics.cpu?.clockMHz
    ? ` · ${(metrics.cpu.clockMHz / 1000).toFixed(1)} GHz`
    : "";

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
        <div className="gauge-grid">
          {/* VRAM */}
          <div className={`gauge${gaugeCell(vramTone)}`}>
            <div className="gauge__top">
              <span className="mlabel">VRAM</span>
              <span className="gauge__value">
                {vramUsedLabel}
                <small>{vramTotalLabel ? ` /${vramTotalLabel}` : " no data"}</small>
              </span>
            </div>
            <ScSeg pct={vramPct} tone={vramTone} />
            <div className="gauge__foot">
              <span>{vramTotal > 0 ? `${vramUsedLabel} / ${vramTotalLabel}` : "—"}</span>
              <ScHist values={Array.from(vramHist)} w={84} h={14} tone={histTone(vramTone)} />
            </div>
          </div>

          {/* RAM — plain hosts only (system RAM separate from discrete VRAM) */}
          {spark.kind === "host" ? (
            <div className={`gauge${gaugeCell(ramTone)}`}>
              <div className="gauge__top">
                <span className="mlabel">RAM</span>
                <span className="gauge__value">
                  {rTotal > 0 ? fmtGB(rUsed * MB).replace(/ (GB|MB)$/, "") : "—"}
                  <small>{rTotal > 0 ? ` /${fmtGB(rTotal * MB)}` : ""}</small>
                </span>
              </div>
              <ScSeg pct={rPct} tone={ramTone} />
              <div className="gauge__foot">
                <span>{rTotal > 0 ? `${fmtGB(rUsed * MB)} / ${fmtGB(rTotal * MB)}` : "—"}</span>
                <ScHist values={Array.from(ramHist)} w={84} h={14} tone={histTone(ramTone)} />
              </div>
            </div>
          ) : null}

          {/* GPU — temp headline, usage bar (overview grouping) */}
          <div className={`gauge${gaugeCell(gpuTone)}`} title={gpuTitle}>
            <div className="gauge__top">
              <span className="mlabel">GPU</span>
              <span className="gauge__value">
                {displayTemp ?? "—"}
                <small>{displayTemp != null ? ` ${tempUnit}` : " no data"}</small>
              </span>
            </div>
            <ScSeg pct={Math.min(100, usage ?? 0)} tone={gpuTone} />
            <div className="gauge__foot">
              <span>{usage != null ? `${usage}%${gpuClockLabel}` : "—"}</span>
              <ScHist values={Array.from(usageHist)} w={84} h={14} tone={histTone(gpuTone)} />
            </div>
          </div>

          {/* CPU — temp headline, usage bar, draw/tdp + clock foot */}
          {cpuTempRaw > 0 || cpuUsage > 0 ? (
            <div className={`gauge${gaugeCell(cpuTone)}`}>
              <div className="gauge__top">
                <span className="mlabel">CPU</span>
                <span className="gauge__value">
                  {cpuTempRaw > 0 ? cpuDisplayTemp : Math.round(cpuUsage)}
                  <small>{cpuTempRaw > 0 ? ` ${tempUnit}` : " %"}</small>
                </span>
              </div>
              <ScSeg pct={Math.min(100, cpuUsage)} tone={cpuTone} />
              <div className="gauge__foot">
                <span>
                  {Math.round(cpuUsage)}%
                  {(metrics.cpu?.tdp ?? 0) > 0
                    ? ` · ${Math.round(metrics.cpu?.draw ?? 0)}/${Math.round(metrics.cpu?.tdp ?? 0)} W`
                    : cpuTempRaw > 0
                      ? ` · ${cpuDisplayTemp}${tempUnit}`
                      : ""}
                  {cpuClockLabel}
                </span>
                <ScHist values={Array.from(cpuUsageHist)} w={84} h={14} tone={histTone(cpuTone)} />
              </div>
            </div>
          ) : null}
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
    </>
  );
}
