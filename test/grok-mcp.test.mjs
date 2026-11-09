import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MCP_KEY_ENV, TOOL_SURFACE_HEADER, claudeMcpAttachment } from "../dist/agents/claude-mcp.js";
import { ensureGrokHome, grokMcpConfig, grokModelConfig, planGrok } from "../dist/agents/grok.js";
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

test("grokMcpConfig: one [mcp_servers] table per server, the key only as a variable name, Ditto's gate not doubled", () => {
  const toml = grokMcpConfig(claudeMcpAttachment(catalog(false), "sess-1"));
  assert.match(toml, /\[mcp_servers\."ditto-github"\]\nurl = "https:\/\/router\.test\/v1\/mcp\/github"\nbearer_token_env_var = "DITTO_ROUTER_MCP_KEY"\nenabled = true\nheaders = \{ "X-Ditto-Session-Id" = "sess-1" \}/);
  assert.match(toml, /\[permission\]\nallow = \["MCPTool\(ditto__\*\)","MCPTool\(ditto-github__\*\)"\]$/);
  assert.ok(!toml.includes("ask ="), "Ditto holds gated calls, so grok asks about nothing");
});

test("grokMcpConfig: client approvals ask for exactly the gated tools, and --yolo asks for nothing", () => {
  assert.match(grokMcpConfig(claudeMcpAttachment(catalog(true), "s")), /\nask = \["MCPTool\(ditto-github__delete_repo\)"\]$/);
  assert.ok(!grokMcpConfig(claudeMcpAttachment(catalog(true), "s", { yolo: true })).includes("ask ="));
});

test("grokMcpConfig: an unattended run (always-approve) denies the gated tools instead of asking", () => {
  const mcp = claudeMcpAttachment(catalog(true), "s");
  const toml = grokMcpConfig(mcp, true);
  assert.match(toml, /\ndeny = \["MCPTool\(ditto-github__delete_repo\)"\]$/);
  assert.ok(!toml.includes("ask ="));
  assert.ok(!grokMcpConfig(claudeMcpAttachment(catalog(true), "s", { yolo: true }), true).includes("deny ="), "--yolo chose to run them");
});

test("ensureGrokHome denies gated tools for a -p launch", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-"));
  const home = await ensureGrokHome(dir, "s", { ...base, prompt: "hi", mcp: claudeMcpAttachment(catalog(true), "s") });
  assert.match(readFileSync(path.join(home, "config.toml"), "utf8"), /\ndeny = \["MCPTool\(ditto-github__delete_repo\)"\]/);
  assert.ok(planGrok({ ...base, prompt: "hi" }, home).args.includes("--always-approve"), "the reason: -p runs always-approve");
});

test("grokModelConfig tells the router the tools are attached only when they are", () => {
  const mcp = claudeMcpAttachment(catalog(false), "s");
  assert.ok(grokModelConfig({ ...base, mcp }).includes(`extra_headers = { "${TOOL_SURFACE_HEADER}" = "mcp" }`));
  assert.ok(!grokModelConfig(base).includes(TOOL_SURFACE_HEADER));
});

test("planGrok sets the env_key the model config names, so inference carries the endpoint key", () => {
  const plan = planGrok(base, "/tmp/grok-home");
  assert.match(grokModelConfig(base), /env_key = "DITTO_INFERENCE_API_KEY"/);
  assert.equal(plan.envSet.DITTO_INFERENCE_API_KEY, "inf-key");
});

test("planGrok passes the MCP key by env, never argv", () => {
  const mcp = claudeMcpAttachment(catalog(false), "s");
  const plan = planGrok({ ...base, mcp, mcpApiKey: "mcp-key" }, "/tmp/grok-home");
  assert.equal(plan.envSet[MCP_KEY_ENV], "mcp-key");
  assert.ok(plan.args.every((a) => !a.includes("mcp-key")));
  assert.equal(planGrok(base, "/tmp/grok-home").envSet[MCP_KEY_ENV], undefined);
});

test("ensureGrokHome writes the servers at launch, and a hook refresh keeps them and the model", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grok-mcp-"));
  const mcp = claudeMcpAttachment(catalog(false), "s");
  const home = await ensureGrokHome(dir, "sess-1", { ...base, model: "grok-9", mcp });
  const written = readFileSync(path.join(home, "config.toml"), "utf8");
  assert.ok(written.includes('[mcp_servers."ditto"]') && written.includes('model = "grok-9"'));
  assert.ok(!written.includes("inf-key"), "no key on disk");
  const hookScript = path.join(dir, "hook.mjs");
  writeFileSync(hookScript, "");
  await ensureGrokHome(dir, "sess-1", undefined, { socketPath: "/tmp/s.sock", scriptPath: hookScript, nodePath: process.execPath });
  assert.equal(readFileSync(path.join(home, "config.toml"), "utf8"), written, "a hook refresh does not rewrite config.toml");
  assert.ok(readFileSync(path.join(home, "hooks", "ditto.json"), "utf8").includes("/tmp/s.sock"));
});

test("wantsMcp: grok follows --mcp, then grok_tool_surface, then native MCP", () => {
  assert.equal(wantsMcp({}, {}, "grok"), true);
  assert.equal(wantsMcp({}, { providerOptions: { grok_tool_surface: "router" } }, "grok"), false);
  assert.equal(wantsMcp({ mcp: false }, {}, "grok"), false);
});
