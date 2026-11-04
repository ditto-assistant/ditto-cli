import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../scripts/claude-router-launcher.sh", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ditto t3 launcher "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeClaude = path.join(root, "claude");
  const fakeHeyditto = path.join(root, "heyditto");
  const capture = path.join(root, "capture.json");
  const claudeCapture = path.join(root, "claude-capture.json");
  const calls = path.join(root, "calls.jsonl");
  const interpreter = `#!${process.execPath}\n`;
  writeFileSync(fakeClaude, interpreter + `import { writeFileSync } from "node:fs"; writeFileSync(process.env.T3_TEST_CLAUDE_CAPTURE, JSON.stringify(process.argv.slice(2))); process.stdout.write("2.1.318 (Claude Code)\\n");\n`);
  writeFileSync(fakeHeyditto, interpreter + `
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.T3_TEST_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "claude" && args[1] === "--help") {
  if (process.env.T3_TEST_HELP_ERROR === "1") process.exit(9);
  process.stdout.write(process.env.T3_TEST_OLD === "1" ? "--mcp-only\\n" : process.env.T3_TEST_NO_CLIPROXY === "1" ? "--no-mcp-only --no-mcp --no-remote-control\\n" : "--no-mcp-only --no-mcp --mcp --cliproxy [url] --no-remote-control\\n");
  process.exit(0);
}
const names = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CONFIG_DIR", "PATH"];
writeFileSync(process.env.T3_TEST_CAPTURE, JSON.stringify({ args, env: Object.fromEntries(names.map(n => [n, process.env[n] ?? null])) }));
process.stdin.pipe(process.stdout);
process.stdin.on("end", () => { process.exitCode = Number(process.env.T3_TEST_EXIT ?? "0"); });
`);
  chmodSync(fakeClaude, 0o700);
  chmodSync(fakeHeyditto, 0o700);
  const env = {
    ...process.env,
    DITTO_T3_HEYDITTO_BIN: fakeHeyditto,
    DITTO_T3_CLAUDE_BIN: fakeClaude,
    DITTO_T3_ENDPOINT: "",
    DITTO_T3_INFERENCE: "router",
    T3_TEST_CAPTURE: capture,
    T3_TEST_CLAUDE_CAPTURE: claudeCapture,
    T3_TEST_CALLS: calls,
    T3_TEST_OLD: "0",
    T3_TEST_NO_CLIPROXY: "0",
    T3_TEST_HELP_ERROR: "0",
    T3_TEST_EXIT: "0",
    ANTHROPIC_BASE_URL: "https://wrong.test",
    ANTHROPIC_AUTH_TOKEN: "test-native-secret",
    ANTHROPIC_API_KEY: "test-api-secret",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: test-header-secret",
    ANTHROPIC_MODEL: "wrong-model",
    CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-secret",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    CLAUDE_CONFIG_DIR: path.join(root, "isolated claude"),
  };
  return {
    root,
    env,
    capture: () => JSON.parse(readFileSync(capture, "utf8")),
    claudeArgs: () => JSON.parse(readFileSync(claudeCapture, "utf8")),
    calls: () => {
      try { return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
    run: (args, overrides = {}, input = "") => spawnSync("sh", [launcher, ...args], {
      env: { ...env, ...overrides }, input, encoding: "utf8", timeout: 10_000,
    }),
  };
}

test("T3 version probes run only Claude, including binary paths with spaces", (t) => {
  const f = fixture(t);
  for (const args of [["--version"], ["-v"], ["--version", "--output-format", "json"], ["--settings", "config with spaces.json", "-v"], ["--session-id", "valid-session", "--settings", "config with spaces.json", "--version"]]) {
    const result = f.run(args, { DITTO_T3_HEYDITTO_BIN: "/does/not/exist" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "2.1.318 (Claude Code)\n");
    assert.deepEqual(f.claudeArgs(), args);
  }
  assert.deepEqual(f.calls(), []);
});

test("version-like missing session values fail before either executable runs", (t) => {
  const f = fixture(t);
  for (const args of [["--session-id", "-v"], ["--session-id", "--version"], ["--version", "--session-id"], ["-v", "--session-id="]]) {
    const result = f.run(args, { DITTO_T3_HEYDITTO_BIN: "/does/not/exist" });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--session-id requires a value/);
  }
  assert.deepEqual(f.calls(), []);
  assert.throws(() => f.claudeArgs(), { code: "ENOENT" });
});

test("a version-like argument after the SDK separator does not bypass heyditto", (t) => {
  const f = fixture(t);
  const result = f.run(["--", "--version"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(f.calls(), [["claude", "--help"], ["claude", "--no-mcp-only", "--no-mcp", "--no-remote-control", "--", "--", "--version"]]);
});

test("T3 stream protocol and argv survive, with isolated auth and a shared fresh session id", (t) => {
  const f = fixture(t);
  const sdkArgs = ["--session-id", "session-1", "--input-format", "stream-json", "--output-format", "stream-json", "--model", "openai/gpt-6.1-sol", "--settings", '{"systemPrompt":"text with spaces"}'];
  const input = '{"type":"control_request","request_id":"r1"}\n';
  const result = f.run(sdkArgs, { DITTO_T3_ENDPOINT: "ditto-dev" }, input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
  const recorded = f.capture();
  assert.deepEqual(recorded.args, ["claude", "--endpoint", "ditto-dev", "--session", "session-1", "--no-mcp-only", "--no-mcp", "--no-remote-control", "--", ...sdkArgs]);
  assert.equal(recorded.env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
  for (const [name, value] of Object.entries(recorded.env)) {
    if (name !== "CLAUDE_CONFIG_DIR" && name !== "PATH") assert.equal(value, null, name);
  }
  assert.equal(recorded.env.PATH.split(path.delimiter)[0], f.root);
  assert.doesNotMatch(result.stdout + result.stderr, /test-(?:native|api|header|oauth)-secret/);
});

test("T3 session-id equals spelling maps to the trace id without requiring an endpoint", (t) => {
  const f = fixture(t);
  const result = f.run(["--session-id=session-2", "--print"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.capture().args, ["claude", "--session", "session-2", "--no-mcp-only", "--no-mcp", "--no-remote-control", "--", "--session-id=session-2", "--print"]);
});

test("T3 resume and continue remove SDK session-id flags without changing other argv", (t) => {
  const f = fixture(t);
  const other = ["--input-format", "stream-json", "--output-format", "stream-json", "--settings", '{"text":"spaces and \\"quotes\\""}', "", "literal * wildcard", "line one\nline two"];
  for (const resume of [["--resume", "session-1"], ["--resume=session-1"], ["-r", "session-1"], ["--continue"], ["-c"]]) {
    for (const session of [["--session-id", "session-1"], ["--session-id=session-1"]]) {
      for (const sdkArgs of [[...session, ...other, ...resume], [...resume, ...other, ...session]]) {
        const result = f.run(sdkArgs);
        assert.equal(result.status, 0, result.stderr);
        const preserved = sdkArgs.filter((arg, index) => !arg.startsWith("--session-id") && !(index > 0 && sdkArgs[index - 1] === "--session-id"));
        assert.deepEqual(f.capture().args, ["claude", "--no-mcp-only", "--no-mcp", "--no-remote-control", "--", ...preserved]);
      }
    }
  }
});

test("resume filtering preserves positional session-id text after the SDK separator", (t) => {
  const f = fixture(t);
  const sdkArgs = ["--session-id=ignored-fresh-id", "--resume", "existing-id", "--", "--session-id", "literal positional text"];
  const result = f.run(sdkArgs);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.capture().args, ["claude", "--no-mcp-only", "--no-mcp", "--no-remote-control", "--", "--resume", "existing-id", "--", "--session-id", "literal positional text"]);
});

test("an old or broken CLI fails before inference and never falls back to Claude", (t) => {
  const f = fixture(t);
  for (const overrides of [{ T3_TEST_OLD: "1" }, { T3_TEST_HELP_ERROR: "1" }]) {
    const before = f.calls().length;
    const result = f.run(["--print"], overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /ditto T3 launcher:/);
    assert.deepEqual(f.calls().slice(before), [["claude", "--help"]]);
  }
});

test("Router failure retains its exit status with no native-account fallback", (t) => {
  const f = fixture(t);
  const result = f.run(["--print"], { T3_TEST_EXIT: "23" });
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(f.calls(), [["claude", "--help"], ["claude", "--no-mcp-only", "--no-mcp", "--no-remote-control", "--", "--print"]]);
});

test("invalid binaries and missing session values fail with no inference launch", (t) => {
  const f = fixture(t);
  for (const overrides of [{ DITTO_T3_HEYDITTO_BIN: "/does/not/exist" }, { DITTO_T3_CLAUDE_BIN: "/does/not/exist" }]) {
    const result = f.run(["--print"], overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  }
  const invalidArgs = [["--session-id"], ["--session-id="], ["--session-id", ""], ["--session-id", "--resume", "abc"], ["--session-id", "--continue"], ["--session-id=-bad"]];
  for (const args of invalidArgs) {
    const result = f.run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--session-id requires a value/);
  }
  assert.deepEqual(f.calls(), [], "invalid session arguments fail before inspecting heyditto");
});

test("CLIProxy attaches endpoint MCP alongside SDK configuration and preserves protocol pipes", (t) => {
  const f = fixture(t);
  const sdkArgs = ["--session-id", "local-session", "--input-format", "stream-json", "--output-format", "stream-json", "--mcp-config", '{"mcpServers":{"t3":{"type":"sdk"}}}'];
  const input = '{"type":"control_request","request_id":"init"}\n';
  const result = f.run(sdkArgs, { DITTO_T3_INFERENCE: "cliproxy", DITTO_T3_ENDPOINT: "ditto-dev" }, input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
  assert.deepEqual(f.capture().args, ["claude", "--endpoint", "ditto-dev", "--session", "local-session", "--no-mcp-only", "--cliproxy", "--mcp", "--no-remote-control", "--", ...sdkArgs]);
  assert.equal(f.capture().env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
  assert.equal(f.capture().env.ANTHROPIC_AUTH_TOKEN, null);
});

test("CLIProxy resume keeps its inference mode without a fresh session selector", (t) => {
  const f = fixture(t);
  const result = f.run(["--session-id", "fresh-id", "--resume", "existing-id", "--print"], { DITTO_T3_INFERENCE: "cliproxy" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.capture().args, ["claude", "--no-mcp-only", "--cliproxy", "--mcp", "--no-remote-control", "--", "--resume", "existing-id", "--print"]);
});

test("CLIProxy requires its mode flags before any session starts", (t) => {
  const f = fixture(t);
  const result = f.run(["--print"], { DITTO_T3_INFERENCE: "cliproxy", T3_TEST_NO_CLIPROXY: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /heyditto lacks --mcp|heyditto lacks --cliproxy/);
  assert.deepEqual(f.calls(), [["claude", "--help"]]);
  assert.throws(() => f.capture(), { code: "ENOENT" });
});

test("unknown inference mode cannot silently choose Router or native inference", (t) => {
  const f = fixture(t);
  const result = f.run(["--print"], { DITTO_T3_INFERENCE: "clirproxy" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DITTO_T3_INFERENCE must be router or cliproxy/);
  assert.deepEqual(f.calls(), []);
});
