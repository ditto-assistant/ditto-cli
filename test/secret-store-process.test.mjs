import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deliver, run } from "../dist/secret-stores/exec.js";

const SECRET = "store-process-synthetic-secret-only";
const store = bin => ({ id: "vault", label: "Test store", bin, installHint: "test fixture" });
const echoAndExit = tail => `const fs=require('node:fs');const value=fs.readFileSync(0,'utf8');process.stdout.write(value+encodeURIComponent(value),()=>process.stderr.write(value+Buffer.from(value).toString('base64'),()=>{${tail}}));`;
function assertPrivateFailure(action, expected) {
  assert.throws(action, error => {
    assert.match(error.message, expected);
    for (const value of [SECRET, encodeURIComponent(SECRET), Buffer.from(SECRET).toString("base64")]) assert.ok(!error.message.includes(value));
    assert.match(error.message, /diagnostics suppressed/);
    return true;
  });
}

test("real signalled delivery reports SIGTERM while suppressing captured child output", { skip: process.platform === "win32" }, () => {
  const args = ["-e", echoAndExit("process.kill(process.pid,'SIGTERM');")];
  const result = run(process.execPath, args, SECRET);
  assert.equal(result.status, null); assert.equal(result.signal, "SIGTERM");
  assert.ok(result.stdout.includes(SECRET)); assert.ok(result.stderr.includes(SECRET));
  assertPrivateFailure(() => deliver(store(process.execPath), "TEST_KEY", [{ kind: "stdin", args, note: "signal fixture" }], SECRET), /terminated by SIGTERM/);
});

test("normal delivery exit remains distinct from signals and still suppresses diagnostics", () => {
  const failed = ["-e", echoAndExit("process.exit(7);")];
  const result = run(process.execPath, failed, SECRET);
  assert.equal(result.status, 7); assert.equal(result.signal, undefined); assert.equal(result.errorCode, undefined);
  assertPrivateFailure(() => deliver(store(process.execPath), "TEST_KEY", [{ kind: "stdin", args: failed, note: "exit fixture" }], SECRET), /exit 7/);
  assert.doesNotThrow(() => deliver(store(process.execPath), "TEST_KEY", [{ kind: "stdin", args: ["-e", "require('node:fs').readFileSync(0,'utf8');process.exit(0)"], note: "success fixture" }], SECRET));
});

test("a real OS launch failure exposes only the stable EACCES code", { skip: process.platform === "win32" }, t => {
  const dir = mkdtempSync(path.join(tmpdir(), "heyditto-process-")), bin = path.join(dir, "not-executable");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  const result = run(bin, [], SECRET);
  assert.equal(result.status, null); assert.equal(result.signal, undefined); assert.equal(result.errorCode, "EACCES");
  assertPrivateFailure(() => deliver(store(bin), "TEST_KEY", [{ kind: "stdin", args: [], note: "OS fixture" }], SECRET), /OS error EACCES/);
});
