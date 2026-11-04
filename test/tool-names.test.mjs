import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The MCP server keeps the pre-rename tool and argument names as deprecated
// aliases (backend pkg/mcp/tool_aliases.go, DITTO-1014). The CLI must call the
// current names so it never shows up in the deprecation logs (DITTO-1220).
const LEGACY_TOOLS = new Set([
  "list_my_memories", "list_knowledge_graphs", "set_knowledge_graph_sharing",
  "subscribe_knowledge_graph", "unsubscribe_knowledge_graph",
  "list_knowledge_graph_subscriptions", "list_knowledge_graph_subscribers",
  "create_dedicated_graph",
]);
const LEGACY_ARGS = ["kg", "kgs", "kg_scope"];

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function run(args, base, dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: {
      ...process.env, DITTO_API_BASE: base, DITTO_API_KEY: "ditto_mcp_test",
      DITTO_CONFIG_DIR: dir, DITTO_CLI_AUTO_UPDATE: "0",
    }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => stdout += b);
    child.stderr.on("data", b => stderr += b);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("commands call current MCP tool and argument names", async () => {
  const calls = [];
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
        calls.push(msg.params);
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "{}" }] } }));
      } else { res.writeHead(202).end(); }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "ditto-tool-names-"));
  const cases = [
    [["knowledge-graphs"], "list_spaces"],
    [["graphs", "available"], "list_spaces"],
    [["my-memories", "--limit", "3"], "list_memories"],
    [["graph-sharing", "--enable"], "set_space_sharing"],
    [["graphs", "sharing", "--disable"], "set_space_sharing"],
    [["graphs", "create", "Team", "notes"], "create_space"],
    [["graphs", "list"], "list_space_subscriptions"],
    [["graphs", "subscribers"], "list_space_subscribers"],
    [["graphs", "add", "@peyton"], "subscribe_to_space"],
    [["graphs", "remove", "@peyton"], "unsubscribe_from_space"],
    [["aggregate", "source", "--kg", "work"], "aggregate_memories", { space: "work" }],
    [["subject-edges", "subj-1", "--kg", "work"], "get_subject_edges", { space: "work" }],
    [["delete", "mem-1", "--confirm", "--kg", "work"], "delete_memory", { space: "work" }],
  ];
  try {
    for (const [args, tool, wantArgs] of cases) {
      const before = calls.length;
      const result = await run([...args, "--output", "json"], base, dir);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(calls.length, before + 1, `${args.join(" ")} made ${calls.length - before} calls`);
      const call = calls.at(-1);
      assert.equal(call.name, tool, args.join(" "));
      assert.ok(!LEGACY_TOOLS.has(call.name), `${args.join(" ")} called deprecated ${call.name}`);
      for (const legacy of LEGACY_ARGS) {
        assert.ok(!(legacy in (call.arguments ?? {})), `${args.join(" ")} sent deprecated argument ${legacy}`);
      }
      for (const [k, v] of Object.entries(wantArgs ?? {})) assert.equal(call.arguments[k], v, `${args.join(" ")} ${k}`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
