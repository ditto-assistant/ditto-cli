import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ORG = { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", slug: "omniaura", name: "Omni Aura", kind: "company", role: "admin" };
const PROMPT = "You are an autonomous coding agent. Merge when CI is green.\n";

/** A stateful endpoints API: personal endpoints carry no companyId, org ones carry ORG.id. */
function startStub(initial = []) {
  const endpoints = initial.map((e) => ({ ...e }));
  const writes = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status, payload) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
      };
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/api/v5/companies") return json(200, { companies: [ORG] });
      if (url.pathname === "/api/v5/inference/endpoints" && req.method === "GET") {
        const company = url.searchParams.get("company");
        // Like the backend: the bare listing is every endpoint the caller CREATED,
        // org-filed ones included, so ownership must be read from companyId.
        const list = company ? endpoints.filter((e) => e.companyId === company) : endpoints;
        return json(200, { baseUrl: "https://router.example.test/v1", endpoints: list });
      }
      if (url.pathname === "/api/v5/inference/endpoints" && req.method === "POST") {
        const input = JSON.parse(body);
        writes.push({ method: "POST", body: input });
        const created = { id: `ep-${endpoints.length + 1}`, status: "active", model: "default/model", providerOptions: {}, ...input };
        endpoints.push(created);
        return json(201, created);
      }
      const m = url.pathname.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)$/);
      if (m && req.method === "PATCH") {
        const input = JSON.parse(body);
        writes.push({ method: "PATCH", id: m[1], body: input });
        const e = endpoints.find((x) => x.id === m[1]);
        Object.assign(e, input);
        return json(200, e);
      }
      return json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, endpoints, writes, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

function run(args, base, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DITTO_API_BASE: base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: path.join(cwd, ".heyditto-config") };
    delete env.DITTO_ENDPOINT;
    const child = spawn(process.execPath, [cliPath, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function repo(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heyditto-profile-"));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
}

const CONFIG = `version = 1\n[repository]\nname = "stack"\ndefault_endpoint = "dev"\n`;
const ORG_PROFILE = `managed = true
name = "dev"
slug = "ditto-dev"
model = "openai/gpt-6.1-sol"
[settings]
owner = "@omniaura"
model_mode = "passthrough"
code_mode = true
kind_routes = { aside = "z-ai/glm-5.3-flash" }
claude_prompt = { file = "../prompts/claude.md", mode = "replace" }
`;

test("repo apply creates an org profile with the checked-in prompt, then is a no-op", async () => {
  const stub = await startStub();
  const dir = await repo({ ".ditto/config.toml": CONFIG, ".ditto/endpoints/dev.toml": ORG_PROFILE, ".ditto/prompts/claude.md": PROMPT });
  try {
    const dry = await run(["repo", "apply", "--dry-run"], stub.base, dir);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dev -> @omniaura\/ditto-dev: create \(dry run\)/);
    assert.equal(stub.writes.length, 0, "a dry run writes nothing");

    const first = await run(["repo", "apply"], stub.base, dir);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(stub.writes.length, 1);
    const sent = stub.writes[0];
    assert.equal(sent.method, "POST");
    assert.equal(sent.body.companyId, ORG.id, "an @org profile is filed under that organization");
    assert.equal(sent.body.slug, "ditto-dev");
    assert.equal(sent.body.model, "openai/gpt-6.1-sol");
    assert.equal(sent.body.modelMode, "passthrough");
    assert.equal(sent.body.codeMode, true);
    assert.deepEqual(sent.body.kindRoutes, { aside: "z-ai/glm-5.3-flash" });
    assert.equal(sent.body.providerOptions.claude_system_prompt, PROMPT, "the prompt file's exact bytes");
    assert.equal(sent.body.providerOptions.claude_prompt_mode, "replace");

    const again = await run(["repo", "apply"], stub.base, dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /ditto-dev: unchanged/);
    assert.equal(stub.writes.length, 1, "an unchanged profile writes nothing");
  } finally {
    stub.close();
  }
});

test("repo apply patches only what differs and keeps unrelated provider options", async () => {
  const stub = await startStub([
    { id: "ep-org", slug: "ditto-dev", companyId: ORG.id, model: "openai/gpt-6.1-sol", modelMode: "passthrough", codeMode: true,
      kindRoutes: { aside: "z-ai/glm-5.3-flash" }, tools: ["search_web", "jira__get_issue"],
      providerOptions: { claude_system_prompt: "old prompt", claude_prompt_mode: "replace", excluded_providers: ["chutes"] } },
  ]);
  const dir = await repo({ ".ditto/config.toml": CONFIG, ".ditto/endpoints/dev.toml": ORG_PROFILE, ".ditto/prompts/claude.md": PROMPT });
  try {
    const out = await run(["repo", "apply"], stub.base, dir);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(stub.writes.length, 1);
    const { method, id, body } = stub.writes[0];
    assert.equal(method, "PATCH");
    assert.equal(id, "ep-org");
    assert.deepEqual(Object.keys(body), ["providerOptions"], "only the prompt changed");
    assert.equal(body.providerOptions.claude_system_prompt, PROMPT);
    assert.deepEqual(body.providerOptions.excluded_providers, ["chutes"], "options the profile does not name survive");
    assert.ok(!("tools" in body), "a tool list the profile does not declare is left alone");
  } finally {
    stub.close();
  }
});

test("a personal profile lands in the caller's own account even when an org endpoint shares the slug", async () => {
  const stub = await startStub([{ id: "ep-org", slug: "dev", companyId: ORG.id, model: "m", providerOptions: {} }]);
  const dir = await repo({
    ".ditto/config.toml": CONFIG,
    ".ditto/endpoints/dev.toml": `managed = true\nname = "dev"\nmodel = "anthropic/claude-sonnet-5"\n`,
  });
  try {
    const out = await run(["repo", "apply"], stub.base, dir);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(stub.writes.length, 1);
    assert.equal(stub.writes[0].method, "POST", "the org's endpoint is not someone's personal profile");
    assert.equal(stub.writes[0].body.companyId, undefined);
  } finally {
    stub.close();
  }
});

test("repo apply refuses an unknown setting and an org the caller is not in", async () => {
  const stub = await startStub();
  try {
    const typo = await repo({ ".ditto/config.toml": CONFIG, ".ditto/endpoints/dev.toml": `managed = true\nname = "dev"\n[settings]\nmodle_mode = "passthrough"\n` });
    const a = await run(["repo", "apply"], stub.base, typo);
    assert.notEqual(a.status, 0);
    assert.match(a.stderr, /modle_mode: unknown setting/);
    const stranger = await repo({ ".ditto/config.toml": CONFIG, ".ditto/endpoints/dev.toml": `managed = true\nname = "dev"\n[settings]\nowner = "@acme"\n` });
    const b = await run(["repo", "apply"], stub.base, stranger);
    assert.notEqual(b.status, 0);
    assert.match(b.stderr, /requires organization @acme/);
    assert.equal(stub.writes.length, 0);
  } finally {
    stub.close();
  }
});

test("a launch with no --endpoint uses the repository's profile; --endpoint still wins", async () => {
  const stub = await startStub([
    { id: "ep-personal", slug: "alpha", model: "m", status: "active", providerOptions: {} },
    { id: "ep-org", slug: "ditto-dev", companyId: ORG.id, model: "m", status: "active", providerOptions: {} },
  ]);
  const dir = await repo({ ".ditto/config.toml": CONFIG, ".ditto/endpoints/dev.toml": ORG_PROFILE, ".ditto/prompts/claude.md": PROMPT });
  const nested = path.join(dir, "workspaces", "task");
  await mkdir(nested, { recursive: true });
  try {
    const fromRepo = await run(["claude", "--dry-run"], stub.base, nested);
    assert.equal(fromRepo.status, 0, fromRepo.stderr);
    assert.equal(JSON.parse(fromRepo.stdout).endpoint.slug, "ditto-dev");
    assert.match(fromRepo.stderr, /using @omniaura\/ditto-dev from /);
    const explicit = await run(["claude", "--dry-run", "--endpoint", "alpha"], stub.base, nested);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(JSON.parse(explicit.stdout).endpoint.slug, "alpha");
  } finally {
    stub.close();
  }
});

test("a launch names the apply command when the repository's profile does not exist yet", async () => {
  const stub = await startStub([{ id: "ep-personal", slug: "alpha", model: "m", status: "active", providerOptions: {} }]);
  const dir = await repo({ ".ditto/config.toml": CONFIG, ".ditto/endpoints/dev.toml": ORG_PROFILE, ".ditto/prompts/claude.md": PROMPT });
  try {
    const out = await run(["claude", "--dry-run"], stub.base, dir);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /heyditto repo apply --profile dev/);
  } finally {
    stub.close();
  }
});
