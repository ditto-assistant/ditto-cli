import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { planClaude } from "../dist/agents/claude.js";
import { planCodex, tomlString } from "../dist/agents/codex.js";
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
    ...env,
  };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env: childEnvFor(env) });
}

/** Async variant for tests that host the stub API in this process (spawnSync would block it). */
function runAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: childEnvFor(env), stdio: ["ignore", "pipe", "pipe"] });
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

test("a real launch mints a 1mo key, revokes it on exit and prints a copyable resume line", async () => {
  const stub = await startStub();
  const claude = fakeClaude();
  try {
    const result = await runAsync(
      ["claude", "--endpoint", "alpha", "--session", "sess-copy"],
      claude.env({ DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", NO_COLOR: "1" }),
    );
    assert.equal(result.status, 0, result.stderr);
    const post = stub.calls.find((c) => c.method === "POST" && /\/keys$/.test(c.url));
    assert.ok(post, "a key was minted");
    assert.equal(JSON.parse(post.body).expiresIn, "1mo");
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && /\/keys\/key-1$/.test(c.url)), "the key was revoked on exit");
    assert.match(readFileSync(claude.log, "utf8"), /--session-id\nsess-copy/);
    // The resume command sits alone on its own line so it can be copied whole.
    assert.match(result.stderr, /^  heyditto claude --resume sess-copy$/m);
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

test("--dry-run codex defaults the model to the endpoint slug and uses -c overrides", async () => {
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
    assert.equal(plan.args[plan.args.indexOf("-m") + 1], "beta");
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
  const env = { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: configDir };
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
    assert.equal(JSON.parse(present.stdout).cwd, goneWorktree);
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
