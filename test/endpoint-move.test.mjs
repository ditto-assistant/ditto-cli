import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const COMPANY = { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", slug: "omniaura", name: "Omni Aura", role: "owner" };

const PERSONAL = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "alpha",
  name: "Alpha",
  model: "anthropic/claude-sonnet-5.5",
  status: "active",
};

const ORG_OWNED = {
  id: "22222222-2222-2222-2222-222222222222",
  slug: "subnet",
  name: "Subnet",
  model: "openai/gpt-6.1-sol",
  status: "active",
  companyId: COMPANY.id,
};

/**
 * A stub of the endpoint API that records each request body, so a test can
 * assert exactly what the CLI asked the server to change. Ownership checks
 * stay the server's job; the CLI only resolves and sends the destination.
 */
function startStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => {
        res.statusCode = status;
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      if (req.headers.authorization !== "Bearer ditto_mcp_test") return json(401, { message: "unauthorized" });
      if (req.url === "/api/v5/companies" && req.method === "GET") return json(200, { companies: [COMPANY] });
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints: [PERSONAL], limit: 10, used: 1 });
      }
      if (req.url === `/api/v5/inference/endpoints?company=${COMPANY.id}` && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints: [ORG_OWNED], limit: 10, used: 1 });
      }
      if (req.url === "/api/v5/inference/endpoints" && req.method === "POST") {
        const input = JSON.parse(body);
        return json(201, { ...PERSONAL, id: "33333333-3333-3333-3333-333333333333", slug: input.slug ?? "new", companyId: input.companyId });
      }
      const patch = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/?]+)$/);
      if (patch && req.method === "PATCH") {
        const current = [PERSONAL, ORG_OWNED].find((e) => e.id === patch[1]);
        if (!current) return json(404, {});
        const input = JSON.parse(body);
        return json(200, { ...current, companyId: input.companyId || undefined });
      }
      return json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, calls, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

let stub;

function run(args, configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-endpoint-move-"))) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        DITTO_API_BASE: stub.base,
        DITTO_API_KEY: "ditto_mcp_test",
        DITTO_CONFIG_DIR: configDir,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const patches = () => stub.calls.filter((c) => c.method === "PATCH");

test("create --org files the endpoint under the organization", async () => {
  stub = await startStub();
  try {
    const result = await run([
      "endpoints", "create", "--slug", "probe", "--org", "omniaura",
      "--billing-mode", "byok", "--provider-key", "d80b7ab9-576f-4c5f-8a5b-26ce7d569f01",
    ]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const post = stub.calls.find((c) => c.method === "POST");
    assert.equal(post.body.companyId, COMPANY.id);
    assert.equal(post.body.billingMode, "byok");
    assert.deepEqual(post.body.providerKeyIds, ["d80b7ab9-576f-4c5f-8a5b-26ce7d569f01"]);
    assert.match(result.stdout, /in omniaura, which owns and pays for it/);
  } finally {
    stub.close();
  }
});

test("create without --org stays personal even with a default organization", async () => {
  stub = await startStub();
  try {
    const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-endpoint-move-"));
    const use = await run(["orgs", "use", "omniaura"], configDir);
    assert.equal(use.code, 0, `stderr: ${use.stderr}`);
    const result = await run(["endpoints", "create", "--slug", "probe"], configDir);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const post = stub.calls.find((c) => c.method === "POST");
    assert.equal(post.body.companyId, undefined);
  } finally {
    stub.close();
  }
});

test("move --org sends the organization id; --personal sends an empty id", async () => {
  stub = await startStub();
  try {
    const into = await run(["endpoints", "move", "alpha", "--org", "omniaura"]);
    assert.equal(into.code, 0, `stderr: ${into.stderr}`);
    assert.match(into.stdout, /Moved alpha into omniaura/);
    const back = await run(["endpoints", "move", "subnet", "--personal"]);
    assert.equal(back.code, 0, `stderr: ${back.stderr}`);
    assert.match(back.stdout, /Moved subnet back to your personal context/);
    const sent = patches();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].url, `/api/v5/inference/endpoints/${PERSONAL.id}`);
    assert.deepEqual(sent[0].body, { companyId: COMPANY.id });
    assert.equal(sent[1].url, `/api/v5/inference/endpoints/${ORG_OWNED.id}`);
    assert.deepEqual(sent[1].body, { companyId: "" });
  } finally {
    stub.close();
  }
});

test("move to where the endpoint already is sends nothing", async () => {
  stub = await startStub();
  try {
    const result = await run(["endpoints", "move", "subnet", "--org", "omniaura"]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /already in omniaura/);
    assert.equal(patches().length, 0);
  } finally {
    stub.close();
  }
});

test("move needs exactly one destination and a known organization", async () => {
  stub = await startStub();
  try {
    const neither = await run(["endpoints", "move", "alpha"]);
    assert.notEqual(neither.code, 0);
    assert.match(neither.stderr, /exactly one of --org/);
    const both = await run(["endpoints", "move", "alpha", "--org", "omniaura", "--personal"]);
    assert.notEqual(both.code, 0);
    assert.match(both.stderr, /exactly one of --org/);
    const unknown = await run(["endpoints", "move", "alpha", "--org", "nope"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /Organizations you belong to: omniaura/);
    assert.equal(patches().length, 0);
  } finally {
    stub.close();
  }
});
