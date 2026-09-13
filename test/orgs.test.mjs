import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const OMNI = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  slug: "omni-aura",
  name: "Omni Aura",
  kind: "company",
  role: "owner",
};
const KLYRO = {
  id: "aaaaaaaa-0000-0000-0000-000000000002",
  slug: "klyro",
  name: "Klyro Labs",
  kind: "company",
  role: "member",
};

const LINEAR = {
  id: "conn-linear",
  companyId: OMNI.id,
  name: "Linear",
  transport: "streamable_http",
  prefix: "linear",
  oauthStatus: "connected",
  enabled: true,
  config: { url: "https://mcp.linear.app/mcp", authType: "oauth", headerNames: [] },
};
const INTERNAL = {
  id: "conn-internal",
  companyId: OMNI.id,
  name: "Internal tools",
  transport: "sse",
  prefix: "internal_tools",
  oauthStatus: "",
  enabled: false,
  config: { url: "https://tools.internal/mcp", authType: "headers", headerNames: ["Authorization"] },
};

const APPROVALS = [
  {
    id: "ap-1",
    status: "pending",
    companyId: OMNI.id,
    requestId: "req-1",
    seq: 1,
    toolName: "github__delete_repo",
    toolTitle: "Delete repository",
    summary: "github__delete_repo(repo: legacy)",
    tier: "gated",
    tierSource: "annotations",
  },
  {
    id: "ap-2",
    status: "pending",
    companyId: OMNI.id,
    requestId: "req-1",
    seq: 0,
    toolName: "linear__delete_issue",
    toolTitle: "Delete issue",
    summary: "linear__delete_issue(id: ENG-402)",
    tier: "gated",
    tierSource: "heuristic",
  },
];

/** Stubs the organization, connection and approval routes the CLI calls. */
/**
 * The backend's bearer-key auth rules, mirrored from ditto-assistant/backend
 * main.go (`middleware.WithBearerKeyAuth`).
 *
 * This stub used to accept any request with any token, which meant the whole
 * suite passed against a server shape that does not exist: five of the six
 * routes these commands call were never registered for `ditto_mcp_` keys and
 * answered 401 in production, and nothing here could see it. A stub that
 * authenticates nothing cannot catch an auth-routing bug, so it now enforces
 * the same (path prefix, methods) grants the real middleware does.
 *
 * Keep this list in sync with main.go. If a new command needs a route that is
 * not here, the correct fix is a backend PR that registers it — not a wider
 * rule in this file.
 */
const BEARER_KEY_RULES = [
  { prefix: "/api/v5/inference/", methods: null },
  { prefix: "/api/v5/chat-agents", methods: null },
  { prefix: "/api/v5/tool-approvals", methods: ["GET", "POST"] },
  // Read-only: this prefix also covers member management, invitations and a
  // credits transfer that moves money, none of which belong to a stored key.
  { prefix: "/api/v5/companies", methods: ["GET"] },
  // A `*` matches exactly one segment, so an organization's tool connections
  // are reachable for writes without opening its siblings.
  { prefix: "/api/v5/companies/*/mcp-servers", methods: null },
  { prefix: "/api/v2/mcp/servers/", methods: ["GET", "POST"] },
];

/** Whether a ditto_mcp_ key is accepted on this method+path at all. */
function bearerKeyAccepted(method, url) {
  const path = url.split("?")[0];
  return BEARER_KEY_RULES.some((rule) => {
    if (rule.methods !== null && !rule.methods.includes(method)) return false;
    if (!rule.prefix.includes("*")) return path.startsWith(rule.prefix);
    const want = rule.prefix.replace(/^\/|\/$/g, "").split("/");
    const got = path.replace(/^\/|\/$/g, "").split("/");
    if (got.length < want.length) return false;
    return want.every((segment, i) => (segment === "*" ? !!got[i] : got[i] === segment));
  });
}

function startStub({ companies = [OMNI, KLYRO], canManage = true, canDecide = true } = {}) {
  const calls = [];
  const connections = [structuredClone(LINEAR), structuredClone(INTERNAL)];
  const approvals = structuredClone(APPROVALS);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : undefined;
      calls.push({ method: req.method, url: req.url, body: parsed });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => {
        res.statusCode = status;
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };

      // Auth first, exactly as the real middleware does. A CLI key on a route
      // nobody registered is a 401 before any handler runs.
      const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
      if (!token.startsWith("ditto_mcp_")) {
        return json(401, { message: "unauthorized", status: 401 });
      }
      if (!bearerKeyAccepted(req.method, req.url)) {
        return json(401, { message: "unauthorized", status: 401 });
      }

      if (req.url === "/api/v5/companies" && req.method === "GET") {
        return json(200, { companies });
      }
      const list = req.url.match(/^\/api\/v5\/companies\/([^/]+)\/mcp-servers$/);
      if (list && req.method === "GET") return json(200, { servers: connections, canManage });
      if (list && req.method === "POST") {
        if (!canManage) return json(403, { message: "this action requires the owner or admin role" });
        const created = {
          id: "conn-new",
          companyId: list[1],
          name: parsed.name,
          transport: parsed.transport,
          prefix: String(parsed.name).toLowerCase().replace(/[^a-z0-9]+/g, "_"),
          oauthStatus: parsed.config?.authType === "oauth" ? "not_connected" : "",
          enabled: true,
          config: {
            url: parsed.config?.url ?? "",
            authType: parsed.config?.authType ?? "oauth",
            headerNames: Object.keys(parsed.config?.headers ?? {}),
          },
        };
        connections.push(created);
        return json(201, created);
      }
      const one = req.url.match(/^\/api\/v5\/companies\/([^/]+)\/mcp-servers\/([^/]+)$/);
      if (one && req.method === "DELETE") {
        if (!canManage) return json(403, { message: "this action requires the owner or admin role" });
        return json(204);
      }
      if (one && req.method === "PATCH") {
        const found = connections.find((c) => c.id === one[2]);
        if (found && parsed.enabled !== undefined) found.enabled = parsed.enabled;
        return json(200, found);
      }
      if (req.url.startsWith("/api/v5/tool-approvals") && req.method === "GET") {
        return json(200, {
          approvals: approvals.filter((a) => a.status === "pending"),
          canDecide,
        });
      }
      const decide = req.url.match(/^\/api\/v5\/tool-approvals\/([^/]+)\/(approve|reject)$/);
      if (decide && req.method === "POST") {
        const found = approvals.find((a) => a.id === decide[1]);
        if (!found) return json(404, { message: "tool approval not found" });
        found.status = decide[2] === "approve" ? "applied" : "rejected";
        return json(200, found);
      }
      json(404, {});
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

/**
 * Async `spawn`, not `spawnSync`.
 *
 * The stub HTTP server runs on this process's event loop, and `spawnSync`
 * blocks it — so the child's request could never be accepted and both sides
 * would wait forever. The funnel tests use `spawn` for the same reason.
 */
function run(base, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // A realistically shaped first-party key. The stub enforces the
        // backend's bearer-key prefix, and "test-key" would be rejected there
        // exactly as it would be in production.
        DITTO_API_KEY: "ditto_mcp_testkey",
        DITTO_API_BASE: base,
        DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-org-")),
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("orgs lists the organizations you belong to, with your role", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["orgs"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /omni-aura/);
    assert.match(result.stdout, /owner/);
    assert.match(result.stdout, /klyro/);
    assert.match(result.stdout, /member/);
  } finally {
    stub.close();
  }
});

test("orgs use remembers the organization so --org can be omitted", async () => {
  const stub = await startStub();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-org-"));
  try {
    const set = await run(stub.base, ["orgs", "use", "omni-aura"], { DITTO_CONFIG_DIR: configDir });
    assert.equal(set.status, 0, set.stderr);
    const listed = await run(stub.base, ["mcp", "list"], { DITTO_CONFIG_DIR: configDir });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /Linear/);
  } finally {
    stub.close();
  }
});

// A 404 that leaves you guessing whether you typed it wrong or were never a
// member is a bad error. Name the organizations they ARE in.
test("an unknown --org names the organizations you do belong to", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["mcp", "list", "--org", "nope"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a member of an organization called "nope"/);
    assert.match(result.stderr, /omni-aura/);
  } finally {
    stub.close();
  }
});

test("a command that needs an organization says how to give it one", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["mcp", "list"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--org <slug>/);
    assert.match(result.stderr, /heyditto orgs use/);
  } finally {
    stub.close();
  }
});

test("mcp list shows each connection's tool prefix and live state", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["mcp", "list", "--org", "omni-aura"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /linear__/);
    assert.match(result.stdout, /connected/);
    // A paused connection is not "ready" — its endpoints cannot use it.
    assert.match(result.stdout, /paused/);
  } finally {
    stub.close();
  }
});

test("mcp add defaults to OAuth and streamable HTTP", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, [
      "mcp",
      "add",
      "Notion",
      "https://mcp.notion.com/mcp",
      "--org",
      "omni-aura",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const post = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/mcp-servers"));
    assert.ok(post, "expected a create call");
    assert.equal(post.body.transport, "streamable_http");
    assert.equal(post.body.config.authType, "oauth");
    // The next step is not obvious, so the CLI says it.
    assert.match(result.stderr, /heyditto mcp connect Notion/);
  } finally {
    stub.close();
  }
});

test("mcp add --auth headers requires a header and sends it", async () => {
  const stub = await startStub();
  try {
    const missing = await run(stub.base, [
      "mcp", "add", "Internal", "https://tools.internal/mcp",
      "--org", "omni-aura", "--auth", "headers",
    ]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--header/);

    const ok = await run(stub.base, [
      "mcp", "add", "Internal", "https://tools.internal/mcp",
      "--org", "omni-aura", "--auth", "headers",
      "--header", "Authorization: Bearer secret-value",
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    const post = stub.calls.filter((c) => c.method === "POST" && c.url.endsWith("/mcp-servers")).pop();
    assert.equal(post.body.config.headers.Authorization, "Bearer secret-value");
    // The value went to the server and must not come back out at the terminal.
    assert.ok(!ok.stdout.includes("secret-value"), ok.stdout);
    assert.ok(!ok.stderr.includes("secret-value"), ok.stderr);
  } finally {
    stub.close();
  }
});

// The CLI does not re-implement the role check. It sends the request and shows
// what the server said, so the two can never disagree.
test("a member's refusal comes from the server, not from the client", async () => {
  const stub = await startStub({ canManage: false });
  try {
    const result = await run(stub.base, [
      "mcp", "add", "Notion", "https://mcp.notion.com/mcp", "--org", "omni-aura",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /owner or admin role/);
  } finally {
    stub.close();
  }
});

test("approvals says nothing has run, and how to decide", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["approvals", "--org", "omni-aura"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Delete repository/);
    assert.match(result.stderr, /None of these has run/);
    // The reading people reach for, and it is wrong.
    assert.match(result.stderr, /does not\n?resume the run/);
  } finally {
    stub.close();
  }
});

// "The server declared it" and "we guessed from the name" are different
// evidence for the same decision.
test("approvals distinguishes a declared classification from an inferred one", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["approvals", "--org", "omni-aura"]);
    assert.match(result.stdout, /server-declared/);
    assert.match(result.stdout, /name heuristic/);
  } finally {
    stub.close();
  }
});

test("approvals allow runs one held call", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["approvals", "allow", "ap-1", "--org", "omni-aura"]);
    assert.equal(result.status, 0, result.stderr);
    const post = stub.calls.find((c) => c.url === "/api/v5/tool-approvals/ap-1/approve");
    assert.ok(post, "expected an approve call");
    assert.match(result.stderr, /Delete repository ran/);
  } finally {
    stub.close();
  }
});

// One run_code script can hold several tools, and to the operator that is one
// decision. They are applied in the order the script made them.
test("approvals allow --request decides a whole request, in sequence order", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, [
      "approvals", "allow", "--request", "req-1", "--org", "omni-aura",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const approved = stub.calls
      .filter((c) => c.url.endsWith("/approve"))
      .map((c) => c.url.split("/")[4]);
    assert.deepEqual(approved, ["ap-2", "ap-1"]);
  } finally {
    stub.close();
  }
});

test("approvals deny refuses without running the tool", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["approvals", "deny", "ap-1", "--org", "omni-aura"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(stub.calls.some((c) => c.url === "/api/v5/tool-approvals/ap-1/reject"));
    assert.ok(!stub.calls.some((c) => c.url.endsWith("/approve")));
    assert.match(result.stderr, /was not run/);
  } finally {
    stub.close();
  }
});

test("approvals with neither an id nor --request explains what it needs", async () => {
  const stub = await startStub();
  try {
    const result = await run(stub.base, ["approvals", "allow", "--org", "omni-aura"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--request/);
  } finally {
    stub.close();
  }
});

test("--output json is machine-readable on every new command", async () => {
  const stub = await startStub();
  try {
    for (const args of [
      ["orgs", "--output", "json"],
      ["mcp", "list", "--org", "omni-aura", "--output", "json"],
      ["approvals", "--org", "omni-aura", "--output", "json"],
    ]) {
      const result = await run(stub.base, args);
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.doesNotThrow(() => JSON.parse(result.stdout), `${args.join(" ")} emitted non-JSON`);
    }
  } finally {
    stub.close();
  }
});

// Reading an organization endpoint's queue is wider than deciding it. Saying so
// here beats letting `approvals allow` answer 404 to someone who just read the
// row on screen.
test("approvals tells a read-only viewer they cannot decide", async () => {
  const stub = await startStub({ canDecide: false });
  try {
    const result = await run(stub.base, ["approvals", "--org", "omni-aura"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Delete repository/);
    assert.match(result.stderr, /see these but not decide them/);
    // The commands it cannot run must not be advertised.
    assert.doesNotMatch(result.stderr, /heyditto approvals allow </);
  } finally {
    stub.close();
  }
});

test("approvals --output json carries canDecide", async () => {
  const stub = await startStub({ canDecide: false });
  try {
    const result = await run(stub.base, ["approvals", "--org", "omni-aura", "--output", "json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).canDecide, false);
  } finally {
    stub.close();
  }
});

// Every route these commands call must be one the backend accepts a first-party
// key on.
//
// This is the assertion that was missing when five of six routes answered 401 in
// production: the stub above accepted anything, so the suite proved only that
// the CLI formats a response it would never receive. Enumerating the calls
// against the same rules the middleware applies turns "did we register it" into
// a test rather than a code review.
test("every route the org commands call accepts a first-party CLI key", () => {
  const calls = [
    ["GET", "/api/v5/companies"],
    ["GET", `/api/v5/companies/${OMNI.id}/mcp-servers`],
    ["POST", `/api/v5/companies/${OMNI.id}/mcp-servers`],
    ["PATCH", `/api/v5/companies/${OMNI.id}/mcp-servers/conn-linear`],
    ["DELETE", `/api/v5/companies/${OMNI.id}/mcp-servers/conn-linear`],
    ["GET", "/api/v5/tool-approvals"],
    ["GET", `/api/v5/tool-approvals?company=${OMNI.id}`],
    ["POST", "/api/v5/tool-approvals/approval-1/approve"],
    ["POST", "/api/v5/tool-approvals/approval-1/reject"],
    ["POST", "/api/v2/mcp/servers/conn-linear/oauth/start"],
    ["GET", "/api/v5/inference/endpoints"],
    ["GET", "/api/v5/inference/endpoints/ep-1/tools"],
  ];
  for (const [method, url] of calls) {
    assert.equal(bearerKeyAccepted(method, url), true, `${method} ${url} must accept a CLI key`);
  }
});

// And the grants stay as narrow as the commands need. A stored key must not
// reach an organization's members, invitations or money just because it can
// list the organization.
test("a CLI key does not reach the rest of the organization surface", () => {
  for (const [method, url] of [
    ["POST", "/api/v5/companies"],
    ["POST", `/api/v5/companies/${OMNI.id}/credits/transfer`],
    ["POST", `/api/v5/companies/${OMNI.id}/members`],
    ["DELETE", `/api/v5/companies/${OMNI.id}/members/someone`],
    ["POST", `/api/v5/companies/${OMNI.id}/invites`],
    ["GET", "/api/v5/admin/feature-flags"],
  ]) {
    assert.equal(bearerKeyAccepted(method, url), false, `${method} ${url} must NOT accept a CLI key`);
  }
});
