import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { liftResumeFlags, planClaude } from "../dist/agents/claude.js";
import { searchTranscripts } from "../dist/agents/claude-transcripts.js";
import { planCodex, tomlString } from "../dist/agents/codex.js";
import { GROK_MODEL_ID, GROK_SESSION_ENV, grokModelConfig, planGrok } from "../dist/agents/grok.js";
import { listEndpointsStubHandler } from "./helpers/stub-api.mjs";
import { apiRootOf, childEnv, stripSeparator } from "../dist/agents/types.js";
import { defaultWorktreeName, ensureGitignore, validWorktreeName } from "../dist/agents/worktree.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const ENDPOINTS = {
  baseUrl: "https://api.example.test/v1",
  endpoints: [
    { id: "11111111-1111-1111-1111-111111111111", slug: "alpha", name: "Alpha", model: "openai/gpt-5.6-luna", spendPeriod: "monthly", spendLimitTokens: 1000000, spentTokens: 25000, recordTrace: true },
    { id: "22222222-2222-2222-2222-222222222222", slug: "beta", name: "Beta", model: "anthropic/claude-sonnet-5", spendPeriod: "never", spendLimitTokens: null, spentTokens: 0, recordTrace: false },
  ],
  limit: 5,
  used: 2,
};

/** Tiny stand-in for the Ditto management API. */
function startStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        if (req.headers.authorization !== "Bearer ditto_mcp_test") {
          res.statusCode = 401;
          return res.end(JSON.stringify({ message: "unauthorized" }));
        }
        return res.end(JSON.stringify(ENDPOINTS));
      }
      if (/\/keys$/.test(req.url) && req.method === "POST") {
        res.statusCode = 201;
        return res.end(JSON.stringify({ id: "key-1", endpointId: "x", name: "n", keyHint: "ab12", key: "ditto_inf_secret_ab12" }));
      }
      if (/\/keys\/key-1$/.test(req.url) && req.method === "DELETE") {
        res.statusCode = 204;
        return res.end();
      }
      if (listEndpointsStubHandler(req, (status, payload) => {
        res.statusCode = status;
        res.end(JSON.stringify(payload));
      })) return;
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, calls, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

function childEnvFor(env) {
  // The launchers merge inherited harness env (e.g. ANTHROPIC_CUSTOM_HEADERS
  // when this test itself runs under a Ditto-launched Claude Code), so drop it.
  // Likewise the developer's color settings: each test opts into color explicitly.
  const { ANTHROPIC_CUSTOM_HEADERS: _headers, ANTHROPIC_API_KEY: _key, NO_COLOR: _nc, NODE_DISABLE_COLORS: _ndc, FORCE_COLOR: _fc, ...parent } = process.env;
  return {
    ...parent,
    DITTO_API_KEY: "",
    DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-agents-")),
    // Never read the developer's own Claude Code sessions.
    CLAUDE_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-claude-home-")),
    ...env,
  };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env: childEnvFor(env) });
}

/** Async variant for tests that host the stub API in this process (spawnSync would block it). */
function runAsync(args, env = {}, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: childEnvFor(env), cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("claude/codex/endpoints/sessions --help work without auth", () => {
  for (const cmd of ["claude", "codex", "endpoints", "sessions"]) {
    const result = run([cmd, "--help"]);
    assert.equal(result.status, 0, `${cmd} --help: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`Usage: heyditto ${cmd}`));
    assert.equal(result.stderr, "");
  }
  assert.match(run(["claude", "--help"]).stdout, /--plan/);
  assert.doesNotMatch(run(["codex", "--help"]).stdout, /--plan/);
  assert.match(run(["login", "--help"]).stdout, /device flow/);
});

test("sessions lists nothing in a fresh config dir", () => {
  const result = run(["sessions"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No coding-agent sessions yet/);
  assert.equal(run(["sessions", "--json"]).stdout.trim(), "[]");
});

test("claude without a key fails fast and mints nothing", () => {
  const result = run(["claude", "--dry-run", "--endpoint", "alpha"], { DITTO_API_BASE: "http://127.0.0.1:9" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Ditto API key configured/);
});

test("--dry-run claude resolves the endpoint and prints the plan (no key minted)", async () => {
  const stub = await startStub();
  try {
    const result = await runAsync(
      ["claude", "--dry-run", "--endpoint", "alpha", "--yellow", "--budget", "500000", "--session", "sess-1", "--", "--verbose"],
      { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test" },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.command, "claude");
    assert.deepEqual(plan.args, ["--permission-mode", "acceptEdits", "--session-id", "sess-1", "--verbose"]);
    assert.equal(plan.env.ANTHROPIC_BASE_URL, "https://api.example.test");
    assert.equal(plan.env.ANTHROPIC_AUTH_TOKEN, "<key>");
    assert.equal(plan.env.ANTHROPIC_CUSTOM_HEADERS, "X-Ditto-Session-Id: sess-1");
    assert.deepEqual(plan.unsetEnv, ["ANTHROPIC_API_KEY"]);
    assert.equal(plan.endpoint.slug, "alpha");
    assert.equal(plan.key.spendLimitTokens, 500000);
    assert.match(result.stderr, /endpoint=alpha/);
    assert.ok(stub.calls.every((c) => c.method === "GET"), "dry run must not POST keys");
  } finally {
    stub.close();
  }
});

test("launch keys default to a month-long safety expiry (revoked on exit anyway)", async () => {
  const stub = await startStub();
  try {
    const result = await runAsync(["claude", "--dry-run", "--endpoint", "alpha"], { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test" });
    assert.equal(result.status, 0, result.stderr);
    // A 1d default killed multi-day `--worktree` sessions with "401 this Ditto endpoint key has expired".
    assert.equal(JSON.parse(result.stdout).key.expiresIn, "1mo");
    assert.match(result.stderr, /expires=1mo \(revoked on exit\)/);
    const help = run(["claude", "--help"]);
    assert.match(help.stdout, /--expires <duration>[\s\S]*default: "1mo"/);
  } finally {
    stub.close();
  }
});

/** Writes a fake `claude` binary that records argv and exits 0. */
function fakeClaude() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-fake-claude-"));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FAKE_CLAUDE_LOG\"\nexit 0\n", { mode: 0o755 });
  const log = path.join(dir, "argv.log");
  return { log, env: (extra = {}) => ({ PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: log, ...extra }) };
}

/** Writes a Claude Code transcript the way Claude stores one under CLAUDE_CONFIG_DIR. */
function writeTranscript(claudeHome, cwd, id, { title, prompt = "hello there", entrypoint = "claude-desktop", recordedCwd = realpathSync(cwd) } = {}) {
  const dir = path.join(claudeHome, "projects", recordedCwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, cwd: recordedCwd, entrypoint, sessionId: id, gitBranch: "main" },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, cwd: recordedCwd, sessionId: id },
    { type: "last-prompt", lastPrompt: prompt, sessionId: id },
    ...(title ? [{ type: "custom-title", customTitle: title, sessionId: id }] : []),
  ];
  writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("a real launch mints a 1mo key, revokes it on exit and prints a copyable resume line", async () => {
  const stub = await startStub();
  const claude = fakeClaude();
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), "heyditto-claude-home-"));
  const id = "5a1b0e0c-7f39-4c47-9a53-1f0b8c2d9e10";
  // Claude writes the transcript on the first prompt; the fake binary does not.
  writeTranscript(claudeHome, process.cwd(), id);
  try {
    const result = await runAsync(
      ["claude", "--endpoint", "alpha", "--session", id],
      claude.env({ DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", NO_COLOR: "1", CLAUDE_CONFIG_DIR: claudeHome }),
    );
    assert.equal(result.status, 0, result.stderr);
    const post = stub.calls.find((c) => c.method === "POST" && /\/keys$/.test(c.url));
    assert.ok(post, "a key was minted");
    assert.equal(JSON.parse(post.body).expiresIn, "1mo");
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && /\/keys\/key-1$/.test(c.url)), "the key was revoked on exit");
    assert.match(readFileSync(claude.log, "utf8"), new RegExp(`--session-id\\n${id}`));
    // The resume command sits alone on its own line so it can be copied whole.
    assert.match(result.stderr, new RegExp(`^  heyditto claude --resume ${id}$`, "m"));
    assert.match(result.stderr, /revoked session key …ab12/);
    assert.doesNotMatch(result.stderr, /\u001b\[/, "NO_COLOR output carries no escape codes");
  } finally {
    stub.close();
  }
});

test("a headless -p launch skips the resume epilogue", async () => {
  const stub = await startStub();
  const claude = fakeClaude();
  try {
    const result = await runAsync(["claude", "--endpoint", "alpha", "-p", "say hi"], claude.env({ DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test" }));
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(claude.log, "utf8"), /-p\nsay hi/);
    assert.match(result.stderr, /revoked session key/);
    assert.doesNotMatch(result.stderr, /resume this session/);
  } finally {
    stub.close();
  }
});

test("FORCE_COLOR paints the launch banner even when stderr is a pipe", async () => {
  const stub = await startStub();
  try {
    const result = await runAsync(["claude", "--dry-run", "--endpoint", "alpha"], { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", FORCE_COLOR: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /\u001b\[/, "FORCE_COLOR turns colors on for a pipe");
    assert.match(result.stderr, /endpoint=(\u001b\[\d+m)*alpha/);
  } finally {
    stub.close();
  }
});

test("--dry-run codex passes the model through by default and uses -c overrides", async () => {
  const stub = await startStub();
  try {
    const result = await runAsync(["codex", "--dry-run", "-e", "beta", "--yolo", "-p", "say hi", "--json"], {
      DITTO_API_BASE: stub.base,
      DITTO_API_KEY: "ditto_mcp_test",
    });
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.command, "codex");
    assert.equal(plan.args[0], "exec");
    assert.ok(plan.args.includes('model_providers.ditto.wire_api="responses"'));
    assert.ok(plan.args.includes('model_providers.ditto.base_url="https://api.example.test/v1"'));
    assert.ok(plan.args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.deepEqual(plan.args.slice(-3), ["--skip-git-repo-check", "--json", "say hi"]);
    assert.ok(!plan.args.includes("-m"), "codex must not be pinned to the endpoint slug");
    assert.equal(plan.env.DITTO_INFERENCE_API_KEY, "<key>");
  } finally {
    stub.close();
  }
});

test("unknown endpoint slug is rejected with the available list", async () => {
  const stub = await startStub();
  try {
    const result = await runAsync(["claude", "--dry-run", "-e", "nope"], { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no endpoint named "nope". Available: alpha, beta/);
  } finally {
    stub.close();
  }
});

test("--resume falls back to the original directory when the worktree is gone", async () => {
  // Regression: `spawn claude ENOENT` when the recorded worktree had been
  // removed since the last launch (Node reports a missing cwd as ENOENT).
  const stub = await startStub();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-resume-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-repo-"));
  const goneWorktree = path.join(repoDir, ".worktrees", "claude-gone");
  const id = "09be41e4-5684-426a-a962-366c4fd6d6aa";
  mkdirSync(path.join(configDir, "sessions"), { recursive: true });
  const record = {
    id,
    harness: "claude",
    endpointId: ENDPOINTS.endpoints[0].id,
    endpointSlug: "alpha",
    harnessSessionId: id,
    cwd: repoDir,
    worktree: goneWorktree,
    createdAt: "2026-09-05T12:18:07.313Z",
    lastLaunchedAt: "2026-09-06T15:26:28.321Z",
    launches: 4,
  };
  writeFileSync(path.join(configDir, "sessions", `${id}.json`), JSON.stringify(record));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), "heyditto-claude-home-"));
  const canonicalWorktree = path.join(realpathSync(repoDir), ".worktrees", "claude-gone");
  writeTranscript(claudeHome, repoDir, id, { recordedCwd: canonicalWorktree });
  const env = { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: configDir, CLAUDE_CONFIG_DIR: claudeHome };
  try {
    const gone = await runAsync(["claude", "--dry-run", "--resume", id, "--yolo"], env);
    assert.equal(gone.status, 0, gone.stderr);
    const plan = JSON.parse(gone.stdout);
    assert.equal(plan.cwd, repoDir, "falls back to the directory the session started from");
    assert.deepEqual(plan.args, ["--dangerously-skip-permissions", "--resume", id]);
    assert.equal(plan.sessionId, id);
    assert.match(gone.stderr, /worktree .*claude-gone no longer exists; resuming in /);
    assert.match(gone.stderr, /--worktree <name> to recreate it/);

    // A worktree that still exists keeps being used.
    mkdirSync(goneWorktree, { recursive: true });
    const present = await runAsync(["claude", "--dry-run", "--resume", id], env);
    assert.equal(present.status, 0, present.stderr);
    assert.equal(JSON.parse(present.stdout).cwd, canonicalWorktree);
    assert.doesNotMatch(present.stderr, /no longer exists/);
  } finally {
    stub.close();
  }
});

test("endpoints lists and sets a default", async () => {
  const stub = await startStub();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-endpoints-"));
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ apiKey: "ditto_mcp_test", agentMode: true }));
  try {
    const env = { DITTO_API_BASE: stub.base, DITTO_CONFIG_DIR: configDir };
    const list = await runAsync(["endpoints"], env);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /alpha\s+openai\/gpt-5\.6-luna\s+25,000 \/ 1,000,000 monthly\s+traces/);
    assert.match(list.stdout, /beta\s+anthropic\/claude-sonnet-5\s+0 \/ ∞/);

    const set = await runAsync(["endpoints", "--set-default", "beta", "--output", "json"], env);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(JSON.parse(set.stdout).defaultEndpoint, "beta");
    const stored = JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8"));
    assert.equal(stored.defaultEndpoint, "beta");
    assert.equal(stored.agentMode, true, "merge must keep existing fields");

    // The default is honored when --endpoint is omitted.
    const plan = await runAsync(["codex", "--dry-run"], env);
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).endpoint.slug, "beta");
  } finally {
    stub.close();
  }
});

test("planClaude: resume, continue, model and header merging", () => {
  const base = { baseUrl: "https://api.heyditto.ai/v1", apiKey: "k", sessionId: "s1", passthrough: [], env: {} };
  assert.deepEqual(planClaude({ ...base, resumeId: "abc" }).args, ["--resume", "abc"]);
  assert.deepEqual(planClaude({ ...base, resumeLast: true, yolo: true }).args, ["--dangerously-skip-permissions", "--continue"]);
  const withModel = planClaude({ ...base, model: "opus", prompt: "hi", plan: true });
  assert.deepEqual(withModel.args, ["--permission-mode", "plan", "--session-id", "s1", "--model", "opus", "-p", "hi"]);
  assert.equal(withModel.envSet.ANTHROPIC_MODEL, "opus");
  const merged = planClaude({ ...base, env: { ANTHROPIC_CUSTOM_HEADERS: "X-Team: a" } });
  assert.equal(merged.envSet.ANTHROPIC_CUSTOM_HEADERS, "X-Team: a\nX-Ditto-Session-Id: s1");
  assert.equal(childEnv(merged, { ANTHROPIC_API_KEY: "old", HOME: "/h" }).ANTHROPIC_API_KEY, undefined);
});

test("planCodex: resume forms and header override", () => {
  const base = { baseUrl: "https://api.heyditto.ai/v1", apiKey: "k", sessionId: "s1", passthrough: ["--search"], env: {} };
  const resumeId = planCodex({ ...base, resumeId: "t1" });
  assert.equal(resumeId.args[0], "resume");
  assert.equal(resumeId.args.at(-1), "t1");
  const last = planCodex({ ...base, resumeLast: true, yellow: true });
  assert.deepEqual(last.args.slice(-6), ["-a", "on-request", "-s", "workspace-write", "--last", "--search"]);
  assert.ok(last.args.includes("--last"));
  assert.ok(last.args.includes('model_providers.ditto.http_headers={"X-Ditto-Session-Id"="s1"}'));
  assert.equal(tomlString('a"b'), '"a\\"b"');
});

test("helpers: separator, api root, worktree names", async () => {
  assert.deepEqual(stripSeparator(["--", "--a", "--", "b"]), ["--a", "--", "b"]);
  assert.deepEqual(stripSeparator(["x"]), ["x"]);
  assert.equal(apiRootOf("https://api.heyditto.ai/v1/"), "https://api.heyditto.ai");
  assert.equal(apiRootOf("http://localhost:3400"), "http://localhost:3400");
  assert.equal(defaultWorktreeName("claude", new Date(2026, 8, 4, 15, 7)), "claude-20260904-1507");
  assert.ok(validWorktreeName("feature/x-1"));
  assert.ok(!validWorktreeName("../escape"));
  assert.ok(!validWorktreeName("-bad"));

  const root = mkdtempSync(path.join(os.tmpdir(), "heyditto-wt-"));
  assert.equal(await ensureGitignore(root), true);
  assert.equal(await ensureGitignore(root), false);
  assert.match(readFileSync(path.join(root, ".gitignore"), "utf8"), /^\.worktrees\/$/m);
});

// A headless run that also asks to resume means "reopen this thread and run
// one turn in it", which codex spells `exec resume`. Emitting only `exec`
// silently started a fresh conversation: the agent answered "I don't know" to
// a question about its own earlier turn, and exited 0.
test("planCodex combines a headless prompt with resume", () => {
  const base = {
    baseUrl: "https://inference.heyditto.ai/v1",
    apiKey: "k",
    sessionId: "s1",
    passthrough: [],
  };

  const last = planCodex({ ...base, prompt: "recall", resumeLast: true });
  assert.equal(last.args[0], "exec");
  assert.equal(last.args[1], "resume", "resume must survive alongside a prompt");
  assert.equal(last.args.at(-1), "recall", "the prompt is the trailing argument");
  assert.ok(last.args.includes("--last"), "--last selects the most recent session");

  const byId = planCodex({ ...base, prompt: "recall", resumeId: "01a07bf3-b403-73a2-8602-abd9fd0dd5db" });
  assert.equal(byId.args[0], "exec");
  assert.equal(byId.args[1], "resume");
  // `exec resume [SESSION_ID] [PROMPT]` — the id comes before the prompt.
  assert.deepEqual(byId.args.slice(-2), ["01a07bf3-b403-73a2-8602-abd9fd0dd5db", "recall"]);
  assert.ok(!byId.args.includes("--last"), "an explicit id must not also pass --last");

  // The un-combined forms are unchanged.
  const promptOnly = planCodex({ ...base, prompt: "hi" });
  assert.equal(promptOnly.args[0], "exec");
  assert.ok(!promptOnly.args.includes("resume"));
  assert.equal(promptOnly.args.at(-1), "hi");

  const resumeOnly = planCodex({ ...base, resumeLast: true });
  assert.equal(resumeOnly.args[0], "resume");
  assert.ok(resumeOnly.args.includes("--last"));
});

// grok routes through a launch-scoped GROK_HOME: a signed-in ~/.grok/auth.json
// beats XAI_API_KEY for every request, which would send the user's xAI session
// token to the Ditto gateway. The plan must therefore point GROK_HOME at the
// prepared home (no auth.json) and pin the session id with -s.
test("planGrok: session pin, modes, prompt and env", () => {
  const home = "/cfg/grok-homes/s1";
  const base = { baseUrl: "https://api.heyditto.ai/v1", apiKey: "k", sessionId: "03a735a2-f328-4fbc-9fb4-5ecd3ef24132", passthrough: [], env: {} };

  const plain = planGrok(base, home);
  assert.deepEqual(plain.args, ["-s", "03a735a2-f328-4fbc-9fb4-5ecd3ef24132"]);
  assert.equal(plain.command, "grok");
  assert.equal(plain.envSet.GROK_HOME, home);
  assert.equal(plain.envSet.XAI_API_KEY, "k");
  assert.equal(plain.envSet[GROK_SESSION_ENV], base.sessionId);
  assert.equal(plain.envSet.GROK_MODELS_BASE_URL, "https://api.heyditto.ai/v1");
  assert.equal(plain.envSet.GROK_XAI_API_BASE_URL, "https://api.heyditto.ai");
  assert.equal(plain.envUnset.length, 0, "nothing needs removing: the launch home isolates auth");

  // A headless run cannot answer permission prompts, so it approves implicitly.
  const prompt = planGrok({ ...base, prompt: "hi", yolo: false }, home);
  assert.ok(prompt.args.includes("--always-approve"));
  assert.ok(prompt.args.includes("-p"));
  assert.equal(prompt.args.at(-1), "hi");

  const yolo = planGrok({ ...base, yolo: true }, home);
  assert.ok(yolo.args.includes("--always-approve"));
  assert.ok(!prompt.args.includes("--permission-mode"));

  const yellow = planGrok({ ...base, yellow: true }, home);
  assert.deepEqual(yellow.args.slice(-2), ["--permission-mode", "auto"]);

  // Non-UUID Ditto session ids cannot pin -s (grok requires UUIDs) but the
  // X-Ditto-Session-Id header still files the turns into the right thread.
  const nonUuid = planGrok({ ...base, sessionId: "team-session" }, home);
  assert.ok(!nonUuid.args.includes("-s"));
  assert.equal(nonUuid.envSet[GROK_SESSION_ENV], "team-session");

  const resume = planGrok({ ...base, resumeId: "01a0ad96-3c7b-7d42-99f5-22d756d3c5e2" }, home);
  assert.deepEqual(resume.args.slice(0, 2), ["--resume", "01a0ad96-3c7b-7d42-99f5-22d756d3c5e2"]);
  assert.ok(!resume.args.includes("-s"), "resume replaces the session pin");

  // Model ids pass through: grok's own grok-* ids normalize like Claude's.
  const withModel = planGrok({ ...base, model: "grok-4.5" }, home);
  assert.deepEqual(withModel.args.slice(-2), ["-m", "grok-4.5"]);
});

test("grokModelConfig: routes at the gateway without secrets on disk", () => {
  const input = { baseUrl: "https://api.heyditto.ai/v1", apiKey: "secret", sessionId: "s1", passthrough: [], env: {} };
  const toml = grokModelConfig(input);
  assert.match(toml, /\[model\.ditto\]/);
  assert.match(toml, new RegExp(`base_url = "https://api\\.heyditto\\.ai/v1"`));
  assert.match(toml, /env_key = "DITTO_INFERENCE_API_KEY"/);
  assert.match(toml, new RegExp(`env_http_headers = \\{ "X-Ditto-Session-Id" = "${GROK_SESSION_ENV}" \\}`));
  assert.match(toml, /\[models\]/);
  assert.match(toml, new RegExp(`default = "${GROK_MODEL_ID}"`));
  assert.ok(!toml.includes("secret"), "the endpoint key rides env_key by name, never its value");
  assert.ok(!toml.includes(input.apiKey));
});

// ---------------------------------------------------------------------------
// Resuming Claude Code sessions: by title, by Claude id, from `-- -r`, and
// sessions that never recorded a conversation.

test("a launch that sent nothing does not promise a resume that cannot work", async () => {
  // Regression: `heyditto claude` exited before the first prompt, printed
  // "resume this session with: heyditto claude --resume <id>", and that command
  // then failed with "No conversation found with session ID".
  const stub = await startStub();
  const claude = fakeClaude();
  try {
    const result = await runAsync(["claude", "--endpoint", "alpha"], claude.env({ DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", NO_COLOR: "1" }));
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /resume this session/);
    assert.match(result.stderr, /nothing was sent, so there is no conversation to resume/);
  } finally {
    stub.close();
  }
});

function resumeFixture() {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-resume-"));
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), "heyditto-claude-home-"));
  const project = mkdtempSync(path.join(os.tmpdir(), "heyditto-project-"));
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "heyditto-elsewhere-"));
  return { configDir, claudeHome, project, elsewhere };
}

test("--resume takes a Claude session title and runs where that session ran", async () => {
  const stub = await startStub();
  const f = resumeFixture();
  const id = "b8bc76fa-ec25-4948-ba7e-f2bf3c077233";
  writeTranscript(f.claudeHome, f.project, id, { title: "Ditto Review quality and UX" });
  writeTranscript(f.claudeHome, f.project, "11111111-2222-4333-8444-555555555555", { title: "Something else" });
  const env = { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: f.configDir, CLAUDE_CONFIG_DIR: f.claudeHome, NO_COLOR: "1" };
  try {
    // Exactly what `claude --resume` prints for a renamed session, run from another directory.
    const byTitle = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--yolo", "--resume", "Ditto Review quality and UX"], env, f.elsewhere);
    assert.equal(byTitle.status, 0, byTitle.stderr);
    const plan = JSON.parse(byTitle.stdout);
    assert.deepEqual(plan.args, ["--dangerously-skip-permissions", "--resume", id]);
    assert.equal(plan.cwd, realpathSync(f.project));
    assert.equal(plan.sessionId, id, "a session first seen here keeps its Claude id as the Ditto session id");
    assert.match(byTitle.stderr, /resuming in .*, where this session ran/);

    // Case-insensitive words from the title work too, and so does the bare Claude id.
    const byWords = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--resume", "review quality"], env, f.elsewhere);
    assert.deepEqual(JSON.parse(byWords.stdout).args, ["--resume", id]);
    const byId = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--resume", id], env, f.elsewhere);
    assert.deepEqual(JSON.parse(byId.stdout).args, ["--resume", id]);

    const none = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--resume", "no such title"], env, f.elsewhere);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no Claude Code session matches "no such title"/);
    assert.match(none.stderr, /--resume` with no value to pick from a list/);
    assert.doesNotMatch(none.stderr, /invalid session id/);
  } finally {
    stub.close();
  }
});

test("an ambiguous --resume lists the candidates when there is no terminal to pick in", async () => {
  const stub = await startStub();
  const f = resumeFixture();
  writeTranscript(f.claudeHome, f.project, "aaaaaaaa-0000-4000-8000-000000000001", { title: "Fix login bug" });
  writeTranscript(f.claudeHome, f.project, "aaaaaaaa-0000-4000-8000-000000000002", { title: "Login page redesign" });
  const env = { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: f.configDir, CLAUDE_CONFIG_DIR: f.claudeHome };
  try {
    const result = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--resume", "login"], env, f.project);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"login" matches 2 sessions; pass one id:/);
    assert.match(result.stderr, /aaaaaaaa-0000-4000-8000-000000000001 {2}Fix login bug/);
  } finally {
    stub.close();
  }
});

test("claude's own -r / --resume / -c after -- resume instead of clashing with --session-id", async () => {
  // Regression: `heyditto claude -- -r` ran `claude --session-id <id> -r` and
  // Claude refused: "--session-id can only be used with --continue or --resume
  // if --fork-session is also specified".
  const stub = await startStub();
  const f = resumeFixture();
  const older = "cccccccc-0000-4000-8000-000000000001";
  const newer = "cccccccc-0000-4000-8000-000000000002";
  writeTranscript(f.claudeHome, f.project, older, { title: "Older" });
  await new Promise((r) => setTimeout(r, 20));
  writeTranscript(f.claudeHome, f.project, newer, { title: "Newer" });
  const env = { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: f.configDir, CLAUDE_CONFIG_DIR: f.claudeHome };
  try {
    for (const tail of [["-r"], ["--resume"], ["-c"], ["--continue"]]) {
      const result = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--yolo", "--", ...tail], env, f.project);
      assert.equal(result.status, 0, `${tail}: ${result.stderr}`);
      const { args } = JSON.parse(result.stdout);
      assert.deepEqual(args, ["--dangerously-skip-permissions", "--resume", newer], `${tail.join(" ")} resumes the newest conversation here`);
      assert.ok(!args.includes("--session-id"));
    }
    const withTitle = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--", "-r", "Older", "--verbose"], env, f.project);
    assert.deepEqual(JSON.parse(withTitle.stdout).args, ["--resume", older, "--verbose"]);
    const eq = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--", `--resume=${older}`], env, f.project);
    assert.deepEqual(JSON.parse(eq.stdout).args, ["--resume", older]);
  } finally {
    stub.close();
  }
});

test("--resume of a session that never sent anything starts it fresh under the same id", async () => {
  const stub = await startStub();
  const f = resumeFixture();
  const id = "8202b237-c51e-4b30-8a6a-eeb1f67c8257";
  mkdirSync(path.join(f.configDir, "sessions"), { recursive: true });
  writeFileSync(
    path.join(f.configDir, "sessions", `${id}.json`),
    JSON.stringify({ id, harness: "claude", endpointId: ENDPOINTS.endpoints[0].id, endpointSlug: "alpha", harnessSessionId: id, cwd: f.project, createdAt: "2026-09-30T00:00:00Z", lastLaunchedAt: "2026-09-30T00:00:00Z", launches: 1 }),
  );
  const env = { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: f.configDir, CLAUDE_CONFIG_DIR: f.claudeHome };
  try {
    const result = await runAsync(["claude", "--dry-run", "--resume", id], env, f.elsewhere);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    // Not `--resume <id>`, which Claude answers with "No conversation found".
    assert.deepEqual(plan.args, ["--session-id", id]);
    assert.equal(plan.sessionId, id);
    assert.equal(plan.cwd, f.project);
    assert.match(result.stderr, /never recorded a conversation \(nothing was sent\), so it starts fresh under the same id/);

    // A bare --resume prefers a real conversation here over that empty launch.
    const real = "dddddddd-0000-4000-8000-000000000001";
    writeTranscript(f.claudeHome, f.project, real, { title: "Real work" });
    const bare = await runAsync(["claude", "--dry-run", "--endpoint", "alpha", "--resume"], env, f.project);
    assert.equal(bare.status, 0, bare.stderr);
    assert.deepEqual(JSON.parse(bare.stdout).args, ["--resume", real]);
  } finally {
    stub.close();
  }
});

test("liftResumeFlags pulls claude's resume flags out of the passthrough", () => {
  assert.deepEqual(liftResumeFlags(["-r"]), { args: [], resume: true });
  assert.deepEqual(liftResumeFlags(["--resume", "My title", "--verbose"]), { args: ["--verbose"], resume: "My title" });
  assert.deepEqual(liftResumeFlags(["--resume", "--verbose"]), { args: ["--verbose"], resume: true });
  assert.deepEqual(liftResumeFlags(["--resume=abc"]), { args: [], resume: "abc" });
  assert.deepEqual(liftResumeFlags(["-c", "--verbose"]), { args: ["--verbose"], continue: true });
  assert.deepEqual(liftResumeFlags(["--verbose"]), { args: ["--verbose"] });
});

test("planClaude leaves the session id to --from-pr or a forwarded --session-id", () => {
  const base = { baseUrl: "https://x/v1", apiKey: "k", sessionId: "s", env: {} };
  assert.deepEqual(planClaude({ ...base, passthrough: ["--from-pr", "12"] }).args, ["--from-pr", "12"]);
  assert.deepEqual(planClaude({ ...base, passthrough: ["--session-id", "u"] }).args, ["--session-id", "u"]);
  assert.deepEqual(planClaude({ ...base, passthrough: [] }).args, ["--session-id", "s"]);
});

test("searchTranscripts: exact title wins, then title words, then prompts; this directory first", () => {
  const t = (id, title, cwd, lastPrompt) => ({ id, title, cwd, lastPrompt, file: "", modifiedAt: new Date() });
  const all = [
    t("1", "Deploy notes", "/b", "review the deploy"),
    t("2", "Ditto Review quality and UX", "/b"),
    t("3", "ditto review quality and ux", "/a"),
    t("4", "Review queue", "/a"),
  ];
  assert.deepEqual(searchTranscripts(all, "DITTO REVIEW QUALITY AND UX", "/a").map((x) => x.id), ["3", "2"]);
  assert.deepEqual(searchTranscripts(all, "review", "/a").map((x) => x.id), ["3", "4", "2", "1"]);
  assert.deepEqual(searchTranscripts(all, "", "/a").length, 4);
});
