import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const COMPANY = { id: "22222222-2222-2222-2222-222222222222", slug: "omni-aura", name: "Omni Aura", kind: "company", role: "owner" };
const REPO = {
  id: "33333333-3333-3333-3333-333333333333", fullName: "ditto-assistant/console", endpointId: "44444444-4444-4444-4444-444444444444",
  revision: 7, enabled: true, verify: true, reviewDrafts: false, postSummary: true, autofixCi: false, allowFixCommand: true,
  resolveFixedThreads: true, reviewVerdicts: true, blockingSeverity: "high", instructions: "be strict", mode: "suggest",
  trigger: "push", minSeverity: "medium", pathFilters: ["!docs/**"], pathInstructions: [], budgetCents: 200, maxMinutes: 10,
  minConfidence: 70, maxComments: 30, autofixMaxPushes: 2, monthlyBudgetUsd: null, lastPolledAt: "x", spend: { cents: 1 },
};

function startStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); };
      if (req.url === "/api/v5/companies") return json(200, { companies: [COMPANY] });
      if (req.url === `/api/v5/review?company=${COMPANY.id}` && req.method === "GET") return json(200, { repositories: [REPO], runs: [] });
      if (req.url === `/api/v5/review/repositories?company=${COMPANY.id}` && req.method === "PUT") return json(200, { ...REPO, ...JSON.parse(body), revision: 8 });
      json(404, { message: "no route" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`, calls,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

function run(base, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: base, DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-review-")) },
  });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("review repos lists the workspace's repositories", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["review", "repos", "--org", "omni-aura"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ditto-assistant\/console\s+on\s+10 min\s+\$2\.00/);
  } finally {
    stub.close();
  }
});

test("review set changes one field and sends every other setting back with the revision", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["review", "set", "Ditto-Assistant/Console", "--max-minutes", "20", "--org", "omni-aura"]);
    assert.equal(out.status, 0, out.stderr);
    const put = stub.calls.find((c) => c.method === "PUT");
    assert.ok(put, "no PUT was sent");
    assert.equal(put.body.ifRevision, 7);
    assert.equal(put.body.maxMinutes, 20);
    for (const key of ["fullName", "endpointId", "instructions", "pathFilters", "budgetCents", "mode", "trigger", "verify", "reviewVerdicts", "blockingSeverity", "monthlyBudgetUsd"]) {
      assert.deepEqual(put.body[key], REPO[key], key);
    }
    assert.equal(put.body.revision, undefined, "the read-only revision field is not sent as a setting");
    assert.equal(put.body.spend, undefined);
    assert.match(out.stdout, /time limit\s+10 → 20 min/);
  } finally {
    stub.close();
  }
});

test("review set refuses an out-of-range time limit before any request", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["review", "set", "ditto-assistant/console", "--max-minutes", "60", "--org", "omni-aura"]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /--max-minutes must be a whole number from 5 to 45/);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.close();
  }
});
