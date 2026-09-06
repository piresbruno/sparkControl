import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("DecodeBench full lifecycle: start → complete → results + history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbench-"));
  const outFile = path.join(dir, "result.json");
  const script = `
const http = require("http");
const fs = require("fs");
const { pathToFileURL } = require("url");
import(pathToFileURL(${JSON.stringify(path.join(ROOT, "server", "collectors", "DecodeBench.js"))}).href).then(async ({ DecodeBenchManager }) => {
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
    res.write('data: {"id":"ccpl-1","model":"fake-m","choices":[{"delta":{"content":"hello world token"}}]}\\n\\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":" more"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}\\n\\n');
      res.write("data: [DONE]\\n\\n");
      res.end();
    }, 20);
  });
});
srv.listen(0, "127.0.0.1", async () => {
  const dir = ${JSON.stringify(dir)};
  const mgr = new DecodeBenchManager(require("path").join(dir, "h.json"), require("path").join(dir, "a.json"));
  const { benchId } = mgr.start({
    sparkId: "sp-bench", lanIp: "127.0.0.1", port: srv.address().port,
    modelId: "fake-m", concurrencies: [1], maxTokens: 64, debug: true,
  });
  let job = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    job = mgr.getJob(benchId);
    if (job.status !== "running") break;
  }
  const hist = mgr.getHistory("sp-bench");
  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({
    status: job.status, error: job.error, waves: job.results.length,
    concurrency: job.results[0]?.concurrency ?? null,
    historyLen: hist.length, benchId,
  }));
  srv.close();
  process.exit(0);
});
});
`;
  fs.writeFileSync(path.join(dir, "flow.cjs"), script);
  execFileSync(process.execPath, [path.join(dir, "flow.cjs")], { timeout: 60_000, encoding: "utf8" });
  const result = JSON.parse(fs.readFileSync(outFile, "utf8"));
  assert.equal(result.status, "completed");
  assert.equal(result.error, null);
  assert.ok(result.waves >= 1, "wave recorded");
  assert.equal(result.concurrency, 1);
  assert.ok(result.historyLen >= 1, "history persisted");
});

test("DecodeBench validation: bad concurrency throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbench2-"));
  const { DecodeBenchManager } = await import("../DecodeBench.js");
  const mgr = new DecodeBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
  assert.throws(
    () => mgr.start({ sparkId: "x", lanIp: "127.0.0.1", port: 1, concurrencies: [], maxTokens: 64 }),
    /concurrency/i
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
