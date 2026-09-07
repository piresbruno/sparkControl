import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "./SettingsDialog";

vi.mock("../api/client", () => ({
  fetchSettings: vi.fn(),
  fetchSparks: vi.fn(),
  updateSettings: vi.fn(),
  rotateAgentToken: vi.fn(),
}));

import { fetchSettings, fetchSparks, updateSettings } from "../api/client";
import type { Settings } from "../api/types";

function baseSettings(over: Partial<Settings> = {}): Settings {
  return {
    pollIntervalMs: 2000,
    defaultLlmPort: 8888,
    autoHideOffline: false,
    temperatureUnit: "celsius",
    benchDebugTraces: false,
    density: "compact",
    traceCapture: true,
    traceCaptureBodies: true,
    traceProxyAllowedOrigins: [],
    modelctl: {
      nasRoot: "/mnt/nas/llm-models",
      nasHostSparkId: null,
      remoteBin: "modelctl",
      source: "git+https://github.com/piresbruno/modelctl",
    },
    agent: { tokenConfigured: false },
    ...over,
  } as Settings;
}

const sparks = [
  { id: "dgx1", name: "DGX1", lanIp: "10.0.10.4", isLocal: true, ssh: { host: "10.0.10.4", user: "u", auth: "key" as const }, modelctlEnabled: true },
  { id: "nasvm", name: "NASVM", lanIp: "10.0.10.26", isLocal: false, ssh: { host: "10.0.10.26", user: "u", auth: "key" as const } },
];

beforeEach(() => {
  vi.mocked(fetchSettings).mockResolvedValue(baseSettings());
  vi.mocked(fetchSparks).mockResolvedValue({ sparks } as never);
  vi.mocked(updateSettings).mockImplementation(async (patch) => patch as Settings);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsDialog — NAS host node picker", () => {
  it("lists sparks with auto default; selection posts the id preserving siblings", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
    const picker = (await screen.findByLabelText(
      "NAS host node (runs modelctl NAS operations)"
    )) as HTMLSelectElement;
    expect(picker.value).toBe("");
    // modelctl-off hint distinguishes opted-in nodes
    expect(screen.getByRole("option", { name: "NASVM (nasvm) — modelctl off" })).toBeTruthy();
    await user.selectOptions(picker, "nasvm");
    expect(picker.value).toBe("nasvm");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const sent = vi.mocked(updateSettings).mock.calls[0][0];
    expect(sent.modelctl?.nasHostSparkId).toBe("nasvm");
    // Picker spreads the full object — siblings must be preserved in the patch.
    expect(sent.modelctl?.nasRoot).toBe("/mnt/nas/llm-models");
    expect(sent.modelctl?.remoteBin).toBe("modelctl");
  });

  it("shows a configured-but-unknown spark id instead of silently resetting to auto", async () => {
    vi.mocked(fetchSettings).mockResolvedValue(
      baseSettings({ modelctl: { ...baseSettings().modelctl, nasHostSparkId: "ghost" } })
    );
    render(<SettingsDialog open onClose={() => {}} onSaved={() => {}} />);
    const picker = (await screen.findByLabelText(
      "NAS host node (runs modelctl NAS operations)"
    )) as HTMLSelectElement;
    expect(picker.value).toBe("ghost");
    expect(screen.getByRole("option", { name: "ghost (not a registered Spark)" })).toBeTruthy();
  });
});
