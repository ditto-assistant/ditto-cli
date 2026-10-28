import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listEndpointsStubHandler } from "./helpers/stub-api.mjs";

const childPath = fileURLToPath(new URL("./helpers/codexapp-transaction-child.mjs", import.meta.url));
const OLD_SECRET = "old-private-key-must-never-log";
const ORIGINAL_SECRET = "original-chatgpt-token-must-never-log";
const NEW_SECRET = "ditto_inf_new-private-key-must-never-log";
const endpoint = { id: "11111111-1111-1111-1111-111111111111", slug: "alpha", name: "Alpha", model: "openai/test", status: "active", recordTrace: true };

async function fixture(t, { backups = false, refuseRevoke = false, loseMintResponse = false, missingPlaintext = false, badCatalogBody = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ditto-codex-transaction-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "codex");
  const config = path.join(root, "ditto");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(config, { mode: 0o700 });
  const files = {
    authBackup: path.join(home, "auth.json.pre-ditto"), configBackup: path.join(home, "config.toml.pre-ditto"),
    catalog: path.join(home, "ditto-models.json"), config: path.join(home, "config.toml"),
    auth: path.join(home, "auth.json"), state: path.join(config, "config.json"),
  };
  const state = { apiKey: "ditto_mcp_fixture", defaultEndpoint: "alpha", codexApp: { endpointId: endpoint.id, endpointSlug: "alpha", keyId: "old-key", keyHint: "old", key: OLD_SECRET, baseUrl: "https://old.invalid/v1", wiredAt: "2026-01-01T00:00:00Z" } };
  writeFileSync(files.config, 'model = "original-model"\nmodel_provider = "original"\n[projects."/work"]\ntrust_level = "trusted"\n', { mode: 0o640 });
  writeFileSync(files.auth, `${JSON.stringify({ tokens: { id_token: ORIGINAL_SECRET } })}\n`, { mode: 0o600 });
  writeFileSync(files.catalog, '{"models":[{"slug":"original-catalog"}]}\n', { mode: 0o640 });
  writeFileSync(files.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  if (backups) {
    writeFileSync(files.authBackup, "earlier-backup-keep-byte-for-byte", { mode: 0o640 });
    writeFileSync(files.configBackup, "earlier-config-backup", { mode: 0o640 });
  }
  const snapshot = () => Object.fromEntries(Object.entries(files).map(([name, file]) => [name, existsSync(file) ? { bytes: readFileSync(file), mode: lstatSync(file).mode & 0o777 } : undefined]));
  const original = snapshot();
  const calls = [];
  const serverFailures = [];
  t.after(() => assert.deepEqual(serverFailures, [], "fixture received invalid credential/order"));
  const live = new Set(["old-key"]);
  let mints = 0;
  let refuse = refuseRevoke;
  let base;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (data) => body += data);
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => { res.statusCode = status; res.end(payload === undefined ? "" : JSON.stringify(payload)); };
      try {
      if (req.method === "GET" && req.url === "/api/v5/inference/endpoints") return json(200, { baseUrl: `${base}/v1`, endpoints: [endpoint] });
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        assert.equal(req.headers.authorization, `Bearer ${NEW_SECRET}-${mints}`);
        assert.equal(req.headers["x-ditto-codex-models"], "true");
        if (badCatalogBody) { res.end(NEW_SECRET); return; }
        return json(200, { models: [{ slug: "alpha" }, { slug: "anthropic/claude-test" }, { slug: "open/test" }] });
      }
      if (req.method === "POST" && req.url.endsWith("/keys")) {
        const id = `new-key-${++mints}`;
        live.add(id);
        if (loseMintResponse) { res.destroy(); return; }
        return json(201, { id, ...(missingPlaintext ? {} : { key: `${NEW_SECRET}-${mints}` }), keyHint: "new", endpointId: endpoint.id });
      }
      if (req.method === "DELETE" && req.url.includes("/keys/")) {
        const id = req.url.split("/").at(-1);
        if (refuse) { refuse = false; return json(503, { message: "fixture cleanup unavailable" }); }
        if (!live.has(id)) return json(404, { message: "key not found or already revoked" });
        if (id === "old-key") {
          const persisted = JSON.parse(readFileSync(files.state, "utf8"));
          assert.match(persisted.codexApp.keyId, /^new-key-/u, "old key can only be revoked after new state is durable");
        }
        live.delete(id);
        return json(204);
      }
      if (listEndpointsStubHandler(req, json)) return;
      return json(404, { message: "fixture route unavailable" });
      } catch (err) { serverFailures.push(err.message); return json(500, { message: "fixture invariant failed" }); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "xdg"), CODEX_HOME: home, DITTO_CONFIG_DIR: config, DITTO_API_BASE: base, DITTO_API_KEY: "ditto_mcp_fixture", NO_COLOR: "1" };
  const start = (options = {}, overrides = {}) => {
    const child = spawn(process.execPath, [childPath, JSON.stringify(options)], { env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
    deadline.unref();
    child.stdout.on("data", (data) => stdout += data); child.stderr.on("data", (data) => stderr += data);
    const result = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status, signal) => {
        clearTimeout(deadline);
        if (timedOut) { reject(new Error("isolated Codex setup fixture timed out")); return; }
        for (const secret of [OLD_SECRET, ORIGINAL_SECRET, NEW_SECRET]) assert.ok(!`${stdout}${stderr}`.includes(secret), "setup/recovery never logs credentials");
        resolve({ status, signal, stdout, stderr });
      });
    });
    return { child, result };
  };
  return { root, home, base, files, original, snapshot, start, run: (options, overrides) => start(options, overrides).result, live, calls, get mints() { return mints; }, pending: path.join(home, ".ditto-codex-app-recovery", "pending") };
}

const stages = ["authBackup", "configBackup", "catalog", "config", "auth", "state"];
const beforeCommit = ["begin", "key-recorded", ...stages.map((s) => `stage:${s}`), "prepared", ...stages.map((s) => `replace:${s}`), "before-journal:committed"];

test("ordinary failures restore every file/mode and revoke only the new key at each stage", async (t) => {
  for (const point of beforeCommit) await t.test(point, async (t) => {
    const f = await fixture(t);
    const result = await f.run({ point, kind: "throw" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /injected failure/u);
    assert.deepEqual(f.snapshot(), f.original);
    assert.deepEqual([...f.live], ["old-key"]);
    assert.equal(existsSync(f.pending), false);
  });
});

test("SIGKILL recovery restores old setup and does not mint another key", async (t) => {
  for (const point of [...beforeCommit, ...stages.map((s) => `replace-ready:${s}`), ...stages.map((s) => `renamed:${s}`)]) await t.test(point, async (t) => {
    const f = await fixture(t);
    const interrupted = await f.run({ point, kind: "kill" });
    assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
    const mintedBeforeRecovery = f.mints;
    const result = await f.run({ recover: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.snapshot(), f.original);
    assert.deepEqual([...f.live], ["old-key"]);
    assert.equal(f.mints, mintedBeforeRecovery);
    assert.equal(existsSync(f.pending), false);
  });
});

test("durable commit preserves new login/backups; ambiguous repeated DELETE remains pending", async (t) => {
  for (const point of ["committed", "old-key-revoked"]) await t.test(point, async (t) => {
    const f = await fixture(t, { backups: true });
    const result = await f.run({ point, kind: "kill" });
    assert.equal(result.signal, "SIGKILL");
    const afterCommit = f.snapshot();
    const manifest = readFileSync(path.join(f.pending, "manifest.json"), "utf8");
    for (const secret of [OLD_SECRET, ORIGINAL_SECRET, NEW_SECRET, "ditto_mcp_fixture"]) assert.ok(!manifest.includes(secret));
    assert.equal(lstatSync(path.dirname(f.pending)).mode & 0o777, 0o700);
    assert.equal(lstatSync(f.pending).mode & 0o777, 0o700);
    for (const name of readdirSync(f.pending)) assert.equal(lstatSync(path.join(f.pending, name)).mode & 0o777, 0o600);
    const recovery = await f.run({ recover: true });
    assert.equal(recovery.status, point === "old-key-revoked" ? 1 : 0, recovery.stderr);
    if (point === "old-key-revoked") {
      assert.match(recovery.stderr, /cleanup is pending/u);
      assert.ok(existsSync(f.pending), "generic404 is not proof that key revocation succeeded");
    }
    assert.deepEqual(f.snapshot(), afterCommit);
    assert.deepEqual([...f.live], ["new-key-1"]);
    assert.equal(f.mints, 1);
    assert.deepEqual(afterCommit.authBackup, f.original.authBackup);
    assert.deepEqual(afterCommit.configBackup, f.original.configBackup);
    assert.equal(afterCommit.auth.mode, 0o600);
  });
});

test("recovery preserves intervening edits and never revokes the retained old key", async (t) => {
  for (const name of ["config", "auth", "state", "catalog"]) await t.test(name, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run({ point: "replace:state", kind: "kill" })).signal, "SIGKILL");
    const edited = `intervening-${name}-edit\n`;
    writeFileSync(f.files[name], edited);
    const beforeRecovery = f.snapshot();
    const recovery = await f.run({ recover: true });
    assert.equal(recovery.status, 1);
    assert.match(recovery.stderr, name === "auth" ? /without further file or key changes/u : /edits were kept/u);
    assert.equal(readFileSync(f.files[name], "utf8"), edited);
    assert.deepEqual([...f.live], name === "auth" ? ["old-key", "new-key-1"] : ["old-key"]);
    if (name === "auth") assert.deepEqual(f.snapshot(), beforeRecovery, "ambiguous login preserves every target before rollback");
    const deletes = f.calls.filter((c) => c.method === "DELETE").length;
    await f.run({ recover: true });
    assert.equal(f.calls.filter((c) => c.method === "DELETE").length, deletes, "already-revoked new key is not retried");
    assert.equal(f.mints, 1);
  });
});

test("an edit after commit preserves both keys rather than revoking the user's replacement login", async (t) => {
  const f = await fixture(t);
  await f.run({ point: "committed", kind: "kill" });
  const edited = `${JSON.stringify({ OPENAI_API_KEY: OLD_SECRET })}\n`;
  writeFileSync(f.files.auth, edited);
  const result = await f.run({ recover: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without further file or key changes/u);
  assert.equal(readFileSync(f.files.auth, "utf8"), edited);
  assert.deepEqual([...f.live], ["old-key", "new-key-1"]);
});

test("another process cannot recover or replace an active setup transaction", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "held");
  const active = f.start({ point: "prepared", kind: "hold", marker });
  t.after(() => active.child.kill("SIGKILL"));
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(marker), "first process reached transaction hold");
  const second = await f.run({ recover: true });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Another codex-app operation/u);
  assert.equal(f.mints, 1);
  active.child.kill("SIGKILL"); await active.result;
  assert.equal((await f.run({ recover: true })).status, 0);
  assert.deepEqual(f.snapshot(), f.original);
});

test("cleanup failure is retryable without rotating or minting another key", async (t) => {
  const f = await fixture(t, { refuseRevoke: true });
  const failed = await f.run({ point: "replace:auth", kind: "throw" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /key cleanup is pending/u);
  assert.deepEqual(f.snapshot(), f.original);
  assert.deepEqual([...f.live], ["old-key", "new-key-1"]);
  assert.equal((await f.run({ recover: true })).status, 0);
  assert.deepEqual([...f.live], ["old-key"]);
  assert.equal(f.mints, 1);
});

test("preexisting file edits before replacement fail closed and preserve the edit", async (t) => {
  const f = await fixture(t);
  const edited = 'model = "intervening-model"\n';
  const result = await f.run({ point: "prepared", edit: { file: f.files.config, contents: edited } });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.files.config, "utf8"), edited);
  assert.deepEqual([...f.live], ["old-key"]);
});

test("journal-write failure after issuance still revokes the known new key", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ point: "before-journal:preparing", occurrence: 2, kind: "throw" });
  assert.equal(result.status, 1);
  assert.deepEqual(f.snapshot(), f.original);
  assert.deepEqual([...f.live], ["old-key"]);
  assert.equal(f.mints, 1);
});

test("old-key cleanup failure retains the durable new setup and retries only cleanup", async (t) => {
  const f = await fixture(t, { refuseRevoke: true });
  const result = await f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /setup is saved/u);
  const committed = f.snapshot();
  assert.deepEqual([...f.live], ["old-key", "new-key-1"]);
  assert.equal((await f.run({ recover: true })).status, 0);
  assert.deepEqual(f.snapshot(), committed);
  assert.deepEqual([...f.live], ["new-key-1"]);
  assert.equal(f.mints, 1);
});

test("known key ID without plaintext is revoked before any local replacement", async (t) => {
  const f = await fixture(t, { missingPlaintext: true });
  const result = await f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no plaintext key/u);
  assert.deepEqual(f.snapshot(), f.original);
  assert.deepEqual([...f.live], ["old-key"]);
});

test("invalid catalog response is sanitized and revokes only the new key", async (t) => {
  const f = await fixture(t, { badCatalogBody: true });
  const result = await f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unreadable model picker/u);
  assert.deepEqual(f.snapshot(), f.original);
  assert.deepEqual([...f.live], ["old-key"]);
});

test("lost issuance response is explicitly unknown and never changes or revokes the old setup", async (t) => {
  const f = await fixture(t, { loseMintResponse: true });
  const result = await f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a key may have been created/u);
  assert.deepEqual(f.snapshot(), f.original);
  assert.deepEqual([...f.live], ["old-key", "new-key-1"], "unreturned key ID cannot be revoked by a client-only transaction");
  assert.equal((await f.run({ recover: true })).status, 0);
  assert.equal(f.mints, 1);
});

test("interrupted new-key cleanup does not guess success from repeated DELETE404", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ failAt: "replace:auth", point: "new-key-revoked", kind: "kill" });
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(f.snapshot(), f.original);
  assert.deepEqual([...f.live], ["old-key"]);
  const recovery = await f.run({ recover: true });
  assert.equal(recovery.status, 1);
  assert.match(recovery.stderr, /cleanup is pending/u);
  assert.ok(existsSync(f.pending));
  assert.equal(f.mints, 1);
});

test("an auth edit after revoke-before-journal interruption reports uncertain earlier cleanup", async (t) => {
  const cases = [
    { name: "prepared rollback revoked the new key", options: { failAt: "replace:auth", point: "new-key-revoked", kind: "kill" }, live: ["old-key"], key: `${NEW_SECRET}-1`, phase: "prepared" },
    { name: "committed cleanup revoked the old key", options: { point: "old-key-revoked", kind: "kill" }, live: ["new-key-1"], key: OLD_SECRET, phase: "committed" },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run(scenario.options)).signal, "SIGKILL");
    assert.deepEqual([...f.live], scenario.live, "the server completed DELETE before the injected crash");
    const journal = readFileSync(path.join(f.pending, "manifest.json"));
    const manifest = JSON.parse(journal.toString("utf8"));
    assert.equal(manifest.phase, scenario.phase);
    assert.notEqual(manifest.newKeyRevoked, true, "the successful deletion was not recorded locally");
    writeFileSync(f.files.auth, `${JSON.stringify({ OPENAI_API_KEY: scenario.key, edited: true })}\n`);
    const before = f.snapshot();
    const calls = f.calls.length;
    const result = await f.run({ recover: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /without further file or key changes/u);
    assert.match(result.stderr, /Earlier cleanup may already have revoked a key/u);
    assert.doesNotMatch(result.stderr, /both keys (?:were kept|remain)/u);
    assert.deepEqual(f.snapshot(), before, "the edited login and all other files are untouched");
    assert.deepEqual(readFileSync(path.join(f.pending, "manifest.json")), journal);
    assert.equal(f.calls.length, calls, "conflict detection makes no further key requests");
    assert.deepEqual([...f.live], scenario.live);
    assert.equal(f.mints, 1);
  });
});

test("a formatted/extended new login or unreadable auth retains both live keys before any rollback", async (t) => {
  for (const contents of [`${JSON.stringify({ OPENAI_API_KEY: `${NEW_SECRET}-1`, auth_mode: "apikey" }, null, 4)}\n`, "{invalid auth\n"]) await t.test(contents.startsWith("{invalid") ? "malformed" : "same key with new formatting", async (t) => {
    const f = await fixture(t);
    await f.run({ point: "replace:state", kind: "kill" });
    writeFileSync(f.files.auth, contents);
    const before = f.snapshot();
    const deletes = f.calls.filter((call) => call.method === "DELETE").length;
    const result = await f.run({ recover: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /without further file or key changes/u);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual([...f.live], ["old-key", "new-key-1"]);
    assert.equal(f.calls.filter((call) => call.method === "DELETE").length, deletes);
    assert.ok(existsSync(f.pending));
  });
});

test("failed auth restoration retains the chosen new login and both keys", async (t) => {
  const f = await fixture(t);
  const result = await f.run({ failAt: "replace:state", point: "before-replace:auth", occurrence: 2, kind: "throw" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without further file or key changes/u);
  assert.equal(JSON.parse(readFileSync(f.files.auth, "utf8")).OPENAI_API_KEY, `${NEW_SECRET}-1`);
  assert.deepEqual([...f.live], ["old-key", "new-key-1"]);
  assert.equal(f.calls.filter((call) => call.method === "DELETE").length, 0);
});

test("recovery rejects another profile target even when its bytes match", async (t) => {
  for (const selector of ["DITTO_CONFIG_DIR", "XDG_CONFIG_HOME"]) await t.test(selector, async (t) => {
    const f = await fixture(t);
    await f.run({ point: "replace:state", kind: "kill" });
    const before = f.snapshot();
    const journal = readFileSync(path.join(f.pending, "manifest.json"));
    const directory = path.join(f.root, "another-profile");
    const target = selector === "DITTO_CONFIG_DIR" ? path.join(directory, "config.json") : path.join(directory, "heyditto", "cli", "config.json");
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, readFileSync(f.files.state), { mode: 0o600 });
    const overrides = selector === "DITTO_CONFIG_DIR" ? { DITTO_CONFIG_DIR: directory } : { DITTO_CONFIG_DIR: "", XDG_CONFIG_HOME: directory };
    const calls = f.calls.length;
    const result = await f.run({ recover: true }, overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /environment does not match/u);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(readFileSync(target), before.state.bytes);
    assert.deepEqual(readFileSync(path.join(f.pending, "manifest.json")), journal);
    assert.deepEqual([...f.live], ["old-key", "new-key-1"]);
    assert.equal(f.calls.length, calls, "no API operation before environment validation");
  });
});

test("recovery rejects a different API origin or namespace before local/key changes", async (t) => {
  for (const selector of ["origin", "namespace"]) await t.test(selector, async (t) => {
    const f = await fixture(t);
    const other = await fixture(t);
    assert.equal((await other.run()).status, 0);
    await f.run({ point: "replace:state", kind: "kill" });
    const before = f.snapshot(), otherBefore = other.snapshot();
    const localCalls = f.calls.length, otherCalls = other.calls.length;
    const result = await f.run({ recover: true }, { DITTO_API_BASE: selector === "origin" ? other.base : `${f.base}/another-namespace` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /environment does not match/u);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(other.snapshot(), otherBefore);
    assert.equal(f.calls.length, localCalls);
    assert.equal(other.calls.length, otherCalls);
    assert.deepEqual([...f.live], ["old-key", "new-key-1"]);
    assert.deepEqual([...other.live], ["new-key-1"]);
  });
});

test("copying a journal into another Codex home cannot redirect rollback", async (t) => {
  const f = await fixture(t);
  await f.run({ point: "replace:state", kind: "kill" });
  const before = f.snapshot();
  const otherHome = path.join(f.root, "another-codex");
  cpSync(f.home, otherHome, { recursive: true });
  const otherAuth = readFileSync(path.join(otherHome, "auth.json"));
  const calls = f.calls.length;
  const result = await f.run({ recover: true }, { CODEX_HOME: otherHome });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /environment does not match/u);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(readFileSync(path.join(otherHome, "auth.json")), otherAuth);
  assert.equal(f.calls.length, calls);
});

test("canonical aliases for the same profile and server remain recoverable", async (t) => {
  const f = await fixture(t);
  await f.run({ point: "replace:state", kind: "kill" });
  const alias = path.join(f.root, "profile-alias");
  symlinkSync(path.dirname(f.files.state), alias, "dir");
  const result = await f.run({ recover: true }, { DITTO_CONFIG_DIR: alias, DITTO_API_BASE: `${f.base}/` });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.snapshot(), f.original);
  assert.deepEqual([...f.live], ["old-key"]);
  assert.ok(lstatSync(alias).isSymbolicLink());
});

test("unbound legacy journals fail closed without touching files or keys", async (t) => {
  const f = await fixture(t);
  await f.run({ point: "replace:state", kind: "kill" });
  const manifest = path.join(f.pending, "manifest.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  delete parsed.environment; parsed.version = 1;
  writeFileSync(manifest, JSON.stringify(parsed));
  const before = f.snapshot(), calls = f.calls.length;
  const result = await f.run({ recover: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid Codex recovery record/u);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.calls.length, calls);
  assert.deepEqual([...f.live], ["old-key", "new-key-1"]);
});
