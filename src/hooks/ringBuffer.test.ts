import { describe, expect, it } from "vitest";
import { RingBuffer, TimedRingBuffer } from "./ringBuffer";

describe("RingBuffer", () => {
  it("keeps bounded chronological output after wraparound", () => {
    const buffer = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((value) => buffer.push(value));
    expect(buffer.length).toBe(3);
    expect(buffer.toArray()).toEqual([3, 4, 5]);
    expect(buffer.first).toBe(3);
    expect(buffer.last).toBe(5);
  });

  it("supports pruning and replacing a duplicate-timestamp tail", () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.replaceLast(9);
    expect(buffer.shift()).toBe(1);
    expect(buffer.toArray()).toEqual([9]);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new RingBuffer<number>(0)).toThrow();
    expect(() => new RingBuffer<number>(1.5)).toThrow();
  });
});

describe("TimedRingBuffer", () => {
  it("prunes samples older than the wall-clock cutoff, keeping the newest", () => {
    const buffer = new TimedRingBuffer(5);
    [0, 1_000, 2_000, 60_000].forEach((at) => buffer.push({ at, value: at }));
    buffer.pruneBefore(2_000);
    expect(buffer.toArray()).toEqual([
      { at: 2_000, value: 2_000 },
      { at: 60_000, value: 60_000 },
    ]);
  });

  it("prunes an entirely stale buffer down to empty", () => {
    const buffer = new TimedRingBuffer(4);
    buffer.push({ at: 0, value: 1 });
    buffer.push({ at: 500, value: 2 });
    buffer.pruneBefore(1_000);
    expect(buffer.toArray()).toEqual([]);
    expect(buffer.last()).toBeUndefined();
  });

  it("drops the oldest samples once capacity is exceeded", () => {
    const buffer = new TimedRingBuffer(3);
    [10, 20, 30, 40].forEach((at) => buffer.push({ at, value: at }));
    expect(buffer.toArray().map((s) => s.at)).toEqual([20, 30, 40]);
    expect(buffer.tail(2).map((s) => s.at)).toEqual([30, 40]);
  });

  it("replaces the tail sample for a repeated timestamp", () => {
    const buffer = new TimedRingBuffer(3);
    buffer.push({ at: 1_000, value: 1 });
    buffer.replaceLast({ at: 1_000, value: 9 });
    expect(buffer.toArray()).toEqual([{ at: 1_000, value: 9 }]);
  });

  it("keeps a bounded workload cheap (12 series × 1 h at 2 s)", () => {
    const series = Array.from({ length: 12 * 8 }, () => new TimedRingBuffer(28_800));
    const startedAt = performance.now();
    for (let sample = 0; sample <= 28_800; sample += 1) {
      for (const buffer of series) buffer.push({ at: sample * 2_000, value: sample });
    }
    const elapsedMs = performance.now() - startedAt;
    expect(series.every((buffer) => buffer.toArray().length === 28_800)).toBe(true);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 10_000);
});
