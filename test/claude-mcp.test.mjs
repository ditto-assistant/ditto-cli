import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { planClaude } from "../dist/agents/claude.js";
import {
  MCP_KEY_ENV,
  TOOL_SURFACE_HEADER,
  claudeMcpAttachment,
  claudeServerName,
  fetchMcpCatalog,
  mergeSettings,
  withClaudeSettings,
} from "../dist/agents/claude-mcp.js";
import { wantsMcp } from "../dist/agents/launch.js";
import { withHookArgs } from "../dist/remote/hooks.js";

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

test("claudeServerName keeps ditto and prefixes every other source", () => {
  assert.equal(claudeServerName("ditto"), "ditto");
  assert.equal(claudeServerName("github"), "ditto-github");
});

test("claudeMcpAttachment: one http server per source, the key only as a variable reference", () => {
  const mcp = claudeMcpAttachment(catalog(false), "sess-1");
  const config = JSON.parse(mcp.config);
  assert.deepEqual(Object.keys(config.mcpServers), ["ditto", "ditto-github"], "a source with no tools is not attached");
  assert.deepEqual(config.mcpServers["ditto-github"], {
    type: "http",
    url: "https://router.test/v1/mcp/github",
    headers: { Authorization: `Bearer \${${MCP_KEY_ENV}}`, "X-Ditto-Session-Id": "sess-1" },
  });
  assert.equal(mcp.servers, 2);
  assert.equal(mcp.tools, 3);
});

test("claudeMcpAttachment: Ditto holds gated calls, so Claude Code is not asked twice", () => {
  const mcp = claudeMcpAttachment(catalog(false), "s");
  assert.deepEqual(mcp.allow, ["mcp__ditto", "mcp__ditto-github"]);
  assert.deepEqual(mcp.ask, []);
});

test("claudeMcpAttachment: client approvals ask for exactly what Ditto would hold, and --yolo asks for nothing", () => {
  const mcp = claudeMcpAttachment(catalog(true), "s");
  assert.deepEqual(mcp.allow, ["mcp__ditto__search_memories", "mcp__ditto-github__list_issues"]);
  assert.deepEqual(mcp.ask, ["mcp__ditto-github__delete_repo"]);
  const yolo = claudeMcpAttachment(catalog(true), "s", { yolo: true });
  assert.deepEqual(yolo.ask, []);
  assert.deepEqual(yolo.allow, mcp.allow);
});

test("planClaude: native MCP attaches the servers, sets the permissions and tells the router", () => {
  const base = { baseUrl: "https://router.test/v1", apiKey: "ditto_inf_secret", sessionId: "s1", passthrough: [], env: {} };
  const plain = planClaude(base);
  assert.ok(!plain.args.includes("--mcp-config"));
  assert.ok(!plain.envSet.ANTHROPIC_CUSTOM_HEADERS.includes(TOOL_SURFACE_HEADER));
  assert.equal(plain.envSet[MCP_KEY_ENV], undefined);

  const mcp = claudeMcpAttachment(catalog(true), "s1");
  const plan = planClaude({ ...base, mcp, passthrough: ["--verbose"] });
  const at = plan.args.indexOf("--mcp-config");
  assert.ok(at >= 0);
  assert.equal(plan.args[at + 1], mcp.config);
  assert.ok(!plan.args.join(" ").includes("ditto_inf_secret"), "the key never appears in argv");
  assert.equal(plan.envSet[MCP_KEY_ENV], "ditto_inf_secret");
  assert.match(plan.envSet.ANTHROPIC_CUSTOM_HEADERS, /X-Ditto-Tool-Surface: mcp/);
  const settings = plan.args.indexOf("--settings");
  assert.deepEqual(JSON.parse(plan.args[settings + 1]), {
    permissions: { allow: ["mcp__ditto__search_memories", "mcp__ditto-github__list_issues"], ask: ["mcp__ditto-github__delete_repo"] },
  });
  assert.ok(plan.args.includes("--verbose"));
});

test("withClaudeSettings merges into a JSON --settings and leaves a file alone", () => {
  const merged = withClaudeSettings(["--settings", '{"permissions":{"allow":["Bash"]},"model":"x"}'], { permissions: { allow: ["mcp__ditto"] } });
  assert.deepEqual(merged.length, 2);
  assert.deepEqual(JSON.parse(merged[1]), { permissions: { allow: ["Bash", "mcp__ditto"] }, model: "x" });
  assert.deepEqual(withClaudeSettings(["--settings", "/tmp/s.json"], { a: 1 }), ["--settings", "/tmp/s.json", "--settings", '{"a":1}']);
  assert.deepEqual(withClaudeSettings(["--settings={}"], { a: 1 }), ['--settings={"a":1}']);
  assert.deepEqual(withClaudeSettings(["-p", "x"], {}), ["-p", "x"]);
  assert.deepEqual(mergeSettings({ a: [1], b: { c: 1 } }, { a: [1, 2], b: { d: 2 } }), { a: [1, 2], b: { c: 1, d: 2 } });
});

test("withHookArgs folds the hooks into native MCP's --settings: one flag, both settings", () => {
  const mcp = claudeMcpAttachment(catalog(false), "s1");
  const plan = planClaude({ baseUrl: "https://router.test/v1", apiKey: "k", sessionId: "s1", passthrough: [], env: {}, mcp });
  const args = withHookArgs("claude", plan.args, ["--settings", JSON.stringify({ hooks: { Stop: [] } })]);
  assert.equal(args.filter((a) => a === "--settings").length, 1);
  const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
  assert.deepEqual(settings.permissions.allow, ["mcp__ditto", "mcp__ditto-github"]);
  assert.deepEqual(settings.hooks, { Stop: [] });
});

test("wantsMcp: the flag wins, then the endpoint's claude_tool_surface, then the router", () => {
  assert.equal(wantsMcp({}, {}), false);
  assert.equal(wantsMcp({}, { providerOptions: { claude_tool_surface: "mcp" } }), true);
  assert.equal(wantsMcp({ mcp: false }, { providerOptions: { claude_tool_surface: "mcp" } }), false);
  assert.equal(wantsMcp({ mcp: true }, { providerOptions: { claude_tool_surface: "router" } }), true);
});

test("fetchMcpCatalog reads GET <base>/mcp with the session key and reports refusals", async () => {
  let seen;
  const server = http.createServer((req, res) => {
    seen = { url: req.url, auth: req.headers.authorization, session: req.headers["x-ditto-session-id"] };
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer good") {
      res.statusCode = 403;
      res.end(JSON.stringify({ type: "error", error: { type: "mcp_unsupported", message: "needs an endpoint key" } }));
      return;
    }
    res.end(JSON.stringify(catalog(false)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1/`;
  try {
    const got = await fetchMcpCatalog(base, "good", "sess-9");
    assert.deepEqual(seen, { url: "/v1/mcp", auth: "Bearer good", session: "sess-9" });
    assert.equal(got.servers.length, 3);
    await assert.rejects(fetchMcpCatalog(base, "bad", "s"), /403: needs an endpoint key/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
