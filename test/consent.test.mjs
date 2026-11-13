import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { apiFetch, noteUpgradeNotice, UPGRADE_HEADER } from "../dist/api.js";
import { CLIENT_HEADER, clientHeaders, packageVersion } from "../dist/config.js";
import { CONSENT_STATUS_TOOL, REQUEST_CONSENT_TOOL, runConsent } from "../dist/consent.js";

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** A fake MCP client answering the two consent tools from queues. */
function fakeClient({ statuses, request }) {
  const calls = [];
  return {
    calls,
    async callTool({ name }) {
      calls.push(name);
      if (name === CONSENT_STATUS_TOOL) return text(statuses.length > 1 ? statuses.shift() : statuses[0]);
      if (name === REQUEST_CONSENT_TOOL) return text(request);
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

function io() {
  let now = 1_000;
  const out = [], err = [], opened = [];
  return {
    out, err, opened,
    io: {
      out: (t) => out.push(t), err: (t) => err.push(t), openURL: (u) => opened.push(u),
      sleep: async (ms) => { now += ms; }, now: () => now,
    },
  };
}

const pending = { status: "pending", url: "https://app.heyditto.ai/consent?code=ABCD-EFGH", code: "ABCD-EFGH", expiresAt: new Date(60_000).toISOString() };

test("clientHeaders names the CLI and its version", () => {
  assert.equal(CLIENT_HEADER, "X-Heyditto-Client");
  assert.deepEqual(clientHeaders(), { "X-Heyditto-Client": `heyditto-cli/${packageVersion}` });
  assert.match(packageVersion, /^\d+\.\d+\.\d+/);
});

test("consent: an account that already accepted asks for nothing", async () => {
  const client = fakeClient({ statuses: [{ complete: true, terms: true, ai: true }] });
  const { out, opened, io: deps } = io();
  assert.equal(await runConsent(client, { wait: true, open: true, json: false }, deps), "complete");
  assert.deepEqual(client.calls, [CONSENT_STATUS_TOOL]);
  assert.match(out.join(""), /already accepted/);
  assert.equal(opened.length, 0);
});

test("consent: shows the owner's link, opens it and waits until it is accepted", async () => {
  const client = fakeClient({ statuses: [{ complete: false }, { complete: false }, { complete: true, terms: true, ai: true }], request: pending });
  const { out, err, opened, io: deps } = io();
  assert.equal(await runConsent(client, { wait: true, open: true, json: false, pollMs: 1_000 }, deps), "complete");
  assert.deepEqual(client.calls, [CONSENT_STATUS_TOOL, REQUEST_CONSENT_TOOL, CONSENT_STATUS_TOOL, CONSENT_STATUS_TOOL]);
  assert.deepEqual(opened, [pending.url]);
  assert.match(err.join(""), /ABCD-EFGH/);
  assert.match(out.join(""), /Accepted/);
});

test("consent: --no-wait prints the link as JSON and stops", async () => {
  const client = fakeClient({ statuses: [{ complete: false }], request: pending });
  const { out, opened, io: deps } = io();
  assert.equal(await runConsent(client, { wait: false, open: false, json: true }, deps), "pending");
  assert.deepEqual(JSON.parse(out.join("")), pending);
  assert.equal(opened.length, 0);
});

test("consent: an unclaimed agent is pointed at its claim link", async () => {
  const client = fakeClient({ statuses: [{ complete: false, account: "unclaimed_agent" }], request: { status: "needs_claim", message: "Claim this agent first." } });
  const { out, io: deps } = io();
  const claimURL = "https://app.heyditto.ai/agent/claim?t=claim-token";
  assert.equal(await runConsent(client, { wait: true, open: true, json: false, claimURL }, deps), "needs_claim");
  assert.match(out.join(""), /Claim this agent first\.\nClaim link: https:\/\/app\.heyditto\.ai\/agent\/claim\?t=claim-token/);
});

test("consent: a link that expires unaccepted is an error", async () => {
  const client = fakeClient({ statuses: [{ complete: false }], request: pending });
  const { io: deps } = io();
  await assert.rejects(runConsent(client, { wait: true, open: false, json: false, pollMs: 20_000 }, deps), /expired before it was accepted/);
});

test("consent: a server without the consent tools says where to accept instead", async () => {
  const client = { async callTool() { return { content: [{ type: "text", text: "tool 'consent_status' not found" }], isError: true }; } };
  const { io: deps } = io();
  await assert.rejects(runConsent(client, { wait: true, open: false, json: false }, deps), /app\.heyditto\.ai\/mcp/);
});

test("the upgrade notice prints once, on stderr, as plain text", () => {
  const written = [];
  const response = (value) => ({ headers: { get: (name) => (name === UPGRADE_HEADER ? value : null) } });
  noteUpgradeNotice(response(null), (t) => written.push(t));
  noteUpgradeNotice(response("Update heyditto: npm install -g @heyditto/cli@latest\u001b[31m"), (t) => written.push(t));
  noteUpgradeNotice(response("second notice"), (t) => written.push(t));
  assert.deepEqual(written, ["warning: Update heyditto: npm install -g @heyditto/cli@latest[31m\n"]);
});

test("REST requests carry the client header", async () => {
  let seen;
  const server = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { base: process.env.DITTO_API_BASE, key: process.env.DITTO_API_KEY };
  process.env.DITTO_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.DITTO_API_KEY = "ditto_mcp_test";
  try {
    await apiFetch("/api/v5/inference/endpoints");
    assert.equal(seen["x-heyditto-client"], `heyditto-cli/${packageVersion}`);
  } finally {
    for (const [name, value] of [["DITTO_API_BASE", env.base], ["DITTO_API_KEY", env.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((r) => server.close(r));
  }
});

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function run(args, base, dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: {
      ...process.env, DITTO_API_BASE: base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: dir, DITTO_CLI_AUTO_UPDATE: "0",
    }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("heyditto consent over MCP sends the client header and exits by outcome", async () => {
  const seen = [];
  let request = pending;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const msg = JSON.parse(body);
      seen.push({ method: msg.method, client: req.headers["x-heyditto-client"], tool: msg.params?.name });
      res.setHeader("content-type", "application/json");
      if (msg.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } }));
      } else if (msg.method === "tools/call") {
        const value = msg.params.name === CONSENT_STATUS_TOOL ? { complete: false } : request;
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: text(value) }));
      } else { res.writeHead(202).end(); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "ditto-consent-"));
  try {
    let result = await run(["consent", "--no-wait", "--no-open", "--output", "json"], base, dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).url, pending.url);
    assert.match(result.stderr, /ABCD-EFGH/);
    assert.deepEqual(seen.filter((s) => s.method === "tools/call").map((s) => s.tool), [CONSENT_STATUS_TOOL, REQUEST_CONSENT_TOOL]);
    assert.ok(seen.length > 0 && seen.every((s) => s.client === `heyditto-cli/${packageVersion}`), JSON.stringify(seen));

    request = { status: "needs_claim", message: "Claim this agent first." };
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ apiKey: "ditto_mcp_test", agentMode: true, claimURL: "https://app.heyditto.ai/agent/claim?t=tok" }));
    result = await run(["consent", "--no-open"], base, dir);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /Claim link: https:\/\/app\.heyditto\.ai\/agent\/claim\?t=tok/);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("heyditto config writes the client header into the MCP configuration", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ditto-config-"));
  const result = await run(["config"], "https://api.example.test", dir);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mcpServers.ditto.headers[CLIENT_HEADER], `heyditto-cli/${packageVersion}`);
});
