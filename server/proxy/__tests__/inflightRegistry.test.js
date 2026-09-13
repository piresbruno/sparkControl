import { test } from "node:test";
import assert from "node:assert/strict";
import { createInflightRegistry } from "../inflightRegistry.js";

function fakeReq() {
  return { destroyed: false, destroy() { this.destroyed = true; } };
}

test("register/get/list lifecycle with filters", () => {
  const reg = createInflightRegistry();
  const id = reg.register({
    sparkId: "s1",
    port: 8081,
    path: "/v1/chat/completions",
    method: "POST",
    startedAt: 1000,
    clientId: "c1",
  });
  assert.equal(typeof id, "string");
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list({ sparkId: "s1" }).length, 1);
  assert.equal(reg.list({ sparkId: "other" }).length, 0);
  assert.equal(reg.list({ port: 8081 }).length, 1);
  assert.equal(reg.list({ port: 1 }).length, 0);
  assert.equal(reg.list({ clientId: "c1" }).length, 1);
  const e = reg.get(id);
  assert.equal(e.startedAt, 1000);
  assert.equal(e.model, null);
  assert.equal(e.stream, null);
  assert.equal(e.cancelledBy, null);
  // Counters are live objects the proxy mutates in place.
  e.model = "m1";
  e.contentLen = 128;
  assert.equal(reg.get(id).model, "m1");
  assert.equal(reg.get(id).contentLen, 128);
});

test("cancel destroys the attached upstream request and marks the reason", () => {
  const reg = createInflightRegistry();
  const id = reg.register({ sparkId: "s1" });
  const req = fakeReq();
  reg.attach(id, req);
  assert.equal(reg.cancel(id, "user"), true);
  assert.equal(req.destroyed, true);
  assert.equal(reg.get(id).cancelledBy, "user");
  assert.equal(reg.cancel(id, "user"), false, "second cancel is a no-op");
});

test("cancel without an attached upstream still marks the entry", () => {
  const reg = createInflightRegistry();
  const id = reg.register({ sparkId: "s1" });
  assert.equal(reg.cancel(id, "client disconnect"), true);
  assert.equal(reg.get(id).cancelledBy, "client disconnect");
});

test("cancel of unknown id → false", () => {
  const reg = createInflightRegistry();
  assert.equal(reg.cancel("does-not-exist", "user"), false);
});

test("unregister drops the entry", () => {
  const reg = createInflightRegistry();
  const id = reg.register({ sparkId: "s1" });
  reg.unregister(id);
  assert.equal(reg.get(id), undefined);
  assert.equal(reg.list().length, 0);
});

test("cancelAll honours sparkId/clientId filters and returns the count", () => {
  const reg = createInflightRegistry();
  const mk = (sparkId, clientId) => {
    const id = reg.register({ sparkId, clientId });
    reg.attach(id, fakeReq());
    return id;
  };
  const ids = [mk("s1", "c1"), mk("s1", "c1"), mk("s2", "c2")];
  assert.equal(reg.cancelAll({ sparkId: "s1" }, "stop-all"), 2);
  // Cancelled entries stay listed until the proxy's terminal path
  // unregisters them; they carry the cancel reason meanwhile.
  assert.deepEqual(
    reg.list({ sparkId: "s1" }).map((e) => e.cancelledBy),
    ["stop-all", "stop-all"]
  );
  assert.equal(reg.list({ sparkId: "s2" }).length, 1);
  for (const id of ids.slice(0, 2)) reg.unregister(id);
  assert.equal(reg.list().length, 1);
  assert.equal(reg.cancelAll({ clientId: "c2" }, "flush client"), 1);
  reg.unregister(ids[2]);
  assert.equal(reg.list().length, 0);
  assert.equal(reg.cancelAll({}, "stop-all"), 0);
});

test("list is oldest-first", () => {
  const reg = createInflightRegistry();
  const a = reg.register({ sparkId: "s", startedAt: 1 });
  const b = reg.register({ sparkId: "s", startedAt: 2 });
  assert.deepEqual(reg.list().map((e) => e.id), [a, b]);
});
