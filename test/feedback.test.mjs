import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function run(args, base, dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: {
      ...process.env, DITTO_API_BASE: base, DITTO_API_KEY: "ditto_mcp_test",
      DITTO_CONFIG_DIR: dir, DITTO_SESSION_ID: "feedback-test-session", DITTO_CLI_AUTO_UPDATE: "0",
    }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => stdout += b);
    child.stderr.on("data", b => stderr += b);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("feedback forwards an explicit trace choice and fails on tool errors", async () => {
  const calls = [];
  let fail = false;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", b => body += b);
    req.on("end", () => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const msg = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (msg.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
          protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" },
        }}));
      } else if (msg.method === "tools/call") {
        calls.push({ params: msg.params, session: req.headers["x-ditto-session-id"] });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: fail ? "disabled" : '{"status":"submitted"}' }], isError: fail,
        }}));
      } else { res.writeHead(202).end(); }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "ditto-feedback-"));
  try {
    let result = await run(["feedback", "Broken search", "--title", "Search", "--tool", "search_memories", "--output", "json"], base, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls[0].params.name, "submit_feedback");
    assert.deepEqual(calls[0].params.arguments, { title: "Search", report: "Broken search", tool_name: "search_memories", include_recent_traces: false });
    assert.equal(calls[0].session, "feedback-test-session");
    const reportFile = path.join(dir, "report.txt");
    writeFileSync(reportFile, "Missing feature\nDetails");
    result = await run(["feedback", "--file", reportFile, "--title", "Feature", "--include-recent-traces"], base, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(calls[1].params.arguments.report, "Missing feature\nDetails");
    assert.equal(calls[1].params.arguments.include_recent_traces, true);
    fail = true;
    result = await run(["feedback", "test", "--title", "t"], base, dir);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /disabled/);
    result = await run(["feedback", "text", "--file", reportFile, "--title", "t"], base, dir);
    assert.notEqual(result.code, 0);
    assert.equal(calls.length, 3);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
