import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SESSION_ID_HEADER, SESSION_NAME_HEADER, sessionHeaders } from "../dist/mcp-session.js";

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
function startStubMCP() {
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
      calls.push({ method: msg.method, headers: req.headers });
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

test("sessionHeaders: id always, name only until sent", () => {
  assert.deepEqual(sessionHeaders(undefined), {});
  assert.deepEqual(sessionHeaders({ id: "abc", source: "env", sendName: false }), { [SESSION_ID_HEADER]: "abc" });
  assert.deepEqual(sessionHeaders({ id: "abc", name: "Refactor", source: "config", sendName: true }), {
    [SESSION_ID_HEADER]: "abc",
    [SESSION_NAME_HEADER]: "Refactor",
  });
  assert.deepEqual(sessionHeaders({ id: "abc", name: "Refactor", source: "config", sendName: false }), { [SESSION_ID_HEADER]: "abc" });
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

    stub.calls.length = 0;
    const second = await runAsync(["status", "--output", "json"], dir, env);
    assert.equal(second.status, 0, second.stderr);
    const init2 = stub.calls.find((c) => c.method === "initialize");
    assert.equal(init2.headers["x-ditto-session-id"], id);
    assert.equal(init2.headers["x-ditto-session-name"], undefined, "name is sent only once");

    stub.calls.length = 0;
    const pinned = await runAsync(["status", "--output", "json"], dir, { ...env, DITTO_SESSION_ID: "other-session" });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(stub.calls.find((c) => c.method === "initialize").headers["x-ditto-session-id"], "other-session");

    run(["session", "end"], dir);
    stub.calls.length = 0;
    const none = await runAsync(["status", "--output", "json"], dir, env);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(stub.calls.find((c) => c.method === "initialize").headers["x-ditto-session-id"], undefined);
  } finally {
    stub.close();
  }
});

test("agents lists chat agents from /api/v5/chat-agents", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-sess-"));
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        agents: [
          { id: "main", kind: "main", name: "Main Agent", mainThreadId: "main", status: "active", threadCount: 3, lastActivityAt: new Date().toISOString(), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", connections: [] },
          { id: "external:inference-abc", kind: "inference_endpoint", name: "work", mainThreadId: "external:inference-abc", status: "active", threadCount: 7, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", connections: [{ id: "c1", agentId: "external:inference-abc", kind: "inference_endpoint", refId: "e1", name: "work", createdAt: "2026-01-01T00:00:00Z" }, { id: "c2", agentId: "external:inference-abc", kind: "mcp_api_key", refId: "12", name: "laptop", createdAt: "2026-01-01T00:00:00Z", revokedAt: "2026-02-01T00:00:00Z" }] },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await runAsync(["agents"], dir, { DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: base });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls[0].url, "/api/v5/chat-agents");
    assert.equal(calls[0].auth, "Bearer ditto_mcp_test");
    assert.match(r.stdout, /^ID\s+KIND\s+NAME\s+THREADS\s+LAST ACTIVITY\s+CONNECTIONS/m);
    assert.match(r.stdout, /main\s+main\s+Main Agent\s+3/);
    assert.match(r.stdout, /inference_endpoint:work$/m);
    assert.doesNotMatch(r.stdout, /laptop/, "revoked connections are hidden");
    const j = await runAsync(["agents", "--output", "json"], dir, { DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: base });
    assert.equal(JSON.parse(j.stdout).agents.length, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
