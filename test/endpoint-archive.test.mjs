import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const LIVE = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "alpha",
  name: "Alpha",
  model: "openai/gpt-5.6-luna",
  status: "active",
};

/** Archived endpoints carry archivedAt and are absent from the default list. */
const ARCHIVED = {
  id: "22222222-2222-2222-2222-222222222222",
  slug: "old-bot",
  name: "Old bot",
  model: "openai/gpt-5.6-nano",
  status: "active",
  archivedAt: "2026-10-01T12:34:56Z",
};

const ORG_ARCHIVED = {
  id: "33333333-3333-3333-3333-333333333333",
  slug: "team-bot",
  name: "Team bot",
  model: "anthropic/claude-sonnet-5",
  status: "active",
  companyId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  archivedAt: "2026-10-02T08:00:00Z",
};

const COMPANY = { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", slug: "omniaura", name: "Omni Aura", role: "admin" };

/**
 * Stub of the endpoint list (live and ?archived=true, personal and per org),
 * archive (DELETE) and unarchive (POST …/unarchive). `unarchive` decides the
 * POST's reply so a test can return the backend's refusals.
 */
function startStub({ unarchive } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => {
        res.statusCode = status;
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const list = (endpoints) => json(200, { baseUrl: "https://api.example.test/v1", endpoints, limit: 5, used: 1 });
      if (req.method === "GET" && req.url === "/api/v5/companies") return json(200, { companies: [COMPANY] });
      if (req.method === "GET" && req.url === "/api/v5/inference/endpoints") return list([LIVE]);
      if (req.method === "GET" && req.url === `/api/v5/inference/endpoints?company=${COMPANY.id}`) return list([]);
      if (req.method === "GET" && req.url === "/api/v5/inference/endpoints?archived=true") return list([ARCHIVED]);
      if (req.method === "GET" && req.url === `/api/v5/inference/endpoints?archived=true&company=${COMPANY.id}`) {
        return list([ORG_ARCHIVED]);
      }
      if (req.method === "DELETE" && /^\/api\/v5\/inference\/endpoints\/[^/]+$/.test(req.url)) return json(204);
      const m = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)\/unarchive$/);
      if (m && req.method === "POST") {
        if (unarchive) return unarchive(m[1], json);
        const found = [ARCHIVED, ORG_ARCHIVED].find((e) => e.id === m[1]);
        if (!found) return json(404, { message: "inference endpoint not found" });
        const { archivedAt: _, ...restored } = found;
        return json(200, restored);
      }
      json(404, { message: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/** Runs the CLI with stdin closed so a confirmation prompt fails rather than hangs. */
function run(base, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DITTO_API_KEY: "ditto_mcp_test",
      DITTO_API_BASE: base,
      DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-archive-")),
    },
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const unarchivePosts = (stub) => stub.calls.filter((c) => c.method === "POST" && c.url.endsWith("/unarchive"));

for (const verb of ["archive", "delete"]) {
  test(`endpoints ${verb} confirms, sends DELETE and states what archiving keeps`, async () => {
    const stub = await startStub();
    try {
      const refused = await run(stub.base, ["endpoints", verb, "alpha"]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /refusing to archive "alpha" without confirmation/);
      assert.ok(!stub.calls.some((c) => c.method === "DELETE"), "must not archive without confirmation");

      const out = await run(stub.base, ["endpoints", verb, "alpha", "--yes"]);
      assert.equal(out.status, 0, out.stderr);
      assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url === `/api/v5/inference/endpoints/${LIVE.id}`));
      assert.match(out.stdout, /Archived endpoint alpha/);
      assert.match(out.stdout, /keys stop working while archived/);
      assert.match(out.stdout, /threads, traces, usage and keys are kept/);
      assert.match(out.stdout, /heyditto endpoints unarchive alpha/);
    } finally {
      stub.close();
    }
  });
}

test("endpoints unarchive resolves the slug among ARCHIVED endpoints and POSTs unarchive", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "unarchive", "old-bot"]);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(stub.calls.some((c) => c.method === "GET" && c.url === "/api/v5/inference/endpoints?archived=true"));
    assert.deepEqual(unarchivePosts(stub).map((c) => c.url), [`/api/v5/inference/endpoints/${ARCHIVED.id}/unarchive`]);
    assert.match(out.stdout, /Restored endpoint old-bot/);
    assert.match(out.stdout, /Keys that were active when it was archived work again/);

    // An organization's archived endpoint resolves through ?archived=true&company=.
    const org = await run(stub.base, ["endpoints", "unarchive", "team-bot"]);
    assert.equal(org.status, 0, org.stderr);
    assert.ok(unarchivePosts(stub).some((c) => c.url === `/api/v5/inference/endpoints/${ORG_ARCHIVED.id}/unarchive`));
  } finally {
    stub.close();
  }
});

test("endpoints unarchive refuses a live endpoint's slug without calling the API, and accepts a raw id", async () => {
  const stub = await startStub();
  try {
    const live = await run(stub.base, ["endpoints", "unarchive", "alpha"]);
    assert.notEqual(live.status, 0);
    assert.match(live.stderr, /no archived endpoint named "alpha"/);
    assert.equal(unarchivePosts(stub).length, 0, "a live slug must not reach the unarchive route");

    const byId = await run(stub.base, ["endpoints", "unarchive", ARCHIVED.id]);
    assert.equal(byId.status, 0, byId.stderr);
    assert.deepEqual(unarchivePosts(stub).map((c) => c.url), [`/api/v5/inference/endpoints/${ARCHIVED.id}/unarchive`]);
  } finally {
    stub.close();
  }
});

test("endpoints unarchive explains 409 endpoint_slug_taken, the slot limit and 404", async () => {
  const cases = [
    [
      (_id, json) => json(409, { code: "endpoint_slug_taken", message: "a live endpoint already uses this slug; archive or rename it, then try again" }),
      /a live endpoint now uses the slug "old-bot"\. Archive or rename that endpoint/,
    ],
    [(_id, json) => json(402, { message: "inference endpoint limit reached" }), /no free endpoint slot.*upgrade your plan/],
    [(_id, json) => json(404, { message: "inference endpoint not found" }), /no archived endpoint "old-bot" you can restore/],
  ];
  for (const [unarchive, expected] of cases) {
    const stub = await startStub({ unarchive });
    try {
      const out = await run(stub.base, ["endpoints", "unarchive", "old-bot"]);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, expected);
      assert.equal(unarchivePosts(stub).length, 1);
    } finally {
      stub.close();
    }
  }
});

test("endpoints list --archived shows archived endpoints with archivedAt; the default list is unchanged", async () => {
  const stub = await startStub();
  try {
    const table = await run(stub.base, ["endpoints", "list", "--archived"]);
    assert.equal(table.status, 0, table.stderr);
    assert.match(table.stdout, /ARCHIVED/);
    assert.match(table.stdout, /old-bot\s+openai\/gpt-5\.6-nano\s+2026-10-01 12:34/);
    assert.match(table.stdout, /team-bot/);
    assert.doesNotMatch(table.stdout, /\balpha\b/);

    const json = await run(stub.base, ["endpoints", "list", "--archived", "--output", "json"]);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed.endpoints.map((e) => [e.slug, e.archivedAt]), [
      ["old-bot", ARCHIVED.archivedAt],
      ["team-bot", ORG_ARCHIVED.archivedAt],
    ]);

    const live = await run(stub.base, ["endpoints", "list"]);
    assert.equal(live.status, 0, live.stderr);
    assert.match(live.stdout, /alpha/);
    assert.doesNotMatch(live.stdout, /old-bot/);
  } finally {
    stub.close();
  }
});
