import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `heyditto agents` is a thin wrapper over the MCP agent-chat tools. It used
// to call REST /api/v5/chat-agents, which lists every connected-chat DM: one
// account's 200-row page was all Slack/Telegram DMs and showed no agent at
// all, while MCP list_agents already returned only the Ditto agents.
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

const replies = {
  list_agents: (args) => ({ agents: [
    { id: "main", name: "Main Agent", main_thread_id: "main", status: "active", thread_count: 3 },
    { id: "agent-triage", name: "Feedback Triage", main_thread_id: "agent-triage", status: "active", thread_count: 1 },
  ], ...(args.space ? { space: args.space } : {}) }),
  list_agent_threads: () => ({ agent: "agent-triage", threads: [{ id: "agent-triage", title: "Feedback Triage", kind: "main", url: "https://app.heyditto.ai/chat/agent-triage" }] }),
  get_agent_thread: (args) => ({ thread_id: args.thread, url: "https://app.heyditto.ai/chat/agent-triage", next_cursor: "older-page", exchanges: [{ pair_id: "pair-1", message: "Which issue?", answer: "ditto-app#2137 has the most reporters." }] }),
  send_message_to_agent: (args) => args.message === "fail"
    ? { message_id: "m-2", status: "failed", failure: { code: "insufficient_credits", message: "Add credits to keep chatting.", ref: "ref-1" } }
    : args.wait_seconds === 0
      ? { message_id: "m-1", status: "pending", url: "https://app.heyditto.ai/chat/agent-triage" }
      : { message_id: "m-1", status: "completed", answer: "ditto-app#2137 has the most reporters." },
  get_agent_message: (args) => args.message_id === "gone" ? null : args.message_id === "empty" ? { message_id: "empty", status: "completed" } : ({ message_id: "m-1", status: "completed", answer: "ditto-app#2137 has the most reporters." }),
};

test("agents commands call the MCP agent-chat tools", async () => {
  const calls = [];
  const rest = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", b => body += b);
    req.on("end", () => {
      if (!req.url.startsWith("/mcp")) { rest.push(req.url); res.writeHead(404).end(); return; }
      if (req.method !== "POST") { res.writeHead(405).end(); return; } // session close
      const msg = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (msg.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {
          protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" },
        }}));
      } else if (msg.method === "tools/call") {
        calls.push(msg.params);
        const reply = replies[msg.params.name]?.(msg.params.arguments ?? {});
        const result = reply
          ? { content: [{ type: "text", text: JSON.stringify(reply) }] }
          : { isError: true, content: [{ type: "text", text: `no message ${msg.params.arguments?.message_id ?? ""} sent by you` }] };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      } else { res.writeHead(202).end(); }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "ditto-agents-mcp-"));
  const last = () => calls.at(-1);
  try {
    let r = await run(["agents"], base, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(last().name, "list_agents");
    assert.deepEqual(last().arguments, {});
    assert.match(r.stdout, /^ID\s+NAME\s+THREADS\s+LAST ACTIVITY/m);
    assert.match(r.stdout, /agent-triage\s+Feedback Triage\s+1/);

    r = await run(["agents", "--space", "omniaura/feedback-triager", "--output", "json"], base, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(last().arguments, { space: "omniaura/feedback-triager" });
    assert.equal(JSON.parse(r.stdout).space, "omniaura/feedback-triager");

    r = await run(["agents", "threads", "agent-triage", "--space", "omniaura/feedback-triager"], base, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(last().name, "list_agent_threads");
    assert.deepEqual(last().arguments, { agent: "agent-triage", space: "omniaura/feedback-triager" });
    assert.match(r.stdout, /^ID\s+TITLE\s+KIND\s+LAST ACTIVITY\s+URL/m);

    r = await run(["agents", "read", "thread-1", "--agent", "agent-triage", "--space", "omniaura/feedback-triager", "--limit", "5", "--cursor", "previous"], base, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(last().name, "get_agent_thread");
    assert.deepEqual(last().arguments, { thread: "thread-1", agent: "agent-triage", space: "omniaura/feedback-triager", limit: 5, cursor: "previous" });
    assert.match(r.stdout, /Which issue\?\n\nditto-app#2137 has the most reporters\./);
    assert.match(r.stdout, /More exchanges are available with cursor: older-page/);

    r = await run(["agents", "send", "--space", "omniaura/feedback-triager", "--agent", "agent-triage", "--wait", "300", "which", "issue?"], base, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(last().name, "send_message_to_agent");
    assert.deepEqual(last().arguments, { space: "omniaura/feedback-triager", agent: "agent-triage", wait_seconds: 300, message: "which issue?" });
    assert.equal(r.stdout.trim(), "ditto-app#2137 has the most reporters.");

    r = await run(["agents", "send", "--wait", "0", "hi"], base, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /pending: message m-1/);
    assert.match(r.stdout, /heyditto agents message m-1 --wait 300/);

    r = await run(["agents", "message", "m-1", "--wait", "30"], base, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(last().name, "get_agent_message");
    assert.deepEqual(last().arguments, { message_id: "m-1", wait_seconds: 30 });
    assert.equal(r.stdout.trim(), "ditto-app#2137 has the most reporters.");

    r = await run(["agents", "send", "fail"], base, dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Add credits to keep chatting\. \(ref ref-1\)/);
    // A failed turn fails scripts reading JSON too.
    r = await run(["agents", "send", "--output", "json", "fail"], base, dir);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.stdout).status, "failed");

    r = await run(["agents", "send", "--client-message-id", "k-1", "--wait", "0", "hi"], base, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(last().arguments.client_message_id, "k-1");

    // A completed turn that returned no answer is not a success.
    r = await run(["agents", "message", "empty"], base, dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /completed but returned no answer/);

    // Out-of-range waits are refused before anything is called.
    for (const wait of ["-100", "301", "1.5", "1e2", ""]) {
      const before = calls.length;
      r = await run(["agents", "send", "--wait", wait, "hi"], base, dir);
      assert.notEqual(r.code, 0, `--wait ${wait}`);
      assert.match(r.stderr, /--wait must be a whole number of seconds from 0 to 300/);
      assert.equal(calls.length, before, `--wait ${wait} called a tool`);
    }

    // A tool error exits 1 with the tool's own message.
    r = await run(["agents", "message", "gone"], base, dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /error: no message gone sent by you/);

    assert.deepEqual(rest, [], "agents must not call REST endpoints");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
