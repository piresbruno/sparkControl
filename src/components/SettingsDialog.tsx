import { useEffect, useState } from "react";
import { fetchSettings, fetchSparks, updateSettings, rotateAgentToken } from "../api/client";
import type { Settings, SparkConfig } from "../api/types";
import { useModalPresence } from "../hooks/useModalPresence";
import packageJson from "../../package.json";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
}

const POLL_PRESETS = [
  { label: "1s", value: 1000 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
];

export function SettingsDialog({ open, onClose, onSaved }: SettingsDialogProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sparks, setSparks] = useState<SparkConfig[]>([]);

  useEscape(onClose);

  useEffect(() => {
    if (!open) {
      setSettings(null);
      setError(null);
      setDirty(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchSettings(), fetchSparks().catch(() => ({ sparks: [] as SparkConfig[] }))])
      .then(([s, sp]) => {
        if (!cancelled) {
          setSettings(s);
          setSparks(sp.sparks);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const { mounted, visible } = useModalPresence(open);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const [rotating, setRotating] = useState(false);
  const [rotateMsg, setRotateMsg] = useState<string | null>(null);

  async function handleRotateToken() {
    setRotating(true);
    try {
      await rotateAgentToken();
      const fresh = await fetchSettings();
      setSettings((prev) => (prev ? { ...prev, ...fresh } : fresh));
      setRotateMsg("Token regenerated — connected agents re-auth; disconnected ones need re-bootstrap");
    } catch (err: unknown) {
      setRotateMsg(err instanceof Error ? err.message : "Rotate failed");
    } finally {
      setRotating(false);
      setTimeout(() => setRotateMsg(null), 6000);
    }
  }

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateSettings(settings);
      setSettings(result);
      setDirty(false);
      onSaved(result);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={`settings-overlay fixed inset-0 z-50 flex justify-center bg-black/55 p-0 sm:p-4${
        visible ? " is-open" : ""
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel w-full max-w-sm">
        <h2 className="shrink-0 px-6 pt-6 text-sm font-semibold text-text-strong">Settings</h2>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4">
          {loading && <p className="text-xs text-muted">Loading…</p>}

          {settings && !loading && (
            <div className="space-y-4">
              {/* Poll interval */}
              <div>
                <label className="mb-2 block text-xs text-muted">Poll interval</label>
                <div className="flex gap-2">
                  {POLL_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => update({ pollIntervalMs: preset.value })}
                      className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                        settings.pollIntervalMs === preset.value
                          ? "bg-accent text-white"
                          : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Default LLM port */}
              <div>
                <label className="mb-1 block text-xs text-muted">Default LLM port</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={settings.defaultLlmPort}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) update({ defaultLlmPort: val });
                  }}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                />
                <p className="mt-1 text-[10px] text-muted">
                  Pre-filled when adding a new Spark (1–65535)
                </p>
              </div>

              {/* Auto-hide offline */}
              <div>
                <label className="flex items-center gap-3 text-xs text-muted">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.autoHideOffline}
                    onClick={() => update({ autoHideOffline: !settings.autoHideOffline })}
                    className={`toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      settings.autoHideOffline ? "is-on" : ""
                    }`}
                  >
                    <span
                      className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                        settings.autoHideOffline ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                  Auto-hide offline Sparks on Overview
                </label>
              </div>

              {/* Benchmark debug traces */}
              <div>
                <label className="flex items-start gap-3 text-xs text-muted">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(settings.benchDebugTraces)}
                    onClick={() =>
                      update({ benchDebugTraces: !settings.benchDebugTraces })
                    }
                    className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      settings.benchDebugTraces ? "is-on" : ""
                    }`}
                  >
                    <span
                      className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                        settings.benchDebugTraces ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                  <span>
                    <span className="block text-text">Enable debug traces for Benchmark runs</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                      Stores prompts, HTTP/completion IDs, content previews, and GPU
                      samples in bench history. Off by default — larger history files.
                    </span>
                  </span>
                </label>
              </div>

              {/* Analysis: trace capture */}
              <div>
                <label className="flex items-start gap-3 text-xs text-muted">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(settings.traceCapture)}
                    onClick={() => update({ traceCapture: !settings.traceCapture })}
                    className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      settings.traceCapture ? "is-on" : ""
                    }`}
                  >
                    <span
                      className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                        settings.traceCapture ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                  <span>
                    <span className="block text-text">Capture LLM traces (Analysis)</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                      Record every inference through the /llm proxy plus bench/showcase
                      runs. Off = pure forwarding, nothing recorded.
                    </span>
                  </span>
                </label>
              </div>

              {/* Analysis: capture bodies */}
              <div>
                <label className="flex items-start gap-3 text-xs text-muted">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(settings.traceCaptureBodies)}
                    onClick={() => update({ traceCaptureBodies: !settings.traceCaptureBodies })}
                    className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      settings.traceCaptureBodies ? "is-on" : ""
                    }`}
                  >
                    <span
                      className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                        settings.traceCaptureBodies ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                  <span>
                    <span className="block text-text">Store request/response bodies</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                      Capped at 32 KB request / 64 KB response. Applies only when trace
                      capture is on. Bodies are never captured when off.
                    </span>
                  </span>
                </label>
              </div>

              {/* Analysis: CORS allowlist */}
              <div>
                <label className="text-xs text-muted">Proxy CORS allowlist (origins, comma-separated)</label>
                <input
                  type="text"
                  value={(settings.traceProxyAllowedOrigins || []).join(", ")}
                  onChange={(e) =>
                    update({
                      traceProxyAllowedOrigins: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="http://localhost:5173"
                  className="mt-1 w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                />
                <p className="mt-1 text-[10px] text-muted">
                  Exact origins allowed to call /llm cross-origin. Empty = same-origin only.
                </p>
              </div>

              {/* modelctl */}
              <div className="grid gap-2">
                <label htmlFor="nas-host-spark" className="text-xs text-muted">
                  NAS host node (runs modelctl NAS operations)
                </label>
                <select
                  id="nas-host-spark"
                  value={settings.modelctl?.nasHostSparkId ?? ""}
                  onChange={(e) =>
                    update({ modelctl: { ...settings.modelctl, nasHostSparkId: e.target.value || null } })
                  }
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                >
                  <option value="">Auto (head → local → sole spark)</option>
                  {settings.modelctl?.nasHostSparkId && !sparks.some((s) => s.id === settings.modelctl?.nasHostSparkId) && (
                    <option value={settings.modelctl.nasHostSparkId}>
                      {settings.modelctl.nasHostSparkId} (not a registered Spark)
                    </option>
                  )}
                  {sparks.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || s.id} ({s.id}){s.modelctlEnabled ? "" : " — modelctl off"}
                    </option>
                  ))}
                </select>
                <label className="text-xs text-muted">modelctl NAS root (path on nodes)</label>
                <input
                  type="text"
                  value={settings.modelctl?.nasRoot ?? ""}
                  onChange={(e) => update({ modelctl: { ...settings.modelctl, nasRoot: e.target.value } })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                />
                <label className="text-xs text-muted">modelctl remote binary (name or path)</label>
                <input
                  type="text"
                  value={settings.modelctl?.remoteBin ?? ""}
                  onChange={(e) => update({ modelctl: { ...settings.modelctl, remoteBin: e.target.value } })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                />
                <label className="text-xs text-muted">modelctl install source (uv tool install)</label>
                <input
                  type="text"
                  value={settings.modelctl?.source ?? ""}
                  onChange={(e) => update({ modelctl: { ...settings.modelctl, source: e.target.value } })}
                  className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
                />
              </div>

              {/* Agent token */}
              <div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted">Agent token</label>
                  <button
                    type="button"
                    onClick={() => void handleRotateToken()}
                    disabled={rotating || !settings.agent?.tokenConfigured}
                    className="text-[11px] rounded border border-border bg-surface-elevated px-2 py-0.5 text-muted hover:text-text disabled:opacity-40"
                  >
                    {rotating ? "Regenerating…" : "Regenerate"}
                  </button>
                </div>
                <p className="mt-1 text-[10px] leading-snug text-muted">
                  {settings.agent?.tokenConfigured
                    ? "Configured (stored encrypted, never shown). Regenerate rotates it; connected agents re-auth automatically, disconnected ones must be re-bootstrapped."
                    : "Not configured yet (generated on first agent install)."}
                  {rotateMsg ? ` ${rotateMsg}` : ""}
                </p>
              </div>

              {/* Temperature unit */}
              <div>
                <label className="text-xs text-muted">Temperature unit</label>
                <div className="mt-1.5 flex gap-2">
                  <button
                    type="button"
                    onClick={() => update({ temperatureUnit: "celsius" })}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                      settings.temperatureUnit === "celsius"
                        ? "bg-accent text-white"
                        : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                    }`}
                  >
                    °C
                  </button>
                  <button
                    type="button"
                    onClick={() => update({ temperatureUnit: "fahrenheit" })}
                    className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                      settings.temperatureUnit === "fahrenheit"
                        ? "bg-accent text-white"
                        : "border border-border bg-surface-elevated text-muted hover:bg-surface-hover"
                    }`}
                  >
                    °F
                  </button>
                </div>
              </div>

              {/* Density */}
              <div>
                <label className="flex items-start gap-3 text-xs text-muted">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.density === "compact"}
                    onClick={() =>
                      update({
                        density: settings.density === "compact" ? "comfortable" : "compact",
                      })
                    }
                    className={`toggle-track relative mt-0.5 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                      settings.density === "compact" ? "is-on" : ""
                    }`}
                  >
                    <span
                      className={`toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform ${
                        settings.density === "compact" ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </button>
                  <span>
                    <span className="block text-text">Compact UI</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted">
                      Tighter spacing, smaller radius, and reduced font size — fits more Sparks on a single screen.
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* Links */}
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-3">
            <span className="text-[10px] text-muted">sparkControl v{packageJson.version}</span>
            <span className="text-border-strong text-[10px]">·</span>
            <a
              href="https://x.com/MiaAI_lab"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted hover:text-accent transition-colors"
            >
              𝕏 @MiaAI_lab
            </a>
            <span className="text-border-strong text-[10px]">·</span>
            <a
              href="https://github.com/MiaAI-Lab"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-muted hover:text-accent transition-colors"
            >
              GitHub MiaAI-Lab
            </a>
          </div>

        </div>

        {error && (
          <div className="shrink-0 px-6 pt-1 text-xs">
            <div className="rounded bg-danger/20 px-3 py-2 text-danger">{error}</div>
          </div>
        )}

        <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-inherit px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !settings || !dirty}
            className="min-h-11 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}