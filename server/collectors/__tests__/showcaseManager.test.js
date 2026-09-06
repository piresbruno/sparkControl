import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShowcaseManager } from "../ShowcaseManager.js";

test("fresh manager: empty history, history round trip, clear", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-mgr-"));
  const histPath = path.join(dir, "showcase-history.json");
  const mgr = new ShowcaseManager(histPath);
  assert.deepEqual(mgr.getHistory("spark-x"), []);
  assert.equal(mgr.getHistorySession("spark-x", "s1"), null);
  mgr._archiveSession({
    sessionId: "s1", sparkId: "spark-x", status: "completed",
    startedAt: Date.now(), finishedAt: Date.now(), streams: [],
  });
  const mgr2 = new ShowcaseManager(histPath);
  assert.equal(mgr2.getHistory("spark-x").length, 1);
  assert.equal(mgr2.getHistorySession("spark-x", "s1").sessionId, "s1");
  mgr2.clearHistory("spark-x");
  assert.deepEqual(mgr2.getHistory("spark-x"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
