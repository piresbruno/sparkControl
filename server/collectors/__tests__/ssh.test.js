import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sshExec, sshTest, llmTest, _setExecFile, _setSshpassAvailable } from "../ssh.js";

afterEach(() => {
  _setExecFile(null);
  _setSshpassAvailable(null);
});

test("sshExec passes key-auth argv, sanitizes env, resolves trimmed stdout", async () => {
  const captured = {};
  _setExecFile((file, args, opts, cb) => {
    captured.file = file;
    captured.args = args;
    captured.opts = opts;
    cb(null, "  hello\n", "");
  });
  const out = await sshExec(
    { id: "s1", ssh: { host: "10.0.0.5", user: "root", auth: "key" } },
    "echo hello"
  );
  assert.equal(out, "hello");
  assert.equal(captured.file, "ssh");
  assert.ok(captured.args.includes("-o", "BatchMode=yes") || captured.args.includes("BatchMode=yes"));
  assert.ok(captured.args.includes("--"), "option stop before destination");
  assert.ok(captured.args.includes("root@10.0.0.5"));
  assert.equal(captured.opts.env.SSHPASS, undefined, "no password env on key auth");
  assert.ok(!("GITHUB_TOKEN" in captured.opts.env), "env whitelist excludes process noise");
});

test("sshExec multiplexes per host with a hand-expanded, short ControlPath", async () => {
  const capture = async (host) => {
    const captured = {};
    _setExecFile((file, args, opts, cb) => {
      captured.args = args;
      cb(null, "ok", "");
    });
    await sshExec({ id: host, ssh: { host, user: "root", auth: "key" } }, "echo ok");
    return captured.args;
  };

  const argsA = await capture("10.0.0.5");
  assert.ok(argsA.includes("ControlMaster=auto"));
  const controlPathArg = argsA.find((a) => a.startsWith("ControlPath="));
  assert.ok(controlPathArg, "ControlPath present");
  assert.match(controlPathArg, /^ControlPath=\/tmp\/sparkcontrol-[0-9a-f]{40}$/);
  assert.ok(!controlPathArg.includes("%"), "expanded, not ssh's %C template");
  assert.ok(
    controlPathArg.length - "ControlPath=".length < 104,
    "socket path under the sun_path limit"
  );
  assert.ok(argsA.includes("ControlPersist=300"));
  assert.equal(argsA[argsA.indexOf("--") + 1], "root@10.0.0.5", "destination still after --");

  const argsB = await capture("10.0.0.6");
  assert.notEqual(
    argsB.find((a) => a.startsWith("ControlPath=")),
    controlPathArg,
    "distinct socket per target host"
  );
});

test("sshExec password auth routes via sshpass -e with SSHPASS env", async () => {
  _setSshpassAvailable(true);
  const captured = {};
  _setExecFile((file, args, opts, cb) => {
    captured.file = file;
    captured.opts = opts;
    cb(null, "ok", "");
  });
  await sshExec(
    { id: "s2", ssh: { host: "10.0.0.5", user: "root", auth: "pass", password: "pw" } },
    "echo ok"
  );
  assert.equal(captured.file, "sshpass");
  assert.equal(captured.opts.env.SSHPASS, "pw");
});

test("sshExec rejects on nonzero exit with stderr message", async () => {
  _setExecFile((file, args, opts, cb) => cb(new Error("exited 2"), "", "remote: boom"));
  await assert.rejects(
    sshExec({ id: "s3", ssh: { host: "10.0.0.5", user: "root", auth: "key" } }, "false"),
    /remote: boom/
  );
});

test("sshExec validates target + user before spawning", async () => {
  _setExecFile(() => assert.fail("must not spawn"));
  await assert.rejects(
    sshExec({ id: "s4", ssh: { host: "169.254.169.254", user: "root", auth: "key" } }, "x"),
    /not allowed/
  );
  await assert.rejects(
    sshExec({ id: "s5", ssh: { host: "10.0.0.5", user: "bad user", auth: "key" } }, "x"),
    /user not allowed/i
  );
  await assert.rejects(
    sshExec({ id: "s6", ssh: { host: "", user: "root", auth: "key" } }, "x"),
    /config missing/i
  );
});

test("sshTest maps ok/fail", async () => {
  _setExecFile((f, a, o, cb) => cb(null, "ok", ""));
  const t1 = await sshTest({ id: "s7", ssh: { host: "10.0.0.5", user: "root", auth: "key" } });
  assert.equal(t1.ok, true);
  _setExecFile((f, a, o, cb) => cb(new Error("nope"), "", "refused"));
  const t2 = await sshTest({ id: "s8", ssh: { host: "10.0.0.5", user: "root", auth: "key" } });
  assert.equal(t2.ok, false);
});
