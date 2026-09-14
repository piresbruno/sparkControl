import { useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { shutdownSpark, wakeSpark, startJob, getJob } from "../../api/client";
import { ConfirmShutdownDialog } from "../ConfirmShutdownDialog";
import { openHermesUpdateDialog } from "../../hooks/useHermesUpdateDialog";
import { EditIcon, PowerOffIcon, PowerOnIcon, RotateIcon } from "../ui/icons";

interface SparkActionsProps {
  spark: SparkSnapshot;
  onEdit?: () => void;
  /** Classes for the button-cluster wrapper (controls responsive visibility). */
  className?: string;
}

/**
 * Update Hermes / Install agent / Shutdown·Wake / Edit action cluster.
 * Rendered once, in the node-detail rack plate (className "rack__keys").
 * Owning the shutdown dialog + transient power/agent messages here keeps the
 * cluster self-contained.
 */
export function SparkActions({ spark, onEdit, className }: SparkActionsProps) {
  const online = spark.online;
  const [powerLoading, setPowerLoading] = useState(false);
  const [powerMsg, setPowerMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [shutdownOpen, setShutdownOpen] = useState(false);

  const hermes = spark.hermes;
  const hermesRunning = hermes?.status === "running";

  function handleHermesUpdate() {
    openHermesUpdateDialog({
      sparkId: spark.id,
      sparkName: spark.name,
      currentVersion: hermes?.version ?? null,
    });
  }

  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMsg, setAgentMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);

  async function handleInstallAgent() {
    setAgentBusy(true);
    setAgentMsg({ text: "Installing…", tone: "ok" });
    try {
      const { jobId } = await startJob({ kind: "install-agent", sparkId: spark.id });
      // The server completes the job only after the agent's first hello —
      // poll until a terminal state (90 s cap; the WS snapshot still flips
      // the chip when a slow install eventually connects).
      const deadline = Date.now() + 90_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await getJob(jobId);
        if (job.status === "completed") {
          setAgentMsg({ text: "Agent connected", tone: "ok" });
          break;
        }
        if (job.status !== "running") {
          setAgentMsg({ text: job.lastError || `Install ${job.status}`, tone: "err" });
          break;
        }
        if (Date.now() > deadline) {
          setAgentMsg({ text: "Install still running — check the agent status chip", tone: "ok" });
          break;
        }
      }
    } catch (err: unknown) {
      setAgentMsg({ text: err instanceof Error ? err.message : "Install failed", tone: "err" });
    } finally {
      setAgentBusy(false);
      setTimeout(() => setAgentMsg(null), 6000);
    }
  }

  async function handleShutdown() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await shutdownSpark(spark.id);
      setPowerMsg({ text: res.message || "Shutdown initiated", tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "Shutdown failed",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  async function handleWake() {
    setPowerLoading(true);
    setPowerMsg(null);
    try {
      const res = await wakeSpark(spark.id);
      setPowerMsg({ text: res.message || "Wake packet sent", tone: "ok" });
    } catch (err: unknown) {
      setPowerMsg({
        text: err instanceof Error ? err.message : "Wake failed",
        tone: "err",
      });
    } finally {
      setPowerLoading(false);
      setTimeout(() => setPowerMsg(null), 5000);
    }
  }

  return (
    <>
      <div className={className}>
        {powerMsg && (
          <span className={`text-[11px] ${powerMsg.tone === "ok" ? "text-success" : "text-danger"}`}>
            {powerMsg.text}
          </span>
        )}
        {hermesRunning && (
          <span
            className="flex items-center gap-1.5 text-[11px] text-warning"
            title="Running `hermes update` on this machine via SSH — this can take a few minutes."
          >
            <RotateIcon className="h-3 w-3" />
            Hermes updating…
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.status === "error" && (
          <span
            className="max-w-[16rem] truncate text-[11px] text-danger"
            title={hermes.error || "Hermes update failed"}
          >
            Hermes update failed
          </span>
        )}
        {!hermesRunning && hermes?.monitoring && hermes.installed !== false && (
          <button
            type="button"
            onClick={() => void handleHermesUpdate()}
            disabled={powerLoading}
            title={
              hermes.updateAvailable === true
                ? `Run "hermes update" on this machine via SSH${
                    hermes.behindCommits ? ` (${hermes.behindCommits} commits behind)` : ""
                  }`
                : "Open Hermes Agent update status and run updates on this machine via SSH"
            }
            className={`flex items-center gap-1.5 rounded-md border bg-surface-elevated px-3 py-1.5 text-[11px] transition-colors disabled:opacity-50 ${
              hermes.updateAvailable === true
                ? "border-warning/40 text-warning hover:bg-warning/15"
                : "border-border text-muted hover:bg-surface-hover hover:text-text"
            }`}
          >
            <RotateIcon className="h-3 w-3" />
            Update Hermes
            {hermes.updateAvailable === true && (
              <span
                className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[9px] font-bold leading-none text-white"
                title={
                  hermes.behindCommits != null
                    ? `${hermes.behindCommits} commit${hermes.behindCommits === 1 ? "" : "s"} behind`
                    : "Update available"
                }
              >
                {hermes.behindCommits != null ? hermes.behindCommits : "!"}
              </span>
            )}
          </button>
        )}
        {online ? (
          <button
            type="button"
            onClick={() => setShutdownOpen(true)}
            disabled={powerLoading}
            title="Graceful shutdown (requires /usr/local/bin/spark-shutdown on the host)"
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-danger/20 hover:text-danger disabled:opacity-50"
          >
            <PowerOffIcon className="h-3 w-3" />
            Shutdown
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleWake()}
            disabled={powerLoading}
            title="Wake-on-LAN (set MAC address in Edit Spark)"
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-success/20 hover:text-success transition-colors disabled:opacity-50"
          >
            <PowerOnIcon className="h-3 w-3" />
            Wake
          </button>
        )}
        {spark.transport === "agent" ? (
          <span
            className="chip chip--live"
            title="sparkdash agent connected — metrics stream over WebSocket"
          >
            Agent v{spark.agentVersion ?? "?"}
          </span>
        ) : spark.agentEnabled ? (
          <>
            <span
              className="chip chip--warn"
              title="Enabled but not connected — metrics via SSH fallback"
            >
              Agent offline
            </span>
            <button
              type="button"
              onClick={() => void handleInstallAgent()}
              disabled={agentBusy || !online}
              title="Bootstrap the Spark Command Agent on this node over SSH (Node runtime → config → systemd → wait for first hello)"
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-50"
            >
              {agentBusy ? "Installing…" : "Install agent"}
            </button>
          </>
        ) : (
          <span
            className="chip"
            title="Enable the Spark Command Agent in Edit Spark to bootstrap it"
          >
            Agent off
          </span>
        )}
        {agentMsg && (
          <span className="max-w-[16rem] truncate text-[11px] text-muted" title={agentMsg.text}>
            {agentMsg.text}
          </span>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-[11px] text-muted hover:bg-surface-hover hover:text-text transition-colors"
          >
            <EditIcon className="h-3 w-3" />
            Edit
          </button>
        )}
      </div>

      <ConfirmShutdownDialog
        open={shutdownOpen}
        onClose={() => setShutdownOpen(false)}
        onConfirm={handleShutdown}
        title={`Shut down ${spark.name}`}
        description={`Gracefully shut down ${spark.name}? This will stop all containers and power off the node.`}
        confirmLabel="Shut down"
      />
    </>
  );
}