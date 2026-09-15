import { useCallback, useEffect, useState } from "react";
import { SERVE_ID } from "../../constants";
import type { ModelctlStatus, SparkConfig, SparkSnapshot } from "../../api/types";
import { isLlmMonitoringEnabled, resolveSparkRole } from "../../api/sparkRole";
import {
  addLlmPort,
  removeLlmPort,
  fetchSparks,
  modelctlStatus as fetchModelctlStatus,
} from "../../api/client";
import { SparkActions } from "./SparkActions";
import { ScChHead, ScModule } from "./console/ScKit";
import { ScResources } from "./console/ScResources";
import { ScServing } from "./console/ScServing";
import { ScTests } from "./console/ScTests";
import { fmtUptimeShort } from "./console/consoleUtils";
import "../../styles/console.css";

interface SparkPageProps {
  spark: SparkSnapshot;
  temperatureUnit: "celsius" | "fahrenheit";
  onEdit?: () => void;
  /** Navigate app views: null → overview, string → another spark id. */
  onNavigate?: (id: string | null) => void;
}

/** Channel anchors, in document order. */
const CHANNEL_ANCHORS = ["sec-resources", "sec-serving", "sec-tests", "sec-node"] as const;

/**
 * Scroll-spy: which channel header is above the viewport line, rAF-throttled.
 * The console scrolls with the window (the rail is position:sticky).
 */
function useChannelSpy(): string {
  const [active, setActive] = useState<string>(CHANNEL_ANCHORS[0]);
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      // Header band + sticky tab bar ≈ 96px; a channel is "current" once its
      // anchor passed that line; last such anchor wins.
      const line = 96;
      let current: string = CHANNEL_ANCHORS[0];
      for (const id of CHANNEL_ANCHORS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      // Bottom of page: short last channels can never cross the line —
      // activate the bottom-most anchor that is on-screen at all.
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
        for (let i = CHANNEL_ANCHORS.length - 1; i >= 0; i--) {
          const el = document.getElementById(CHANNEL_ANCHORS[i]);
          if (el && el.getBoundingClientRect().top < window.innerHeight) {
            current = CHANNEL_ANCHORS[i];
            break;
          }
        }
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);
  return active;
}

function dataField(k: string, v: string | null) {
  if (v == null || v === "" || v === "—") return null;
  return (
    <div className="plate__f">
      <span className="plate__k">{k}</span>
      <span className="plate__v" title={v}>
        {v}
      </span>
    </div>
  );
}

export function SparkPage({ spark, temperatureUnit, onEdit, onNavigate }: SparkPageProps) {
  const { metrics } = spark;
  const activeChannel = useChannelSpy();
  const [llmPorts, setLlmPorts] = useState<number[]>(spark.llmPorts ?? [spark.llmPort ?? 8888]);
  // Config-only fields the WS snapshot doesn't carry (modelctl opt-in, head name).
  const [allCfg, setAllCfg] = useState<SparkConfig[] | null>(null);
  const cfg = allCfg?.find((s) => s.id === spark.id) ?? null;
  const [modelctl, setModelctl] = useState<ModelctlStatus | null>(null);

  const llmOn = isLlmMonitoringEnabled(spark);
  const role = resolveSparkRole(spark);
  const modelctlEnabled = Boolean(cfg?.modelctlEnabled);

  // Sync when spark data changes (WS push)
  useEffect(() => {
    if (spark.llmPorts) setLlmPorts(spark.llmPorts);
  }, [spark.llmPorts]);

  // Resolve configs (modelctlEnabled flag + names for the worker head link).
  useEffect(() => {
    let dead = false;
    setAllCfg(null);
    fetchSparks()
      .then(({ sparks }) => !dead && setAllCfg(sparks))
      .catch(() => !dead && setAllCfg(null));
    return () => {
      dead = true;
    };
  }, [spark.id]);

  // modelctl version (once per node + explicit refresh after install).
  const refreshModelctl = useCallback(() => {
    return fetchModelctlStatus(spark.id)
      .then((st) => {
        setModelctl(st);
        if (st.installed) setCfgInstalled();
        return st;
      })
      .catch((err) => {
        setModelctl({
          installed: false,
          version: null,
          uv: { installed: false, version: null },
          error: String(err instanceof Error ? err.message : err),
        });
      });
    function setCfgInstalled() {
      setAllCfg((list) =>
        list ? list.map((s) => (s.id === spark.id ? { ...s, modelctlEnabled: true } : s)) : list
      );
    }
  }, [spark.id]);

  useEffect(() => {
    if (!modelctlEnabled || !spark.online) return;
    void refreshModelctl();
  }, [modelctlEnabled, spark.online, refreshModelctl]);


  const handleAddPort = useCallback(
    async (port: number) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      if (llmPorts.includes(port)) return;
      try {
        const result = await addLlmPort(spark.id, port);
        setLlmPorts(result.llmPorts);
      } catch (err) {
        console.error("Failed to add LLM port:", err);
      }
    },
    [spark.id, llmPorts]
  );

  const handleRemovePort = useCallback(
    async (port: number) => {
      try {
        const result = await removeLlmPort(spark.id, port);
        setLlmPorts(result.llmPorts);
      } catch (err) {
        console.error("Failed to remove LLM port:", err);
      }
    },
    [spark.id]
  );


  const anyEngine = llmOn && (metrics.llm ?? []).some((l) => l?.available);
  const tailscaleOn = Boolean(spark.tailscaleMonitoring);
  const primaryPort = llmPorts[0] ?? null;
  const primaryLlm = metrics.llm?.[0] ?? null;
  const headSparkName =
    spark.workerHeadId != null
      ? allCfg == null
        ? null
        : (allCfg.find((s) => s.id === spark.workerHeadId)?.name ?? spark.workerHeadId)
      : null;

  // Rack plate values
  const hw = spark.hardware;
  const soc = hw.gpuChip ?? (hw.device === "DGX Spark" ? "GB10" : null);
  const pkgs =
    [
      modelctl?.installed ? `modelctl v${modelctl.version ?? "?"}` : null,
      spark.agentEnabled ? `agent v${spark.agentVersion ?? "?"}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;

  return (
    <div className="spark-console">
      <main className="console">
        {/* ── Node header: rack plate ───────────────────────────────── */}
        <header className="module rack col-full" aria-label="Node identity">
          <div className="rack__back">
            <a
              className="node-back"
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onNavigate?.(null);
              }}
            >
              ‹ Overview
            </a>
            <div className="rack__id">
              <span
                className={`led ${spark.online ? "led--live" : ""}`}
                title={spark.online ? "Online" : "Offline"}
                aria-label={spark.online ? "Online" : "Offline"}
              />
              <span className="rack__name">{spark.name}</span>
              {role !== "standalone" ? <span className="chip chip--accent">{role}</span> : null}
              {role === "worker" && spark.workerLabel ? (
                <span className="chip">{spark.workerLabel}</span>
              ) : null}
            </div>
          </div>
          <SparkActions spark={spark} onEdit={onEdit} className="rack__keys" />
        </header>

        {/* ── Sticky channel rail ───────────────────────────────────── */}
        <aside className="rail" aria-label="Console channels">
          <span className="rail__cap">CH</span>
          <RailChannel
            target="sec-resources"
            num="01"
            short="Res"
            title="Resources"
            led={spark.online ? "accent" : "off"}
            active={activeChannel === "sec-resources"}
          />
          <RailChannel
            target="sec-serving"
            num="02"
            short="Srv"
            title="Serving"
            led={anyEngine ? "live" : "off"}
            active={activeChannel === "sec-serving"}
          />
          <RailChannel
            target="sec-tests"
            num="03"
            short="Tst"
            title="Tests"
            led="off"
            active={activeChannel === "sec-tests"}
          />
          <RailChannel
            target="sec-node"
            num="04"
            short="Nd"
            title="Node"
            led={spark.online ? "accent" : "off"}
            active={activeChannel === "sec-node"}
          />
          <div className="rail__bus" aria-hidden="true" />
        </aside>

        <div className="console__body">
          {/* ── CH·01 Resources ─────────────────────────────────────── */}
          <div id="sec-resources" />
          <ScChHead
            code="CH·01"
            title="Resources"
            note={
              role === "worker"
                ? "worker telemetry · no local engine"
                : "unified memory · storage · network" + (tailscaleOn ? " · tailnet" : "")
            }
          />
          <ScResources
            spark={spark}
            temperatureUnit={temperatureUnit}
            tailscaleOn={tailscaleOn}
            headSparkName={headSparkName}
            workerHeadId={spark.workerHeadId ?? null}
            onNavigate={onNavigate}
          />

          {/* ── CH·02 Serving ───────────────────────────────────────── */}
          <div id="sec-serving" />
          <ScChHead
            code="CH·02"
            title="Serving"
            note={
              role === "worker"
                ? "workers serve through their head"
                : "engine bays (live truth) · launch & manage runs in the Serve section"
            }
            aside={
              /* Unification: script- and recipe-class control lives on /serve;
                 the node page keeps WS engine truth + the armed hero stop. */
              <button
                type="button"
                className="key"
                style={{ padding: "1px 8px", fontSize: "var(--fs-10)" }}
                onClick={() => onNavigate?.(SERVE_ID)}
                title="Open the cluster Serve page (deployments, scripts, launch)"
              >
                Serve ▸
              </button>
            }
          />
          <ScServing
            spark={spark}
            llmOn={llmOn}
            role={role}
            llmPorts={llmPorts}
            primaryPort={primaryPort}
            onAddPort={handleAddPort}
            onRemovePort={handleRemovePort}
            workerHeadId={spark.workerHeadId ?? null}
            headSparkName={headSparkName}
            onNavigate={onNavigate}
          />

          {/* ── CH·03 Tests ─────────────────────────────────────────── */}
          <div id="sec-tests" />
          <ScChHead
            code="CH·03"
            title="Tests"
            note="run against the model in CH·02 · tagged so Analysis separates self-runs"
          />
          <ScTests
            sparkId={spark.id}
            primaryPort={llmOn ? primaryPort : null}
            modelId={primaryLlm?.modelId ?? null}
            contextLength={primaryLlm?.contextLength ?? null}
            llmAvailable={Boolean(primaryLlm?.available)}
          />

          {/* ── CH·04 Node — demoted identity plate ────────────────── */}
          <div id="sec-node" />
          <ScChHead
            code="CH·04"
            title="Node"
            note="identity plate · power keys top-right"
          />
          <ScModule label="Node">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {spark.transport === "agent" ? (
                <span
                  className="chip chip--live"
                  title={`sparkdash agent connected (v${spark.agentVersion ?? "?"}) — metrics stream over WebSocket; SSH is the fallback`}
                >
                  Agent
                </span>
              ) : spark.agentEnabled ? (
                <span
                  className="chip"
                  title="sparkdash agent enabled but not connected — metrics come over SSH"
                >
                  SSH
                </span>
              ) : null}
              {spark.hermes?.monitoring && spark.hermes.installed && spark.hermes.version ? (
                <span
                  className="chip"
                  title={`Hermes Agent ${spark.hermes.version} installed on this machine`}
                >
                  Hermes
                </span>
              ) : null}
              {spark.hermes?.monitoring &&
              spark.hermes.installed === false &&
              spark.hermes.checkedAt != null ? (
                <span
                  className="chip chip--err"
                  title="The `hermes` binary was not found on this machine (check the install path or Edit Spark)."
                >
                  Hermes not found
                </span>
              ) : null}
              {spark.hermes?.monitoring && spark.hermes.error && spark.hermes.status === "idle" ? (
                <span
                  className="chip chip--err"
                  style={{ maxWidth: "16rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={`Update check failed — it will retry automatically: ${spark.hermes.error}`}
                >
                  Update check failed
                </span>
              ) : null}
            </div>
            <div className="plate" role="group" aria-label="Node data plate">
              {dataField("HW", hw.device ?? null)}
              {dataField("SOC", soc)}
              {dataField("Addr", spark.lanIp ?? cfg?.lanIp ?? null)}
              {dataField("Up", spark.online ? fmtUptimeShort(spark.uptime) : "offline")}
              {dataField("Pkg", pkgs)}
            </div>
          </ScModule>

        </div>
      </main>
    </div>
  );
}

function RailChannel({
  target,
  num,
  short,
  title,
  led,
  active,
}: {
  target: string;
  num: string;
  short: string;
  title: string;
  led: "off" | "live" | "success" | "accent";
  active: boolean;
}) {
  return (
    <button
      className={`rail__ch${active ? " rail__ch--active" : ""}`}
      type="button"
      title={title}
      aria-current={active ? "true" : undefined}
      onClick={() =>
        document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
    >
      <span className={`led${led === "off" ? "" : ` led--${led}`}`} aria-hidden="true" />
      <span className="rail__num">{num}</span>
      {short}
    </button>
  );
}
