import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ENDPOINT = { id: "ep-1", slug: "alpha", name: "Alpha", model: "openai/gpt-5.6-luna", status: "active" };
const SESSION = {
  id: "sess-1", endpointId: "ep-1", harness: "codex", turnCount: 12, traceBytes: 2048,
  systemPromptHash: "abcdef0123456789", lastSeenAt: new Date().toISOString(),
};

function startStub({ tools, sessions = [SESSION], traces, prompt } = {}) {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const json = (s, p) => { res.statusCode = s; res.end(JSON.stringify(p)); };
    if (req.url === "/api/v5/inference/endpoints") return json(200, { baseUrl: "https://x/v1", endpoints: [ENDPOINT] });
    if (req.url === "/api/v5/inference/tools") return json(200, { tools: tools ?? [] });
    if (req.url === `/api/v5/inference/endpoints/${ENDPOINT.id}/sessions`) return json(200, { sessions });
    if (req.url === "/api/v5/inference/sessions/sess-1/traces") return json(200, { session: SESSION, traces: traces ?? [] });
    if (req.url === "/api/v5/inference/sessions/sess-1/system-prompt") {
      return json(200, { systemPrompt: prompt ?? "", hash: SESSION.systemPromptHash });
    }
    json(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); server.close(); },
  })));
}

function run(base, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: base,
      DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-obs-")) },
  });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("endpoints tools lists the catalogue and flags what is unavailable", async () => {
  const stub = await startStub({ tools: [
    { name: "search_memories", group: "memory", title: "Search memories", enabled: true },
    { name: "search_x", group: "search", title: "Search X", enabled: false },
  ] });
  try {
    const out = await run(stub.base, ["endpoints", "tools"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /search_memories\s+memory/);
    assert.match(out.stdout, /search_x\s+search\s+unavailable/);
    // The hint tells you how to act on what you just read.
    assert.match(out.stderr, /--tools search_memories/);
  } finally { stub.close(); }
});

test("endpoints sessions renders recorded sessions", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "sessions", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /sess-1\s+codex\s+12\s+2\.0 KB/);
    assert.match(out.stderr, /endpoints traces sess-1/);
  } finally { stub.close(); }
});

test("endpoints sessions says so plainly when there are none", async () => {
  const stub = await startStub({ sessions: [] });
  try {
    const out = await run(stub.base, ["endpoints", "sessions", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /no recorded sessions on alpha/);
  } finally { stub.close(); }
});

test("endpoints traces renders turns and points at the system prompt", async () => {
  const stub = await startStub({ traces: [
    { id: "t1", turnIndex: 1, kind: "chat", provider: "gm", model: "openai/gpt-5.6-luna",
      promptTokens: 100, completionTokens: 20, toolCalls: 2, finishReason: "stop" },
  ] });
  try {
    const out = await run(stub.base, ["endpoints", "traces", "sess-1"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /1\s+chat\s+gm\s+openai\/gpt-5\.6-luna\s+100→20\s+2\s+stop/);
    assert.match(out.stderr, /endpoints system-prompt sess-1/);
  } finally { stub.close(); }
});

test("endpoints traces explains an empty result rather than printing nothing", async () => {
  const stub = await startStub({ traces: [] });
  try {
    const out = await run(stub.base, ["endpoints", "traces", "sess-1"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /no traces recorded/);
    assert.match(out.stderr, /--record-trace on/);
  } finally { stub.close(); }
});

test("endpoints system-prompt prints the prompt to stdout and the metadata to stderr", async () => {
  const stub = await startStub({ prompt: "You are a coding agent.\nBe precise." });
  try {
    const out = await run(stub.base, ["endpoints", "system-prompt", "sess-1"]);
    assert.equal(out.status, 0, out.stderr);
    // stdout is the prompt alone, so it pipes cleanly into a diff.
    assert.equal(out.stdout, "You are a coding agent.\nBe precise.\n");
    assert.match(out.stderr, /hash abcdef012345/);
    assert.match(out.stderr, /35 chars/);
  } finally { stub.close(); }
});

test("--output json is machine-readable for every observability command", async () => {
  const stub = await startStub({
    tools: [{ name: "search_memories" }],
    traces: [{ id: "t1", turnIndex: 1 }],
    prompt: "P",
  });
  try {
    for (const [args, check] of [
      [["endpoints", "tools", "--output", "json"], (v) => assert.equal(v[0].name, "search_memories")],
      [["endpoints", "sessions", "alpha", "--output", "json"], (v) => assert.equal(v[0].id, "sess-1")],
      [["endpoints", "traces", "sess-1", "--output", "json"], (v) => assert.equal(v.traces[0].id, "t1")],
      [["endpoints", "system-prompt", "sess-1", "--output", "json"], (v) => assert.equal(v.systemPrompt, "P")],
    ]) {
      const out = await run(stub.base, args);
      assert.equal(out.status, 0, `${args.join(" ")}: ${out.stderr}`);
      check(JSON.parse(out.stdout));
    }
  } finally { stub.close(); }
});
