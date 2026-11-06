import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planClaude } from "../dist/agents/claude.js";
import { claudeHookAttachment, decodeHookArgs, parseClaudeHooks, stopHookScriptPath } from "../dist/agents/claude-hooks.js";
import { claudeMcpAttachment } from "../dist/agents/claude-mcp.js";
import { expandRepos, hookInput, stopFindings, stopHookOutput, unpushedProblems } from "../dist/agents/claude-stop-hook.js";
import { claudeHookSettings, withHookArgs } from "../dist/remote/hooks.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_NOSYSTEM: "1", HOME: os.tmpdir() };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

function tmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A bare "origin" with main pushed, and a full clone of it tracking main. */
function originAndClone() {
  const base = tmp("ditto-hooks-");
  const origin = path.join(base, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { env: GIT_ENV });
  const seed = path.join(base, "seed");
  execFileSync("git", ["clone", origin, seed], { env: GIT_ENV, stdio: "ignore" });
  git(seed, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(path.join(seed, "README"), "x\n");
  git(seed, "add", "README");
  git(seed, "commit", "-m", "init");
  git(seed, "push", "origin", "main");
  return { base, origin, seed };
}

const plan = (extra = {}) => planClaude({ baseUrl: "https://router.test/v1", apiKey: "k", sessionId: "s1", passthrough: [], env: {}, ...extra });
const settingsOf = (args) => JSON.parse(args[args.indexOf("--settings") + 1]);

test("parseClaudeHooks: stop checks and repos, typos refused", () => {
  assert.equal(parseClaudeHooks(undefined, "x"), undefined);
  assert.deepEqual(parseClaudeHooks({ stop: { checks: ["unpushed"] } }, "x"), { stop: { checks: ["unpushed"], repos: ["."] } });
  assert.deepEqual(parseClaudeHooks({ stop: { checks: ["unpushed"], repos: [".", "workspaces/*/*"] } }, "x").stop.repos, [".", "workspaces/*/*"]);
  assert.deepEqual(parseClaudeHooks({ stop: { checks: [] } }, "x"), { stop: { checks: [], repos: ["."] } }, "an empty list is an explicit off");
  assert.throws(() => parseClaudeHooks({ stop: { checks: ["unpushd"] } }, "x"), /unknown check "unpushd"/);
  assert.throws(() => parseClaudeHooks({ stopp: {} }, "x"), /x\.claude_hooks\.stopp: unknown hook/);
  assert.throws(() => parseClaudeHooks({ stop: { checks: ["unpushed"], path: ["."] } }, "x"), /unknown key/);
  assert.throws(() => parseClaudeHooks({ stop: { checks: ["unpushed"], repos: ["../other"] } }, "x"), /inside the repository/);
  assert.throws(() => parseClaudeHooks({ stop: { checks: ["unpushed"], repos: ["/etc"] } }, "x"), /inside the repository/);
  assert.throws(() => parseClaudeHooks("stop", "x"), /must be a table/);
});

test("claudeHookAttachment: one Stop command hook carrying only paths and check names", () => {
  assert.equal(claudeHookAttachment(undefined, { root: "/r", source: "s" }), undefined);
  assert.equal(claudeHookAttachment({ stop: { checks: [], repos: ["."] } }, { root: "/r", source: "s" }), undefined);
  const a = claudeHookAttachment({ stop: { checks: ["unpushed"], repos: ["."] } }, { root: "/r", source: ".ditto/endpoints/dev.toml", node: "/n/node", script: "/s/hook.js" });
  assert.deepEqual(a.summary, ["Stop (unpushed)"]);
  const [group] = a.settings.hooks.Stop;
  assert.equal(group.matcher, undefined, "Stop takes no matcher");
  const [hook] = group.hooks;
  assert.equal(hook.type, "command");
  assert.equal(hook.timeout, 60);
  const m = /^'\/n\/node' '\/s\/hook\.js' '([A-Za-z0-9_-]+)'$/.exec(hook.command);
  assert.ok(m, hook.command);
  assert.deepEqual(decodeHookArgs(m[1]), { root: "/r", checks: ["unpushed"], repos: ["."], source: ".ditto/endpoints/dev.toml" });
  assert.ok(stopHookScriptPath().endsWith(path.join("agents", "claude-stop-hook.js")));
});

test("planClaude: hooks ride the one --settings, with or without MCP, and in every inference mode", () => {
  const hooks = claudeHookAttachment({ stop: { checks: ["unpushed"], repos: ["."] } }, { root: "/r", source: "s" });
  // Router surface, no MCP: hooks alone still produce a --settings.
  const routerOnly = plan({ hooks });
  assert.equal(routerOnly.args.filter((a) => a === "--settings").length, 1);
  assert.deepEqual(settingsOf(routerOnly.args).hooks, hooks.settings.hooks);
  // No hooks, no MCP: argv is untouched, exactly as before.
  assert.ok(!plan().args.includes("--settings"));
  // Native MCP + hooks: permissions and hooks in the same value.
  const mcp = claudeMcpAttachment({ endpoint: "e", approvalMode: "park", clientApprovals: false, servers: [{ name: "ditto", url: "https://r/v1/mcp/ditto", tools: [{ name: "t", tier: "read", approval: false }] }] }, "s1");
  const both = plan({ hooks, mcp });
  assert.equal(both.args.filter((a) => a === "--settings").length, 1);
  assert.deepEqual(settingsOf(both.args), { permissions: { allow: ["mcp__ditto"] }, hooks: hooks.settings.hooks });
  // A user's inline --settings absorbs ours, their own hooks kept.
  const user = plan({ hooks, passthrough: ["--settings", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } })] });
  assert.equal(user.args.filter((a) => a === "--settings").length, 1);
  assert.deepEqual(settingsOf(user.args).hooks.Stop.map((g) => g.hooks[0].command), ["mine", hooks.settings.hooks.Stop[0].hooks[0].command]);
  // --mcp-only (native account) and CLIProxy keep the hooks too.
  assert.deepEqual(settingsOf(plan({ hooks, mcp, mcpOnly: true }).args).hooks, hooks.settings.hooks);
  assert.deepEqual(settingsOf(plan({ hooks, localInference: true }).args).hooks, hooks.settings.hooks);
});

test("Remote Control's relay hooks and Ditto's Stop hook both survive the merge", () => {
  const hooks = claudeHookAttachment({ stop: { checks: ["unpushed"], repos: ["."] } }, { root: "/r", source: "s" });
  const args = withHookArgs("claude", plan({ hooks }).args, ["--settings", claudeHookSettings("/tmp/sock", "/s/relay.js", "/n/node")]);
  assert.equal(args.filter((a) => a === "--settings").length, 1);
  const stops = settingsOf(args).hooks.Stop.map((g) => g.hooks[0].command);
  assert.equal(stops.length, 2);
  assert.ok(stops.some((c) => c.includes("claude-stop-hook.js")));
  assert.ok(stops.some((c) => c.includes("relay.js")));
  assert.ok(settingsOf(args).hooks.UserPromptSubmit, "the relay's other events are kept");
});

test("unpushedProblems: clean, dirty, ahead of upstream, never pushed", () => {
  const { base, origin } = originAndClone();
  const clone = path.join(base, "clone");
  execFileSync("git", ["clone", origin, clone], { env: GIT_ENV, stdio: "ignore" });
  return (async () => {
    assert.deepEqual(await unpushedProblems(clone), [], "a fresh clone is durable");
    writeFileSync(path.join(clone, "new.txt"), "n\n");
    assert.deepEqual(await unpushedProblems(clone), ["1 uncommitted change"]);
    git(clone, "add", "new.txt");
    git(clone, "commit", "-m", "work");
    assert.deepEqual(await unpushedProblems(clone), ["1 commit on main not pushed to origin/main"]);
    git(clone, "push", "origin", "main");
    assert.deepEqual(await unpushedProblems(clone), []);
    // A new branch with no commits of its own has nothing to push.
    git(clone, "checkout", "-b", "task/empty");
    assert.deepEqual(await unpushedProblems(clone), []);
    writeFileSync(path.join(clone, "b.txt"), "b\n");
    git(clone, "add", "b.txt");
    git(clone, "commit", "-m", "branch work");
    assert.deepEqual(await unpushedProblems(clone), ["branch task/empty is not on origin (1 local commit)"]);
    // A detached HEAD and a repository with no remote are not reported.
    git(clone, "checkout", "--detach");
    assert.deepEqual(await unpushedProblems(clone), []);
    const local = tmp("ditto-hooks-local-");
    execFileSync("git", ["init", "-b", "main", local], { env: GIT_ENV });
    writeFileSync(path.join(local, "f"), "f\n");
    git(local, "add", "f");
    git(local, "commit", "-m", "local");
    assert.deepEqual(await unpushedProblems(local), []);
  })();
});

test("unpushedProblems: a pushed branch with no remote-tracking ref is not misread as unpushed", async () => {
  const { base, origin } = originAndClone();
  // The setup-workspace trap: --single-branch clone, task branch pushed with
  // `git push -u`, but no refspec, so @{upstream} does not resolve.
  const clone = path.join(base, "single");
  execFileSync("git", ["clone", "--single-branch", "--branch", "main", origin, clone], { env: GIT_ENV, stdio: "ignore" });
  git(clone, "checkout", "-b", "task/x");
  writeFileSync(path.join(clone, "x.txt"), "x\n");
  git(clone, "add", "x.txt");
  git(clone, "commit", "-m", "x");
  git(clone, "push", "origin", "task/x");
  assert.throws(() => git(clone, "rev-parse", "@{upstream}"), "precondition: no upstream ref");
  assert.deepEqual(await unpushedProblems(clone), [], "ls-remote shows the branch at HEAD");
  writeFileSync(path.join(clone, "y.txt"), "y\n");
  git(clone, "add", "y.txt");
  git(clone, "commit", "-m", "y");
  assert.match((await unpushedProblems(clone))[0], /^origin\/task\/x is at [0-9a-f]{12}, local HEAD [0-9a-f]{12} is not on it$/);
});

test("unpushedProblems: an unreachable remote reports nothing rather than guessing", async () => {
  const { base, origin } = originAndClone();
  const clone = path.join(base, "clone");
  execFileSync("git", ["clone", "--single-branch", "--branch", "main", origin, clone], { env: GIT_ENV, stdio: "ignore" });
  git(clone, "checkout", "-b", "task/y");
  writeFileSync(path.join(clone, "y.txt"), "y\n");
  git(clone, "add", "y.txt");
  git(clone, "commit", "-m", "y");
  git(clone, "remote", "set-url", "origin", path.join(base, "gone.git"));
  assert.deepEqual(await unpushedProblems(clone), []);
});

test("expandRepos and stopFindings: globbed workspaces, relative names, bounded to git repos", async () => {
  const { base, origin, seed } = originAndClone();
  const root = seed;
  const ws = path.join(root, "workspaces", "task-1");
  mkdirSync(ws, { recursive: true });
  execFileSync("git", ["clone", origin, path.join(ws, "backend")], { env: GIT_ENV, stdio: "ignore" });
  execFileSync("git", ["clone", origin, path.join(ws, "app")], { env: GIT_ENV, stdio: "ignore" });
  mkdirSync(path.join(ws, "not-a-repo"));
  mkdirSync(path.join(root, "workspaces", ".hidden", "r"), { recursive: true });
  writeFileSync(path.join(ws, "app", "dirty.txt"), "d\n");
  assert.deepEqual(
    (await expandRepos(root, [".", "workspaces/*/*"])).map((r) => path.relative(root, r) || "."),
    [".", path.join("workspaces", "task-1", "app"), path.join("workspaces", "task-1", "backend")],
  );
  assert.deepEqual(await expandRepos(root, ["missing/*"]), []);
  const findings = await stopFindings({ root, checks: ["unpushed"], repos: [".", "workspaces/*/*"], source: "s" });
  // The seed's own untracked workspaces/ dir counts as uncommitted in "." here.
  assert.deepEqual(findings.map((f) => f.repo), [".", path.join("workspaces", "task-1", "app")]);
  assert.deepEqual(findings[1].problems, ["1 uncommitted change"]);
  assert.deepEqual(await stopFindings({ root, checks: [], repos: ["."], source: "s" }), []);
  void base;
});

test("stopHookOutput: blocks once with a reason, never when already continuing", async () => {
  const { base, origin } = originAndClone();
  const clone = path.join(base, "clone");
  execFileSync("git", ["clone", origin, clone], { env: GIT_ENV, stdio: "ignore" });
  const args = { root: clone, checks: ["unpushed"], repos: ["."], source: ".ditto/endpoints/dev.toml" };
  assert.equal(await stopHookOutput({ stop_hook_active: false }, args), "", "nothing to report");
  writeFileSync(path.join(clone, "w.txt"), "w\n");
  const out = JSON.parse(await stopHookOutput({ stop_hook_active: false }, args));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /^Ditto stop check \(\.ditto\/endpoints\/dev\.toml\)/);
  assert.match(out.reason, /- \.: 1 uncommitted change/);
  assert.equal(await stopHookOutput({ stop_hook_active: true }, args), "", "a second stop in the same chain ends the turn");
  assert.notEqual(await stopHookOutput(undefined, args), "", "missing input counts as a first stop");
});

/** Runs the compiled hook the way Claude Code does: argv + JSON on stdin. */
function runHook(argv, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/agents/claude-stop-hook.js", import.meta.url)), ...argv], { stdio: ["pipe", "pipe", "pipe"], env: GIT_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("the compiled Stop hook: a block decision on stdout, exit 0 always", async () => {
  const { base, origin } = originAndClone();
  const clone = path.join(base, "clone");
  execFileSync("git", ["clone", origin, clone], { env: GIT_ENV, stdio: "ignore" });
  writeFileSync(path.join(clone, "w.txt"), "w\n");
  const attachment = claudeHookAttachment({ stop: { checks: ["unpushed"], repos: ["."] } }, { root: clone, source: "dev.toml" });
  const encoded = /'([A-Za-z0-9_-]+)'$/.exec(attachment.settings.hooks.Stop[0].hooks[0].command)[1];
  const input = JSON.stringify({ session_id: "s", transcript_path: "/t", cwd: clone, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "done" });

  const blocked = await runHook([encoded], input);
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");

  const again = await runHook([encoded], JSON.stringify({ hook_event_name: "Stop", stop_hook_active: true }));
  assert.deepEqual([again.status, again.stdout], [0, ""]);

  // Input cut short mid-JSON: the hook cannot see stop_hook_active, so it must not block.
  for (const [argv, stdin] of [[[], input], [["not-base64-json"], input], [[encoded], "not json"], [[encoded], input.slice(0, 40)]]) {
    const r = await runHook(argv, stdin);
    assert.deepEqual([r.status, r.stdout], [0, ""], `${argv} / ${stdin.slice(0, 20)} must neither fail nor block the turn`);
  }
  // No input at all still reads as a first stop.
  const empty = await runHook([encoded], "");
  assert.equal(JSON.parse(empty.stdout).decision, "block");
});

test("hookInput: empty is a first stop, unreadable is unknown", () => {
  assert.equal(hookInput(""), undefined);
  assert.equal(hookInput("  \n"), undefined);
  assert.deepEqual(hookInput('{"stop_hook_active":true}'), { stop_hook_active: true });
  assert.equal(hookInput('{"stop_hook_active":tr'), null);
  assert.equal(hookInput("[1]"), null);
  assert.equal(hookInput("null"), null);
});

test("expandRepos: symlinks never lead outside the root", async () => {
  const root = tmp("ditto-hooks-root-");
  const outside = tmp("ditto-hooks-outside-");
  mkdirSync(path.join(outside, "repo", ".git"), { recursive: true });
  mkdirSync(path.join(outside, ".git"));
  mkdirSync(path.join(root, "real", "repo", ".git"), { recursive: true });
  symlinkSync(outside, path.join(root, "out"));
  symlinkSync(path.join(root, "real"), path.join(root, "alias"));
  const rel = async (patterns) => (await expandRepos(root, patterns)).map((r) => path.relative(root, r));
  assert.deepEqual(await rel(["out", "out/repo"]), [], "a link out of the root is refused");
  assert.deepEqual(await rel(["alias/repo"]), [path.join("alias", "repo")], "a link that stays inside is fine");
  assert.deepEqual(await rel(["real/*"]), [path.join("real", "repo")]);
});

test("expandRepos: stops at 64 repositories, even across patterns", async () => {
  const root = tmp("ditto-hooks-cap-");
  for (let i = 0; i < 70; i += 1) mkdirSync(path.join(root, "a", `r${String(i).padStart(2, "0")}`, ".git"), { recursive: true });
  mkdirSync(path.join(root, "b", "late", ".git"), { recursive: true });
  const found = await expandRepos(root, ["a/*", "b/*"]);
  assert.equal(found.length, 64);
  assert.ok(found.every((r) => r.includes(`${path.sep}a${path.sep}`)), "a later pattern adds nothing once the cap is reached");
});

test("stopFindings: one shared budget bounds every git call", async () => {
  const root = tmp("ditto-hooks-budget-");
  for (const r of ["r1", "r2", "r3", "r4"]) mkdirSync(path.join(root, r, ".git"), { recursive: true });
  const timeouts = [];
  // A git that is always slow: each call takes its whole timeout and answers dirty.
  const slow = (cwd, args, timeoutMs) => {
    timeouts.push(timeoutMs);
    return new Promise((resolve) => setTimeout(() => resolve(args[0] === "status" ? " M f\n" : undefined), Math.min(timeoutMs, 80)));
  };
  const started = Date.now();
  const findings = await stopFindings({ root, checks: ["unpushed"], repos: ["*"], source: "s" }, slow, 200);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 600, `finished in ${elapsed} ms`);
  assert.ok(findings.length >= 1 && findings.length < 4, `checked ${findings.length} of 4 before the budget ran out`);
  assert.ok(timeouts.every((t) => t <= 200), "no call is given more than what is left");
});
