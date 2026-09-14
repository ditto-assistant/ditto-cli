import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverCommands, commandInvocation, parseFrontmatter } from "../dist/remote/catalog.js";
import { buildPrompt, safeAttachmentName } from "../dist/remote/attachments.js";
import { withHookArgs } from "../dist/remote/hooks.js";
import { createFakeHarnesses } from "./helpers/fake-harness.mjs";
import { startHostStub } from "./helpers/host-stub.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const require = createRequire(import.meta.url);

// @lydell/node-pty ships prebuilt binaries for darwin/linux/win32 on x64 and
// arm64. The PTY tests skip on a platform it has no prebuilt for; on a
// supported platform a load failure (optional dependencies omitted, broken
// install) fails the load test below instead of silently skipping everything.
let nodePty;
let ptyLoadError;
try {
  nodePty = require("@lydell/node-pty");
} catch (err) {
  ptyLoadError = (err instanceof Error ? err.message : String(err)).split("\n")[0];
}
const ptyUnsupported = ptyLoadError !== undefined && /does not support your platform/.test(ptyLoadError);
const ptySkip = nodePty
  ? false
  : ptyUnsupported
    ? `@lydell/node-pty has no prebuilt for ${process.platform}-${process.arch}`
    : `@lydell/node-pty failed to load: ${ptyLoadError}`;

const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A git repo with a Claude command + skill and a Codex prompt fixture set. */
function makeRepo() {
  const dir = realpathSync(tmp("heyditto-remote-repo-"));
  spawnSync("git", ["init", "-q", dir]);
  mkdirSync(path.join(dir, ".claude", "commands"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude", "commands", "deploy.md"),
    "---\ndescription: deploy the current branch\nargument-hint: <env>\n---\nDeploy to $ARGUMENTS.\n",
  );
  mkdirSync(path.join(dir, ".claude", "skills", "tidy"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "skills", "tidy", "SKILL.md"), "---\nname: tidy\ndescription: tidy the code\n---\n# tidy\n");
  mkdirSync(path.join(dir, ".claude", "skills", "hidden"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "skills", "hidden", "SKILL.md"), "---\nname: hidden\nuser-invocable: false\n---\n");
  return dir;
}

function makeHomes() {
  const claudeHome = tmp("heyditto-remote-claude-home-");
  mkdirSync(path.join(claudeHome, "commands"), { recursive: true });
  writeFileSync(path.join(claudeHome, "commands", "standup.md"), "Write the standup.\n");
  const plugin = path.join(claudeHome, "plugins", "cache", "market", "fancy", "1.0.0");
  mkdirSync(path.join(plugin, "skills", "polish"), { recursive: true });
  writeFileSync(path.join(plugin, "skills", "polish", "SKILL.md"), "---\nname: polish\ndescription: polish the ui\n---\n");
  mkdirSync(path.join(claudeHome, "plugins"), { recursive: true });
  writeFileSync(
    path.join(claudeHome, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "fancy@market": [{ scope: "user", installPath: plugin, version: "1.0.0" }] } }),
  );
  const codexHome = tmp("heyditto-remote-codex-home-");
  mkdirSync(path.join(codexHome, "prompts"), { recursive: true });
  writeFileSync(path.join(codexHome, "prompts", "deploy.md"), "---\ndescription: deploy it\n---\nDeploy.\n");
  mkdirSync(path.join(codexHome, "skills", "chronicle"), { recursive: true });
  writeFileSync(path.join(codexHome, "skills", "chronicle", "SKILL.md"), "---\nname: chronicle\ndescription: write the chronicle\n---\n");
  return { claudeHome, codexHome };
}

function baseEnv(stub, fakes, homes, extra = {}) {
  return {
    ...process.env,
    ...fakes.env(),
    DITTO_API_BASE: stub.base,
    DITTO_API_KEY: "ditto_mcp_test",
    DITTO_CONFIG_DIR: tmp("heyditto-remote-cfg-"),
    CLAUDE_CONFIG_DIR: homes.claudeHome,
    CODEX_HOME: homes.codexHome,
    FAKE_TURN_MS: "300",
    TERM: "xterm-256color",
    ...extra,
  };
}

/** Runs the CLI inside a pseudo-terminal, as a person would. */
function spawnTui(args, { cwd, env }) {
  const child = nodePty.spawn(process.execPath, [cliPath, ...args], { name: "xterm-256color", cols: 100, rows: 30, cwd, env });
  let output = "";
  child.onData((d) => (output += d));
  const exit = new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
  return { child, exit, output: () => output, write: (s) => child.write(s) };
}

async function waitUntil(fn, { timeout = 10_000, what = "condition" } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test("attachments: names are confined to the turn folder and the prompt lists relative paths", () => {
  assert.equal(safeAttachmentName("../../etc/passwd"), "passwd");
  assert.equal(safeAttachmentName(".env"), "env");
  assert.equal(safeAttachmentName("C:\\Users\\me\\report.pdf"), "report.pdf");
  const prompt = buildPrompt("look at this\r\n", [{ relPath: ".tmp/ditto/attachments/t1/a.png" }, { relPath: ".tmp/ditto/attachments/t1/b.txt" }]);
  assert.equal(prompt, "look at this\n\nAttached files:\n- .tmp/ditto/attachments/t1/a.png\n- .tmp/ditto/attachments/t1/b.txt");
  assert.equal(buildPrompt("plain", []), "plain");
});

test("hook args land where each harness accepts them", () => {
  assert.deepEqual(withHookArgs("claude", ["--session-id", "s"], ["--settings", "{}"]), ["--session-id", "s", "--settings", "{}"]);
  assert.deepEqual(withHookArgs("codex", ["resume", "-c", "x=1", "id"], ["-c", "notify=[]"]), ["resume", "-c", "notify=[]", "-c", "x=1", "id"]);
  assert.deepEqual(withHookArgs("codex", ["exec", "resume", "--last", "p"], ["-c", "n"]), ["exec", "resume", "-c", "n", "--last", "p"]);
});

test("catalog: discovers custom commands, skills, plugin skills and builtins per harness", async () => {
  const repo = makeRepo();
  const homes = makeHomes();
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  const prevCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = homes.claudeHome;
  process.env.CODEX_HOME = homes.codexHome;
  try {
    const claude = await discoverCommands("claude", repo);
    const byName = Object.fromEntries(claude.map((c) => [c.name, c]));
    assert.deepEqual(byName.deploy, { name: "deploy", description: "deploy the current branch", source: "custom", argsHint: "<env>", headless: true });
    assert.equal(byName.standup.source, "custom");
    assert.equal(byName.standup.description, "Write the standup.");
    assert.deepEqual(byName.tidy, { name: "tidy", description: "tidy the code", source: "skill", headless: true });
    assert.equal(byName.hidden, undefined, "user-invocable: false skills stay out of the catalog");
    assert.equal(byName["fancy:polish"].source, "plugin");
    assert.equal(byName.compact.source, "builtin");
    assert.equal(byName.compact.headless, false);
    assert.equal(byName.review.headless, true);
    // Custom entries come before builtins, so the app's palette lists them first.
    assert.ok(claude.findIndex((c) => c.name === "deploy") < claude.findIndex((c) => c.name === "help"));

    const codex = await discoverCommands("codex", repo);
    const codexByName = Object.fromEntries(codex.map((c) => [c.name, c]));
    assert.equal(codexByName["prompts:deploy"].source, "custom");
    assert.equal(codexByName["prompts:deploy"].headless, true);
    assert.equal(codexByName.$chronicle.source, "skill");
    assert.equal(codexByName.compact.headless, false);
    assert.equal(commandInvocation("claude", byName.deploy, "deploy", "prod"), "/deploy prod");
    assert.equal(commandInvocation("codex", codexByName.$chronicle, "$chronicle", undefined), "$chronicle");
    assert.equal(commandInvocation("codex", codexByName["prompts:deploy"], "prompts:deploy", " now "), "/prompts:deploy now");
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prevClaude;
    process.env.CODEX_HOME = prevCodex;
  }
  assert.deepEqual(parseFrontmatter("no frontmatter").fields, {});
});

// ---------------------------------------------------------------------------
// TUI mode (needs @lydell/node-pty)
// ---------------------------------------------------------------------------

test("tui: @lydell/node-pty loads on every platform it ships a prebuilt for", { skip: ptyUnsupported && ptySkip }, () => {
  assert.ok(nodePty, `${ptyLoadError} — were optional dependencies omitted at install?`);
});

test("tui: default launch announces, sends the catalog, and runs prompt / command / permission turns from the app", { skip: ptySkip }, async () => {
  const stub = await startHostStub();
  const fakes = createFakeHarnesses();
  const homes = makeHomes();
  const repo = makeRepo();
  const env = baseEnv(stub, fakes, homes);
  const run = spawnTui(["claude"], { cwd: repo, env });
  try {
    const hello = await stub.waitFor((f) => f.type === "hello");
    assert.equal(hello.kind, "cli");
    assert.equal(hello.capabilities.attachments, true);
    assert.equal(hello.capabilities.headless, true);
    const announce = await stub.waitFor((f) => f.type === "session.announce");
    assert.equal(announce.harness, "claude-code");
    assert.equal(announce.mode, "tui");
    assert.equal(announce.cwd, repo);
    assert.equal(announce.status, "idle");
    const catalog = await stub.waitFor((f) => f.type === "session.commands");
    assert.equal(catalog.sessionId, announce.sessionId);
    assert.ok(catalog.commands.some((c) => c.name === "deploy" && c.source === "custom"));
    assert.ok(catalog.commands.some((c) => c.name === "compact" && c.source === "builtin" && c.headless === false));

    // The fake harness got the hook settings and is on screen.
    await waitUntil(() => run.output().includes("fake claude ready"), { what: "fake claude banner" });
    const launch = fakes.entries().find((e) => e.mode === "tui");
    assert.deepEqual(launch.hooks.sort(), ["Notification", "PreToolUse", "Stop", "UserPromptSubmit"]);

    // 1. Prompt with an attachment.
    const bytes = Buffer.from("notes from the phone\n");
    const attachment = stub.addAttachment("att-1", "notes.txt", bytes);
    stub.send({ type: "turn.deliver", turnId: "turn-1", sessionId: announce.sessionId, text: "read the notes", attachments: [attachment] });
    await stub.waitFor((f) => f.type === "turn.ack" && f.turnId === "turn-1");
    await stub.waitFor((f) => f.type === "turn.started" && f.turnId === "turn-1");
    const finished = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "turn-1");
    assert.equal(finished.exitCode, 0);
    assert.equal(finished.interrupted, undefined);
    const saved = path.join(repo, ".tmp", "ditto", "attachments", "turn-1", "notes.txt");
    assert.equal(readFileSync(saved, "utf8"), "notes from the phone\n");
    const submitted = fakes.entries().find((e) => e.event === "prompt");
    assert.equal(submitted.prompt, "read the notes\n\nAttached files:\n- .tmp/ditto/attachments/turn-1/notes.txt");
    const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    assert.ok(exclude.includes("\n.tmp/\n"), ".tmp/ is excluded per clone, never via .gitignore");
    assert.equal(existsSync(path.join(repo, ".gitignore")), false);
    // Session status went running → idle around the turn, driven by the hooks.
    assert.ok(stub.frames.some((f) => f.type === "session.status" && f.status === "running"));
    await stub.waitFor((f) => f.type === "session.status" && f.status === "idle", { from: stub.frames.indexOf(finished) });

    // A duplicate delivery is acked but not re-run.
    stub.send({ type: "turn.deliver", turnId: "turn-1", sessionId: announce.sessionId, text: "read the notes" });
    await stub.waitFor((f, i) => f.type === "turn.ack" && f.turnId === "turn-1", { from: stub.frames.length });
    await sleep(200);
    assert.equal(fakes.entries().filter((e) => e.event === "prompt").length, 1);

    // 2. A custom command with args is typed as /deploy prod.
    stub.send({ type: "turn.deliver", turnId: "turn-2", sessionId: announce.sessionId, kind: "command", text: "", command: { name: "deploy", args: "prod" } });
    const finished2 = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "turn-2");
    assert.equal(finished2.exitCode, 0);
    assert.equal(fakes.entries().filter((e) => e.event === "prompt")[1].prompt, "/deploy prod");

    // 3. A turn that raises a permission prompt: prompt.request → prompt.answer → keystroke.
    stub.send({ type: "turn.deliver", turnId: "turn-3", sessionId: announce.sessionId, text: "please [ask] run the tests" });
    const request = await stub.waitFor((f) => f.type === "prompt.request");
    assert.equal(request.kind, "permission");
    assert.equal(request.sessionId, announce.sessionId);
    assert.match(request.text, /permission/i);
    assert.equal(request.options[0].id, "1");
    assert.equal(stub.frames.some((f) => f.type === "turn.finished" && f.turnId === "turn-3"), false, "turn waits for the answer");
    stub.send({ type: "prompt.answer", promptId: request.promptId, value: "1" });
    const finished3 = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "turn-3");
    assert.equal(finished3.exitCode, 0);
    assert.deepEqual(
      fakes.entries().filter((e) => e.event === "answer").map((e) => e.key),
      ["1"],
    );

    // 4. Same, answered through a turn of kind "answer".
    stub.send({ type: "turn.deliver", turnId: "turn-4", sessionId: announce.sessionId, text: "again [ask]" });
    const request2 = await stub.waitFor((f) => f.type === "prompt.request" && f.promptId !== request.promptId);
    stub.send({ type: "turn.deliver", turnId: "turn-5", sessionId: announce.sessionId, kind: "answer", text: "", answer: { promptId: request2.promptId, value: "Yes" } });
    const answered = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "turn-5");
    assert.equal(answered.exitCode, 0);
    await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "turn-4");
    assert.deepEqual(
      fakes.entries().filter((e) => e.event === "answer").map((e) => e.key),
      ["1", "1"],
    );

    // Ctrl+C at the keyboard ends the harness; the host announces the session closed and the key is revoked.
    run.write("\u0003");
    const code = await Promise.race([run.exit, sleep(15000).then(() => "no exit")]);
    assert.equal(code, 0, run.output());
    await stub.waitFor((f) => f.type === "session.closed" && f.sessionId === announce.sessionId, { timeout: 2000 }).catch(() => undefined);
    assert.ok(stub.frames.some((f) => f.type === "session.closed"), "session.closed sent on exit");
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url.includes("/keys/key-2")), "session key revoked");
  } finally {
    run.child.kill();
    await Promise.race([run.exit, sleep(5000)]);
    await stub.close();
  }
});

test("tui: turn.interrupt sends the harness its interrupt key and finishes the turn as interrupted", { skip: ptySkip }, async () => {
  const stub = await startHostStub();
  const fakes = createFakeHarnesses();
  const homes = makeHomes();
  const repo = makeRepo();
  const run = spawnTui(["claude"], { cwd: repo, env: baseEnv(stub, fakes, homes, { FAKE_TURN_MS: "6000" }) });
  try {
    const announce = await stub.waitFor((f) => f.type === "session.announce");
    await waitUntil(() => run.output().includes("fake claude ready"), { what: "fake claude banner" });
    stub.send({ type: "turn.deliver", turnId: "long", sessionId: announce.sessionId, text: "take your time" });
    await stub.waitFor((f) => f.type === "turn.started" && f.turnId === "long");
    const t0 = Date.now();
    stub.send({ type: "turn.interrupt", turnId: "long" });
    const finished = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "long", { timeout: 4000 });
    assert.equal(finished.interrupted, true);
    assert.ok(Date.now() - t0 < 3000, "interrupt ended the turn well before its 6 s duration");
    assert.equal(fakes.entries().find((e) => e.event === "turn-finished").interrupted, true);
    run.write("\u0003");
    assert.equal(await run.exit, 0);
  } finally {
    run.child.kill();
    await Promise.race([run.exit, sleep(5000)]);
    await stub.close();
  }
});

test("tui: a dropped connection reconnects and re-announces the session and its catalog", { skip: ptySkip }, async () => {
  const stub = await startHostStub();
  const fakes = createFakeHarnesses();
  const homes = makeHomes();
  const repo = makeRepo();
  const run = spawnTui(["codex"], { cwd: repo, env: baseEnv(stub, fakes, homes) });
  try {
    const first = await stub.waitFor((f) => f.type === "session.announce");
    assert.equal(first.harness, "codex");
    await stub.waitFor((f) => f.type === "session.commands");
    await waitUntil(() => run.output().includes("fake codex ready"), { what: "fake codex banner" });
    const before = stub.frames.length;
    stub.dropClients();
    const hello = await stub.waitFor((f) => f.type === "hello", { from: before, timeout: 15_000 });
    assert.equal(hello.hostId, "host-1", "the host id from the first welcome is presented again");
    const again = await stub.waitFor((f) => f.type === "session.announce", { from: before, timeout: 15_000 });
    assert.equal(again.sessionId, first.sessionId);
    await stub.waitFor((f) => f.type === "session.commands", { from: before, timeout: 15_000 });
    assert.equal(stub.connections(), 2);
    // Turns still flow on the new connection; Codex's notify hook ends them.
    stub.send({ type: "turn.deliver", turnId: "after", sessionId: first.sessionId, text: "still there?" });
    const finished = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "after");
    assert.equal(finished.exitCode, 0);
    assert.equal(fakes.entries().find((e) => e.mode === "tui").notify, true, "codex launched with our notify override");
    run.write("\u0003");
    assert.equal(await run.exit, 0);
  } finally {
    run.child.kill();
    await Promise.race([run.exit, sleep(5000)]);
    await stub.close();
  }
});

test("tui: --no-remote-control never connects and launches the harness without hooks", { skip: ptySkip }, async () => {
  const stub = await startHostStub();
  const fakes = createFakeHarnesses();
  const homes = makeHomes();
  const repo = makeRepo();
  const run = spawnTui(["claude", "--no-remote-control"], { cwd: repo, env: baseEnv(stub, fakes, homes) });
  try {
    await waitUntil(() => run.output().includes("fake claude ready"), { what: "fake claude banner" });
    await sleep(1500);
    assert.equal(stub.connections(), 0);
    assert.equal(stub.frames.length, 0);
    const launch = fakes.entries().find((e) => e.mode === "tui");
    assert.deepEqual(launch.hooks, []);
    assert.equal(launch.args.includes("--settings"), false);
    run.write("\u0003");
    assert.equal(await run.exit, 0);
    assert.ok(stub.calls.some((c) => c.method === "DELETE"), "key still revoked on exit");
  } finally {
    run.child.kill();
    await Promise.race([run.exit, sleep(5000)]);
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Headless mode (plain stdio)
// ---------------------------------------------------------------------------

function spawnHeadless(args, { cwd, env }) {
  const child = spawn(process.execPath, [cliPath, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const exit = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}

test("headless: one codex exec per turn, resumed thread, catalog rules, clean Ctrl+C", async () => {
  const stub = await startHostStub();
  const fakes = createFakeHarnesses();
  const homes = makeHomes();
  const repo = makeRepo();
  const run = spawnHeadless(["codex", "--headless"], { cwd: repo, env: baseEnv(stub, fakes, homes) });
  try {
    const announce = await stub.waitFor((f) => f.type === "session.announce");
    assert.equal(announce.mode, "headless");
    assert.equal(announce.harness, "codex");
    const catalog = await stub.waitFor((f) => f.type === "session.commands");
    assert.ok(catalog.commands.some((c) => c.name === "prompts:deploy" && c.headless));

    stub.send({ type: "turn.deliver", turnId: "h1", sessionId: announce.sessionId, text: "first" });
    await stub.waitFor((f) => f.type === "turn.started" && f.turnId === "h1");
    const f1 = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "h1");
    assert.equal(f1.exitCode, 0);
    stub.send({ type: "turn.deliver", turnId: "h2", sessionId: announce.sessionId, text: "second" });
    const f2 = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "h2");
    assert.equal(f2.exitCode, 0);
    const runs = fakes.entries().filter((e) => e.mode === "headless");
    assert.equal(runs.length, 2);
    assert.equal(runs[0].args[0], "exec");
    assert.notEqual(runs[0].args[1], "resume", "the first turn starts the thread");
    assert.equal(runs[0].prompt, "first");
    assert.deepEqual(runs[1].args.slice(0, 2), ["exec", "resume"]);
    assert.ok(runs[1].args.includes("--last"));
    assert.equal(runs[1].prompt, "second");
    assert.ok(runs[0].args.some((a) => a.startsWith("notify=[")), "codex exec carries the notify override");

    // A TUI-only builtin is refused with a reason; a custom prompt runs.
    stub.send({ type: "turn.deliver", turnId: "h3", sessionId: announce.sessionId, kind: "command", text: "", command: { name: "compact" } });
    const f3 = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "h3");
    assert.equal(f3.exitCode, 0);
    assert.match(f3.unsupported, /compact/);
    stub.send({ type: "turn.deliver", turnId: "h4", sessionId: announce.sessionId, kind: "command", text: "", command: { name: "prompts:deploy", args: "staging" } });
    const f4 = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "h4");
    assert.equal(f4.unsupported, undefined);
    assert.equal(fakes.entries().filter((e) => e.mode === "headless").at(-1).prompt, "/prompts:deploy staging");
    // Harness prompts cannot be answered headless.
    stub.send({ type: "turn.deliver", turnId: "h5", sessionId: announce.sessionId, kind: "answer", text: "", answer: { promptId: "x", value: "1" } });
    const f5 = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "h5");
    assert.match(f5.unsupported, /headless/);

    run.child.kill("SIGINT");
    const code = await run.exit;
    assert.equal(code, 0, run.stderr());
    assert.ok(stub.frames.some((f) => f.type === "session.closed" && f.sessionId === announce.sessionId));
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url.includes("/keys/key-2")), "session key revoked on Ctrl+C");
    assert.match(run.stderr(), /headless remote control on/);
  } finally {
    run.child.kill();
    await Promise.race([run.exit, sleep(5000)]);
    await stub.close();
  }
});

test("headless: claude turns resume the session id after the first one and -p seeds the first turn", async () => {
  const stub = await startHostStub();
  const fakes = createFakeHarnesses();
  const homes = makeHomes();
  const repo = makeRepo();
  const run = spawnHeadless(["claude", "--headless", "--session", "sess-abc", "-p", "seed"], { cwd: repo, env: baseEnv(stub, fakes, homes) });
  try {
    const announce = await stub.waitFor((f) => f.type === "session.announce");
    assert.equal(announce.sessionId, "sess-abc");
    await waitUntil(() => fakes.entries().some((e) => e.mode === "headless"), { what: "seed turn" });
    stub.send({ type: "turn.deliver", turnId: "c2", sessionId: "sess-abc", text: "next" });
    await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === "c2");
    const runs = fakes.entries().filter((e) => e.mode === "headless");
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0].args.slice(0, 2), ["--session-id", "sess-abc"]);
    assert.equal(runs[0].prompt, "seed");
    assert.deepEqual(runs[1].args.slice(0, 2), ["--resume", "sess-abc"]);
    assert.ok(runs[1].args.includes("stream-json"));
    assert.equal(runs[1].prompt, "next");
    run.child.kill("SIGINT");
    assert.equal(await run.exit, 0);
  } finally {
    run.child.kill();
    await Promise.race([run.exit, sleep(5000)]);
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// heyditto fork
// ---------------------------------------------------------------------------

test("fork: copies a Claude transcript under a new session id and records the new session", async () => {
  const homes = makeHomes();
  const cfg = tmp("heyditto-fork-cfg-");
  const repo = makeRepo();
  const canonical = spawnSync("realpath", [repo], { encoding: "utf8" }).stdout.trim() || repo;
  const slug = Array.from(canonical, (ch) => (/[A-Za-z0-9]/.test(ch) ? ch : "-")).join("");
  const oldId = "11111111-2222-4333-8444-555555555555";
  const projectDir = path.join(homes.claudeHome, "projects", slug);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    path.join(projectDir, `${oldId}.jsonl`),
    [
      JSON.stringify({ type: "user", sessionId: oldId, cwd: canonical, message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", sessionId: oldId, cwd: canonical, message: { role: "assistant", content: "hi" } }),
    ].join("\n") + "\n",
  );
  mkdirSync(path.join(cfg, "sessions"), { recursive: true });
  writeFileSync(
    path.join(cfg, "sessions", `${oldId}.json`),
    JSON.stringify({ id: oldId, harness: "claude", endpointId: "e1", endpointSlug: "alpha", harnessSessionId: oldId, cwd: repo, createdAt: "2026-09-13T00:00:00Z", lastLaunchedAt: "2026-09-13T00:00:00Z", launches: 3 }),
  );
  const env = { ...process.env, DITTO_API_KEY: "", DITTO_CONFIG_DIR: cfg, CLAUDE_CONFIG_DIR: homes.claudeHome, CODEX_HOME: homes.codexHome };
  const r = spawnSync(process.execPath, [cliPath, "fork", oldId, "--json"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.from, oldId);
  const newId = out.session.id;
  assert.notEqual(newId, oldId);
  assert.equal(out.session.harnessSessionId, newId);
  assert.equal(out.session.harness, "claude");
  assert.equal(out.session.launches, 1);
  const copied = readFileSync(out.transcript, "utf8");
  assert.ok(copied.includes(newId) && !copied.includes(oldId), "session id rewritten throughout the copy");
  assert.equal(path.basename(out.transcript), `${newId}.jsonl`);
  assert.ok(existsSync(path.join(projectDir, `${oldId}.jsonl`)), "the original transcript is untouched");
  assert.ok(existsSync(path.join(cfg, "sessions", `${newId}.json`)));
  const text = spawnSync(process.execPath, [cliPath, "fork", oldId], { encoding: "utf8", env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /heyditto claude --resume [0-9a-f-]{36}/);
  const missing = spawnSync(process.execPath, [cliPath, "fork", "nope"], { encoding: "utf8", env });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no local session/);
});

test("fork: --worktree puts the copy on a fresh branch and moves the transcript to the worktree's project", async () => {
  const homes = makeHomes();
  const cfg = tmp("heyditto-fork-cfg-");
  const repo = makeRepo();
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  spawnSync("git", ["-C", repo, "add", "."]);
  spawnSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]);
  const canonical = spawnSync("realpath", [repo], { encoding: "utf8" }).stdout.trim() || repo;
  const slug = Array.from(canonical, (ch) => (/[A-Za-z0-9]/.test(ch) ? ch : "-")).join("");
  const oldId = "aaaaaaaa-2222-4333-8444-555555555555";
  const projectDir = path.join(homes.claudeHome, "projects", slug);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, `${oldId}.jsonl`), `${JSON.stringify({ type: "user", sessionId: oldId, cwd: canonical })}\n`);
  mkdirSync(path.join(cfg, "sessions"), { recursive: true });
  writeFileSync(
    path.join(cfg, "sessions", `${oldId}.json`),
    JSON.stringify({ id: oldId, harness: "claude", endpointId: "e1", endpointSlug: "alpha", harnessSessionId: oldId, cwd: repo, createdAt: "2026-09-13T00:00:00Z", lastLaunchedAt: "2026-09-13T00:00:00Z", launches: 1 }),
  );
  const env = { ...process.env, DITTO_API_KEY: "", DITTO_CONFIG_DIR: cfg, CLAUDE_CONFIG_DIR: homes.claudeHome, CODEX_HOME: homes.codexHome };
  const r = spawnSync(process.execPath, [cliPath, "fork", oldId, "--worktree", "try-b", "--json"], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.session.worktree, path.join(repo, ".worktrees", "try-b"));
  assert.equal(out.session.cwd, repo);
  const branches = spawnSync("git", ["-C", repo, "branch", "--list", "try-b"], { encoding: "utf8" }).stdout;
  assert.match(branches, /try-b/);
  const wtCanonical = spawnSync("realpath", [out.session.worktree], { encoding: "utf8" }).stdout.trim();
  assert.ok(out.transcript.includes(Array.from(wtCanonical, (ch) => (/[A-Za-z0-9]/.test(ch) ? ch : "-")).join("")), "transcript lives under the worktree's project slug");
  assert.ok(readFileSync(out.transcript, "utf8").includes(wtCanonical), "cwd fields point at the worktree");
});
