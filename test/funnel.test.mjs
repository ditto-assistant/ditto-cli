import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deviceLogin, verificationLink } from "../dist/device-login.js";
import { mergeActivationURL, saveLogin, readStoredAuth } from "../dist/store.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const ALPHA = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "alpha",
  name: "Alpha",
  model: "openai/gpt-5.6-luna",
  spendPeriod: "monthly",
  spendLimitTokens: 1000000,
  spentTokens: 25000,
  recordTrace: true,
  status: "active",
};
const BETA = {
  id: "22222222-2222-2222-2222-222222222222",
  slug: "beta",
  name: "Beta",
  model: "anthropic/claude-sonnet-5",
  spendPeriod: "never",
  spendLimitTokens: null,
  spentTokens: 0,
  recordTrace: false,
  status: "active",
};
const PENDING = {
  ...ALPHA,
  status: "pending_plan",
  activation: {
    state: "pending_plan",
    reason: "agent_unclaimed",
    requiredTier: 3,
    requiredTierName: "Hero",
    priceHint: "$20/month",
    message: "Endpoint alpha is created but inactive until your user claims this agent and subscribes to Ditto Hero ($20/month).",
    url: "https://app.example.test/agent/claim?activate=11111111-1111-1111-1111-111111111111",
  },
};

/** Stub of the Ditto API covering the device flow and endpoint management. */
function startStub({ endpoints = [ALPHA, BETA], tokenPollsUntilOk = 2 } = {}) {
  const calls = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      const json = (status, payload) => {
        res.statusCode = status;
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      if (req.url === "/api/v2/mcp/device-code" && req.method === "POST") {
        const intent = JSON.parse(body).intent;
        return json(200, {
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_url: "https://app.example.test/device",
          verification_uri_complete: `https://app.example.test/device?code=ABCD-1234&intent=${intent}&client=heyditto-cli`,
          expires_in: 600,
          interval: 1,
        });
      }
      if (req.url === "/api/v2/mcp/device-token" && req.method === "POST") {
        polls += 1;
        if (polls < tokenPollsUntilOk) return json(200, { error: "authorization_pending" });
        return json(200, {
          access_token: "ditto_mcp_fromdevice",
          token_type: "Bearer",
          endpoint: { id: BETA.id, slug: BETA.slug, name: BETA.name, model: BETA.model },
          set_default: true,
        });
      }
      const authed = req.headers.authorization === "Bearer ditto_mcp_test" || req.headers.authorization === "Bearer ditto_mcp_fromdevice";
      if (req.url.startsWith("/api/v5/inference/endpoints") && !authed) return json(401, { message: "unauthorized" });
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints, limit: 5, used: endpoints.length });
      }
      if (req.url === "/api/v5/inference/endpoints" && req.method === "POST") {
        const input = JSON.parse(body || "{}");
        return json(201, { ...BETA, id: "33333333-3333-3333-3333-333333333333", slug: input.slug ?? "endpoint-3", name: input.name ?? "Endpoint 3", model: input.model ?? "openai/gpt-5.6-luna" });
      }
      const m = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)(\/keys(?:\/([^/]+))?)?$/);
      if (m && req.method === "PATCH") {
        const patch = JSON.parse(body);
        return json(200, { ...endpoints.find((e) => e.id === m[1]), ...patch });
      }
      if (m && !m[2] && req.method === "DELETE") return json(204);
      if (m && m[2] === "/keys" && req.method === "GET") {
        return json(200, { keys: [{ id: "key-1", endpointId: m[1], name: "cli:claude:host", keyHint: "ab12", expiresAt: null, lastUsedAt: null, revokedAt: null }] });
      }
      if (m && m[3] && req.method === "DELETE") return json(204);
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, calls, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

function childEnvFor(env) {
  const { ANTHROPIC_CUSTOM_HEADERS: _h, ANTHROPIC_API_KEY: _k, ...parent } = process.env;
  return {
    ...parent,
    DITTO_API_KEY: "",
    DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-funnel-")),
    ...env,
  };
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8", env: childEnvFor(env) });
}

function runAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: childEnvFor(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("deviceLogin sends the intent and returns the browser's endpoint choice", async () => {
  const stub = await startStub();
  const prevBase = process.env.DITTO_API_BASE;
  process.env.DITTO_API_BASE = stub.base;
  try {
    const seen = [];
    const result = await deviceLogin({ intent: "claude", onCode: (code, url) => seen.push({ code, url }) });
    assert.equal(result.apiKey, "ditto_mcp_fromdevice");
    assert.deepEqual(result.endpoint, { id: BETA.id, slug: "beta", name: "Beta", model: BETA.model });
    assert.equal(result.setDefault, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].code, "ABCD-1234");
    assert.equal(seen[0].url, "https://app.example.test/device?code=ABCD-1234&intent=claude&client=heyditto-cli");
    const codeReq = stub.calls.find((c) => c.url === "/api/v2/mcp/device-code");
    assert.equal(codeReq.body.intent, "claude");
    assert.equal(codeReq.body.client, "heyditto-cli");
    assert.match(codeReq.body.client_version, /^\d+\.\d+\.\d+/);
    assert.ok(codeReq.body.hostname.length > 0);
    assert.equal(codeReq.auth, undefined, "device-code must be unauthenticated");
    const tokenReqs = stub.calls.filter((c) => c.url === "/api/v2/mcp/device-token");
    assert.equal(tokenReqs.length, 2, "first poll pending, second ok");
    assert.equal(tokenReqs[0].body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
  } finally {
    if (prevBase === undefined) delete process.env.DITTO_API_BASE;
    else process.env.DITTO_API_BASE = prevBase;
    stub.close();
  }
});

test("verificationLink prefers the backend's complete URI and falls back to ?code=", () => {
  assert.equal(
    verificationLink({ verification_url: "https://a/device", verification_uri_complete: "https://a/device?code=X&intent=login", user_code: "X" }),
    "https://a/device?code=X&intent=login",
  );
  assert.equal(verificationLink({ verification_url: "https://a/device", user_code: "AB-CD" }), "https://a/device?code=AB-CD");
  assert.equal(verificationLink({ verification_url: "https://a/device?x=1", user_code: "Q" }), "https://a/device?x=1&code=Q");
});

test("mergeActivationURL copies the claim token onto the backend link", () => {
  const backend = "https://app.example.test/agent/claim?activate=ep-1";
  assert.equal(
    mergeActivationURL(backend, "https://app.example.test/agent/claim?t=tok_123"),
    "https://app.example.test/agent/claim?activate=ep-1&t=tok_123",
  );
  assert.equal(mergeActivationURL(backend, undefined), backend);
  assert.equal(mergeActivationURL(backend, "not a url"), backend);
  assert.equal(mergeActivationURL("https://x/y?t=keep", "https://z/?t=other"), "https://x/y?t=keep");
  assert.equal(mergeActivationURL(backend, "https://app.example.test/agent/claim"), backend, "no token to copy");
});

test("saveLogin merges: keeps the default endpoint, clears agent fields", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "heyditto-savelogin-"));
  const prev = process.env.DITTO_CONFIG_DIR;
  process.env.DITTO_CONFIG_DIR = dir;
  try {
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ apiKey: "ditto_mcp_agent", agentMode: true, agentUserID: "agent_1", claimURL: "https://x/agent/claim?t=1", defaultEndpoint: "alpha", activeSession: { id: "s1" } }),
    );
    await saveLogin("ditto_mcp_human");
    let stored = await readStoredAuth();
    assert.equal(stored.apiKey, "ditto_mcp_human");
    assert.equal(stored.defaultEndpoint, "alpha");
    assert.deepEqual(stored.activeSession, { id: "s1" });
    assert.equal(stored.agentMode, undefined);
    assert.equal(stored.agentUserID, undefined);
    assert.equal(stored.claimURL, undefined);
    await saveLogin("ditto_mcp_human", { defaultEndpoint: "beta" });
    stored = await readStoredAuth();
    assert.equal(stored.defaultEndpoint, "beta");
  } finally {
    if (prev === undefined) delete process.env.DITTO_CONFIG_DIR;
    else process.env.DITTO_CONFIG_DIR = prev;
  }
});

test("endpoints group help works without auth", () => {
  const top = run(["endpoints", "--help"]);
  assert.equal(top.status, 0, top.stderr);
  assert.match(top.stdout, /Usage: heyditto endpoints/);
  for (const sub of ["list", "create", "show", "use", "pick", "open", "set", "delete", "keys"]) {
    assert.match(top.stdout, new RegExp(`^\\s+${sub}\\b`, "m"), `missing subcommand ${sub}`);
  }
  const create = run(["endpoints", "create", "--help"]);
  assert.equal(create.status, 0, create.stderr);
  assert.match(create.stdout, /Usage: heyditto endpoints create/);
  assert.match(create.stdout, /--model/);
  const set = run(["endpoints", "set", "--help"]);
  assert.match(set.stdout, /--spend-limit/);
  assert.match(set.stdout, /--record-trace/);
  const revoke = run(["endpoints", "keys", "revoke", "--help"]);
  assert.equal(revoke.status, 0, revoke.stderr);
  assert.match(revoke.stdout, /Usage: heyditto endpoints keys revoke/);
  assert.match(run(["login", "--help"]).stdout, /browser/);
});

test("endpoints list --output json and bare endpoints --set-default still work", async () => {
  const stub = await startStub();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-funnel-cfg-"));
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ apiKey: "ditto_mcp_test" }));
  const env = { DITTO_API_BASE: stub.base, DITTO_CONFIG_DIR: configDir };
  try {
    const list = await runAsync(["endpoints", "list", "--output", "json"], env);
    assert.equal(list.status, 0, list.stderr);
    const parsed = JSON.parse(list.stdout);
    assert.equal(parsed.endpoints.length, 2);
    assert.equal(parsed.defaultEndpoint, null);
    assert.equal(parsed.baseUrl, "https://api.example.test/v1");

    const set = await runAsync(["endpoints", "--set-default", "alpha"], env);
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stderr, /Default endpoint set to alpha/);
    assert.equal(JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8")).defaultEndpoint, "alpha");

    const use = await runAsync(["endpoints", "use", "beta", "--output", "json"], env);
    assert.equal(use.status, 0, use.stderr);
    assert.equal(JSON.parse(use.stdout).defaultEndpoint, "beta");

    const show = await runAsync(["endpoints", "show", "alpha"], env);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /slug:\s+alpha/);
    assert.match(show.stdout, /web:\s+https:\/\/app\.heyditto\.ai\/settings\/developer\?endpoint=alpha/);

    const open = await runAsync(["endpoints", "open", "beta", "--print"], { ...env, DITTO_APP_BASE: "https://app.example.test/" });
    assert.equal(open.status, 0, open.stderr);
    assert.equal(open.stdout.trim(), "https://app.example.test/settings/developer?endpoint=beta");
  } finally {
    stub.close();
  }
});

test("endpoints create makes the first endpoint the default and prints the launch hint", async () => {
  const stub = await startStub();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-funnel-cfg-"));
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ apiKey: "ditto_mcp_test" }));
  try {
    const created = await runAsync(["endpoints", "create", "--name", "Work"], { DITTO_API_BASE: stub.base, DITTO_CONFIG_DIR: configDir });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /Created endpoint endpoint-3 .*now the default/);
    assert.match(created.stdout, /heyditto claude --endpoint endpoint-3/);
    const post = stub.calls.find((c) => c.method === "POST" && c.url === "/api/v5/inference/endpoints");
    assert.deepEqual(post.body, { name: "Work" });
    assert.equal(JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8")).defaultEndpoint, "endpoint-3");
  } finally {
    stub.close();
  }
});

test("endpoints delete needs --yes without a TTY, then sends DELETE and clears the default", async () => {
  const stub = await startStub();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-funnel-cfg-"));
  writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ apiKey: "ditto_mcp_test", defaultEndpoint: "alpha" }));
  const env = { DITTO_API_BASE: stub.base, DITTO_CONFIG_DIR: configDir };
  try {
    const refused = await runAsync(["endpoints", "delete", "alpha"], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing to delete "alpha" without confirmation/);
    assert.ok(!stub.calls.some((c) => c.method === "DELETE"), "must not delete without confirmation");

    const deleted = await runAsync(["endpoints", "delete", "alpha", "--yes"], env);
    assert.equal(deleted.status, 0, deleted.stderr);
    assert.match(deleted.stdout, /Deleted endpoint alpha/);
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url === `/api/v5/inference/endpoints/${ALPHA.id}`));
    assert.equal(JSON.parse(readFileSync(path.join(configDir, "config.json"), "utf8")).defaultEndpoint, undefined);

    const keys = await runAsync(["endpoints", "keys", "beta"], env);
    assert.equal(keys.status, 0, keys.stderr);
    assert.match(keys.stdout, /key-1\s+…ab12\s+cli:claude:host/);
    const revokeRefused = await runAsync(["endpoints", "keys", "revoke", "beta", "key-1"], env);
    assert.equal(revokeRefused.status, 1);
    const revoked = await runAsync(["endpoints", "keys", "revoke", "beta", "key-1", "--yes"], env);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url === `/api/v5/inference/endpoints/${BETA.id}/keys/key-1`));
  } finally {
    stub.close();
  }
});

test("endpoints set PATCHes only the given fields and gates spend-limit increases", async () => {
  const stub = await startStub();
  const env = { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test" };
  try {
    const ok = await runAsync(["endpoints", "set", "alpha", "--record-trace", "off", "--model", "x/y"], env);
    assert.equal(ok.status, 0, ok.stderr);
    const patch = stub.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch.body, { model: "x/y", recordTrace: false });

    const raise = await runAsync(["endpoints", "set", "alpha", "--spend-limit", "none"], env);
    assert.equal(raise.status, 1);
    assert.match(raise.stderr, /refusing to raise the spend limit of "alpha"/);

    const nothing = await runAsync(["endpoints", "set", "alpha"], env);
    assert.equal(nothing.status, 1);
    assert.match(nothing.stderr, /nothing to change/);
  } finally {
    stub.close();
  }
});

test("a pending_plan endpoint blocks launch and prints the activation notice with the claim token", async () => {
  const stub = await startStub({ endpoints: [PENDING, BETA] });
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-funnel-cfg-"));
  writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({ apiKey: "ditto_mcp_test", agentMode: true, claimURL: "https://app.example.test/agent/claim?t=tok_abc" }),
  );
  const env = { DITTO_API_BASE: stub.base, DITTO_CONFIG_DIR: configDir };
  try {
    const launch = await runAsync(["claude", "--dry-run", "--endpoint", "alpha"], env);
    assert.equal(launch.status, 1);
    assert.match(launch.stderr, /endpoint "alpha" is not active yet \(pending_plan\)/);
    assert.match(launch.stderr, /inactive until your user claims this agent/);
    assert.match(launch.stderr, /Activation link: https:\/\/app\.example\.test\/agent\/claim\?activate=1111.*&t=tok_abc/);

    const list = await runAsync(["endpoints"], env);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /alpha .*inactive/);
    assert.match(list.stderr, /! alpha is not active yet/);
    const json = await runAsync(["endpoints", "list", "--output", "json"], env);
    assert.match(JSON.parse(json.stdout).endpoints[0].activation.url, /t=tok_abc/);

    // The healthy endpoint still launches.
    const okLaunch = await runAsync(["claude", "--dry-run", "--endpoint", "beta"], env);
    assert.equal(okLaunch.status, 0, okLaunch.stderr);
  } finally {
    stub.close();
  }
});

test("claude without a key and without a TTY still fails fast (no device flow)", async () => {
  const stub = await startStub();
  try {
    const result = await runAsync(["claude", "--endpoint", "alpha"], { DITTO_API_BASE: stub.base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no Ditto API key configured/);
    assert.match(result.stderr, /heyditto login/);
    assert.ok(!stub.calls.some((c) => c.url === "/api/v2/mcp/device-code"), "non-interactive runs must not start a device flow");
  } finally {
    stub.close();
  }
});
