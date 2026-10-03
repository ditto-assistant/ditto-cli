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

const RUN = { id: "55555555-5555-5555-5555-555555555555", repositoryId: REPO.id, prNumber: 88,
  status: "completed", headSha: "a".repeat(40), attempts: 0, summary: { posted: 1 },
  reviewUrl: "https://github.com/ditto-assistant/console/pull/88#pullrequestreview-1" };

function startStub({ statuses = ["completed"], refusal, detailDelay = 0 } = {}) {
  let detailReads = 0;
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); };
      if (req.url === "/api/v5/companies") return json(200, { companies: [COMPANY] });
      if (req.url === `/api/v5/review?company=${COMPANY.id}` && req.method === "GET") return json(200, { repositories: [REPO], runs: [RUN] });
      if (req.url === `/api/v5/review/repositories?company=${COMPANY.id}` && req.method === "PUT") return json(200, { ...REPO, ...JSON.parse(body), revision: 8 });
      const query = `?company=${COMPANY.id}`;
      const pullsRoute = `/api/v5/review/repositories/${REPO.id}/pulls`;
      if (req.url === pullsRoute + query && req.method === "GET") return json(200, { pulls: [{ number: 88, title: "review picker", draft: false, url: "https://github.com/ditto-assistant/console/pull/88" }] });
      if (req.url === pullsRoute + "/88/review" + query && req.method === "POST") {
        if (refusal) return json(refusal, { message: "only managers may start reviews" });
        return json(202, { runId: RUN.id, status: "queued", alreadyReviewed: { attempt: 1 } });
      }
      const runRoute = `/api/v5/review/runs/${RUN.id}`;
      if (req.url === runRoute + query && req.method === "GET") {
        const status = statuses[Math.min(detailReads++, statuses.length - 1)];
        const reply = () => json(200, { run: { ...RUN, status }, repository: REPO, result: { findings: [{ title: "finding" }] }, attempts: [] });
        if (detailDelay) setTimeout(reply, detailDelay); else reply();
        return;
      }
      if (req.url === runRoute + "/retry" + query && req.method === "POST") return json(202, { status: "queued", reusedResult: true });
      if (req.url === runRoute + "/cancel" + query && req.method === "POST") return json(200, { runId: RUN.id, status: "running", cancelRequested: true });
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


test("review help exposes lifecycle commands", async () => {
  const out = await run("http://127.0.0.1:1", ["review", "--help"]);
  assert.equal(out.status, 0, out.stderr);
  for (const command of ["repos", "set", "runs", "pulls", "start", "status", "watch", "retry", "cancel"]) assert.match(out.stdout, new RegExp(`\\b${command}\\b`));
});

test("review runs filters by repository and returns JSON", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["review", "runs", "Ditto-Assistant/Console", "--org", COMPANY.slug, "--output", "json"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { runs: [RUN] });
    assert.ok(stub.calls.every(c => c.method === "GET"));
  } finally { stub.close(); }
});

test("review pulls uses the repository id and organization scope", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["review", "pulls", REPO.fullName, "--org", COMPANY.slug]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /#88.*review picker/);
    assert.ok(stub.calls.some(c => c.url === `/api/v5/review/repositories/${REPO.id}/pulls?company=${COMPANY.id}`));
  } finally { stub.close(); }
});

test("review start queues exactly once and preserves the re-review notice", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["review", "start", REPO.fullName, "88", "--org", COMPANY.slug, "--output", "json"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).alreadyReviewed.attempt, 1);
    const writes = stub.calls.filter(c => c.method === "POST");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, `/api/v5/review/repositories/${REPO.id}/pulls/88/review?company=${COMPANY.id}`);
  } finally { stub.close(); }
});

test("review start --watch follows the returned run without queuing it again and emits one JSON document", async () => {
  const stub = await startStub({ statuses: ["running", "publishing", "partial"] });
  try {
    const out = await run(stub.base, ["review", "start", REPO.fullName, "88", "--org", COMPANY.slug, "--watch", "--interval", "1", "--timeout", "10", "--output", "json"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).run.status, "partial");
    assert.match(out.stderr, /running[\s\S]*publishing[\s\S]*partial/);
    assert.match(out.stderr, /already reviewed/);
    assert.equal(stub.calls.filter(c => c.method === "POST").length, 1);
  } finally { stub.close(); }
});

test("review status exposes results and uses the scoped run detail", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["review", "status", RUN.id, "--org", COMPANY.slug, "--output", "json"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).result.findings[0].title, "finding");
    assert.ok(stub.calls.some(c => c.url === `/api/v5/review/runs/${RUN.id}?company=${COMPANY.id}`));
  } finally { stub.close(); }
});

test("review watch exits on failed, cancelled, skipped, and superseded states without a write", async () => {
  for (const status of ["failed", "cancelled", "skipped", "superseded"]) {
    const stub = await startStub({ statuses: [status] });
    try {
      const out = await run(stub.base, ["review", "watch", RUN.id, "--org", COMPANY.slug, "--output", "json"]);
      assert.equal(out.status, status === "failed" ? 1 : 0, out.stderr);
      assert.equal(JSON.parse(out.stdout).run.status, status);
      assert.ok(stub.calls.every(c => c.method === "GET"));
    } finally { stub.close(); }
  }
});

test("review watch times out without cancelling the server run, including a hung response", async () => {
  for (const detailDelay of [0, 2000]) {
    const stub = await startStub({ statuses: ["running"], detailDelay });
    try {
      const out = await run(stub.base, ["review", "watch", RUN.id, "--org", COMPANY.slug, "--timeout", "1", "--interval", "1"]);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /timed out.*review continues on the server/);
      assert.ok(stub.calls.every(c => c.method === "GET"));
    } finally { stub.close(); }
  }
});

test("review lifecycle validates identifiers and watch flags before any request", async () => {
  const stub = await startStub();
  try {
    for (const args of [
      ["start", REPO.fullName, "0"], ["start", REPO.fullName, "1.5"],
      ["start", REPO.fullName, "88", "--watch", "--interval", "0"],
      ["watch", RUN.id, "--timeout", "0"], ["status", "../other"], ["cancel", "invalid"],
    ]) {
      const out = await run(stub.base, ["review", ...args, "--org", COMPANY.slug]);
      assert.notEqual(out.status, 0, JSON.stringify(args));
    }
    assert.equal(stub.calls.length, 0);
  } finally { stub.close(); }
});

test("review actions keep server semantics; start propagates manager refusal without a retry", async () => {
  const stub = await startStub({ refusal: 403 });
  try {
    for (const action of ["retry", "cancel"]) {
      const out = await run(stub.base, ["review", action, RUN.id, "--org", COMPANY.slug, "--output", "json"]);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(JSON.parse(out.stdout)[action === "retry" ? "reusedResult" : "cancelRequested"], true);
      assert.ok(stub.calls.some(c => c.method === "POST" && c.url === `/api/v5/review/runs/${RUN.id}/${action}?company=${COMPANY.id}`));
    }
    const before = stub.calls.filter(c => c.method === "POST").length;
    const out = await run(stub.base, ["review", "start", REPO.fullName, "88", "--org", COMPANY.slug]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /HTTP 403.*only managers/);
    assert.equal(stub.calls.filter(c => c.method === "POST").length, before + 1);
  } finally { stub.close(); }
});
