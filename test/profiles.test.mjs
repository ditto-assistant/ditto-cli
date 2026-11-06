import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listEndpointsStubHandler } from "./helpers/stub-api.mjs";
import { materialize, profileView, profilesPatch, setProfileEndpointPatch } from "../dist/profile-state.js";
import { applyT3Setup, planT3Setup, profileT3Defaults, resolveT3Profile } from "../dist/t3/setup.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const ENDPOINTS = {
  baseUrl: "https://api.example.test/v1",
  endpoints: [
    { id: "11111111-1111-1111-1111-111111111111", slug: "alpha", name: "Alpha", model: "m", spendPeriod: "never", spentTokens: 0, status: "active" },
    { id: "22222222-2222-2222-2222-222222222222", slug: "beta", name: "Beta", model: "m", spendPeriod: "never", spentTokens: 0, status: "active" },
    { id: "33333333-3333-3333-3333-333333333333", slug: "subnet-dev", name: "Subnet", model: "m", spendPeriod: "never", spentTokens: 0, status: "active" },
  ],
};

/** `hold` parks each endpoint-list request until `release()`; `held` resolves when one is parked. */
function startStub({ hold = false } = {}) {
  const calls = [];
  const parked = [];
  let onParked;
  const held = new Promise((resolve) => { onParked = resolve; });
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); };
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        if (!hold) return json(200, ENDPOINTS);
        parked.push(() => json(200, ENDPOINTS));
        onParked();
        return;
      }
      if (listEndpointsStubHandler(req, json)) return;
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      calls,
      held,
      release: () => { hold = false; for (const send of parked.splice(0)) send(); },
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

/** A private config dir seeded like an install that predates profiles. */
function configFixture(t, seed = { apiKey: "ditto_mcp_saved", defaultEndpoint: "alpha" }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-profiles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  if (seed) writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  const cwd = path.join(dir, "elsewhere"); // outside any repository's .ditto config
  mkdirSync(cwd);
  return { dir, file, cwd, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

function run(stub, cfg, args, env = {}) {
  const childEnv = { ...process.env, DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: stub.base, DITTO_CONFIG_DIR: cfg.dir, DITTO_NO_UPDATE: "1", ...env };
  if (!("DITTO_PROFILE" in env)) delete childEnv.DITTO_PROFILE;
  const child = spawn(process.execPath, [cliPath, "--no-auto-update", ...args], { cwd: cfg.cwd, stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function withStub(fn, options) {
  const stub = await startStub(options);
  try { await fn(stub); } finally { stub.close(); }
}

// ---------------------------------------------------------------------------
// Pure state

test("an install with only defaultEndpoint reads as an implicit active `default` profile", () => {
  assert.deepEqual(profileView({ defaultEndpoint: "alpha" }), { profiles: { default: { endpoint: "alpha" } }, active: "default", implicit: true });
  assert.deepEqual(profileView(undefined), { profiles: { default: {} }, active: "default", implicit: true });
  // Setting the implicit default's endpoint writes exactly what older versions wrote.
  assert.deepEqual(setProfileEndpointPatch({ defaultEndpoint: "alpha" }, "default", "beta"), { defaultEndpoint: "beta" });
  // Materialising preserves the legacy default as the active profile.
  assert.deepEqual(materialize({ defaultEndpoint: "alpha" }), { profiles: { default: { endpoint: "alpha" } }, active: "default" });
  assert.deepEqual(materialize({}), { profiles: {}, active: undefined });
  // defaultEndpoint always mirrors the active profile for older CLIs.
  assert.deepEqual(profilesPatch({ default: { endpoint: "alpha" }, subnet: { endpoint: "subnet-dev" } }, "subnet").defaultEndpoint, "subnet-dev");
});

// ---------------------------------------------------------------------------
// CLI: CRUD, switching, overrides, migration

test("legacy install keeps working unchanged until a profile is created", async (t) => {
  const cfg = configFixture(t);
  await withStub(async (stub) => {
    const list = await run(stub, cfg, ["profile", "list", "--output", "json"]);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), { activeProfile: "default", implicit: true, profiles: [{ name: "default", endpoint: "alpha", inference: "cliproxy", active: true }] });
    assert.deepEqual(cfg.read(), { apiKey: "ditto_mcp_saved", defaultEndpoint: "alpha" }, "listing must not write");

    const use = await run(stub, cfg, ["endpoints", "use", "beta"]);
    assert.equal(use.status, 0, use.stderr);
    assert.equal(use.stdout, "Default endpoint set to beta.\n");
    assert.deepEqual(cfg.read(), { apiKey: "ditto_mcp_saved", defaultEndpoint: "beta" }, "no profile fields appear for a legacy user");

    const plan = await run(stub, cfg, ["claude", "--dry-run"]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).endpoint.slug, "beta");
  });
});

test("creating a profile migrates the current default into an active `default` profile", async (t) => {
  const cfg = configFixture(t);
  await withStub(async (stub) => {
    const created = await run(stub, cfg, ["profile", "create", "subnet", "--endpoint", "33333333-3333-3333-3333-333333333333"]);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /Created profile subnet → subnet-dev\./);
    assert.match(created.stdout, /saved as profile "default" and stays active/);
    const stored = cfg.read();
    assert.equal(stored.apiKey, "ditto_mcp_saved", "the saved key survives");
    assert.equal(stored.activeProfile, "default");
    assert.equal(stored.defaultEndpoint, "alpha");
    assert.equal(stored.profiles.default.endpoint, "alpha");
    assert.equal(stored.profiles.subnet.endpoint, "subnet-dev", "an id is saved as the canonical slug");
    for (const profile of Object.values(stored.profiles)) {
      assert.deepEqual(Object.keys(profile).filter((k) => !["endpoint", "inference", "createdAt"].includes(k)), [], "profiles hold no credentials");
    }

    const plan = await run(stub, cfg, ["claude", "--dry-run"]);
    assert.equal(JSON.parse(plan.stdout).endpoint.slug, "alpha", "new sessions still use the old default");

    const dup = await run(stub, cfg, ["profile", "create", "subnet", "--endpoint", "beta"]);
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /already exists/);
    const missing = await run(stub, cfg, ["profile", "create", "other", "--endpoint", "nope"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no endpoint named "nope"/);
    const bad = await run(stub, cfg, ["profile", "create", "Bad Name", "--endpoint", "beta"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /invalid profile name/);
    assert.deepEqual(Object.keys(cfg.read().profiles).sort(), ["default", "subnet"], "rejected creates write nothing");
  });
});

test("profile create keeps a profile another process saved during the endpoint lookup", async (t) => {
  const cfg = configFixture(t);
  await withStub(async (stub) => {
    assert.equal((await run(stub, cfg, ["profile", "create", "subnet", "--endpoint", "subnet-dev"])).status, 0);
  });
  await withStub(async (stub) => {
    // `profile create work` parks on the endpoint lookup...
    const creating = run(stub, cfg, ["profile", "create", "work", "--endpoint", "beta"]);
    await stub.held;
    // ...while a second heyditto saves another profile and switches to it.
    const concurrent = cfg.read();
    concurrent.profiles.other = { endpoint: "alpha", createdAt: "2026-11-05T00:00:00.000Z" };
    concurrent.activeProfile = "subnet";
    concurrent.defaultEndpoint = "subnet-dev";
    writeFileSync(cfg.file, `${JSON.stringify(concurrent, null, 2)}\n`);
    stub.release();
    const created = await creating;
    assert.equal(created.status, 0, created.stderr);
    const stored = cfg.read();
    assert.deepEqual(Object.keys(stored.profiles).sort(), ["default", "other", "subnet", "work"], "the concurrent profile must survive");
    assert.equal(stored.activeProfile, "subnet", "the concurrent switch must survive");
    assert.equal(stored.defaultEndpoint, "subnet-dev");
    assert.equal(stored.profiles.work.endpoint, "beta");
  }, { hold: true });
});

test("the first profile of an install with no default becomes active", async (t) => {
  const cfg = configFixture(t, { apiKey: "ditto_mcp_saved" });
  await withStub(async (stub) => {
    const created = await run(stub, cfg, ["profile", "create", "subnet", "--endpoint", "subnet-dev", "--output", "json"]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(created.stdout).activeProfile, "subnet");
    assert.deepEqual(cfg.read().profiles, { subnet: cfg.read().profiles.subnet });
    assert.equal(cfg.read().defaultEndpoint, "subnet-dev");
  });
});

test("switching, --profile and DITTO_PROFILE select endpoints without touching other profiles", async (t) => {
  const cfg = configFixture(t);
  await withStub(async (stub) => {
    assert.equal((await run(stub, cfg, ["profile", "create", "subnet", "--endpoint", "subnet-dev"])).status, 0);

    // One command, another profile: nothing saved changes.
    const before = readFileSync(cfg.file, "utf8");
    const flag = await run(stub, cfg, ["claude", "--dry-run", "--profile", "subnet"]);
    assert.equal(flag.status, 0, flag.stderr);
    assert.equal(JSON.parse(flag.stdout).endpoint.slug, "subnet-dev");
    assert.match(flag.stderr, /using profile subnet → subnet-dev/);
    const env = await run(stub, cfg, ["codex", "--dry-run"], { DITTO_PROFILE: "subnet" });
    assert.equal(env.status, 0, env.stderr);
    assert.equal(JSON.parse(env.stdout).endpoint.slug, "subnet-dev");
    const listed = await run(stub, cfg, ["endpoints", "--output", "json", "--profile", "subnet"]);
    assert.equal(JSON.parse(listed.stdout).defaultEndpoint, "subnet-dev");
    // --endpoint still wins over a named profile.
    const explicit = await run(stub, cfg, ["claude", "--dry-run", "--endpoint", "beta"], { DITTO_PROFILE: "subnet" });
    assert.equal(JSON.parse(explicit.stdout).endpoint.slug, "beta");
    assert.equal(readFileSync(cfg.file, "utf8"), before, "per-command selection must not write");

    // `endpoints use --profile` edits only that profile.
    const retarget = await run(stub, cfg, ["endpoints", "use", "beta", "--profile", "subnet"]);
    assert.equal(retarget.status, 0, retarget.stderr);
    assert.equal(retarget.stdout, "Default endpoint set to beta (profile subnet).\n");
    let stored = cfg.read();
    assert.equal(stored.profiles.subnet.endpoint, "beta");
    assert.equal(stored.profiles.default.endpoint, "alpha");
    assert.equal(stored.defaultEndpoint, "alpha", "the active profile's mirror is unchanged");
    assert.equal((await run(stub, cfg, ["profile", "set", "subnet", "--endpoint", "subnet-dev"])).status, 0);

    // Switch the active profile: new sessions follow it.
    const use = await run(stub, cfg, ["profile", "use", "subnet"]);
    assert.equal(use.status, 0, use.stderr);
    stored = cfg.read();
    assert.equal(stored.activeProfile, "subnet");
    assert.equal(stored.defaultEndpoint, "subnet-dev", "older CLIs see the active profile's endpoint");
    assert.equal(stored.profiles.default.endpoint, "alpha");
    assert.equal(JSON.parse((await run(stub, cfg, ["claude", "--dry-run"])).stdout).endpoint.slug, "subnet-dev");
    assert.equal(JSON.parse((await run(stub, cfg, ["claude", "--dry-run", "--profile", "default"])).stdout).endpoint.slug, "alpha");
    // Status without a key skips the MCP connect and still reports the profile.
    const saved = readFileSync(cfg.file, "utf8");
    const { apiKey: _key, ...keyless } = cfg.read();
    writeFileSync(cfg.file, JSON.stringify(keyless));
    const status = JSON.parse((await run(stub, cfg, ["status", "--output", "json"], { DITTO_API_KEY: "" })).stdout);
    assert.deepEqual([status.profile.name, status.profile.source, status.defaultEndpoint], ["subnet", "active", "subnet-dev"]);
    const overridden = JSON.parse((await run(stub, cfg, ["status", "--output", "json", "--profile", "default"], { DITTO_API_KEY: "" })).stdout);
    assert.deepEqual([overridden.profile.name, overridden.profile.source, overridden.defaultEndpoint], ["default", "flag", "alpha"]);
    writeFileSync(cfg.file, saved);

    const unknown = await run(stub, cfg, ["claude", "--dry-run", "--profile", "nope"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /no profile named "nope"/);
    const unknownEnv = await run(stub, cfg, ["claude", "--dry-run"], { DITTO_PROFILE: "nope" });
    assert.match(unknownEnv.stderr, /no profile named "nope".*DITTO_PROFILE/);
  });
});

test("rename and delete keep the active profile coherent", async (t) => {
  const cfg = configFixture(t);
  await withStub(async (stub) => {
    assert.equal((await run(stub, cfg, ["profile", "create", "subnet", "--endpoint", "subnet-dev", "--use"])).status, 0);
    const refused = await run(stub, cfg, ["profile", "delete", "subnet"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /is active/);

    assert.equal((await run(stub, cfg, ["profile", "rename", "subnet", "sn118"])).status, 0);
    let stored = cfg.read();
    assert.equal(stored.activeProfile, "sn118");
    assert.equal(stored.profiles.sn118.endpoint, "subnet-dev");
    assert.equal(stored.profiles.subnet, undefined);
    const clash = await run(stub, cfg, ["profile", "rename", "sn118", "default"]);
    assert.notEqual(clash.status, 0);

    assert.equal((await run(stub, cfg, ["profile", "use", "default"])).status, 0);
    const deleted = await run(stub, cfg, ["profile", "delete", "sn118"]);
    assert.equal(deleted.status, 0, deleted.stderr);
    stored = cfg.read();
    assert.deepEqual(Object.keys(stored.profiles), ["default"]);
    assert.equal(stored.activeProfile, "default");
    assert.equal(stored.defaultEndpoint, "alpha");
    assert.equal(stored.apiKey, "ditto_mcp_saved");
  });
});

// ---------------------------------------------------------------------------
// T3: a second provider next to the first

function t3Fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ditto t3 profiles "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "t3");
  const userdata = path.join(base, "userdata");
  mkdirSync(userdata, { recursive: true });
  const settings = path.join(userdata, "settings.json");
  const subscription = { driver: "claudeAgent", enabled: true, config: { homePath: "/Users/someone/.claude" } };
  writeFileSync(settings, JSON.stringify({ providerInstances: { claudeAgent: subscription } }) + "\n", { mode: 0o600 });
  const claude = path.join(root, "claude");
  const heyditto = path.join(root, "heyditto");
  writeFileSync(claude, `#!${process.execPath}\nprocess.stdout.write("fake Claude\\n");\n`, { mode: 0o700 });
  writeFileSync(heyditto, `#!${process.execPath}\nif(process.argv.includes('--help'))process.stdout.write('--cliproxy --mcp --no-mcp --no-mcp-only --no-remote-control\\n');else process.stdout.write(JSON.stringify({args:process.argv.slice(2),endpoint:process.env.DITTO_T3_ENDPOINT}));\n`, { mode: 0o700 });
  return { base, settings, subscription, bins: { baseDir: base, claudeBin: claude, heydittoBin: heyditto } };
}

const profiles = {
  default: { endpoint: "ditto-dev" },
  subnet: { endpoint: "subnet-dev", inference: "cliproxy" },
};
const pick = (name, source = "flag") => async () => ({ name, profile: profiles[name], source, implicit: false });

test("profile T3 defaults: the default profile keeps the original instance", () => {
  assert.deepEqual(profileT3Defaults("default", "cliproxy"), { instance: "claude_ditto_cliproxy" });
  assert.deepEqual(profileT3Defaults("subnet", "cliproxy"), { instance: "claude_ditto_subnet_cliproxy", name: "Claude Subnet" });
  assert.deepEqual(profileT3Defaults("sn-118", "router"), { instance: "claude_ditto_sn_118_router", name: "Claude Sn 118 (Router)" });
});

test("t3 setup --profile resolves endpoint, instance and label, with explicit flags winning", async () => {
  assert.deepEqual((await resolveT3Profile({}, pick("subnet"))).options, { endpoint: "subnet-dev", inference: "cliproxy", instance: "claude_ditto_subnet_cliproxy", name: "Claude Subnet" });
  assert.deepEqual((await resolveT3Profile({ instance: "x", name: "Mine" }, pick("subnet"))).options, { endpoint: "subnet-dev", inference: "cliproxy", instance: "x", name: "Mine" });
  await assert.rejects(resolveT3Profile({ endpoint: "beta" }, pick("subnet")), /either --profile or --endpoint/);
  // Active (not named) profile + explicit --endpoint: legacy behaviour.
  assert.deepEqual((await resolveT3Profile({ endpoint: "beta" }, pick("subnet", "active"))).options, { endpoint: "beta" });
  // No profiles saved: legacy behaviour.
  const legacy = async () => ({ name: "default", profile: { endpoint: "alpha" }, source: "active", implicit: true });
  assert.deepEqual((await resolveT3Profile({}, legacy)).options, {});
  // Saved profiles, bare setup: the active profile picks its own instance, so a
  // switched-to `subnet` can never rebind the original provider.
  assert.equal((await resolveT3Profile({}, pick("subnet", "active"))).options.instance, "claude_ditto_subnet_cliproxy");
});

test("two Claude providers coexist, each bound to its own endpoint, and the subscription provider is untouched", async (t) => {
  const f = t3Fixture(t);
  const first = planT3Setup({ ...f.bins, ...(await resolveT3Profile({}, pick("default"))).options });
  applyT3Setup(first);
  const firstBytes = new Map([first.launcherPath, ...first.files.map((x) => x.path)].map((p) => [p, readFileSync(p, "utf8")]));

  const second = planT3Setup({ ...f.bins, ...(await resolveT3Profile({}, pick("subnet"))).options });
  assert.equal(second.action, "add");
  applyT3Setup(second);

  const settings = JSON.parse(readFileSync(f.settings, "utf8"));
  assert.deepEqual(Object.keys(settings.providerInstances).sort(), ["claudeAgent", "claude_ditto_cliproxy", "claude_ditto_subnet_cliproxy"]);
  assert.deepEqual(settings.providerInstances.claudeAgent, f.subscription, "the normal Claude subscription provider is unchanged");
  assert.equal(settings.providerInstances.claude_ditto_cliproxy.displayName, "Claude CLIProxy + Ditto");
  assert.equal(settings.providerInstances.claude_ditto_subnet_cliproxy.displayName, "Claude Subnet");
  assert.notEqual(second.homePath, first.homePath, "each provider has its own Claude home");
  assert.equal(settings.providerInstances.claude_ditto_cliproxy.config.binaryPath, first.launcherPath, "the first provider still points at its own launcher");
  for (const [p, bytes] of firstBytes) assert.equal(readFileSync(p, "utf8"), bytes, `first provider file changed: ${p}`);

  const launch = (plan) => JSON.parse(spawnSync(plan.launcherPath, ["--print"], { encoding: "utf8" }).stdout);
  const a = launch(first);
  const b = launch(second);
  assert.equal(a.endpoint, "ditto-dev");
  assert.equal(b.endpoint, "subnet-dev");
  assert.deepEqual(a.args.slice(a.args.indexOf("--endpoint"), a.args.indexOf("--endpoint") + 2), ["--endpoint", "ditto-dev"]);
  assert.deepEqual(b.args.slice(b.args.indexOf("--endpoint"), b.args.indexOf("--endpoint") + 2), ["--endpoint", "subnet-dev"]);

  // No credentials anywhere setup wrote.
  const written = [f.settings, ...[first, second].flatMap((p) => p.files.map((x) => x.path))].map((p) => readFileSync(p, "utf8")).join("\n");
  assert.doesNotMatch(written, /ditto_(mcp|inf)_\w|"apiKey"|ANTHROPIC_AUTH_TOKEN=/);

  // Rerunning the first profile's setup changes nothing, including the second provider.
  assert.deepEqual(applyT3Setup(planT3Setup({ ...f.bins, ...(await resolveT3Profile({}, pick("default"))).options })), { changed: false });
  assert.equal(readdirSync(path.join(f.base, "ditto-providers")).sort().join(","), "backups,claude_ditto_cliproxy,claude_ditto_subnet_cliproxy");
});
