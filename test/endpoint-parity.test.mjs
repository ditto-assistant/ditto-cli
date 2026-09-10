import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ENDPOINT = { id: "1", slug: "alpha", name: "Alpha", model: "openai/gpt-5.6-luna", status: "active" };

function startStub(endpoint = ENDPOINT) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      const json = (s, p) => { res.statusCode = s; res.end(p === undefined ? "" : JSON.stringify(p)); };
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints: [endpoint] });
      }
      if (/^\/api\/v5\/inference\/endpoints\/[^/]+$/.test(req.url) && req.method === "PATCH") {
        return json(200, { ...endpoint, ...JSON.parse(body) });
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`, calls,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

function run(base, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: base,
      DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-parity-")) },
  });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const patchOf = (stub) => stub.calls.find((c) => c.method === "PATCH")?.body;

test("every dashboard setting is reachable from one set call", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha",
      "--stream-granularity", "full", "--model-mode", "passthrough", "--billing-mode", "byok",
      "--routing-mode", "fast", "--context-compaction", "aggressive", "--result-compression", "grouped",
      "--max-tool-rounds", "12", "--precompact-at", "120000", "--trace-retention", "30",
      "--batch", "on", "--batch-max-requests", "500", "--tool-compression", "on",
      "--record-attachments", "on", "--tools", "search_memories,fetch_memories"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub), {
      streamGranularity: "full", modelMode: "passthrough", billingMode: "byok",
      routingMode: "fast", contextCompaction: "aggressive", resultCompression: "grouped",
      maxToolRounds: 12, precompactAtTokens: 120000, traceRetentionDays: 30,
      batchEnabled: true, batchMaxRequests: 500, toolCompression: true,
      recordAttachments: true, tools: ["search_memories", "fetch_memories"],
    });
  } finally { stub.close(); }
});

test("repeatable maps replace the whole set, and none clears it", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha",
      "--alias", "fast=z-ai/glm-5.3-flash", "--alias", "smart=anthropic/claude-opus-5",
      "--model-route", "gpt-5=openai/gpt-5.6-luna", "--kind-route", "aside=z-ai/glm-5.3-flash"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub), {
      aliases: { fast: "z-ai/glm-5.3-flash", smart: "anthropic/claude-opus-5" },
      modelRoutes: { "gpt-5": "openai/gpt-5.6-luna" },
      kindRoutes: { aside: "z-ai/glm-5.3-flash" },
    });
  } finally { stub.close(); }

  const clear = await startStub();
  try {
    const out = await run(clear.base, ["endpoints", "set", "alpha", "--alias", "none"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(clear), { aliases: {} });
  } finally { clear.close(); }
});

test("--tools none clears the server toolset", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--tools", "none"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub), { tools: [] });
  } finally { stub.close(); }
});

test("invalid values are rejected before anything is written", async () => {
  for (const args of [
    ["--routing-mode", "cheapest"],
    ["--context-compaction", "max"],
    ["--stream-granularity", "verbose"],
    ["--max-tool-rounds", "-1"],
    ["--trace-retention", "abc"],
    ["--alias", "missing-equals"],
    ["--model-route", "=novalue"],
  ]) {
    const stub = await startStub();
    try {
      const out = await run(stub.base, ["endpoints", "set", "alpha", ...args]);
      assert.notEqual(out.status, 0, `${args.join(" ")} should fail`);
      assert.equal(stub.calls.some((c) => c.method === "PATCH"), false, `${args.join(" ")} must not write`);
    } finally { stub.close(); }
  }
});

test("endpoints show reports the routing and context settings", async () => {
  const stub = await startStub({
    ...ENDPOINT, routingMode: "fast", billingMode: "byok", streamGranularity: "full",
    contextCompaction: "aggressive", resultCompression: "grouped", toolCompression: true,
    maxToolRounds: 12, precompactAtTokens: 120000, traceRetentionDays: 0,
    batchEnabled: true, batchMaxRequests: 500,
    aliases: { fast: "z-ai/glm-5.3-flash" },
  });
  try {
    const out = await run(stub.base, ["endpoints", "show", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /routing:\s+fast, billing byok, stream full/);
    assert.match(out.stdout, /context:\s+compaction aggressive, results grouped, tool descriptions compressed/);
    assert.match(out.stdout, /tool rounds:\s+12/);
    assert.match(out.stdout, /trace keep:\s+forever/);
    assert.match(out.stdout, /batch:\s+on \(max 500 per batch\)/);
    assert.match(out.stdout, /aliases:\s+fast → z-ai\/glm-5\.3-flash/);
  } finally { stub.close(); }
});
