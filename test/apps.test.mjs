import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakeCLIs } from "./helpers/fake-cli.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SECRET = "app-secret-PLAINTEXT-MUST-NEVER-PRINT-77";

const APP = {
  appID: "dittobench-3f9a",
  name: "DittoBench",
  slug: "dittobench",
  kind: "app",
  enabled: true,
  archived: false,
  createdAt: "2026-09-12T00:00:00Z",
  metadata: { description: "Bittensor subnet 118" },
  consentRationale: { "credits:spend": "Pays for the inference your miner uses." },
};
const ENDPOINT = { id: "11111111-1111-1111-1111-111111111111", slug: "screener", name: "Screener", model: "openai/gpt-5.6-luna", status: "active", spendPeriod: "monthly" };

function startStub() {
  const calls = [];
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
      const u = req.url;
      if (u.startsWith("/api/v5/admin/apps") && req.headers.authorization !== "Bearer ditto_mcp_test") return json(401, { message: "unauthorized" });
      if (u === "/api/v5/admin/apps" && req.method === "GET") return json(200, { apps: [APP] });
      if (u === "/api/v5/admin/apps" && req.method === "POST") return json(200, { ...APP, appID: "newapp-1a2b", name: JSON.parse(body).name, appSecret: SECRET, consentRationale: undefined });
      if (u === `/api/v5/admin/apps/${APP.appID}` && req.method === "PATCH") return json(200, { ...APP, ...JSON.parse(body) });
      if (u === `/api/v5/admin/apps/${APP.appID}/rotate-secret` && req.method === "POST") return json(200, { appID: APP.appID, appSecret: SECRET });
      if (u === `/api/v5/admin/apps/${APP.appID}/verify-callback-origin` && req.method === "POST") {
        const input = JSON.parse(body);
        return input.confirm
          ? json(200, { origin: input.origin, verified: true, callbackOrigins: [input.origin] })
          : json(200, { origin: input.origin, verified: false, token: "tok-123", wellKnown: `${input.origin}/.well-known/ditto-callback-challenge` });
      }
      if (u === `/api/v5/admin/apps/${APP.appID}/endpoints` && req.method === "GET") return json(200, { endpoints: [{ ...ENDPOINT, appBilling: "sponsor" }], baseUrl: "https://api.example.test/v1", onBehalfOfHeader: "X-Ditto-On-Behalf-Of" });
      if (u === `/api/v5/admin/apps/${APP.appID}/endpoints` && req.method === "POST") return json(201, { ...ENDPOINT, appBilling: JSON.parse(body).billing });
      if (u === "/api/v5/inference/endpoints" && req.method === "GET") return json(200, { baseUrl: "https://api.example.test/v1", endpoints: [ENDPOINT], limit: 5, used: 1 });
      if (u === `/api/v5/consent-profile/${APP.appID}`) return json(200, { appID: APP.appID, name: APP.name, enabled: true, rationale: APP.consentRationale, endpoints: [], callbackOrigins: ["https://dittobench.ai"], iconUrl: "https://cdn.example.test/icon.png" });
      if (u.startsWith("/api/v5/me/receipts")) return json(200, { since: "2026-08-13T00:00:00Z", receipts: [{ id: 1, timestamp: "2026-09-12T10:00:00Z", leg: "ditto", appID: APP.appID, model: "openai/gpt-5.6-luna", billing: "user", dittoTokens: 25000000, estimatedTokens: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15 }], summary: [{ leg: "ditto", appID: APP.appID, appName: APP.name, calls: 1, dittoTokens: 25000000, estimatedTokens: 0 }] });
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function run(args, env = {}) {
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
  return { DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-apps-")), NO_COLOR: "1" };
}

test("apps list uses the first-party key against the admin apps route", async () => {
  const stub = await startStub();
  try {
    const out = await run(["apps", "list", "--output", "json"], baseEnv(stub));
    assert.equal(out.code, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).apps[0].appID, APP.appID);
    assert.equal(stub.calls[0].auth, "Bearer ditto_mcp_test");
  } finally {
    await stub.close();
  }
});

test("apps create forwards the app secret to the store over stdin and never prints it", async () => {
  const stub = await startStub();
  const fake = createFakeCLIs(["gh"]);
  try {
    const out = await run(
      ["apps", "create", "DittoBench", "--gh-secret", "DITTO_OIDC_CLIENT_SECRET", "--repo", "ditto-assistant/ditto-subnet", "--yes", "--output", "json"],
      { ...baseEnv(stub), ...fake.env() },
    );
    assert.equal(out.code, 0, out.stderr);
    assert.ok(!out.stdout.includes(SECRET) && !out.stderr.includes(SECRET), "secret must never reach stdout/stderr");
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.app.appSecret, undefined);
    assert.equal(parsed.oidc.DITTO_OIDC_CLIENT_ID, "newapp-1a2b");
    assert.equal(parsed.secretStored.secretName, "DITTO_OIDC_CLIENT_SECRET");
    const ghWrite = fake.writes().find((c) => c.bin === "gh");
    assert.ok(ghWrite, "gh must have received the secret");
    assert.ok(ghWrite.stdin.includes(SECRET), "secret travels on stdin");
    assert.ok(fake.calls().every((c) => !c.args.join(" ").includes(SECRET)), "secret never in argv");
  } finally {
    await stub.close();
  }
});

test("apps create without a store keeps the secret hidden and says how to rotate it", async () => {
  const stub = await startStub();
  try {
    const out = await run(["apps", "create", "DittoBench"], baseEnv(stub));
    assert.equal(out.code, 0, out.stderr);
    assert.ok(!out.stdout.includes(SECRET) && !out.stderr.includes(SECRET));
    assert.match(out.stdout, /DITTO_OIDC_CLIENT_ID=newapp-1a2b/);
    assert.match(out.stderr, /apps secret rotate/);
  } finally {
    await stub.close();
  }
});

test("apps secret rotate refuses without a destination and forwards with one", async () => {
  const stub = await startStub();
  const fake = createFakeCLIs(["gh"]);
  try {
    const refused = await run(["apps", "secret", "rotate", "dittobench", "--yes"], baseEnv(stub));
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /never printed/);
    assert.ok(!stub.calls.some((c) => c.url.endsWith("/rotate-secret")), "no rotation without a destination");

    const out = await run(["apps", "secret", "rotate", "dittobench", "--gh-secret", "DITTO_OIDC_CLIENT_SECRET", "--repo", "a/b", "--yes"], { ...baseEnv(stub), ...fake.env() });
    assert.equal(out.code, 0, out.stderr);
    assert.ok(!out.stdout.includes(SECRET) && !out.stderr.includes(SECRET));
    assert.ok(fake.calls().some((c) => c.bin === "gh" && c.stdin.includes(SECRET)));
  } finally {
    await stub.close();
  }
});

test("apps consent set patches the whole rationale map and rejects unknown scopes", async () => {
  const stub = await startStub();
  try {
    const bad = await run(["apps", "consent", "set", "dittobench", "admin:everything", "no"], baseEnv(stub));
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /unknown scope/);
    const out = await run(["apps", "consent", "set", "dittobench", "openid", "Links your miner hotkeys to your Ditto account."], baseEnv(stub));
    assert.equal(out.code, 0, out.stderr);
    const patch = stub.calls.find((c) => c.method === "PATCH");
    assert.deepEqual(patch.body.consentRationale, {
      "credits:spend": "Pays for the inference your miner uses.",
      openid: "Links your miner hotkeys to your Ditto account.",
    });
  } finally {
    await stub.close();
  }
});

test("apps oidc prints env lines with the client id and no secret; origins verify walks the challenge", async () => {
  const stub = await startStub();
  try {
    const oidc = await run(["apps", "oidc", "dittobench", "--callback", "https://dittobench.ai/auth/ditto/callback"], baseEnv(stub));
    assert.equal(oidc.code, 0, oidc.stderr);
    assert.match(oidc.stdout, new RegExp(`DITTO_OIDC_CLIENT_ID=${APP.appID}`));
    assert.match(oidc.stdout, /DITTO_OIDC_TOKEN_ENDPOINT=.*\/token/);
    assert.match(oidc.stdout, /DITTO_OIDC_REDIRECT_URI=https:\/\/dittobench.ai\/auth\/ditto\/callback/);
    assert.ok(!/SECRET=/.test(oidc.stdout));

    const challenge = await run(["apps", "origins", "verify", "dittobench", "https://dittobench.ai"], baseEnv(stub));
    assert.equal(challenge.code, 0, challenge.stderr);
    assert.match(challenge.stdout, /tok-123/);
    const confirmed = await run(["apps", "origins", "verify", "dittobench", "https://dittobench.ai", "--confirm"], baseEnv(stub));
    assert.match(confirmed.stdout, /Verified https:\/\/dittobench.ai/);
  } finally {
    await stub.close();
  }
});

test("apps endpoints attach sends the endpoint id and billing choice", async () => {
  const stub = await startStub();
  try {
    const out = await run(["apps", "endpoints", "attach", "dittobench", "screener", "--billing", "user", "--output", "json"], baseEnv(stub));
    assert.equal(out.code, 0, out.stderr);
    const post = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/endpoints"));
    assert.deepEqual(post.body, { endpointId: ENDPOINT.id, billing: "user" });
    const list = await run(["apps", "endpoints", "list", "dittobench"], baseEnv(stub));
    assert.match(list.stdout, /screener.*sponsor/);
    assert.match(list.stdout, /X-Ditto-On-Behalf-Of/);
  } finally {
    await stub.close();
  }
});

test("receipts renders the summary and lines with app attribution", async () => {
  const stub = await startStub();
  try {
    const out = await run(["receipts", "--app", APP.appID], baseEnv(stub));
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /DittoBench/);
    assert.match(out.stdout, /\$0\.0250/);
    assert.ok(stub.calls[0].url.includes(`app=${APP.appID}`));
  } finally {
    await stub.close();
  }
});
