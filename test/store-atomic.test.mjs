import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveLogin, updateStoredAuth, writeStoredAuth } from "../dist/store.js";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ditto-atomic-profile-"));
  const previous = process.env.DITTO_CONFIG_DIR;
  process.env.DITTO_CONFIG_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.DITTO_CONFIG_DIR; else process.env.DITTO_CONFIG_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, "config.json");
  const original = `${JSON.stringify({ apiKey: "fixture-old-key", defaultEndpoint: "team", defaultCompany: "org", activeSession: { id: "session" }, codexApp: { keyId: "old-endpoint-key" }, agentMode: true, agentUserID: "agent" })}\n`;
  writeFileSync(file, original, { mode: 0o600 });
  return { root, file, original };
}

test("profile/login writes retain the old bytes and mode on partial-write and rename failure", async (t) => {
  for (const operation of ["write", "update", "login"]) for (const failure of ["partial write", "rename"]) await t.test(`${operation}: ${failure}`, async (t) => {
    const f = fixture(t);
    const fail = () => { throw new Error("injected profile I/O failure"); };
    const io = failure === "partial write" ? { write: async (handle, contents) => { await handle.writeFile(contents.slice(0, 12)); fail(); } } : { rename: async () => { assert.equal(readFileSync(f.file, "utf8"), f.original); fail(); } };
    const attempt = operation === "write" ? writeStoredAuth({ apiKey: "fixture-new-key" }, io) : operation === "update" ? updateStoredAuth({ defaultEndpoint: "new" }, io) : saveLogin("fixture-new-key", {}, io);
    await assert.rejects(attempt, /injected profile I\/O failure/u);
    assert.equal(readFileSync(f.file, "utf8"), f.original);
    assert.equal(lstatSync(f.file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(f.root), ["config.json"], "temporary secret profile is removed after ordinary failure");
  });
});

test("atomic login keeps defaults/session/desktop state and clears agent login fields", async (t) => {
  const f = fixture(t);
  await saveLogin(" fixture-new-key ");
  const result = JSON.parse(readFileSync(f.file, "utf8"));
  assert.equal(result.apiKey, "fixture-new-key");
  assert.equal(result.defaultEndpoint, "team");
  assert.equal(result.defaultCompany, "org");
  assert.deepEqual(result.activeSession, { id: "session" });
  assert.deepEqual(result.codexApp, { keyId: "old-endpoint-key" });
  assert.equal(result.agentMode, undefined);
  assert.equal(result.agentUserID, undefined);
  assert.equal(lstatSync(f.file).mode & 0o777, 0o600);
});

test("atomic profile update preserves existing symlink identity and owner-only target permissions", async (t) => {
  const f = fixture(t);
  const actual = path.join(f.root, "actual.json");
  writeFileSync(actual, f.original, { mode: 0o600 });
  rmSync(f.file); symlinkSync(actual, f.file);
  await updateStoredAuth({ defaultCompany: "next" });
  assert.ok(lstatSync(f.file).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(actual, "utf8")).defaultCompany, "next");
  assert.equal(lstatSync(actual).mode & 0o777, 0o600);
});

test("atomic replacement does not bypass a read-only profile", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t);
  chmodSync(f.file, 0o400);
  await assert.rejects(updateStoredAuth({ defaultCompany: "next" }), /writable by its owner/u);
  assert.equal(readFileSync(f.file, "utf8"), f.original);
  assert.equal(lstatSync(f.file).mode & 0o777, 0o400);
});
