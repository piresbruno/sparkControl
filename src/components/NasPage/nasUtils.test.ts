import { describe, expect, it } from "vitest";
import { doctorSummary, jobPct, jobSpeed, lastLogLine, versionIsNewer } from "./nasUtils";

describe("jobPct / jobSpeed / lastLogLine — download log parsing", () => {
  const bar = (pct: number | string, rate: string) =>
    `model-00001-of-000002.safetensors:  ${pct}%|████▌     | 12.3GB/27.5GB [02:10<02:35, ${rate}]`;

  it("jobPct takes the newest frame's percentage", () => {
    const logTail = `${bar(21, "88MB/s")}\r${bar(67, "97.4MB/s")}`;
    expect(jobPct({ logTail })).toBe(67);
    expect(jobPct({ logTail: "staging into .modelctl-staging" })).toBeNull();
  });

  it("jobSpeed takes the newest rate token across tqdm formats", () => {
    expect(jobSpeed({ logTail: bar(45, "97.4MB/s") })).toBe("97.4MB/s");
    expect(jobSpeed({ logTail: bar(45, "937kB/s") })).toBe("937kB/s");
    expect(jobSpeed({ logTail: bar(45, "1.23GiB/s") })).toBe("1.23GiB/s");
    expect(jobSpeed({ logTail: bar(45, "110 MB/s") })).toBe("110MB/s");
    const twoFrames = `${bar(21, "88MB/s")}\r${bar(67, "97.4MB/s")}`;
    expect(jobSpeed({ logTail: twoFrames })).toBe("97.4MB/s");
    expect(jobSpeed({ logTail: "staging into .modelctl-staging" })).toBeNull();
  });

  it("lastLogLine returns the freshest \\r frame, capped at 90 chars", () => {
    const logTail = `${bar(21, "88MB/s")}\r${bar(67, "97.4MB/s")}`;
    expect(lastLogLine(logTail)).toContain("67%");
    expect(lastLogLine("x".repeat(200)).length).toBe(90);
    expect(lastLogLine("done\n\n")).toBe("done");
    expect(lastLogLine("")).toBe("");
  });
});

describe("doctorSummary — real modelctl array contract", () => {
  it("summarizes a clean audit as all-refs-valid", () => {
    const report = [
      { name: "a", status: "valid", reference: "/r/active/a", object: "/r/models/x", detail: "" },
      { name: "b", status: "valid", reference: "/r/active/b", object: "/r/models/y", detail: "" },
    ];
    expect(doctorSummary(report)).toBe("2 checks · all active refs valid");
  });

  it("counts findings and flags repair-active when a repairable dir is present", () => {
    const report = [
      { name: "a", status: "valid", reference: "/r/active/a" },
      { name: "b", status: "repairable_directory", reference: "/r/active/b", detail: "dup" },
      { name: "c", status: "broken_symlink", reference: "/r/active/c" },
    ];
    const s = doctorSummary(report);
    expect(s).toContain("3 checks");
    expect(s).toContain("1 repairable directory");
    expect(s).toContain("1 broken symlink");
    expect(s).toContain("repair-active can fix 1");
  });

  it("treats hidden_foreign_entry / missing_journal as benign", () => {
    const report = [
      { name: ".foo", status: "hidden_foreign_entry" },
      { name: "b", status: "missing_journal" },
      { name: "c", status: "valid" },
    ];
    // All three are benign → "all active refs valid", not a finding list.
    expect(doctorSummary(report)).toBe("3 checks · all active refs valid");
  });

  it("empty store reports nothing to audit", () => {
    expect(doctorSummary([])).toBe("0 active references · nothing to audit");
  });

  it("keeps the object counters fallback", () => {
    expect(doctorSummary({ checks: 9, passed: 9 })).toBe("9 checks · 9 ok");
  });

  it("echoes a raw (unparsable) report", () => {
    expect(doctorSummary({ raw: "doctor says fine" })).toBe("doctor says fine");
  });
});

describe("versionIsNewer — downgrade guard", () => {
  it("true only when latest is higher", () => {
    expect(versionIsNewer("v0.18.0", "0.17.0")).toBe(true);
    expect(versionIsNewer("0.20.0", "0.9.6")).toBe(true); // numeric, not lexicographic
  });

  it("false for equal, lower, or missing", () => {
    expect(versionIsNewer("v0.18.0", "0.18.0")).toBe(false);
    expect(versionIsNewer("v0.9.6", "0.18.0")).toBe(false); // the observed downgrade case
    expect(versionIsNewer(null, "0.18.0")).toBe(false);
    expect(versionIsNewer("v0.18.0", null)).toBe(false);
  });

  it("pads unequal lengths and strips prerelease/build", () => {
    expect(versionIsNewer("1.0", "1.0.1")).toBe(false);
    expect(versionIsNewer("1.0.1", "1.0")).toBe(true);
    expect(versionIsNewer("1.2.3-rc1", "1.2.3")).toBe(false); // core equal
  });
});
