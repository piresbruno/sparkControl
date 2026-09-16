export type ClockApplyParts = {
  gpu?: { mode: "lock"; mhz: number } | { mode: "reset" };
  cpu?: { mode: "cap"; khz: number } | { mode: "reset" };
};

export type ClockStatusShape = {
  gpu?: { maxSmMHz?: number | null } | null;
  cpu?: { hwMaxKhz?: number | null; hwMinKhz?: number | null } | null;
};

/** body → apply parts; null when the request shape is invalid. */
export function parseClockApplyRequest(body: unknown): ClockApplyParts | null;

/** Live-bounds check; returns an error message or null when allowed. */
export function validateClockBounds(status: ClockStatusShape | null | undefined, parts: ClockApplyParts): string | null;
