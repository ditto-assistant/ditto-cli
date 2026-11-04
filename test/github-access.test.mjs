import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const COMPANY = { id: "22222222-2222-2222-2222-222222222222", slug: "omni-aura", name: "Omni Aura", kind: "company", role: "owner" };
const EXISTING = { id: "33333333-3333-3333-3333-333333333333", fullName: "acme/console", endpointId: "44444444-4444-4444-4444-444444444444", revision: 1 };
const CONFIGURE = "https://github.com/organizations/acme/settings/installations/7";
const INSTALL = "https://github.com/apps/ditto-code/installations/new";

const granted = (repository) => ({ repository, owner: repository.split("/")[0], ownerType: "Organization", state: "granted", admin: true, installationId: 7 });
const notSelected = (repository, admin = true) => ({ repository, owner: "acme", ownerType: "Organization", state: "repository_not_selected", admin, installationId: 7, actionUrl: CONFIGURE, configureUrl: CONFIGURE });
const notInstalled = (repository) => ({ repository, owner: repository.split("/")[0], ownerType: "Organization", state: "not_installed", admin: false, actionUrl: INSTALL, installUrl: INSTALL });

/**
 * A fake Ditto API. `access(name, n)` answers the nth (0-based) access check
 * of a repository, which is how a grant made on GitHub mid-run is faked.
 */
function startStub({ access, linkRefusal = () => false }) {
  const calls = [];
  const checks = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); };
      const url = new URL(req.url, "http://stub");
      if (url.pathname === "/api/v5/companies") return json(200, { companies: [COMPANY] });
      if (url.pathname === "/api/v5/review/github-access" && req.method === "GET") {
        const repositories = url.searchParams.getAll("repository").map((name) => {
          const n = checks.get(name) ?? 0;
          checks.set(name, n + 1);
          return access(name, n);
        });
        return json(200, { repositories });
      }
      if (url.pathname === "/api/v5/review" && req.method === "GET") return json(200, { repositories: [EXISTING], runs: [] });
      if (url.pathname === "/api/v5/review/repositories" && req.method === "PUT") {
        const sent = JSON.parse(body);
        if (linkRefusal(sent.fullName)) {
          const problem = "Ditto could not link this repository. Check that your GitHub account is connected, that you are an admin of the repository, and that the Ditto Code app is installed on it with pull request write access.";
          return json(400, { message: "invalid Ditto Review configuration", fields: { fullName: problem }, params: { field: "fullName", problem } });
        }
        return json(200, { ...EXISTING, ...sent, id: "99999999-9999-9999-9999-999999999999", revision: 1 });
      }
      json(404, { message: "no route" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}`, calls,
      accessCalls: () => calls.filter((c) => c.url.startsWith("/api/v5/review/github-access")),
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

function run(base, args, cwd) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DITTO_API_KEY: "ditto_mcp_test", DITTO_API_BASE: base, DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-access-")) },
  });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("review access says which repositories Ditto Code cannot reach and prints the configure page once", async () => {
  const stub = await startStub({ access: (name) => (name === "acme/api" ? granted(name) : notSelected(name)) });
  try {
    const out = await run(stub.base, ["review", "access", "acme/api", "acme/web", "acme/docs"]);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stdout, /acme\/api: Ditto Code can access it\./);
    assert.match(out.stdout, /acme\/web, acme\/docs: Ditto Code cannot access these repositories\./);
    assert.match(out.stdout, /installed on acme, but these repositories are not in its selection/);
    assert.equal(out.stdout.split(`Open: ${CONFIGURE}`).length - 1, 1, "one page for one installation");
    assert.match(out.stdout, /keep "Only select repositories", add web, docs, then Save\. Repositories already selected stay selected\./);
    assert.match(out.stdout, /passkey/);
    assert.doesNotMatch(out.stdout, /All repositories"/, "all-repositories access is never the fallback");
    const [call] = stub.accessCalls();
    assert.deepEqual(new URL(call.url, "http://x").searchParams.getAll("repository"), ["acme/api", "acme/web", "acme/docs"]);
  } finally {
    stub.close();
  }
});

test("review access --all asks for All repositories only when the person says so, and flags non-admins", async () => {
  const stub = await startStub({ access: (name) => notInstalled(name) });
  try {
    const out = await run(stub.base, ["review", "access", "acme/api", "--all"]);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stdout, /not installed on acme/);
    assert.match(out.stdout, new RegExp(`Open: ${INSTALL.replaceAll("/", "\\/")}`));
    assert.match(out.stdout, /pick acme as the account to install on, then choose "All repositories"/);
    assert.match(out.stdout, /needs an owner of acme/);
  } finally {
    stub.close();
  }
});

test("review access --wait re-checks until GitHub reports access, then separates it from Review setup", async () => {
  const stub = await startStub({ access: (name, n) => (n < 2 ? notSelected(name) : granted(name)) });
  try {
    const out = await run(stub.base, ["review", "access", "acme/web", "--wait", "--interval", "1", "--timeout", "30"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(stub.accessCalls().length, 3, "first check, one re-check still pending, one granted");
    assert.match(out.stderr, /Waiting for GitHub access to acme\/web/);
    assert.match(out.stdout, /After re-checking:\nacme\/web: Ditto Code can access it\./);
    assert.match(out.stdout, /GitHub App access only\. To have Ditto Review pull requests, run: heyditto review add/);
    assert.equal(stub.calls.filter((c) => c.method !== "GET").length, 0, "checking access writes nothing and starts no review");
  } finally {
    stub.close();
  }
});

test("review access --output json is the machine shape and still exits 2 while access is missing", async () => {
  const stub = await startStub({ access: (name) => notSelected(name) });
  try {
    const out = await run(stub.base, ["review", "access", "acme/web", "--output", "json", "--wait", "--interval", "1", "--timeout", "1"]);
    assert.equal(out.status, 2, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.allGranted, false);
    assert.equal(parsed.repositories[0].actionUrl, CONFIGURE);
    assert.equal(parsed.repositories[0].state, "repository_not_selected");
  } finally {
    stub.close();
  }
});

test("review access defaults to the current checkout's GitHub origin", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-access-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:ditto-assistant/homebrew-tap.git"], { cwd: dir });
  const stub = await startStub({ access: (name) => granted(name) });
  try {
    const out = await run(stub.base, ["review", "access"], dir);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ditto-assistant\/homebrew-tap: Ditto Code can access it\./);
  } finally {
    stub.close();
  }
});

test("review add explains a refusal caused by missing Ditto Code app access, with the page to open", async () => {
  const stub = await startStub({ access: (name) => notSelected(name), linkRefusal: () => true });
  try {
    const out = await run(stub.base, ["review", "add", "acme/web", "--org", "omni-aura"]);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /Ditto Review could not be set up for acme\/web because the Ditto Code GitHub App cannot access it\./);
    assert.match(out.stderr, new RegExp(`Open: ${CONFIGURE.replaceAll("/", "\\/")}`));
    assert.match(out.stderr, /heyditto review access acme\/web --wait/);
    assert.equal(stub.calls.filter((c) => c.method === "PUT").length, 1, "no retry without the person returning");
  } finally {
    stub.close();
  }
});

test("review add keeps the backend's own refusal when app access is not the problem", async () => {
  const stub = await startStub({ access: (name) => granted(name), linkRefusal: () => true });
  try {
    const out = await run(stub.base, ["review", "add", "acme/web", "--org", "omni-aura"]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /PUT \/api\/v5\/review\/repositories.*HTTP 400 - invalid Ditto Review configuration/);
    assert.doesNotMatch(out.stderr, /cannot access it/);
  } finally {
    stub.close();
  }
});
