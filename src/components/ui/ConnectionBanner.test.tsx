import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner";

const healthy = { connected: true, lastValidSnapshotAt: 1_000, snapshotError: null, now: 2_000, stale: false };

afterEach(cleanup);

describe("ConnectionBanner", () => {
  it("renders nothing while telemetry is healthy", () => {
    const { container } = render(<ConnectionBanner {...healthy} />);
    expect(container.firstChild).toBeNull();
  });

  it("announces staleness with the age of the last update", () => {
    render(<ConnectionBanner {...healthy} stale now={31_000} />);
    expect(screen.getByRole("status").textContent).toMatch(/stale/i);
    expect(screen.getByText(/30s ago/)).toBeTruthy();
  });

  it("announces a disconnect with the age of the data on screen", () => {
    render(<ConnectionBanner {...healthy} connected={false} now={125_000} />);
    expect(screen.getByRole("status").textContent).toMatch(/disconnected/i);
    expect(screen.getByText(/2m 4s ago/)).toBeTruthy();
  });

  it("prefers the server payload error over the age message", () => {
    render(
      <ConnectionBanner
        connected
        lastValidSnapshotAt={1_000}
        snapshotError="The server sent malformed telemetry data."
        now={31_000}
        stale
      />
    );
    expect(screen.getByText("The server sent malformed telemetry data.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/error/i);
  });

  it("waits for a first valid update when nothing has arrived yet", () => {
    render(<ConnectionBanner connected={false} lastValidSnapshotAt={null} snapshotError={null} now={5_000} stale={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/disconnected/i);
    expect(screen.getByText(/first valid update/i)).toBeTruthy();
  });
});
