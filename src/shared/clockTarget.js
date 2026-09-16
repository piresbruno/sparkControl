/**
 * Clock-control apply-request contract — shared by the server route
 * (server/index.js) and the React panel (ScClocks) so the UI can be
 * contract-tested against the exact validator the route runs.
 *
 * A valid apply body names at least one domain:
 *   { gpu: { mhz: number } | { reset: true } }
 *   { cpu: { maxPerfKhz: number } | { reset: true } }
 * Values are plain integers; anything else → null (route answers 400).
 */

export function parseClockApplyRequest(body) {
  if (!body || typeof body !== "object") return null;
  const parts = {};
  if (body.gpu !== undefined) {
    const g = body.gpu;
    if (!g || typeof g !== "object") return null;
    if (g.reset === true) parts.gpu = { mode: "reset" };
    else if (Number.isInteger(g.mhz) && g.mhz >= 200) parts.gpu = { mode: "lock", mhz: g.mhz };
    else return null;
  }
  if (body.cpu !== undefined) {
    const c = body.cpu;
    if (!c || typeof c !== "object") return null;
    if (c.reset === true) parts.cpu = { mode: "reset" };
    else if (Number.isInteger(c.maxPerfKhz) && c.maxPerfKhz > 0) parts.cpu = { mode: "cap", khz: c.maxPerfKhz };
    else return null;
  }
  return Object.keys(parts).length > 0 ? parts : null;
}

/**
 * Live-bounds check against the parsed status probe. Returns an error
 * message when a lock/cap exceeds the node's reported hardware envelope,
 * or null when the request may proceed. Bound checks are skipped when the
 * node did not report the corresponding limit.
 */
export function validateClockBounds(status, parts) {
  if (parts.gpu && parts.gpu.mode === "lock" && status?.gpu?.maxSmMHz != null && parts.gpu.mhz > status.gpu.maxSmMHz) {
    return `gpu.mhz ${parts.gpu.mhz} exceeds clocks.max.sm ${status.gpu.maxSmMHz}`;
  }
  if (parts.cpu && parts.cpu.mode === "cap") {
    const hwMin = status?.cpu?.hwMinKhz ?? null;
    const hwMax = status?.cpu?.hwMaxKhz ?? null;
    if (hwMax != null && parts.cpu.khz > hwMax) {
      return `cpu.maxPerfKhz ${parts.cpu.khz} exceeds hw max ${hwMax}`;
    }
    if (hwMin != null && parts.cpu.khz < hwMin) {
      return `cpu.maxPerfKhz ${parts.cpu.khz} below hw min ${hwMin}`;
    }
  }
  return null;
}
