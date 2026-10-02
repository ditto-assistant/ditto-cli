import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const APP_ID = "acme-tool";
const SAM = { subjectType: "user", subjectId: "uid-sam", email: "sam@contractor.example", companyName: "", external: true, createdAt: "2026-09-30T00:00:00Z" };

// A stateful stand-in for the app access routes: visibility/trust/client type
// on the app, the share list, and the backend's 409 for an unacknowledged
// share outside the owning organization.
function startStub({ visibility = "internal", shares = [] } = {}) {
  const state = { access: { visibility, clientType: "server", trusted: false }, shares: [...shares] };
  const calls = [];
  const app = () => ({ appID: APP_ID, name: "Acme Tool", slug: APP_ID, kind: "app", enabled: true, archived: false, createdAt: "2026-09-01T00:00:00Z", access: { ...state.access } });
  const sharesBody = () => ({ visibility: state.access.visibility, externalCount: state.shares.filter((s) => s.external).length, shares: state.shares });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = body ? JSON.parse(body) : undefined;
      calls.push({ method: req.method, url: req.url, body: input });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => {
        res.statusCode = status;
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      const base = `/api/v5/admin/apps/${APP_ID}`;
      if (req.url === "/api/v5/admin/apps" && req.method === "GET") return json(200, { apps: [app()] });
      if (req.url === base && req.method === "PATCH") {
        for (const k of ["visibility", "clientType", "trusted"]) if (input[k] !== undefined) state.access[k] = input[k];
        return json(200, app());
      }
      if (req.url === `${base}/shares` && req.method === "GET") return json(200, sharesBody());
      if (req.url === `${base}/shares` && req.method === "POST") {
        const external = (input.email ?? "").endsWith("@contractor.example") || input.companySlug === "partner";
        if (external && !input.acknowledgeExternal) {
          return json(409, { message: "This person isn't in the organization that owns the app.", code: "app_share_external_unacknowledged", ref: "r1", status: 409 });
        }
        state.shares.push(input.email ? { ...SAM, email: input.email, external } : { subjectType: "company", subjectId: "co-partner", companyName: "Partner", external, createdAt: "2026-10-01T00:00:00Z" });
        if (state.access.visibility === "internal") state.access.visibility = "shared";
        return json(200, sharesBody());
      }
      const del = req.url.match(new RegExp(`^${base}/shares/(user|company)/(.+)$`));
      if (del && req.method === "DELETE") {
        state.shares = state.shares.filter((s) => !(s.subjectType === del[1] && s.subjectId === decodeURIComponent(del[2])));
        res.writeHead(204);
        return res.end();
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, calls, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function baseEnv(stub) {
  return { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-access-")), NO_COLOR: "1" };
}

test("apps access shows visibility, trust, client type and flags external shares", async () => {
  const stub = await startStub({ visibility: "shared", shares: [SAM] });
  try {
    const out = await run(["apps", "access", APP_ID], baseEnv(stub));
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /who can sign in: shared/);
    assert.match(out.stdout, /1 outside the organization/);
    assert.match(out.stdout, /sam@contractor\.example\s+person\s+yes/);

    const json = JSON.parse((await run(["apps", "access", "show", APP_ID, "--output", "json"], baseEnv(stub))).stdout);
    assert.equal(json.access.visibility, "shared");
    assert.equal(json.shares.externalCount, 1);
  } finally {
    await stub.close();
  }
});

test("apps access on an internal app says kept shares are paused", async () => {
  const stub = await startStub({ visibility: "internal", shares: [SAM] });
  try {
    const out = await run(["apps", "access", APP_ID], baseEnv(stub));
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /paused while the app is internal/);
  } finally {
    await stub.close();
  }
});

test("apps share outside the organization needs --external, then makes the app shared", async () => {
  const stub = await startStub();
  try {
    const refused = await run(["apps", "share", APP_ID, "sam@contractor.example"], baseEnv(stub));
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /outside the organization/);
    assert.match(refused.stderr, /--external/);
    assert.equal(stub.state.shares.length, 0);

    const done = await run(["apps", "share", APP_ID, "sam@contractor.example", "--external"], baseEnv(stub));
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /The app is now shared/);
    const post = stub.calls.filter((c) => c.method === "POST").at(-1);
    assert.deepEqual(post.body, { email: "sam@contractor.example", acknowledgeExternal: true });

    await run(["apps", "share", APP_ID, "@partner", "--external"], baseEnv(stub));
    assert.deepEqual(stub.calls.filter((c) => c.method === "POST").at(-1).body, { companySlug: "partner", acknowledgeExternal: true });
  } finally {
    await stub.close();
  }
});

test("narrowing the audience asks for the app id unless --yes; widening does not", async () => {
  const stub = await startStub({ visibility: "shared" });
  try {
    const refused = await run(["apps", "access", "set", APP_ID, "--visibility", "internal"], baseEnv(stub));
    assert.notEqual(refused.code, 0);
    assert.ok(!stub.calls.some((c) => c.method === "PATCH"), "nothing changed without confirmation");

    const done = await run(["apps", "access", "set", APP_ID, "--visibility", "internal", "--trusted", "--yes"], baseEnv(stub));
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(stub.calls.find((c) => c.method === "PATCH").body, { visibility: "internal", trusted: true });

    const widen = await run(["apps", "access", "set", APP_ID, "--visibility", "shared"], baseEnv(stub));
    assert.equal(widen.code, 0, widen.stderr);
    assert.equal(stub.state.access.visibility, "shared");

    const clientType = await run(["apps", "access", "set", APP_ID, "--client-type", "public"], baseEnv(stub));
    assert.notEqual(clientType.code, 0, "a client-type switch is confirmed too");
    assert.equal(stub.state.access.clientType, "server");
  } finally {
    await stub.close();
  }
});

test("apps unshare finds the share by email and confirms", async () => {
  const stub = await startStub({ visibility: "shared", shares: [SAM] });
  try {
    const missing = await run(["apps", "unshare", APP_ID, "nobody@example.com", "--yes"], baseEnv(stub));
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /Shared with: sam@contractor\.example/);

    const refused = await run(["apps", "unshare", APP_ID, "sam@contractor.example"], baseEnv(stub));
    assert.notEqual(refused.code, 0);
    assert.equal(stub.state.shares.length, 1);

    const done = await run(["apps", "unshare", APP_ID, "SAM@contractor.example", "--yes"], baseEnv(stub));
    assert.equal(done.code, 0, done.stderr);
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/shares/user/uid-sam")));
    assert.equal(stub.state.shares.length, 0);
  } finally {
    await stub.close();
  }
});
