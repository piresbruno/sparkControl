import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { comfyCancelJob } from "../comfyActions.js";

function fakeComfy(port, respond) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => respond(req, res, srv));
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

const spark = { id: "c1", isLocal: true, lanIp: "127.0.0.1", comfyPort: 8188 };

test("comfyCancelJob: missing promptId rejected without network", async () => {
  const r = await comfyCancelJob(spark, null, 8188);
  assert.equal(r.ok, false);
  assert.match(r.message, /promptId required/);
});

test("comfyCancelJob: modern jobs API cancel succeeds", async () => {
  const srv = await fakeComfy(8188, (req, res) => {
    if (req.method === "POST" && req.url.includes("/api/jobs/")) {
      res.writeHead(200); res.end(); return;
    }
    res.writeHead(404); res.end();
  });
  const r = await comfyCancelJob(spark, "prompt-1", 8188);
  assert.equal(r.ok, true);
  assert.equal(r.method, "api_jobs_cancel");
  srv.close();
});

test("comfyCancelJob: falls back to legacy interrupt when jobs API 404s", async () => {
  const srv = await fakeComfy(8188, (req, res, srvRef) => {
    if (req.method === "POST" && req.url.includes("/api/jobs/")) {
      res.writeHead(404); res.end(); return;
    }
    if (req.method === "POST" && req.url.includes("/interrupt")) {
      res.writeHead(200); res.end(); return;
    }
    res.writeHead(404); res.end();
  });
  const r = await comfyCancelJob(spark, "prompt-2", 8188);
  assert.equal(r.ok, true);
  srv.close();
});

test("comfyCancelJob: unreachable server → ok:false with message", async () => {
  const r = await comfyCancelJob(spark, "prompt-3", 59999);
  assert.equal(r.ok, false);
  assert.ok(r.message);
});
