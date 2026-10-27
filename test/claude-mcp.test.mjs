import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { planClaude } from "../dist/agents/claude.js";
import {
  MCP_KEY_ENV,
  TOOL_SURFACE_HEADER,
  claudeMcpAttachment,
  claudeServerName,
  fetchMcpCatalog,
  mcpApprovalNote,
  mergeSettings,
  sweepStaleSettings,
  withClaudeSettings,
  writePrivateSettings,
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
  assert.equal(mcp.gated, 1);
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

test("withClaudeSettings merges into the one --settings, inline or a file", () => {
  const merged = withClaudeSettings(["--settings", '{"permissions":{"allow":["Bash"]},"model":"x"}'], { permissions: { allow: ["mcp__ditto"] } });
  assert.deepEqual(merged.length, 2);
  assert.deepEqual(JSON.parse(merged[1]), { permissions: { allow: ["Bash", "mcp__ditto"] }, model: "x" });
  // A settings file is merged into ONE private copy whose path replaces it:
  // Claude Code honours a single --settings, and a file's contents (which can
  // hold secrets) must not land in argv. A relative path means Claude's cwd.
  const dir = mkdtempSync(path.join(os.tmpdir(), "ditto-settings-"));
  writeFileSync(path.join(dir, "s.json"), '{"model":"y","env":{"TOKEN":"s3cret"},"permissions":{"deny":["WebFetch"]}}');
  const fromFile = withClaudeSettings(["-p", "x", "--settings", "s.json"], { permissions: { allow: ["mcp__ditto"] } }, { cwd: dir });
  assert.equal(fromFile.filter((a) => a === "--settings").length, 1);
  assert.ok(!fromFile.join(" ").includes("s3cret"), "settings contents never enter argv");
  const copy = fromFile[3];
  assert.notEqual(copy, path.join(dir, "s.json"), "the user's file is not modified");
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(copy)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(copy, "utf8")), { model: "y", env: { TOKEN: "s3cret" }, permissions: { deny: ["WebFetch"], allow: ["mcp__ditto"] } });
  assert.throws(() => withClaudeSettings(["--settings", "s.json"], { a: 1 }, { cwd: os.tmpdir() + "/nowhere" }), /cannot be merged with native MCP permissions/);
  assert.throws(() => withClaudeSettings(["--settings", "[1]"], { a: 1 }), /cannot be merged|not a JSON object/);
  // "__proto__" in settings JSON is data, never a prototype swap.
  const proto = JSON.parse(withClaudeSettings(["--settings", '{"a":1}'], JSON.parse('{"__proto__":{"polluted":true}}'))[1]);
  assert.deepEqual(Object.keys(proto), ["a", "__proto__"]);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(withClaudeSettings(["--settings={}"], { a: 1 }), ['--settings={"a":1}']);
  assert.deepEqual(withClaudeSettings(["-p", "x"], {}), ["-p", "x"]);
  assert.deepEqual(mergeSettings({ a: [1], b: { c: 1 } }, { a: [1, 2], b: { d: 2 } }), { a: [1, 2], b: { c: 1, d: 2 } });
});

test("withHookArgs folds an inline --settings= hook flag too", () => {
  const args = withHookArgs("claude", ["--settings", '{"permissions":{"allow":["mcp__ditto"]}}'], ['--settings={"hooks":{"Stop":[]}}', "--verbose"]);
  assert.deepEqual(args.filter((a) => a.startsWith("--settings")).length, 1);
  assert.deepEqual(JSON.parse(args[1]), { permissions: { allow: ["mcp__ditto"] }, hooks: { Stop: [] } });
  assert.equal(args.at(-1), "--verbose");
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
    // A server that never answers cannot hold up the launch.
    const stall = http.createServer(() => {});
    await new Promise((resolve) => stall.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(fetchMcpCatalog(`http://127.0.0.1:${stall.address().port}/v1`, "good", "s", fetch, 100), /timeout|aborted/i);
    } finally {
      stall.closeAllConnections();
      stall.close();
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("hooks merge into native MCP's private settings copy when the user passed a settings file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ditto-hook-settings-"));
  writeFileSync(path.join(dir, "mine.json"), '{"model":"opus"}');
  const mcp = claudeMcpAttachment(catalog(false), "s1");
  const plan = planClaude({ baseUrl: "https://router.test/v1", apiKey: "k", sessionId: "s1", passthrough: ["--settings", "mine.json"], env: {}, mcp, cwd: dir });
  const args = withHookArgs("claude", plan.args, ["--settings", JSON.stringify({ hooks: { Stop: [] } })]);
  assert.equal(args.filter((a) => a === "--settings").length, 1, "the hooks must not become a second, ignored --settings");
  const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
  assert.deepEqual(settings, { model: "opus", permissions: { allow: ["mcp__ditto", "mcp__ditto-github"] }, hooks: { Stop: [] } });
});

test("private settings copies are reused per content, per temp root, and swept only when their CLI is gone", () => {
  const a = writePrivateSettings('{"a":1}');
  assert.equal(writePrivateSettings('{"a":1}'), a, "re-planning the same settings reuses one file");
  assert.notEqual(writePrivateSettings('{"a":2}'), a);
  assert.match(path.basename(path.dirname(a)), new RegExp(`^ditto-claude-settings-${process.pid}-`));
  const otherRoot = mkdtempSync(path.join(os.tmpdir(), "ditto-root-"));
  assert.ok(writePrivateSettings('{"a":1}', otherRoot).startsWith(otherRoot), "a different temp root gets its own directory");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "ditto-sweep-"));
  const dead = path.join(tmp, "ditto-claude-settings-111-abc");
  const fresh = path.join(tmp, "ditto-claude-settings-333-abc");
  const live = path.join(tmp, "ditto-claude-settings-222-abc");
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const unnamed = path.join(tmp, "ditto-claude-settings-xyz");
  const other = path.join(tmp, "someone-else-111-abc");
  for (const d of [dead, fresh, live, unnamed, other]) mkdirSync(d);
  for (const d of [dead, live, unnamed, other]) utimesSync(d, old, old);
  sweepStaleSettings(tmp, (pid) => pid === 222);
  assert.equal(existsSync(dead), false, "a dead CLI's copy is removed");
  // Its launcher died, but the Claude it spawned may not have read --settings yet.
  assert.equal(existsSync(fresh), true, "a dead CLI's copy written in the last few minutes is kept");
  sweepStaleSettings(tmp, (pid) => pid === 222, Date.now() + 6 * 60 * 1000);
  assert.equal(existsSync(fresh), false, "and removed once the grace period is over");
  assert.equal(existsSync(live), true, "a live session keeps its settings however long it runs");
  assert.equal(existsSync(unnamed), true, "a directory without an owner pid is left alone");
  assert.equal(existsSync(other), true, "only our own prefix is swept");
});

test("mcpApprovalNote says who stops a gated call, and never claims a gate that is not there", () => {
  assert.equal(mcpApprovalNote(claudeMcpAttachment(catalog(false), "s")), "Ditto holds 1 gated");
  assert.equal(mcpApprovalNote(claudeMcpAttachment(catalog(true), "s")), "Claude Code asks before 1 gated");
  assert.equal(mcpApprovalNote(claudeMcpAttachment(catalog(true), "s", { yolo: true })), "1 gated run unasked (--yolo)");
  // An endpoint whose approval mode is off marks nothing gated: nobody holds or asks.
  const off = { ...catalog(true), approvalMode: "off", servers: catalog(true).servers.map((s) => ({ ...s, tools: s.tools.map((t) => ({ ...t, approval: false })) })) };
  assert.equal(mcpApprovalNote(claudeMcpAttachment(off, "s")), "no gated tools");
  assert.equal(mcpApprovalNote(claudeMcpAttachment({ ...off, clientApprovals: false }, "s")), "no gated tools");
});
