import assert from "node:assert/strict";
import test from "node:test";

import { MCP_KEY_ENV, TOOL_SURFACE_HEADER, claudeMcpAttachment } from "../dist/agents/claude-mcp.js";
import { OPENCODE_KEY_ENV, opencodeConfig, opencodeMcp, planOpencode } from "../dist/agents/opencode.js";
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

const base = { baseUrl: "https://inference.heyditto.ai/v1", apiKey: "inf-key", sessionId: "sess-1", passthrough: [], env: {}, model: "ditto-dev" };

test("opencodeConfig: a Ditto provider on the endpoint, the key only as {env:…}, the session on every request", () => {
  const config = JSON.parse(opencodeConfig(base));
  assert.equal(config.model, "ditto/ditto-dev");
  assert.deepEqual(config.provider.ditto.options.baseURL, "https://inference.heyditto.ai/v1");
  assert.equal(config.provider.ditto.options.apiKey, `{env:${OPENCODE_KEY_ENV}}`);
  assert.equal(config.provider.ditto.options.headers["X-Ditto-Session-Id"], "sess-1");
  assert.equal(config.provider.ditto.options.headers[TOOL_SURFACE_HEADER], undefined, "no tools attached, the router keeps them");
  assert.equal(config.mcp, undefined);
  assert.ok(!JSON.stringify(config).includes("inf-key"));
});

test("opencodeConfig: local inference sends none of the Router's headers", () => {
  const config = JSON.parse(opencodeConfig({ ...base, localInference: true, mcp: claudeMcpAttachment(catalog(false), "s") }));
  assert.deepEqual(config.provider.ditto.options.headers, {});
});

test("opencodeConfig: native MCP attaches remote servers and tells the router", () => {
  const config = JSON.parse(opencodeConfig({ ...base, mcp: claudeMcpAttachment(catalog(false), "sess-1") }));
  assert.equal(config.provider.ditto.options.headers[TOOL_SURFACE_HEADER], "mcp");
  assert.deepEqual(config.mcp["ditto-github"], {
    type: "remote",
    url: "https://router.test/v1/mcp/github",
    enabled: true,
    oauth: false,
    headers: { Authorization: `Bearer {env:${MCP_KEY_ENV}}`, "X-Ditto-Session-Id": "sess-1" },
  });
  assert.deepEqual(config.permission, { "ditto_*": "allow", "ditto-github_*": "allow" }, "Ditto holds gated calls, so OpenCode asks about nothing");
});

test("opencodeMcp: under client approvals each server asks (denies when unattended) and allows only its listed ungated tools", () => {
  assert.deepEqual(opencodeMcp(claudeMcpAttachment(catalog(true), "s")).permission, {
    "ditto_*": "ask", "ditto-github_*": "ask", "ditto_search_memories": "allow", "ditto-github_list_issues": "allow",
  }, "a gated or later-advertised tool falls to ask");
  const unattended = opencodeMcp(claudeMcpAttachment(catalog(true), "s"), true).permission;
  assert.deepEqual(unattended, { "ditto_*": "deny", "ditto-github_*": "deny", "ditto_search_memories": "allow", "ditto-github_list_issues": "allow" });
  assert.deepEqual(Object.keys(unattended).slice(0, 2), ["ditto_*", "ditto-github_*"], "server-wide rules first, so the listed allows win");
  assert.deepEqual(opencodeMcp(claudeMcpAttachment(catalog(true), "s", { yolo: true }), true).permission, { "ditto_*": "allow", "ditto-github_*": "allow" }, "--yolo runs them");
  assert.deepEqual(opencodeMcp(claudeMcpAttachment(catalog(false), "s"), true).permission, { "ditto_*": "allow", "ditto-github_*": "allow" }, "Ditto holds gated calls itself");
});

test("opencodeMcp: when flattened names could collide, nothing is allowed by name", () => {
  const cat = {
    endpoint: "e", approvalMode: "park", clientApprovals: true,
    servers: [
      { name: "a", url: "https://router.test/v1/mcp/a", tools: [{ name: "b_c", tier: "read", approval: false }] },
      { name: "a_b", url: "https://router.test/v1/mcp/a_b", tools: [{ name: "c", tier: "gated", approval: true }] },
    ],
  };
  // claudeServerName prefixes non-ditto sources: "ditto-a" and "ditto-a_b".
  const permission = opencodeMcp(claudeMcpAttachment(cat, "s")).permission;
  assert.deepEqual(permission, { "ditto-a_*": "ask", "ditto-a_b_*": "ask" }, "ditto-a_b_c must not be allowed by ditto-a's b_c");
});

test("planOpencode: TUI and run forms, keys only in env", () => {
  const mcp = claudeMcpAttachment(catalog(true), "s");
  const run = planOpencode({ ...base, mcp, mcpApiKey: "mcp-key", prompt: "hi", passthrough: ["--format", "json"] });
  assert.equal(run.command, "opencode");
  assert.deepEqual(run.args, ["run", "--format", "json", "hi"]);
  assert.equal(run.envSet[OPENCODE_KEY_ENV], "inf-key");
  assert.equal(run.envSet[MCP_KEY_ENV], "mcp-key");
  assert.equal(JSON.parse(run.envSet.OPENCODE_CONFIG_CONTENT).permission["ditto-github_*"], "deny", "a run cannot answer a prompt");
  assert.ok(run.args.every((a) => !a.includes("key")));

  assert.deepEqual(planOpencode({ ...base, resumeLast: true, plan: true }).args, ["--continue", "--agent", "plan"]);
  assert.deepEqual(planOpencode({ ...base, resumeId: "ses_1", yolo: true }).args, ["--session", "ses_1", "--auto"]);
  assert.throws(() => planOpencode({ ...base, yellow: true }), /--yellow is not supported/);
});

test("wantsMcp: OpenCode follows --mcp, then opencode_tool_surface, then native MCP", () => {
  assert.equal(wantsMcp({}, {}, "opencode"), true);
  assert.equal(wantsMcp({ mcp: false }, {}, "opencode"), false);
  assert.equal(wantsMcp({}, { providerOptions: { opencode_tool_surface: "router" } }, "opencode"), false);
});

test("findOpencodeSession names the one session this launch created in its directory, and nothing it cannot be sure of", async () => {
  const { findOpencodeSession } = await import("../dist/agents/opencode.js");
  const list = (sessions, status = 0) => () => ({ status, stdout: JSON.stringify(sessions) });
  const since = 1000;
  const mine = { id: "ses_mine", created: 1500, directory: "/work/repo" };
  assert.equal(findOpencodeSession("/work/repo", since, list([mine, { id: "ses_old", created: 500, directory: "/work/repo" }, { id: "ses_other", created: 1600, directory: "/elsewhere" }])), "ses_mine");
  assert.equal(findOpencodeSession("/work/repo", since, list([mine, { id: "ses_parallel", created: 1700, directory: "/work/repo" }])), undefined, "two candidates: a parallel run");
  assert.equal(findOpencodeSession("/work/repo", since, list([mine, { id: "ses_child", created: 1600, directory: "/work/repo", parentID: "ses_mine" }])), "ses_mine", "a subagent's child session does not count");
  assert.equal(findOpencodeSession("/work/repo", since, list([{ id: "ses_nested", time: { created: 1500 }, directory: "/work/repo" }])), "ses_nested", "the nested time.created form");
  assert.equal(findOpencodeSession("/work/repo", since, list([{ id: "ses_old_nested", time: { created: 500 }, directory: "/work/repo" }])), undefined);
  assert.equal(findOpencodeSession("/work/repo", since, list([])), undefined);
  assert.equal(findOpencodeSession("/work/repo", since, list([mine], 1)), undefined, "a failed listing");
  assert.equal(findOpencodeSession("/work/repo", since, () => ({ status: 0, stdout: "not json" })), undefined);
});
