import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const ALPHA = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "alpha",
  name: "Alpha",
  model: "openai/gpt-5.6-luna",
  status: "active",
};

/**
 * Brian's case: the `subnet` endpoint is created by the organization's owner,
 * so the bare listing (caller-created only) does not contain it — only the
 * org-scoped listing `?company=<id>` does.
 */
const ORG_ENDPOINT = {
  id: "faddcc69-accd-47e4-9814-9de6a4b9c65e",
  slug: "subnet",
  name: "Subnet",
  model: "anthropic/claude-sonnet-5",
  status: "active",
};

const COMPANY = { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", slug: "omniaura", name: "Omni Aura", role: "member" };

function startStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => {
        res.statusCode = status;
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      if (req.headers.authorization !== "Bearer ditto_mcp_test") return json(401, { message: "unauthorized" });
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints: [ALPHA], limit: 5, used: 1 });
      }
      if (req.url === "/api/v5/companies" && req.method === "GET") {
        return json(200, { companies: [COMPANY] });
      }
      if (req.url === `/api/v5/inference/endpoints?company=${COMPANY.id}` && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints: [ORG_ENDPOINT], limit: 5, used: 1 });
      }
      const m = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)\/keys$/);
      if (m && req.method === "POST") {
        return json(201, { id: "key-1", endpointId: m[1], name: "n", keyHint: "zz99", key: "ditto_inf_secret_zz99", expiresAt: "2027-01-01T00:00:00Z" });
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

/** spawnSync from a Node parent with an open server socket hangs; the rest of
 * this suite launches the CLI asynchronously for the same reason. */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        DITTO_API_BASE: stub.base,
        DITTO_API_KEY: "ditto_mcp_test",
        DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-org-endpoint-")),
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

let stub;

test("codex resolves an organization endpoint absent from the personal listing", async () => {
  stub = await startStub();
  try {
    const result = await run(["codex", "--endpoint", "subnet", "--dry-run"]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.endpoint.slug, "subnet");
    assert.equal(plan.endpoint.id, ORG_ENDPOINT.id);
    // The org-scoped listing was consulted, not just the bare route.
    assert.ok(
      stub.calls.some((c) => c.url === `/api/v5/inference/endpoints?company=${COMPANY.id}`),
      "expected a company-scoped endpoint listing",
    );
  } finally {
    stub.close();
  }
});
