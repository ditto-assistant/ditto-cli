import assert from "node:assert/strict";
import test from "node:test";

import { MCP_KEY_ENV, TOOL_SURFACE_HEADER, claudeMcpAttachment } from "../dist/agents/claude-mcp.js";
import { codexMcpArgs, planCodex } from "../dist/agents/codex.js";
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
    { name: "empty", url: "https://router.test/v1/mcp/empty", tools: [] },
  ],
});

const base = { baseUrl: "https://inference.heyditto.ai/v1", apiKey: "inf-key", sessionId: "sess-1", passthrough: [], env: {} };

test("codexMcpArgs: one -c override per server that turns it on, with the key only as a variable name", () => {
  const args = codexMcpArgs(claudeMcpAttachment(catalog(false), "sess-1"));
  assert.deepEqual(args, [
    "-c",
    `mcp_servers.ditto={enabled=true,url="https://router.test/v1/mcp/ditto",bearer_token_env_var="${MCP_KEY_ENV}",http_headers={"X-Ditto-Session-Id"="sess-1"},default_tools_approval_mode="approve"}`,
    "-c",
    `mcp_servers.ditto-github={enabled=true,url="https://router.test/v1/mcp/github",bearer_token_env_var="${MCP_KEY_ENV}",http_headers={"X-Ditto-Session-Id"="sess-1"},default_tools_approval_mode="approve"}`,
  ], "Ditto holds gated calls, so Codex is not asked twice; a source with no tools is not attached");
  assert.ok(args.every((a) => !a.includes("inf-key")));
});

test("codexMcpArgs: client approvals prompt for exactly what Ditto would hold, and --yolo prompts for nothing", () => {
  const asked = codexMcpArgs(claudeMcpAttachment(catalog(true), "sess-1"));
  assert.ok(asked[3].endsWith(`default_tools_approval_mode="approve",tools={"delete_repo"={"approval_mode"="prompt"}}}`), asked[3]);
  assert.ok(!asked[1].includes("tools={"), "a server with no gated tools prompts for nothing");
  const yolo = codexMcpArgs(claudeMcpAttachment(catalog(true), "sess-1", { yolo: true }));
  assert.ok(yolo.every((a) => !a.includes("prompt")));
});

test("an unsafe server name is left out of the attachment for every harness, and reported", () => {
  const cat = catalog(false);
  cat.servers.push({ name: "evil.model_provider", url: "https://router.test/v1/mcp/x", tools: [{ name: "t", tier: "read", approval: false }] });
  const mcp = claudeMcpAttachment(cat, "s");
  assert.deepEqual(mcp.skipped, ["evil.model_provider"]);
  assert.equal(mcp.servers, 2, "counts describe only what is attached");
  assert.equal(mcp.tools, 3);
  assert.ok(!mcp.config.includes("evil") && !mcp.allow.some((r) => r.includes("evil")));
  const args = codexMcpArgs(mcp);
  assert.equal(args.length, mcp.attached.length * 2, "Codex renders every attached server");
  assert.ok(args.every((a) => !a.includes("evil")));
});

test("planCodex: native MCP attaches the servers, passes the key by env and tells the router", () => {
  const mcp = claudeMcpAttachment(catalog(false), "sess-1");
  const plan = planCodex({ ...base, mcp, mcpApiKey: "mcp-key", prompt: "hi" });
  assert.ok(plan.args.some((a) => a.startsWith("mcp_servers.ditto={")));
  const headers = plan.args.find((a) => a.startsWith("model_providers.ditto.http_headers="));
  assert.ok(headers.includes(`"${TOOL_SURFACE_HEADER}"="mcp"`), headers);
  assert.equal(plan.envSet[MCP_KEY_ENV], "mcp-key");
  assert.equal(plan.args.at(-1), "hi", "the prompt stays the trailing argument");
  assert.ok(plan.args.every((a) => !a.includes("mcp-key")), "the key never lands in argv");

  const router = planCodex({ ...base, prompt: "hi" });
  assert.ok(router.args.every((a) => !a.startsWith("mcp_servers.")));
  assert.ok(!router.args.find((a) => a.startsWith("model_providers.ditto.http_headers=")).includes(TOOL_SURFACE_HEADER));
  assert.equal(router.envSet[MCP_KEY_ENV], undefined);
});

test("wantsMcp: Codex follows --mcp, then codex_tool_surface, then native MCP", () => {
  assert.equal(wantsMcp({}, {}, "codex"), true);
  assert.equal(wantsMcp({}, { providerOptions: { codex_tool_surface: "router" } }, "codex"), false);
  assert.equal(wantsMcp({}, { providerOptions: { claude_tool_surface: "router" } }, "codex"), true, "Claude's option does not decide for Codex");
  assert.equal(wantsMcp({ mcp: false }, {}, "codex"), false);
  assert.equal(wantsMcp({ mcp: true }, { providerOptions: { codex_tool_surface: "router" } }, "codex"), true);
});
