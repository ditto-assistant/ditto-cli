import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatQuotaNotice, parseQuotaNotice } from "../dist/quota.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const QUOTA_BODY = {
  code: "memory_quota_exceeded",
  message: "monthly memory quota exceeded",
  action: "upgrade",
  params: { resource: "memory_save_monthly", limit: 1000, used: 1000, requested: 1, resetsAt: "2026-11-01T00:00:00Z" },
};

test("parseQuotaNotice reads the 429 body and ignores other errors", () => {
  const n = parseQuotaNotice(QUOTA_BODY);
  assert.equal(n?.resource, "memory_save_monthly");
  assert.equal(n?.limit, 1000);
  assert.equal(n?.resetsAt, "2026-11-01T00:00:00Z");
  assert.equal(parseQuotaNotice({ code: "not_found", message: "nope" }), undefined);
  assert.equal(parseQuotaNotice("text"), undefined);
});

test("formatQuotaNotice tells the agent to stop retrying and where to subscribe", () => {
  const withLink = formatQuotaNotice(parseQuotaNotice({ ...QUOTA_BODY, upgradeUrl: "https://example.test/upgrade" }), "https://example.test/claim?t=abc");
  assert.match(withLink, /memory save monthly limit is reached \(1000 of 1000 used\)/);
  assert.match(withLink, /stop retrying/);
  assert.match(withLink, /https:\/\/example\.test\/upgrade\?t=abc/);
  const noLink = formatQuotaNotice(parseQuotaNotice(QUOTA_BODY));
  assert.match(noLink, /Ask your account owner to subscribe or upgrade/);
});

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("REST 429 from the API surfaces as an upgrade instruction", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify(QUOTA_BODY));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const home = mkdtempSync(path.join(os.tmpdir(), "quota-"));
  try {
    const r = await runCli(["endpoints", "list"], { HOME: home, XDG_CONFIG_HOME: home, DITTO_API_KEY: "k", DITTO_API_BASE: `http://127.0.0.1:${port}` });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /limit is reached/);
    assert.match(r.stderr, /stop retrying/);
    assert.doesNotMatch(r.stderr, /HTTP 429/);
  } finally {
    server.close();
  }
});
