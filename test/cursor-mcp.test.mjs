import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MCP_KEY_ENV, claudeMcpAttachment } from "../dist/agents/claude-mcp.js";
import { packageVersion } from "../dist/config.js";
import { CURSOR_PLUGIN_NAME, cursorMcpConfig, planCursor, writeCursorPlugin } from "../dist/agents/cursor.js";
import { wantsMcp } from "../dist/agents/launch.js";

const catalog = (clientApprovals) => ({
  endpoint: "ditto-dev",
  approvalMode: "park",
  clientApprovals,
  servers: [
    { name: "ditto", url: "https://router.test/v1/mcp/ditto", tools: [{ name: "search_memories", tier: "read", approval: false }] },
    {
      name: "github",
      url: "https://router.test/v1/mcp/github",
      tools: [
        { name: "list_issues", tier: "read", approval: false },
        { name: "delete_repo", tier: "gated", approval: true },
      ],
    },
  ],
});

const base = { baseUrl: "https://inference.heyditto.ai/v1", apiKey: "inf-key", sessionId: "sess-1", passthrough: [], env: {} };

test("cursorMcpConfig: one url server per source, the key only as ${env:…}", () => {
  const config = JSON.parse(cursorMcpConfig(claudeMcpAttachment(catalog(false), "sess-1")));
  assert.deepEqual(Object.keys(config.mcpServers), ["ditto", "ditto-github"]);
  assert.deepEqual(config.mcpServers["ditto-github"], {
    url: "https://router.test/v1/mcp/github",
    headers: { Authorization: `Bearer \${env:${MCP_KEY_ENV}}`, "X-Ditto-Session-Id": "sess-1", "X-Heyditto-Client": `heyditto-cli/${packageVersion}` },
  });
});

test("cursorMcpConfig never adds a deny header of its own: Cursor asks, or --yolo runs", () => {
  const config = JSON.parse(cursorMcpConfig(claudeMcpAttachment(catalog(true), "s")));
  assert.equal(config.mcpServers.ditto.headers["X-Ditto-Tool-Deny"], undefined);
});

test("writeCursorPlugin: a private plugin directory named for the server prefix, no key on disk", () => {
  const dir = writeCursorPlugin(claudeMcpAttachment(catalog(false), "s"));
  assert.equal(path.basename(dir), CURSOR_PLUGIN_NAME);
  assert.equal(statSync(path.dirname(dir)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(readFileSync(path.join(dir, ".cursor-plugin", "plugin.json"), "utf8")).name, CURSOR_PLUGIN_NAME);
  assert.ok(existsSync(path.join(dir, ".mcp.json")));
  assert.ok(!readFileSync(path.join(dir, ".mcp.json"), "utf8").includes("inf-key"));
  assert.ok(dir.startsWith(os.tmpdir()));
});

test("planCursor: plugin, resume and permission forms; the key only in env", () => {
  const mcp = claudeMcpAttachment(catalog(false), "s");
  const plan = planCursor({ ...base, mcp, mcpApiKey: "mcp-key", passthrough: ["--browser"] }, "/tmp/p/ditto");
  assert.equal(plan.command, "cursor-agent");
  assert.deepEqual(plan.args, ["--plugin-dir", "/tmp/p/ditto", "--browser"]);
  assert.equal(plan.envSet[MCP_KEY_ENV], "mcp-key");
  assert.ok(plan.args.every((a) => !a.includes("mcp-key")));

  assert.deepEqual(planCursor({ ...base, resumeLast: true, model: "sonnet-5", plan: true }).args, ["--continue", "--model", "sonnet-5", "--plan"]);
  assert.deepEqual(planCursor({ ...base, resumeId: "chat-1", yolo: true }).args, ["--resume", "chat-1", "--force"]);
  assert.deepEqual(planCursor({ ...base, prompt: "hi" }).args, ["-p", "hi"], "-p adds no Cursor-wide --force or --trust of its own");
  assert.deepEqual(planCursor({ ...base, prompt: "hi", yolo: true }).args, ["--force", "-p", "hi"], "only an explicit --yolo forces");
  assert.deepEqual(planCursor({ ...base, prompt: "hi", passthrough: ["--output-format", "json"] }).args, ["-p", "hi", "--output-format", "json"], "the prompt follows -p");
  assert.throws(() => planCursor({ ...base, yellow: true }), /--yellow is not supported/);
  assert.deepEqual(planCursor(base).envSet, {}, "no tools, no MCP key");
});

test("wantsMcp: Cursor CLI follows --mcp, then cursor_tool_surface, then native MCP", () => {
  assert.equal(wantsMcp({}, {}, "cursor"), true);
  assert.equal(wantsMcp({ mcp: false }, {}, "cursor"), false);
});

test("a later launch sweeps a killed CLI's plugin directory, never a live one's", async () => {
  const { mkdtempSync, mkdirSync, utimesSync } = await import("node:fs");
  const { sweepStaleSettings } = await import("../dist/agents/claude-mcp.js");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cursor-sweep-"));
  const dead = path.join(tmp, "ditto-cursor-999991-abc");
  const live = path.join(tmp, "ditto-cursor-999992-abc");
  const other = path.join(tmp, "ditto-claude-settings-999991-abc");
  for (const d of [dead, live, other]) {
    mkdirSync(d);
    utimesSync(d, new Date(0), new Date(0));
  }
  sweepStaleSettings(tmp, (pid) => pid === 999992, Date.now(), "ditto-cursor-");
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(other), true, "only this prefix is swept");
});

test("createCursorChat returns the new chat's id, and nothing it cannot trust", async () => {
  const { createCursorChat } = await import("../dist/agents/cursor.js");
  const reply = (status, stdout) => () => ({ status, stdout });
  assert.equal(createCursorChat("/tmp", reply(0, "e4ff66b3-fd7f-4d9e-9601-860faed0d225\n")), "e4ff66b3-fd7f-4d9e-9601-860faed0d225");
  assert.equal(createCursorChat("/tmp", reply(1, "e4ff66b3-fd7f-4d9e-9601-860faed0d225\n")), undefined, "a failed run");
  assert.equal(createCursorChat("/tmp", reply(0, "Please log in\n")), undefined, "not an id");
  assert.equal(createCursorChat("/tmp", reply(null, undefined)), undefined, "timed out");
});
