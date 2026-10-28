import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeCLIs } from "./helpers/fake-cli.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const ID = "11111111-1111-1111-1111-111111111111";
const EP = "22222222-2222-2222-2222-222222222222";
const COMPANY = "33333333-3333-3333-3333-333333333333";
const SECRET = "sk-proj-synthetic-provider-test-value";
const key = { id: ID, provider: "openai", label: "test", keyHint: "alue", enabled: true, configured: true };
// Mirrors providerkeys.Provider's wire shape, rather than a UI-only catalog.
const providers = [
  { id: "openai", displayName: "OpenAI", keyPrefixHints: ["sk-proj-", "sk-svcacct-", "sk-"], protocols: ["openai_chat"], requiresBaseUrl: false, modelDiscovery: true, balanceSupported: false, routable: true },
  { id: "anthropic", displayName: "Anthropic", keyPrefixHints: ["sk-ant-"], protocols: ["anthropic_messages"], requiresBaseUrl: false, modelDiscovery: true, balanceSupported: false, routable: true },
  { id: "openrouter", displayName: "OpenRouter", keyPrefixHints: ["sk-or-v1-"], protocols: ["openai_chat"], requiresBaseUrl: false, modelDiscovery: true, balanceSupported: true, routable: true },
  { id: "gm", displayName: "GM", protocols: ["openai_chat"], requiresBaseUrl: false, modelDiscovery: true, balanceSupported: true, routable: true },
  { id: "engy", displayName: "Engy", keyPrefixHints: ["sk-engy-"], protocols: ["openai_chat"], requiresBaseUrl: false, modelDiscovery: true, balanceSupported: false, routable: true },
  { id: "vercel_ai_gateway", displayName: "Vercel AI Gateway", protocols: ["openai_chat"], requiresBaseUrl: false, modelDiscovery: true, balanceSupported: true, routable: true },
  { id: "cloudflare_ai_gateway", displayName: "Cloudflare AI Gateway", protocols: ["openai_chat"], requiresBaseUrl: false, modelDiscovery: false, balanceSupported: false, routable: true, params: [{ name: "account_id", label: "Account ID", required: true }, { name: "gateway_id", label: "Gateway ID", required: true }] },
];

async function fixture(t, handler) {
  const calls = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), "heyditto-provider-tests-"));
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const data = body ? JSON.parse(body) : undefined;
      calls.push({ method: req.method, url: req.url, body: data });
      res.setHeader("content-type", "application/json");
      const send = (status, value) => { res.statusCode = status; res.end(value === undefined ? "" : JSON.stringify(value)); };
      if (handler?.(req, res, data, send)) return;
      if (req.url === "/api/v5/companies") return send(200, { companies: [{ id: COMPANY, slug: "omniaura", name: "Omni Aura", role: "owner" }] });
      if (req.url.startsWith("/api/v5/inference/endpoints") && req.method === "GET") return send(200, { endpoints: [{ id: EP, slug: "review", model: "z-ai/glm-5.3-flash", billingMode: "byok", providerOptions: { private_upstream_routing: { enabled: false, routes: [] }, unrelated: "preserve" }, privateUpstreamRoutingAllowed: true }] });
      if (req.url === "/api/v5/inference/provider-keys/providers") return send(200, { providers });
      if (req.url.endsWith("/inspect")) return send(200, { keyId: ID, validation: { status: "valid" }, models: { status: "advertised", models: [{ id: "provider/model" }] }, balance: { status: "unsupported" }, key: SECRET });
      if (req.url.endsWith("/probe")) return send(200, { requestLimit: data.requests, outputTokenLimit: data.maxOutputTokens, capacityVerified: false, costBoundAvailable: false, calls: [{ model: data.models[0], status: "completed", attempted: true, latencyMs: 12, inputTokenAccounting: "inclusive", key: SECRET }], secret: SECRET });
      if (req.url === "/api/v5/inference/provider-keys" && req.method === "POST") return send(201, { ...key, provider: data.provider === "custom" ? data.protocol === "anthropic_messages" ? "custom_anthropic" : "custom_openai" : data.provider, key: data.key, label: `saved ${data.key}`, arbitrary: data.key });
      if (req.url.startsWith("/api/v5/inference/provider-keys") && req.method === "GET") return send(200, { keys: [{ ...key, key: SECRET, templateParams: { credential: SECRET } }], canManage: true });
      if (req.method === "PATCH") return send(200, key);
      if (req.method === "DELETE") return send(204);
      send(404, { message: "not found" });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const run = (args, input = "", extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--no-auto-update", ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DITTO_API_BASE: base, DITTO_API_KEY: "ditto_mcp_synthetic", DITTO_CONFIG_DIR: dir, ...extraEnv } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
  return { run, calls, dir, base };
}

test("stdin onboarding uploads once to a detected provider and excludes plaintext even from success fields", async t => {
  const f = await fixture(t);
  const result = await f.run(["provider-keys", "add", "--stdin", "--no-inspect", "--personal"], SECRET);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
  const saves = f.calls.filter(call => call.method === "POST");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].body.key, SECRET);
  assert.equal(saves[0].body.provider, "openai");
});

test("unknown keys stop before upload and a full custom endpoint can infer its protocol", async t => {
  const f = await fixture(t);
  const unknown = await f.run(["provider-keys", "add", "--stdin", "--no-inspect"], "opaque-synthetic-value");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown key type/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  const added = await f.run(["provider-keys", "add", "--stdin", "--no-inspect", "--provider", "custom", "--base-url", "https://api.example.com/prefix/chat/completions", "--org", "omniaura"], "opaque-synthetic-value");
  assert.equal(added.code, 0, added.stderr);
  const save = f.calls.find(call => call.method === "POST");
  assert.equal(save.body.companyId, COMPANY);
  assert.equal(save.body.protocol, "openai_chat");
  assert.equal(save.body.baseUrl, "https://api.example.com/prefix/chat/completions");
});

test("backend-shaped catalog supports named OpenAI, Anthropic and GM credentials", async t => {
  const f = await fixture(t);
  for (const provider of ["openai", "anthropic", "gm"]) {
    const result = await f.run(["provider-keys", "add", "--stdin", "--no-inspect", "--provider", provider], `synthetic-${provider}-credential`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.calls.filter(call => call.method === "POST").at(-1).body.provider, provider);
  }
  const hinted = await f.run(["provider-keys", "add", "--stdin", "--no-inspect"], "sk-ant-synthetic-credential");
  assert.equal(hinted.code, 0, hinted.stderr);
  assert.equal(f.calls.filter(call => call.method === "POST").at(-1).body.provider, "anthropic");
  for (const [secret, provider] of [["sk-svcacct-synthetic-credential", "openai"], ["sk-engy-synthetic-credential", "engy"]]) {
    const detected = await f.run(["provider-keys", "add", "--stdin", "--no-inspect"], secret);
    assert.equal(detected.code, 0, detected.stderr);
    assert.equal(f.calls.filter(call => call.method === "POST").at(-1).body.provider, provider);
    assert.ok(!`${detected.stdout}${detected.stderr}`.includes(secret));
  }
});

test("balance help discloses fixed billing origins and adapter choices match the server", async t => {
  const f = await fixture(t);
  const help = await f.run(["provider-keys", "add", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /https:\/\/api\.platform\.getimpala\.ai\/v1\/account/);
  assert.match(help.stdout, /different origin/);
  for (const provider of ["openrouter", "gm", "vercel_ai_gateway"]) {
    const saved = await f.run(["provider-keys", "add", "--stdin", "--no-inspect", "--provider", provider, "--balance-provider", provider], SECRET);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(f.calls.filter(call => call.method === "POST").at(-1).body.balanceProvider, provider);
  }
  const before = f.calls.filter(call => call.method === "POST").length;
  const mismatched = await f.run(["provider-keys", "add", "--stdin", "--no-inspect", "--provider", "openai", "--balance-provider", "gm"], SECRET);
  assert.equal(mismatched.code, 1);
  assert.equal(f.calls.filter(call => call.method === "POST").length, before);
  const custom = await f.run(["provider-keys", "add", "--stdin", "--no-inspect", "--provider", "custom", "--protocol", "anthropic", "--base-url", "https://inference.example.com", "--balance-provider", "impala"], SECRET);
  assert.equal(custom.code, 0, custom.stderr);
  assert.equal(f.calls.filter(call => call.method === "POST").at(-1).body.balanceProvider, "impala");
  assert.equal(JSON.parse(custom.stdout).key.provider, "custom_anthropic");
});

test("declared public provider parameters are required and credentials cannot enter them", async t => {
  const f = await fixture(t);
  const args = ["provider-keys", "add", "--stdin", "--no-inspect", "--provider", "cloudflare_ai_gateway"];
  const missing = await f.run(args, SECRET);
  assert.equal(missing.code, 1);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  const invalid = await f.run([...args, "--param", `account_id=${SECRET}`, "--param", "gateway_id=review"], SECRET);
  assert.equal(invalid.code, 1);
  assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(SECRET));
  const saved = await f.run([...args, "--param", "account_id=public-account", "--param", "gateway_id=review"], SECRET);
  assert.equal(saved.code, 0, saved.stderr);
  assert.deepEqual(f.calls.filter(call => call.method === "POST").at(-1).body.templateParams, { account_id: "public-account", gateway_id: "review" });
});

test("priority bounds match the server before native or custom keys are submitted", async t => {
  const f = await fixture(t);
  for (const providerArgs of [["--provider", "openai"], ["--provider", "custom", "--protocol", "openai", "--base-url", "https://api.example.com/v1"]]) {
    for (const priority of ["0", "10001", "2147483647"]) {
      const before = f.calls.filter(call => call.method === "POST").length;
      const invalid = await f.run(["provider-keys", "add", "--stdin", "--no-inspect", ...providerArgs, "--priority", priority], SECRET);
      assert.equal(invalid.code, 1);
      assert.equal(f.calls.filter(call => call.method === "POST").length, before);
      assert.match(invalid.stderr, /1 to 10000/);
    }
    const valid = await f.run(["provider-keys", "add", "--stdin", "--no-inspect", ...providerArgs, "--priority", "10000"], SECRET);
    assert.equal(valid.code, 0, valid.stderr);
    assert.equal(f.calls.filter(call => call.method === "POST").at(-1).body.priority, 10000);
  }
  const invalidSet = await f.run(["provider-keys", "set", ID, "--priority", "0"]);
  assert.equal(invalidSet.code, 1);
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0);
});

test("error responses cannot echo provider credentials", async t => {
  const f = await fixture(t, (req, res, data, send) => {
    if (req.method === "POST" && req.url === "/api/v5/inference/provider-keys") { send(400, { message: data.key, key: data.key }); return true; }
  });
  const result = await f.run(["provider-keys", "add", "--stdin", "--no-inspect"], SECRET);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 400/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
});

test("provider upload redirects are refused before a second destination receives credentials", async t => {
  let redirected = 0;
  const destination = http.createServer((req, res) => { redirected++; res.end("{}"); });
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  t.after(() => destination.close());
  const f = await fixture(t, (req, res) => {
    if (req.method === "POST" && req.url === "/api/v5/inference/provider-keys") { res.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}/steal` }); res.end(); return true; }
  });
  const result = await f.run(["provider-keys", "add", "--stdin", "--no-inspect"], SECRET);
  assert.equal(result.code, 1);
  assert.equal(redirected, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
});

test("list and inspection retain unsupported balance without any generation", async t => {
  const f = await fixture(t);
  const listed = await f.run(["provider-keys", "list", "--org", "omniaura"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.ok(!listed.stdout.includes(SECRET));
  assert.ok(f.calls.some(call => call.url === `/api/v5/inference/provider-keys?companyId=${COMPANY}`));
  const balance = await f.run(["provider-keys", "balance", ID, "--org", "omniaura"]);
  assert.equal(balance.code, 0, balance.stderr);
  assert.equal(JSON.parse(balance.stdout).balance.status, "unsupported");
  assert.equal(JSON.parse(balance.stdout).balance.amountUsd, undefined);
  assert.ok(!f.calls.some(call => call.url.endsWith("/probe")));
});

test("probe requires explicit bounds and spend confirmation; dry run makes no probe call", async t => {
  const f = await fixture(t);
  const args = ["provider-keys", "probe", ID, "--model", "provider/model", "--requests", "3", "--max-output-tokens", "8", "--allow-unknown-cost"];
  const plan = await f.run([...args, "--dry-run"]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).generationCallsMade, 0);
  const refused = await f.run(args);
  assert.equal(refused.code, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith("/probe")).length, 0);
  const ran = await f.run([...args, "--confirm-spend"]);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(f.calls.filter(call => call.url.endsWith("/probe")).length, 1);
  assert.ok(!ran.stdout.includes(SECRET));
  assert.equal(JSON.parse(ran.stdout).capacityVerified, false);
});

test("pool writes submit only the typed policy, preserving billing and unrelated options", async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, "pool.json");
  const policy = { enabled: true, routes: [{ keyId: ID, weight: 100, requestsPerMinute: 75 }] };
  await writeFile(file, JSON.stringify(policy));
  const dry = await f.run(["endpoints", "pool", "set", "review", "--file", file, "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(f.calls.filter(call => call.method === "PATCH").length, 0);
  const result = await f.run(["endpoints", "pool", "set", "review", "--file", file]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls.find(call => call.method === "PATCH").body, { privateUpstreamRouting: policy });
});

test("gcloud import keeps secret bytes inside child capture and upload; no key in argv or output", async t => {
  const f = await fixture(t);
  const binary = path.join(f.dir, "gcloud");
  const log = path.join(f.dir, "gcloud-argv.jsonl");
  await writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.FAKE_GCLOUD_LOG, JSON.stringify(process.argv.slice(2))+'\\n');\nif(process.argv[2]==='auth')process.stdout.write(JSON.stringify([{account:'person@example.com',status:'ACTIVE'}]));\nelse if(process.argv[2]==='config')process.stdout.write(JSON.stringify({core:{account:'person@example.com',project:process.env.FAKE_GCLOUD_WRONG_PROJECT?'other-project':'my-project'},auth:process.env.FAKE_GCLOUD_IMPERSONATE?{impersonate_service_account:'other@project.iam.gserviceaccount.com'}:{}}));\nelse if(process.env.FAKE_GCLOUD_FAIL){process.stderr.write(process.env.FAKE_SECRET);process.exitCode=1;}\nelse process.stdout.write(process.env.FAKE_SECRET);\n`, { mode: 0o700 });
  const env = { PATH: `${f.dir}${path.delimiter}${process.env.PATH}`, FAKE_GCLOUD_LOG: log, FAKE_SECRET: SECRET, CLOUDSDK_AUTH_ACCESS_TOKEN: "", CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: "", CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "", CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: "" };
  const args = ["provider-keys", "import", "--from", "gcloud", "--secret", "provider-key", "--project", "my-project", "--account", "person@example.com", "--no-inspect"];
  const result = await f.run(args, "", env);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].includes("my-project") && calls[2].includes("person@example.com"));
  assert.ok(!JSON.stringify(calls).includes(SECRET));
  const failed = await f.run(args, "", { ...env, FAKE_GCLOUD_FAIL: "1" });
  assert.equal(failed.code, 1);
  assert.ok(!`${failed.stdout}${failed.stderr}`.includes(SECRET));
  assert.match(failed.stderr, /Diagnostic output was suppressed/);
  for (const extra of [{ FAKE_GCLOUD_IMPERSONATE: "1" }, { FAKE_GCLOUD_WRONG_PROJECT: "1" }, { CLOUDSDK_AUTH_ACCESS_TOKEN: SECRET }]) {
    const before = f.calls.filter(call => call.method === "POST").length;
    const refused = await f.run(args, "", { ...env, ...extra });
    assert.equal(refused.code, 1);
    assert.equal(f.calls.filter(call => call.method === "POST").length, before);
    assert.ok(!`${refused.stdout}${refused.stderr}`.includes(SECRET));
  }
});

test("legacy login rejects raw argv without echo and stdin login remains usable", async t => {
  const f = await fixture(t);
  const loginSecret = "ditto_mcp_synthetic_login_value";
  const refused = await f.run(["login", loginSecret]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /command arguments are refused/);
  assert.ok(!`${refused.stdout}${refused.stderr}`.includes(loginSecret));
  const saved = await f.run(["login", "--stdin"], `${loginSecret}\n`);
  assert.equal(saved.code, 0, saved.stderr);
  assert.ok(!`${saved.stdout}${saved.stderr}`.includes(loginSecret));
  assert.match(saved.stdout, /Saved key/);
});

test("credential-mint HTTP failures and malformed JSON never reflect their response body", async t => {
  for (const malformed of [false, true]) {
    const f = await fixture(t, (req, res, data, send) => {
      if (req.method === "POST" && req.url === `/api/v5/inference/endpoints/${EP}/keys`) {
        if (malformed) { res.statusCode = 200; res.end(`${SECRET}${SECRET}`); }
        else send(500, { message: `${SECRET}${SECRET}`, key: SECRET });
        return true;
      }
    });
    const fake = createFakeCLIs(["gh"]);
    const result = await f.run(["endpoints", "keys", "create", "review", "--gh-secret", "DITTO_KEY", "--repo", "acme/app", "--yes"], "", fake.env());
    assert.equal(result.code, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
    assert.match(result.stderr, /suppressed|no response body was printed/);
    assert.equal(fake.writes().length, 0);
  }
});

test("agent signup hides minted-key echoes in metadata and preserves the normal claim capability", async t => {
  const minted = "ditto_mcp_synthetic_new_agent_key";
  const claimURL = "https://app.example.test/agent/claim?token=normal_claim_capability";
  const f = await fixture(t, (req, res, data, send) => {
    if (req.url === "/api/v5/agents/signup") {
      send(201, { accountID: `account_${minted}`, userID: "agent_1", apiKeyID: 12, apiKey: minted, agentCaller: minted, claimURL, status: "unclaimed", createdAt: "2026-10-28T16:00:00Z", subscribedGraphs: [minted] });
      return true;
    }
  });
  const result = await f.run(["init", "--name", "synthetic-agent", "--subscribe", "foundation", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(minted));
  assert.equal(JSON.parse(result.stdout).claimURL, claimURL);
  assert.equal(JSON.parse(result.stdout).apiKeyStored, true);
  const repeat = await f.run(["init", "--json"]);
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.ok(!`${repeat.stdout}${repeat.stderr}`.includes(minted));
  assert.equal(JSON.parse(repeat.stdout).claimURL, claimURL);
});

test("agent signup HTTP, parse and redirect failures never print credential-bearing bodies", async t => {
  for (const kind of ["http", "json", "redirect"]) {
    const f = await fixture(t, (req, res, data, send) => {
      if (req.url === "/api/v5/agents/signup") {
        if (kind === "http") send(500, { message: SECRET, apiKey: SECRET });
        else if (kind === "json") { res.statusCode = 200; res.end(SECRET); }
        else { res.writeHead(307, { location: "http://127.0.0.1:1/must-not-follow" }); res.end(SECRET); }
        return true;
      }
    });
    const result = await f.run(["init", "--json"]);
    assert.equal(result.code, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
    assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  }
});
