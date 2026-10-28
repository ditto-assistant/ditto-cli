import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { importGCloudProviderSecret } from "../dist/provider-secrets.js";
import { createFakeCLIs } from "./helpers/fake-cli.mjs";

const SECRET = "synthetic-capture-secret-only";
const input = { secret: "qa-key", project: "qa-project", account: "person@example.com" };
const live = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(check, limit = 5000) {
  const until = Date.now() + limit;
  while (!check()) { if (Date.now() >= until) assert.fail("owned fixture cleanup deadline exceeded"); await delay(25); }
}
function fixture(t, mode) {
  const dir = mkdtempSync(path.join(tmpdir(), "heyditto-capture-lifecycle-"));
  const pids = path.join(dir, "owned-pids.json");
  writeFileSync(path.join(dir, "gcloud"), `#!${process.execPath}
import fs from 'node:fs'; import {spawn} from 'node:child_process';
if(process.argv[2]==='auth') process.stdout.write(JSON.stringify([{account:'person@example.com',status:'ACTIVE'}]));
else if(process.argv[2]==='config') process.stdout.write(JSON.stringify({core:{account:'person@example.com',project:'qa-project'}}));
else {
 process.on('SIGTERM',()=>{});
 process.stdout.on('error',()=>{}); process.stderr.on('error',()=>{});
 const descendant=process.env.FIXTURE_MODE==='pipes'?spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]}):undefined;
 fs.writeFileSync(process.env.OWNED_PIDS,JSON.stringify([process.pid,...(descendant?[descendant.pid]:[])]));
 if(process.env.FIXTURE_MODE==='overflow')process.stdout.write(Buffer.alloc(131072,65));
 else process.stdout.write(process.env.SYNTHETIC_KEY);
 process.stderr.write(process.env.SYNTHETIC_KEY);
 setInterval(()=>{},1000);
}
`, { mode: 0o700 });
  t.after(() => {
    // These exact PIDs were recorded by this test's own isolated executable.
    if (existsSync(pids)) for (const pid of JSON.parse(readFileSync(pids, "utf8"))) if (live(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  return { pids, env: { PATH: dir, HOME: dir, OWNED_PIDS: pids, FIXTURE_MODE: mode, SYNTHETIC_KEY: SECRET } };
}

test("overflow rejects promptly and force-kills only its TERM-ignoring child", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const f = fixture(t, "overflow"), start = Date.now();
  const failure = await importGCloudProviderSecret(input, f.env).then(() => assert.fail("overflow import succeeded"), error => error);
  assert.ok(Date.now() - start < 5000);
  assert.ok(Date.now() - statSync(f.pids).mtimeMs < 1500, "overflow must settle before the 2s forced kill");
  assert.match(failure.message, /capture limit/); assert.ok(!failure.message.includes(SECRET));
  const [pid] = JSON.parse(readFileSync(f.pids, "utf8"));
  assert.ok(live(pid), "the TERM-ignoring child must survive immediate rejection until forced cleanup");
  await waitFor(() => !live(pid));
});

test("timeout settles with inherited pipes still open and preserves forced child cleanup", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  const f = fixture(t, "pipes"), original = globalThis.setTimeout;
  let deadlines = 0;
  // Shorten only the third 30s deadline (secret capture), not its real 2s kill.
  // All children/pipes/signals are real; no provider or credential is contacted.
  globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 30000 && ++deadlines === 3 ? 1500 : ms, ...args);
  const start = Date.now();
  try {
    const pending = importGCloudProviderSecret(input, f.env);
    await assert.rejects(Promise.race([pending, delay(5500).then(() => { throw new Error("fixture import did not settle"); })]), error => /timed out/.test(error.message) && !error.message.includes(SECRET));
  } finally { globalThis.setTimeout = original; }
  assert.ok(Date.now() - start < 5000);
  const [parent, descendant] = JSON.parse(readFileSync(f.pids, "utf8"));
  assert.ok(live(parent), "the TERM-ignoring wrapper must still await forced cleanup");
  assert.ok(live(descendant), "the inherited-pipe control must still be alive at settlement");
  await waitFor(() => !live(parent));
  assert.ok(live(descendant), "the helper must not kill an unrelated process tree");
});

test("fake platform failures flush complete large stdout/stderr echoes before exiting", async t => {
  const f = createFakeCLIs(["gh"]); t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const secret = `${SECRET}/`.repeat(32768);
  const child = spawn(path.join(f.dir, "bin/gh"), ["fail"], { env: { ...f.env({ FAKE_CLI_FAIL: "fail", FAKE_CLI_ECHO_STDIN: "1" }) }, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [], stderr = [];
  child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
  child.stdin.end(secret);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 1); assert.equal(Buffer.concat(stdout).toString(), secret + secret);
  assert.equal(Buffer.concat(stderr).toString(), secret + encodeURIComponent(secret) + secret + 'gh: refusing "fail" (fake failure)\n');
});


test("overflow wipes captured and late buffers and late close does not cancel owned kill", { timeout: 10000 }, async () => {
  const original = childProcess.spawn, buffers = [], kills = [];
  let secretChild;
  childProcess.spawn = (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 123; child.exitCode = null; child.signalCode = null;
    child.kill = (signal = "SIGTERM") => { kills.push(signal); return true; };
    queueMicrotask(() => {
      if (args[0] === "auth" || args[0] === "config") {
        child.stdout.emit("data", Buffer.from(JSON.stringify(args[0] === "auth" ? [{ account: "person@example.com", status: "ACTIVE" }] : { core: { account: "person@example.com", project: "qa-project" } })));
        child.emit("close", 0); return;
      }
      secretChild = child;
      for (const value of [Buffer.from(SECRET), Buffer.alloc(65536, 65)]) { buffers.push(value); child.stdout.emit("data", value); }
      child.emit("close", 0); // A late wrapper close must not cancel forced cleanup.
      queueMicrotask(() => {
        const late = Buffer.from(SECRET); buffers.push(late); child.stdout.emit("data", late);
        const diagnostic = Buffer.from(SECRET); buffers.push(diagnostic); child.stderr.emit("data", diagnostic);
        child.emit("error", new Error(SECRET));
      });
    });
    return child;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(importGCloudProviderSecret(input, {}), error => /capture limit/.test(error.message) && !error.message.includes(SECRET));
    await delay(25);
    assert.ok(buffers.every(buffer => buffer.every(byte => byte === 0)));
    assert.equal(secretChild.stdout.destroyed, true); assert.equal(secretChild.stderr.destroyed, true);
    await waitFor(() => kills.includes("SIGKILL"));
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});
