import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ENDPOINT = { id: "ep-1", slug: "alpha", name: "Alpha", model: "openai/gpt-5.6-luna", status: "active" };

function startStub({ savings, models, moveStatus = 200 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      const json = (s, p) => { res.statusCode = s; res.end(JSON.stringify(p)); };
      if (req.url === "/api/v5/inference/endpoints") return json(200, { baseUrl: "https://x/v1", endpoints: [ENDPOINT] });
      if (req.url.startsWith(`/api/v5/inference/endpoints/${ENDPOINT.id}/savings`)) return json(200, savings ?? {});
      if (req.url === `/api/v5/inference/endpoints/${ENDPOINT.id}/models-seen`) return json(200, { models: models ?? [] });
      if (req.url === `/api/v5/inference/endpoints/${ENDPOINT.id}/move`) return json(moveStatus, { ...ENDPOINT });
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${server.address().port}`, calls,
    close: () => { server.closeAllConnections(); server.close(); },
  })));
}

function run(base, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: base,
      DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-final-")) },
  });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("endpoints savings totals the window and breaks it down by strategy", async () => {
  const stub = await startStub({ savings: {
    windowDays: 30, requests: 17034, tokensSaved: 1073866253, usdSaved: 2820.26, usdBilled: 5971.94,
    byStrategy: [{ strategy: "kind_route", requests: 1036, tokensSaved: 95202934, usdSaved: 621.8 }],
  } });
  try {
    const out = await run(stub.base, ["endpoints", "savings", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /last 30 days/);
    assert.match(out.stdout, /requests:\s+17,034/);
    assert.match(out.stdout, /usd saved:\s+\$2820\.26\s+\(billed \$5971\.94\)/);
    assert.match(out.stdout, /kind_route\s+1,036\s+95,202,934\s+\$621\.80/);
  } finally { stub.close(); }
});

test("--days is validated and forwarded", async () => {
  const stub = await startStub({ savings: { windowDays: 7 } });
  try {
    const ok = await run(stub.base, ["endpoints", "savings", "alpha", "--days", "7"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(stub.calls.some((c) => c.url.includes("days=7")), "the window must reach the API");
    const bad = await run(stub.base, ["endpoints", "savings", "alpha", "--days", "0"]);
    assert.notEqual(bad.status, 0);
  } finally { stub.close(); }
});

test("models-seen hides the resolved column when nothing was rewritten", async () => {
  const stub = await startStub({ models: [
    { requested: "claude-opus-5", resolvedModel: "claude-opus-5", count: 10, kinds: { chat: 10 }, lastSeenAt: new Date().toISOString() },
    { requested: "claude-sonnet-5", resolvedModel: "openai/gpt-5.6-luna", count: 151, kinds: { chat: 151 }, lastSeenAt: new Date().toISOString() },
  ] });
  try {
    const out = await run(stub.base, ["endpoints", "models-seen", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    // A model that resolved to itself shows no redirect — only real rewrites stand out.
    assert.match(out.stdout, /claude-opus-5\s+10\s+chat/);
    assert.match(out.stdout, /claude-sonnet-5\s+openai\/gpt-5\.6-luna\s+151/);
    assert.match(out.stderr, /--model-route claude-opus-5=/);
  } finally { stub.close(); }
});

test("move requires a direction and refuses both at once", async () => {
  const stub = await startStub();
  try {
    const none = await run(stub.base, ["endpoints", "move", "alpha", "--yes"]);
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /--company <id>.*--personal/s);
    const both = await run(stub.base, ["endpoints", "move", "alpha", "--company", "c1", "--personal", "--yes"]);
    assert.notEqual(both.status, 0);
    assert.match(both.stderr, /opposites/);
    assert.equal(stub.calls.some((c) => c.method === "POST"), false, "nothing may move without a clear direction");
  } finally { stub.close(); }
});

test("move sends the target and needs confirmation without --yes", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "move", "alpha", "--company", "c1", "--yes"]);
    assert.equal(out.status, 0, out.stderr);
    const post = stub.calls.find((c) => c.method === "POST");
    assert.deepEqual(post.body, { companyId: "c1" });

    const personal = await startStub();
    try {
      const out2 = await run(personal.base, ["endpoints", "move", "alpha", "--personal", "--yes"]);
      assert.equal(out2.status, 0, out2.stderr);
      assert.deepEqual(personal.calls.find((c) => c.method === "POST").body, { companyId: null });
    } finally { personal.close(); }
  } finally { stub.close(); }
});

test("move without --yes refuses on a non-TTY rather than moving silently", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "move", "alpha", "--company", "c1"]);
    assert.notEqual(out.status, 0);
    assert.equal(stub.calls.some((c) => c.method === "POST"), false, "ownership must not change unconfirmed");
  } finally { stub.close(); }
});
