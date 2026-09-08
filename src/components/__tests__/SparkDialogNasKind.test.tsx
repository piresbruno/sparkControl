import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddSparkDialog } from "../AddSparkDialog";
import { EditSparkDialog } from "../EditSparkDialog";

vi.mock("../../api/client", () => ({
  addSpark: vi.fn(),
  testSparkConfig: vi.fn(),
  updateSpark: vi.fn(),
  deleteSpark: vi.fn(),
  fetchSparks: vi.fn(),
  setSparkPassword: vi.fn(),
  testSpark: vi.fn(),
}));

import { addSpark, fetchSparks, updateSpark } from "../../api/client";

// The dialogs label most fields with sibling <label>s (no htmlFor), so tests
// key off placeholders, aria-labels, and select display values instead.
const SPARK_UNIT = "NVIDIA DGX Spark";
const NAS_FORCED_LABEL = /modelctl integration — required for a store node/;

const baseSpark = {
  id: "dgx1",
  name: "DGX1",
  kind: "spark" as const,
  lanIp: "10.0.10.4",
  isLocal: false,
  ssh: { host: "10.0.10.4", user: "u", auth: "key" as const },
};
const nasvm = {
  ...baseSpark,
  id: "nasvm",
  name: "NASVM",
  kind: "nas" as const,
  nasRoot: "/mnt/nas/llm-models",
  modelctlEnabled: true,
};

beforeEach(() => {
  vi.mocked(addSpark).mockResolvedValue({ success: true } as never);
  vi.mocked(updateSpark).mockResolvedValue({ success: true } as never);
  vi.mocked(fetchSparks).mockResolvedValue({ sparks: [baseSpark, nasvm] } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AddSparkDialog — NAS model store kind", () => {
  it("switching to NAS hides LLM ports/local-host fields, shows the store path, locks modelctl on", async () => {
    const user = userEvent.setup();
    render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);

    const unit = screen.getByDisplayValue(SPARK_UNIT) as HTMLSelectElement;
    expect(unit.value).toBe("spark");
    expect(screen.getByPlaceholderText("8888")).toBeTruthy(); // LLM Ports
    expect(screen.getByText("This host (local collectors — no SSH for metrics)")).toBeTruthy();

    await user.selectOptions(unit, "nas");
    // Irrelevant fields disappear
    expect(screen.queryByPlaceholderText("8888")).toBeNull();
    expect(screen.queryByPlaceholderText("10.0.0.1")).toBeNull(); // CX7 IP
    expect(screen.queryByText("This host (local collectors — no SSH for metrics)")).toBeNull();
    // Store path input + hint appear
    expect(screen.getByLabelText("NAS LLM models path")).toBeTruthy();
    expect(screen.getByText(/for every store command/)).toBeTruthy();
    // modelctl forced checked + disabled
    const forced = screen.getByLabelText(NAS_FORCED_LABEL) as HTMLInputElement;
    expect(forced.checked).toBe(true);
    expect(forced.disabled).toBe(true);
    // Agent opt-in stays available
    const agent = screen.getByLabelText(
      "Spark Command Agent (outbound WS transport; SSH stays as fallback)"
    ) as HTMLInputElement;
    expect(agent.disabled).toBe(false);

    // Back to a Spark: the ports field returns, modelctl unlocks
    await user.selectOptions(unit, "spark");
    expect(screen.getByPlaceholderText("8888")).toBeTruthy();
    expect(screen.queryByLabelText("NAS LLM models path")).toBeNull();
    expect(
      screen.getByLabelText("modelctl integration (inventory, placement, serving on this node)")
    ).toBeTruthy();
  });

  it("Save is disabled without a store path and posts kind nas with the trimmed nasRoot", async () => {
    const user = userEvent.setup();
    render(<AddSparkDialog open onClose={() => {}} onAdded={() => {}} />);
    await user.selectOptions(screen.getByDisplayValue(SPARK_UNIT) as HTMLSelectElement, "nas");
    await user.type(screen.getByPlaceholderText("My Spark"), "Vault NAS");
    await user.type(screen.getByPlaceholderText("192.168.1.100"), "10.0.10.26");

    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nasRoot still empty

    await user.type(screen.getByLabelText("NAS LLM models path"), " /mnt/nas/llm-models ");
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);

    await waitFor(() => expect(addSpark).toHaveBeenCalledTimes(1));
    expect(vi.mocked(addSpark).mock.calls[0][0]).toMatchObject({
      kind: "nas",
      nasRoot: "/mnt/nas/llm-models",
      modelctlEnabled: true,
      // ssh host derives from the LAN IP when left blank
      ssh: { host: "10.0.10.26" },
    });
  });
});

describe("EditSparkDialog — NAS node handling", () => {
  it("loads a nas node with the path prefilled, modelctl locked on, role picker hidden", async () => {
    render(<EditSparkDialog open sparkId="nasvm" onClose={() => {}} onSaved={() => {}} />);

    const path = (await screen.findByLabelText("NAS LLM models path")) as HTMLInputElement;
    expect(path.value).toBe("/mnt/nas/llm-models");
    // kind select reads back as nas
    expect((screen.getByDisplayValue(/NAS model store/) as HTMLSelectElement).value).toBe("nas");
    // Role picker + WoL/MAC + LLM monitoring hidden for store nodes
    expect(screen.queryByDisplayValue("Standalone")).toBeNull();
    expect(screen.queryByText("MAC Address (Wake-on-LAN override)")).toBeNull();
    expect(screen.queryByText("LLM monitoring")).toBeNull();
    const mctl = screen.getByLabelText(NAS_FORCED_LABEL) as HTMLInputElement;
    expect(mctl.checked).toBe(true);
    expect(mctl.disabled).toBe(true);
  });

  it("converting a Spark to NAS posts kind nas + nasRoot with standalone coercions", async () => {
    const user = userEvent.setup();
    render(<EditSparkDialog open sparkId="dgx1" onClose={() => {}} onSaved={() => {}} />);
    const unit = (await screen.findByDisplayValue(SPARK_UNIT)) as HTMLSelectElement;
    await user.selectOptions(unit, "nas");
    await user.type(screen.getByLabelText("NAS LLM models path"), "/mnt/nas/llm-models");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateSpark).toHaveBeenCalledTimes(1));
    const [id, patch] = vi.mocked(updateSpark).mock.calls[0];
    expect(id).toBe("dgx1");
    expect(patch).toMatchObject({
      kind: "nas",
      nasRoot: "/mnt/nas/llm-models",
      modelctlEnabled: true,
      role: "standalone",
      workerNode: false,
      workerHeadId: null,
      llmMonitoring: false,
      comfyMonitoring: false,
      tailscaleMonitoring: false,
    });
  });

  it("blocks saving a NAS node without a store path", async () => {
    const user = userEvent.setup();
    render(<EditSparkDialog open sparkId="nasvm" onClose={() => {}} onSaved={() => {}} />);
    const path = await screen.findByLabelText("NAS LLM models path");
    await user.clear(path);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText(/NAS LLM models path is required/)).toBeTruthy()
    );
    expect(updateSpark).not.toHaveBeenCalled();
  });
});
