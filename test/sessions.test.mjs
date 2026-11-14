import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CLIENT_HEADER, SESSION_ID_HEADER, SESSION_NAME_HEADER, sessionHeaders } from "../dist/mcp-session.js";
import { packageVersion } from "../dist/config.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function envFor(configDir, extra = {}) {
  return { ...process.env, DITTO_API_KEY: "", DITTO_SESSION_ID: "", DITTO_CONFIG_DIR: configDir, ...extra };
}

function run(args, configDir, extra = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env: envFor(configDir, extra) });
}

function runAsync(args, configDir, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: envFor(configDir, extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Minimal Streamable-HTTP MCP server that records request headers. */
function startStubMCP(toolResults = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = {};
      try {
        msg = JSON.parse(body);
      } catch {
        /* not json */
      }
      calls.push({ method: msg.method, params: msg.params, headers: req.headers });
      if (req.method !== "POST") {
        res.statusCode = 405;
        return res.end();
      }
      if (msg.method === "initialize") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "stub", version: "0" },
            },
          }),
        );
      }
      if (msg.method === "tools/list") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "save_memory", inputSchema: { type: "object" } }] } }));
      }
      if (msg.method === "tools/call") {
        res.setHeader("content-type", "application/json");
        const result = toolResults[msg.params.name];
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }));
      }
      res.statusCode = 202;
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        calls,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

test("session and agents --help work without auth", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-sess-"));
  for (const args of [["session", "--help"], ["session", "new", "--help"], ["agents", "--help"]]) {
    const r = run(args, dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  }
  const r = run(["session", "--help"], dir);
  for (const sub of ["new", "list", "use", "current", "end"]) assert.match(r.stdout, new RegExp(`\\b${sub}\\b`));
});

test("session new / current / list / end / use round trip", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-sess-"));
  assert.equal(run(["session", "current"], dir).status, 1);

  const created = run(["session", "new", "refactor", "auth"], dir);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.trim();
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.match(created.stderr, /refactor auth/);

  const current = run(["session", "current", "--output", "json"], dir);
  assert.equal(current.status, 0);
  const active = JSON.parse(current.stdout);
  assert.equal(active.id, id);
  assert.equal(active.name, "refactor auth");
  assert.equal(active.source, "config");
  assert.equal(active.sendName, true);

  const list = run(["session", "list"], dir);
  assert.match(list.stdout, new RegExp(`^\\* ${id}\\s+active`, "m"));

  const ended = run(["session", "end"], dir);
  assert.equal(ended.status, 0);
  assert.equal(run(["session", "current"], dir).status, 1);
  assert.match(run(["session", "list"], dir).stdout, /ended/);

  const reused = run(["session", "use", id.slice(0, 8)], dir);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(reused.stdout.trim(), id);
  assert.equal(JSON.parse(run(["session", "current", "--output", "json"], dir).stdout).id, id);

  // The saved key must survive session bookkeeping (merge-safe config writes).
  const cfg = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(cfg.activeSession.id, id);
});

test("DITTO_SESSION_ID pins the session and validates its shape", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-sess-"));
  const pinned = run(["session", "current", "--output", "json"], dir, { DITTO_SESSION_ID: "ci:run-42" });
  assert.equal(pinned.status, 0);
  assert.deepEqual(JSON.parse(pinned.stdout), { id: "ci:run-42", source: "env", sendName: false });
  const bad = run(["status"], dir, { DITTO_SESSION_ID: "has spaces", DITTO_API_KEY: "ditto_mcp_x" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /DITTO_SESSION_ID must match/);
});

test("consent opens a pending link for the account owner", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-consent-"));
  const stub = await startStubMCP({
    consent_status: { complete: false, account: "claimed_agent", message: "Not accepted yet." },
    request_consent: { status: "pending", url: "https://app.example/mcp/consent?code=ABCD-EFGH", code: "ABCD-EFGH" },
  });
  try {
    const result = await runAsync(["consent"], dir, { DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: stub.base });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /https:\/\/app\.example\/mcp\/consent\?code=ABCD-EFGH/);
    assert.match(result.stdout, /ABCD-EFGH/);
    assert.deepEqual(stub.calls.filter((call) => call.method === "tools/call").map((call) => call.params.name), ["consent_status", "request_consent"]);
  } finally {
    stub.close();
  }
});

test("sessionHeaders: client version always, session name only until sent", () => {
  const client = { [CLIENT_HEADER]: `heyditto-cli/${packageVersion}` };
  assert.deepEqual(sessionHeaders(undefined), client);
  assert.deepEqual(sessionHeaders({ id: "abc", source: "env", sendName: false }), { ...client, [SESSION_ID_HEADER]: "abc" });
  assert.deepEqual(sessionHeaders({ id: "abc", name: "Refactor", source: "config", sendName: true }), {
    ...client,
    [SESSION_ID_HEADER]: "abc",
    [SESSION_NAME_HEADER]: "Refactor",
  });
  assert.deepEqual(sessionHeaders({ id: "abc", name: "Refactor", source: "config", sendName: false }), { ...client, [SESSION_ID_HEADER]: "abc" });
});

test("MCP requests carry X-Ditto-Session-Id, and the name exactly once", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-sess-"));
  const stub = await startStubMCP();
  try {
    const created = run(["session", "new", "wire", "check"], dir);
    const id = created.stdout.trim();
    const env = { DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: stub.base };

    const first = await runAsync(["status", "--output", "json"], dir, env);
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.session.id, id);
    assert.equal(report.session.name, "wire check");
    const init = stub.calls.find((c) => c.method === "initialize");
    assert.ok(init, "initialize request reached the stub");
    assert.equal(init.headers["x-ditto-session-id"], id);
    assert.equal(init.headers["x-ditto-session-name"], "wire check");
    assert.equal(init.headers.authorization, "Bearer ditto_mcp_test");
    assert.equal(init.headers["x-heyditto-client"], `heyditto-cli/${packageVersion}`);

    stub.calls.length = 0;
    const second = await runAsync(["status", "--output", "json"], dir, env);
    assert.equal(second.status, 0, second.stderr);
    const init2 = stub.calls.find((c) => c.method === "initialize");
    assert.equal(init2.headers["x-ditto-session-id"], id);
    assert.equal(init2.headers["x-ditto-session-name"], undefined, "name is sent only once");
    assert.equal(init2.headers["x-heyditto-client"], `heyditto-cli/${packageVersion}`);

    stub.calls.length = 0;
    const pinned = await runAsync(["status", "--output", "json"], dir, { ...env, DITTO_SESSION_ID: "other-session" });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(stub.calls.find((c) => c.method === "initialize").headers["x-ditto-session-id"], "other-session");

    run(["session", "end"], dir);
    stub.calls.length = 0;
    const none = await runAsync(["status", "--output", "json"], dir, env);
    assert.equal(none.status, 0, none.stderr);
    const noSessionHeaders = stub.calls.find((c) => c.method === "initialize").headers;
    assert.equal(noSessionHeaders["x-ditto-session-id"], undefined);
    assert.equal(noSessionHeaders["x-heyditto-client"], `heyditto-cli/${packageVersion}`);
  } finally {
    stub.close();
  }
});

