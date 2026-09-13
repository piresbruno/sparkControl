/**
 * Membership invalidation contract between SparkRegistry and FleetEnergyTracker.
 *
 * The tracker is scoped to the node ids captured at construction. Every registry
 * add/remove/update re-checks them, so a node set that no longer matches the
 * tracker's scope surfaces as membershipChanged/restartRequired with the live
 * aggregates nulled — while integration keeps running underneath, so restoring
 * the scope reveals the energy accumulated during the mismatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-energy-reg-"));
process.env.SPARKS_JSON_PATH = path.join(tmp, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");

const { SparkRegistry } = await import("../../sparks/SparkRegistry.js");
const { FleetEnergyTracker } = await import("../FleetEnergyTracker.js");

const BASE_AT = Date.UTC(2026, 7, 23, 12, 34, 0);

const cfg = (id) => ({
  id,
  name: id,
  lanIp: "10.0.0.5",
  ssh: { host: "10.0.0.5", user: "root", auth: "key" },
  llmPorts: [8888],
});

/** Minimal snapshot accepted by estimateNodeWatts: 98.2 W per node at cpuUsage 0. */
function nodeSnapshot(id) {
  return {
    id,
    online: true,
    telemetryFresh: true,
    role: "worker",
    llmPorts: [],
    metrics: {
      gpu: { power: { draw: 70 } },
      cpu: { usage: 0 },
      llm: [],
    },
  };
}

test("registry add/remove/update invalidate the attached tracker without losing accumulation", () => {
  const registry = new SparkRegistry();
  registry.addSpark(cfg("node-a"));
  registry.addSpark(cfg("node-b"));

  // Same wiring as server/index.js: scope captured at construction, then attached.
  let now = BASE_AT;
  const tracker = new FleetEnergyTracker({
    nodeIds: registry.sparkIds,
    filePath: null,
    load: false,
    now: () => now,
  });
  registry.setFleetEnergyTracker(tracker);

  const fleet = (...ids) => ids.map(nodeSnapshot);

  tracker.record(fleet("node-a", "node-b"), BASE_AT);
  tracker.record(fleet("node-a", "node-b"), BASE_AT + 2_000);
  const before = tracker.snapshot(BASE_AT + 2_000);
  assert.equal(before.membershipChanged, false);
  assert.equal(before.currentWatts30s, 196.4);
  assert.ok(before.energy24hKwh > 0);
  const coverageBefore = before.coverage24hMs;

  // Adding a node changes membership: live aggregates are nulled, restart flagged.
  registry.addSpark(cfg("node-c"));
  const changed = tracker.snapshot(BASE_AT + 2_000);
  assert.equal(changed.membershipChanged, true);
  assert.equal(changed.restartRequired, true);
  assert.deepEqual(changed.trackedNodeIds, ["node-a", "node-b"]);
  assert.deepEqual(changed.currentNodeIds, ["node-a", "node-b", "node-c"]);
  assert.equal(changed.freshNodeCount, 0);
  assert.equal(changed.currentWatts30s, null);
  assert.equal(changed.energy24hKwh, null);
  assert.equal(changed.energy31dKwh, null);

  // Records for the new set still integrate: coverage (not gated by membership)
  // grows, so the invalidation is a reporting gate, not a data loss.
  now = BASE_AT + 4_000;
  assert.equal(tracker.record(fleet("node-a", "node-b", "node-c"), now), true);
  now = BASE_AT + 6_000;
  assert.equal(tracker.record(fleet("node-a", "node-b", "node-c"), now), true);
  const during = tracker.snapshot(now);
  assert.equal(during.membershipChanged, true);
  assert.ok(
    during.coverage24hMs > coverageBefore,
    "fleet integration must keep accumulating while membership is invalidated"
  );

  // Update without a membership change must not re-flag (nor unflag) anything.
  registry.updateSpark("node-a", { name: "Node A" });
  assert.equal(tracker.snapshot(now).membershipChanged, true);

  // Back to the tracked set: the scope matches again and integration continues.
  registry.removeSpark("node-c");
  now = BASE_AT + 8_000;
  assert.equal(tracker.record(fleet("node-a", "node-b"), now), true);
  const restored = tracker.snapshot(now);
  assert.equal(restored.membershipChanged, false);
  assert.equal(restored.restartRequired, false);
  assert.deepEqual(restored.currentNodeIds, ["node-a", "node-b"]);
  assert.equal(restored.currentWatts30s, 196.4);
  assert.ok(
    restored.energy24hKwh > before.energy24hKwh,
    "energy integrated while invalidated must survive scope restoration"
  );
});
