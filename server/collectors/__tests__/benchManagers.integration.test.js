/**
 * PrefillBench + ShowcaseManager lifecycle integration — runs each manager
 * flow in a child node process (child writes a JSON result) so the SSE fetch
 * against a loopback ephemeral server behaves identically to production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Runs a child flow script; `dir` must contain flow.cjs; returns its JSON. */
function runFlow(dir) {
  const outFile = path.join(dir, "result.json");
  execFileSync(process.execPath, [path.join(dir, "flow.cjs")], {
    timeout: 90_000,
    encoding: "utf8",
  });
  return JSON.parse(fs.readFileSync(outFile, "utf8"));
}

const ENGINE = `
const srv = http.createServer((req, res) => {
  if (req.url.includes("/metrics")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("vllm:generation_tokens_total 1000\\n");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"ccpl-1","model":"fake-m","choices":[{"delta":{"content":"tok"}}]}\\n\\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":" more"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1024,"completion_tokens":2,"total_tokens":1026}}\\n\\n');
      res.write("data: [DONE]\\n\\n");
      res.end();
    }, 15);
  });
});
`;

test("PrefillBench lifecycle completes a 1024-token sweep", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefill-int-"));
  fs.writeFileSync(path.join(dir, "flow.cjs"), `
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const dir = ${JSON.stringify(dir)};
${ENGINE}
import(pathToFileURL(${JSON.stringify(path.join(ROOT, "server", "collectors", "PrefillBench.js"))}).href).then(async ({ PrefillBenchManager }) => {
srv.listen(0, "127.0.0.1", async () => {
  try {
    const mgr = new PrefillBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
    const { benchId } = mgr.start({
      sparkId: "sp-pf", lanIp: "127.0.0.1", port: srv.address().port,
      modelId: "fake-m", contextSizes: [1024],
    });
    let job = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      job = mgr.getJob(benchId);
      if (job.status !== "running") break;
    }
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
      status: job.status, error: job.error, rows: job.results?.length ?? 0,
      historyLen: mgr.getHistory("sp-pf").length,
    }));
  } catch (err) {
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ fatal: err.message }));
  }
  srv.close();
  process.exit(0);
});
});
`);
  const result = runFlow(dir);
  assert.equal(result.fatal, undefined, `child fatal: ${result.fatal}`);
  assert.equal(result.status, "completed");
  assert.equal(result.error, null);
  assert.ok(result.rows >= 1, "sweep row recorded");
  assert.ok(result.historyLen >= 1, "history persisted");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ShowcaseManager session completes and archives to history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-int-"));
  fs.writeFileSync(path.join(dir, "flow.cjs"), `
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const dir = ${JSON.stringify(dir)};
${ENGINE}
import(pathToFileURL(${JSON.stringify(path.join(ROOT, "server", "collectors", "ShowcaseManager.js"))}).href).then(async ({ ShowcaseManager }) => {
srv.listen(0, "127.0.0.1", async () => {
  try {
    const mgr = new ShowcaseManager(path.join(dir, "showcase-history.json"));
    const { sessionId } = mgr.start({
      sparkId: "sp-show", lanIp: "127.0.0.1", port: srv.address().port,
      modelId: "fake-m", maxTokens: 64, prompts: ["Say hi"],
    });
    let last = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const sess = mgr.sessions.get(sessionId);
      last = sess;
      const streamsDone = sess?.streams?.every?.((s) => s.status !== "streaming");
      if (sess?.status !== "running" || streamsDone) break;
    }
    const hist = mgr.getHistory("sp-show");
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({
      sessionStatus: last?.status ?? "gone",
      historyLen: hist.length,
    }));
  } catch (err) {
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ fatal: err.message }));
  }
  srv.close();
  process.exit(0);
});
});
`);
  const result = runFlow(dir);
  assert.equal(result.fatal, undefined, `child fatal: ${result.fatal}`);
  assert.ok(["completed", "failed", "running"].includes(result.sessionStatus), `status: ${result.sessionStatus}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
