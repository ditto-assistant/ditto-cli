import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { Command } from "commander";
import { chooseEndpoint } from "../dist/agents/launch.js";
import { applyT3Setup, planT3Setup, registerT3Commands } from "../dist/t3/setup.js";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ditto t3's setup "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "t3");
  const userdata = path.join(base, "userdata");
  mkdirSync(userdata, { recursive: true });
  const settings = path.join(userdata, "settings.json");
  const original = JSON.stringify({ unknownFutureSetting: { value: 42 }, usageLimitSources: { hub: { managementKey: "private-test-secret" } }, providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: false, config: { homePath: "/existing/claude" } } } }) + "\n";
  writeFileSync(settings, original, { mode: 0o600 });
  const claude = path.join(root, "claude");
  const heyditto = path.join(root, "heyditto");
  writeFileSync(claude, `#!${process.execPath}\nprocess.stdout.write("fake Claude 1.0.0\\n");\n`, { mode: 0o700 });
  writeFileSync(heyditto, `#!${process.execPath}\nif(process.argv.includes('--help'))process.stdout.write('--cliproxy --mcp --no-mcp --no-mcp-only --no-remote-control\\n');else process.stdout.write(JSON.stringify({args:process.argv.slice(2),endpoint:process.env.DITTO_T3_ENDPOINT,inference:process.env.DITTO_T3_INFERENCE}));\n`, { mode: 0o700 });
  const options = { endpoint: "ditto-dev", baseDir: base, claudeBin: claude, heydittoBin: heyditto };
  return { root, base, userdata, settings, original, options, plan: (overrides = {}) => planT3Setup({ ...options, ...overrides }) };
}

test("T3 setup dry-run keeps settings and secrets untouched, including a live server", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.userdata, "server-runtime.json"), JSON.stringify({ version: 1, pid: process.pid }));
  const plan = f.plan();
  assert.equal(plan.runningPid, process.pid);
  assert.equal(plan.action, "add");
  assert.equal(readFileSync(f.settings, "utf8"), f.original);
  assert.deepEqual(readdirSync(f.base), ["userdata"]);
  let printed = "";
  t.mock.method(process.stdout, "write", (value) => { printed += value; return true; });
  const program = new Command();
  registerT3Commands(program);
  program.parse(["node", "heyditto", "t3", "setup", "--endpoint", "ditto-dev", "--base-dir", f.base, "--claude-bin", f.options.claudeBin, "--heyditto-bin", f.options.heydittoBin, "--dry-run", "--json"]);
  const summary = JSON.parse(printed);
  assert.equal(summary.runningPid, process.pid);
  assert.equal(summary.dryRun, true);
  assert.doesNotMatch(printed, /private-test-secret|managementKey/);
  assert.equal(readFileSync(f.settings, "utf8"), f.original);
  assert.deepEqual(readdirSync(f.base), ["userdata"]);
});

test("T3 setup preserves other providers, backs up exact bytes privately, and reruns without another backup", (t) => {
  const f = fixture(t);
  const plan = f.plan();
  const applied = applyT3Setup(plan);
  assert.equal(applied.changed, true);
  assert.equal(readFileSync(applied.backup, "utf8"), f.original);
  assert.equal(statSync(applied.backup).mode & 0o777, 0o600);
  assert.equal(statSync(f.settings).mode & 0o777, 0o600);
  const before = JSON.parse(f.original);
  const after = JSON.parse(readFileSync(f.settings, "utf8"));
  assert.deepEqual(after.unknownFutureSetting, before.unknownFutureSetting);
  assert.deepEqual(after.usageLimitSources, before.usageLimitSources);
  assert.deepEqual(after.providerInstances.claudeAgent, before.providerInstances.claudeAgent);
  assert.equal(after.providerInstances[plan.instance].config.binaryPath, plan.launcherPath);
  assert.equal(statSync(plan.homePath).mode & 0o777, 0o700);
  const version = spawnSync(plan.launcherPath, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, "fake Claude 1.0.0\n", "generated paths containing apostrophes survive shell quoting");
  const launched = spawnSync(plan.launcherPath, ["--print"], { encoding: "utf8" });
  assert.equal(launched.status, 0, launched.stderr);
  const captured = JSON.parse(launched.stdout);
  assert.equal(captured.endpoint, "ditto-dev");
  assert.equal(captured.inference, "cliproxy");
  assert.ok(captured.args.includes("--cliproxy"));
  assert.ok(captured.args.includes("--mcp"));
  const again = applyT3Setup(f.plan());
  assert.deepEqual(again, { changed: false });
  assert.equal(readdirSync(path.dirname(applied.backup)).length, 1);
});

test("a running T3 server or a settings change after planning prevents every config write", (t) => {
  const f = fixture(t);
  const plan = f.plan();
  const runtime = path.join(f.userdata, "server-runtime.json");
  writeFileSync(runtime, JSON.stringify({ pid: process.pid }));
  assert.throws(() => applyT3Setup(plan), /T3 is running/);
  assert.equal(readFileSync(f.settings, "utf8"), f.original);
  assert.equal(existsSync(plan.managedRoot), false);
  rmSync(runtime);
  const raced = JSON.stringify({ addedElsewhere: true });
  writeFileSync(f.settings, raced);
  assert.throws(() => applyT3Setup(plan), /changed since planning/);
  assert.equal(readFileSync(f.settings, "utf8"), raced);
  assert.equal(existsSync(plan.managedRoot), false);
});

test("T3 setup refuses another provider's id and malformed settings without printing private excerpts", (t) => {
  const f = fixture(t);
  assert.throws(() => f.plan({ instance: "claudeAgent" }), /already exists outside this setup/);
  writeFileSync(f.settings, '{"managementKey":"private-test-secret",');
  assert.throws(() => f.plan(), (error) => /Cannot parse T3 settings/.test(error.message) && !error.message.includes("private-test-secret"));
  assert.equal(existsSync(path.join(f.base, "ditto-providers")), false);
});

test("linked settings or generated launchers cannot redirect setup writes", (t) => {
  const f = fixture(t);
  const target = path.join(f.root, "other-settings.json");
  writeFileSync(target, f.original);
  rmSync(f.settings);
  symlinkSync(target, f.settings);
  assert.throws(() => f.plan(), /linked or unexpected/);
  assert.equal(readFileSync(target, "utf8"), f.original);
  rmSync(f.settings);
  writeFileSync(f.settings, f.original);
  const plan = f.plan();
  mkdirSync(path.dirname(plan.launcherPath), { recursive: true, mode: 0o700 });
  symlinkSync(target, plan.launcherPath);
  assert.throws(() => applyT3Setup(plan), /linked or unexpected/);
  assert.equal(readFileSync(target, "utf8"), f.original);
  assert.equal(readFileSync(f.settings, "utf8"), f.original);
});

test("mode changes install a new immutable launcher and leave the previous launcher intact", (t) => {
  const f = fixture(t);
  const first = f.plan();
  applyT3Setup(first);
  const firstText = readFileSync(first.launcherPath, "utf8");
  const next = f.plan({ inference: "router" });
  assert.notEqual(next.launcherPath, first.launcherPath);
  assert.equal(next.homePath, first.homePath);
  applyT3Setup(next);
  assert.equal(readFileSync(first.launcherPath, "utf8"), firstText);
  const result = spawnSync(next.launcherPath, ["--print"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(result.stdout);
  assert.equal(captured.inference, "router");
  assert.ok(captured.args.includes("--no-mcp"));
  assert.ok(!captured.args.includes("--cliproxy"));
});

test("unsupported CLIs and unsafe instance names fail before setup writes", (t) => {
  const f = fixture(t);
  writeFileSync(f.options.heydittoBin, `#!${process.execPath}\nprocess.stdout.write('--mcp-only\\n');\n`);
  assert.throws(() => f.plan(), /selected heyditto does not support/);
  assert.throws(() => f.plan({ instance: "../escape" }), /--instance/);
  assert.equal(readFileSync(f.settings, "utf8"), f.original);
  assert.equal(existsSync(path.join(f.base, "ditto-providers")), false);
});

test("T3 setup without --endpoint uses the normal default/pick/create choice and installs it", async (t) => {
  const f = fixture(t);
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", () => true);
  const calls = [];
  const program = new Command();
  registerT3Commands(program, { chooseEndpoint: async (readOnly) => { calls.push(readOnly); return { slug: "picked-endpoint" }; } });
  const args = ["node", "heyditto", "t3", "setup", "--base-dir", f.base, "--claude-bin", f.options.claudeBin, "--heyditto-bin", f.options.heydittoBin, "--json"];
  await program.parseAsync([...args, "--dry-run"]);
  assert.deepEqual(calls, [true], "a dry run must not create an endpoint or save a default");
  assert.equal(readFileSync(f.settings, "utf8"), f.original);
  let printed = "";
  process.stdout.write.mock.mockImplementation((value) => { printed += value; return true; });
  const fresh = new Command();
  registerT3Commands(fresh, { chooseEndpoint: async (readOnly) => { calls.push(readOnly); return { slug: "picked-endpoint" }; } });
  await fresh.parseAsync(args);
  assert.equal(calls.at(-1), false);
  const summary = JSON.parse(printed);
  assert.equal(summary.endpoint, "picked-endpoint");
  const launcher = readFileSync(summary.binaryPath, "utf8");
  assert.match(launcher, /DITTO_T3_ENDPOINT='picked-endpoint'/);
});

test("T3 setup without --endpoint fails on local problems before choosing an endpoint", async (t) => {
  const f = fixture(t);
  writeFileSync(f.settings, "not json");
  let called = false;
  const program = new Command();
  registerT3Commands(program, { chooseEndpoint: async () => { called = true; return { slug: "x" }; } });
  await assert.rejects(program.parseAsync(["node", "heyditto", "t3", "setup", "--base-dir", f.base, "--claude-bin", f.options.claudeBin, "--heyditto-bin", f.options.heydittoBin]), /Cannot parse T3 settings/);
  assert.equal(called, false);
});

test("a read-only endpoint choice on a terminal never offers to create an endpoint", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ditto-choose-endpoint-"));
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/api/v5/inference/endpoints" ? { baseUrl: "http://127.0.0.1/v1", endpoints: [] } : {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const saved = { env: { ...process.env }, stdin: process.stdin.isTTY, stderr: process.stderr.isTTY };
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
    for (const key of ["DITTO_API_BASE", "DITTO_API_KEY", "DITTO_CONFIG_DIR"]) saved.env[key] === undefined ? delete process.env[key] : (process.env[key] = saved.env[key]);
    process.stdin.isTTY = saved.stdin;
    process.stderr.isTTY = saved.stderr;
  });
  Object.assign(process.env, { DITTO_API_BASE: `http://127.0.0.1:${server.address().port}`, DITTO_API_KEY: "ditto_mcp_synthetic", DITTO_CONFIG_DIR: path.join(root, "config") });
  // A terminal is what makes the create prompt reachable; without the guard
  // this call would wait on stdin for the answer instead of rejecting.
  process.stdin.isTTY = true;
  process.stderr.isTTY = true;
  await assert.rejects(chooseEndpoint("claude", true), /no inference endpoints yet/);
  assert.deepEqual(calls.filter((c) => c.startsWith("POST")), []);
  assert.equal(existsSync(path.join(root, "config")), false);
});
