/**
 * Helpers for the NAS node page (kind "nas"). Kept out of the component so
 * they can be tested and reused (Overview NAS card uses matchStoreMount).
 * Snapshot storage metrics are MB-based (SystemCollector), byte metrics
 * (model bytes) are GB/TB via consoleUtils.
 */
import type { MctlJob, NasQueueEntry, StorageMetrics } from "../../api/types";

/** Storage value in MB → "10.0 / 16.5 TB"-voice size string. */
export function fmtStore(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return "-";
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Pick the storage mount that contains the store root (or contains it from
 * below, e.g. root "/mnt/nas/models" under mount "/mnt/nas"). Longest label
 * wins so a precise bind-mount beats its parent.
 */
export function matchStoreMount(
  storage: StorageMetrics[],
  root: string | null | undefined
): StorageMetrics | null {
  const r = (root ?? "").replace(/\/+$/, "");
  if (!r) return null;
  let best: StorageMetrics | null = null;
  for (const d of storage) {
    const label = (d.label ?? "").replace(/\/+$/, "");
    if (!label) continue;
    if (label === r || r.startsWith(`${label}/`) || label.startsWith(`${r}/`)) {
      if (!best || label.length > best.label.length) best = d;
    }
  }
  return best;
}

/** Timestamp (ms) → "just now" / "12m ago" / "3h ago" / "4d ago"; null → "never". */
export function agoLabel(ts: number | string | null | undefined, now = Date.now()): string {
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  if (t == null || !Number.isFinite(t)) return "never";
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/**
 * Per-model in-flight download state from running jobs. Download jobs are
 * named `download NAME` (or `download repo`), so a word-boundary token match
 * is exact (house rule — never substring). Queue jobs carry no per-model
 * name, so their log tail is scanned with whitespace-token equality.
 */
export function modelDownloadState(
  model: string,
  jobs: Pick<MctlJob, "kind" | "status" | "name" | "logTail">[]
): "download" | "queue" | null {
  for (const j of jobs) {
    if (j.status !== "running") continue;
    if (j.kind === "download") {
      if (j.name.split(/\s+/).includes(model)) return "download";
    } else if (j.kind === "queue") {
      if (j.logTail && j.logTail.split(/\s+/).includes(model)) return "queue";
    }
  }
  return null;
}

/** True while `model` is named in a running download/queue job. */
export function isModelBusyDownloading(
  model: string,
  jobs: Pick<MctlJob, "kind" | "status" | "name" | "logTail">[]
): boolean {
  return modelDownloadState(model, jobs) !== null;
}

/**
 * Client-side mirror of the server-built downloads.yaml (values quoted like
 * the server does — JSON.stringify is a valid YAML double-quoted scalar).
 * Preview only; the server rebuilds the YAML from the validated entries.
 */
export function buildQueuePreview(entries: NasQueueEntry[], jobs: number): string {
  void jobs; // jobs is a CLI flag (--jobs N), not a YAML field
  const lines: string[] = ["downloads:"];
  for (const e of entries) {
    lines.push(`  - source: ${JSON.stringify(e.source)}`);
    if (e.name) lines.push(`    name: ${JSON.stringify(e.name)}`);
    if (e.revision) lines.push(`    revision: ${JSON.stringify(e.revision)}`);
    if (e.quantization) lines.push(`    quantization: ${JSON.stringify(e.quantization)}`);
    if (e.runtime) lines.push(`    runtime: ${JSON.stringify(e.runtime)}`);
    if (e.mmproj) lines.push(`    mmproj: ${JSON.stringify(e.mmproj)}`);
    if (e.mtp) lines.push(`    mtp: ${JSON.stringify(e.mtp)}`);
    if (e.force) lines.push(`    force: true`);
  }
  return lines.join("\n");
}

/**
 * One-line summary of a `modelctl doctor` report.
 *
 * Real contract: modelctl emits an ARRAY of audit items
 * `{name,status,reference,object,detail}` (integrity.ActiveReferenceAudit).
 * Status vocabulary (integrity.py): `valid`, `hidden_foreign_entry`,
 * `missing_journal` are benign; the rest are findings —
 * `repairable_directory` (repair-active can fix), `broken_symlink`,
 * `invalid_object`, `outside_store_symlink`, `journal_object_mismatch`,
 * `regular_directory`, `foreign_entry`. Summary: total + "all active refs
 * valid" when clean, else the non-benign statuses counted. Defensive
 * fallback: an OBJECT report (older/alternative shapes) keeps the
 * counters path; a `{raw}` report is echoed. Never throws.
 */
const DOCTOR_BENIGN: Record<string, true> = {
  valid: true,
  hidden_foreign_entry: true,
  missing_journal: true,
};

export function doctorSummary(report: unknown): string {
  if (report == null) return "no report";
  if (typeof report === "string") return report.slice(0, 400);
  // Canonical: an array of audit items.
  if (Array.isArray(report)) {
    if (report.length === 0) return "0 active references · nothing to audit";
    const counts: Record<string, number> = {};
    let benign = 0;
    for (const item of report) {
      let key = "unknown";
      if (item && typeof item === "object" && "status" in item) {
        const st = item.status;
        if (typeof st === "string") key = st;
      }
      if (DOCTOR_BENIGN[key]) benign += 1;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const total = report.length;
    const findings: string[] = [];
    for (const st of Object.keys(counts)) {
      if (DOCTOR_BENIGN[st]) continue;
      findings.push(`${counts[st]} ${st.replace(/_/g, " ")}`);
    }
    if (findings.length === 0) return `${total} checks · all active refs valid`;
    const repairable = counts["repairable_directory"] ?? 0;
    const lead = benign ? `${benign} valid · ` : "";
    return `${total} checks · ${lead}${findings.join(" · ")}${
      repairable ? ` · ⚑ repair-active can fix ${repairable}` : ""
    }`;
  }
  const o = report as Record<string, unknown>;
  if (typeof o.raw === "string") return o.raw.slice(0, 400);
  const num = (k: string): number | null =>
    typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null;
  const bits: string[] = [];
  const checks = num("checks") ?? num("total") ?? num("checks_total");
  if (checks != null) bits.push(`${checks} checks`);
  const pass = num("passed") ?? num("ok");
  if (pass != null) bits.push(`${pass} ok`);
  const repair = num("repairable");
  if (repair != null) bits.push(`${repair} repairable`);
  const failed = num("failed") ?? (Array.isArray(o.issues) ? (o.issues as unknown[]).length : null);
  if (failed != null) bits.push(`${failed} failed`);
  if (bits.length > 0) return bits.join(" · ");
  try {
    return JSON.stringify(report).slice(0, 400);
  } catch {
    return "report unavailable";
  }
}

/**
 * True when `latest` is a HIGHER semver than `installed` (both may carry a
 * leading "v"; missing/unequal-length/prerelease handled). Guards the
 * "update available" chip so a stale release tag never advertises a
 * downgrade as an update. Numeric-only compare; unparseable → false.
 */
export function versionIsNewer(latest: string | null, installed: string | null): boolean {
  const parse = (v: string | null): number[] | null => {
    if (!v) return null;
    const core = v.replace(/^v/i, "").split(/[-+]/)[0];
    const parts = core.split(".").map((n) => Number.parseInt(n, 10));
    return parts.length && parts.every((n) => Number.isFinite(n)) ? parts : null;
  };
  const a = parse(latest);
  const b = parse(installed);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
