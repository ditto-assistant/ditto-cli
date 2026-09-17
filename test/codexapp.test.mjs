import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyAuthJson, codexHome, removeTopLevelString, upsertTopLevelString } from "../dist/agents/codexapp.js";
import { listEndpointsStubHandler } from "./helpers/stub-api.mjs";

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

const MINTED_PLAINTEXT = "ditto_inf_PLAINTEXT_MUST_NEVER_PRINT_zz99";

/** Stub covering the routes codex-app touches: catalog, key mint/revoke, endpoint patch. */
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
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints: [ALPHA], limit: 5, used: 1 });
      }
      if (listEndpointsStubHandler(req, json)) return;
      const m = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)(\/keys(?:\/([^/]+))?)?$/);
      if (m && m[2] === "/keys" && req.method === "POST") {
        const input = JSON.parse(body);
        return json(201, { id: "key-2", endpointId: m[1], name: input.name, keyHint: "zz99", key: MINTED_PLAINTEXT, expiresAt: "2027-09-05T00:00:00Z", spendLimitTokens: input.spendLimitTokens ?? null, spendPeriod: input.spendPeriod ?? "never" });
      }
      if (m && m[3] && req.method === "DELETE") return json(204);
      if (m && req.method === "PATCH") return json(200, { ...ALPHA, ...JSON.parse(body) });
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        calls,
        mints: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/keys")),
        revocations: () => calls.filter((c) => c.method === "DELETE"),
        patches: () => calls.filter((c) => c.method === "PATCH"),
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/** An isolated environment: own config dir, own CODEX_HOME, stub API base.
 * `configDir` pins the Ditto config across runs within one test so a second
 * run can see the first one's codex-app record (key rotation, --unset). */
function childEnvFor(codexDir, configDir, extra = {}) {
  return {
    ...process.env,
    DITTO_API_KEY: "ditto_mcp_test",
    DITTO_CONFIG_DIR: configDir,
    DITTO_API_BASE: STUB_BASE,
    CODEX_HOME: codexDir,
    NO_COLOR: "1",
    ...extra,
  };
}

let STUB_BASE = "";

/**
 * Async spawn, like the funnel tests: spawnSync would block this process's
 * event loop and the in-process stub could never answer the child.
 */
function run(args, codexDir, configDir, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: childEnvFor(codexDir, configDir, extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("upsertTopLevelString inserts before the first table, replaces in place, and parses back", () => {
  const original = 'personality = "pragmatic"\nmodel = "gpt-5.6-terra"\n\n[projects."/x"]\ncwd = "y"\n';
  const withBase = upsertTopLevelString(original, "openai_base_url", "https://api.example.test/v1", "# added by `heyditto codex-app`");
  assert.match(withBase, /openai_base_url = "https:\/\/api\.example\.test\/v1"/);
  assert.match(withBase, /# added by `heyditto codex-app`/);
  // Inserted before the first table header, so it stays top-level.
  assert.ok(withBase.indexOf("openai_base_url") < withBase.indexOf("[projects."));
  assert.ok(withBase.indexOf('personality = "pragmatic"') < withBase.indexOf("openai_base_url"));
  // An existing key is replaced in place, everything else byte-identical.
  const replaced = upsertTopLevelString(withBase, "openai_base_url", "https://other.test/v1");
  assert.ok(!replaced.includes("api.example.test"));
  assert.ok(replaced.includes('personality = "pragmatic"') && replaced.includes("[projects."));
  // A same-named key inside a table is never rewritten.
  const nested = 'openai_base_url = "https://top.test/v1"\n[svc]\nopenai_base_url = "https://inner.test/v1"\n';
  const onlyTop = upsertTopLevelString(nested, "openai_base_url", "https://new.test/v1");
  assert.ok(onlyTop.includes("https://inner.test/v1"), "nested value untouched");
  assert.ok(!onlyTop.includes("https://top.test/v1"));
});

test("removeTopLevelString removes the assignment and the marker comment", () => {
  const withBase = '# added by `heyditto codex-app`\nopenai_base_url = "https://api.example.test/v1"\nmodel = "m"\n';
  assert.equal(removeTopLevelString(withBase, "openai_base_url"), 'model = "m"\n');
  assert.equal(removeTopLevelString('model = "m"\n', "openai_base_url"), 'model = "m"\n');
});

test("classifyAuthJson distinguishes api-key, ChatGPT and unknown logins", () => {
  assert.equal(classifyAuthJson(undefined), "absent");
  assert.equal(classifyAuthJson("  "), "absent");
  assert.equal(classifyAuthJson('{"OPENAI_API_KEY": "sk-x"}'), "api-key");
  assert.equal(classifyAuthJson('{"tokens": {"id_token": "t"}, "last_refresh": "x"}'), "chatgpt");
  assert.equal(classifyAuthJson("{}"), "unknown");
  assert.equal(classifyAuthJson("not json"), "unknown");
});

test("codexHome honors CODEX_HOME", () => {
  assert.equal(codexHome({ CODEX_HOME: "/tmp/x" }), "/tmp/x");
  assert.equal(codexHome({}), path.join(os.homedir(), ".codex"));
});

test("codex-app --dry-run prints the plan and writes nothing", async () => {
  const stub = await startStub();
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  try {
    const result = await run(["codex-app", "--dry-run"], codexDir, configDir);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.endpoint.slug, "alpha");
    assert.equal(plan.baseUrl, "https://api.example.test/v1");
    assert.equal(plan.write[path.join(codexDir, "config.toml")].openai_base_url, "https://api.example.test/v1");
    assert.equal(plan.enableModelPicker, true);
    assert.equal(existsSync(path.join(codexDir, "config.toml")), false, "config.toml untouched");
    assert.equal(existsSync(path.join(codexDir, "auth.json")), false, "auth.json untouched");
    assert.equal(stub.mints().length, 0, "no key minted on dry-run");
  } finally {
    stub.close();
  }
});

test("codex-app wires config.toml + auth.json, enables the picker, and --unset restores", async () => {
  const stub = await startStub();
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  const configPath = path.join(codexDir, "config.toml");
  const authPath = path.join(codexDir, "auth.json");
  writeFileSync(configPath, 'personality = "pragmatic"\nmodel = "gpt-5.6-terra"\n\n[projects."/x"]\ncwd = "y"\n');
  try {
    const first = await run(["codex-app", "--endpoint", "alpha", "--yes", "--show-key"], codexDir, configDir);
    assert.equal(first.status, 0, first.stderr);
    assert.ok(first.stderr.includes(MINTED_PLAINTEXT), "--show-key prints the key");
    const config = readFileSync(configPath, "utf8");
    assert.match(config, /openai_base_url = "https:\/\/api\.example\.test\/v1"/);
    assert.match(config, /# added by `heyditto codex-app`/);
    assert.ok(config.includes('model = "gpt-5.6-terra"'), "existing model untouched without --model");
    assert.ok(config.includes("[projects."), "existing tables preserved");
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(auth.OPENAI_API_KEY, MINTED_PLAINTEXT);
    const patch = stub.patches().find((p) => p.body.providerOptions);
    assert.ok(patch, "codex_models enabled on the endpoint");
    assert.equal(patch.body.providerOptions.codex_models, true);
    assert.equal(stub.mints().length, 1);
    assert.equal(existsSync(`${authPath}.pre-ditto`), false, "no auth backup when there was no prior login");

    // A second run rotates the key.
    const second = await run(["codex-app", "--endpoint", "alpha", "--yes"], codexDir, configDir);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.stderr.includes("revoked the previous codex-app key"), "previous key revoked");
    assert.equal(stub.mints().length, 2);

    // --unset restores the config and removes the key file.
    const unset = await run(["codex-app", "--unset"], codexDir, configDir);
    assert.equal(unset.status, 0, unset.stderr);
    const restored = readFileSync(configPath, "utf8");
    assert.ok(!restored.includes("openai_base_url"), "openai_base_url removed");
    assert.ok(restored.includes('model = "gpt-5.6-terra"'), "model preserved");
    assert.ok(restored.includes("[projects."), "tables preserved");
    assert.equal(existsSync(authPath), false, "codex-app's auth.json removed");
    assert.equal(stub.revocations().length, 2, "key revoked on unset");
  } finally {
    stub.close();
  }
});

test("codex-app backs up and confirms over an existing ChatGPT login, --unset restores it", async () => {
  const stub = await startStub();
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  const authPath = path.join(codexDir, "auth.json");
  writeFileSync(path.join(codexDir, "config.toml"), 'model = "gpt-5.6-terra"\n');
  writeFileSync(authPath, JSON.stringify({ tokens: { id_token: "tok" }, last_refresh: "2026-09-01" }, null, 2));
  try {
    // Non-interactive without --yes: refuse rather than destroy a login.
    const refused = await run(["codex-app"], codexDir, configDir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--yes|aborted|confirm/i);
    assert.equal(readFileSync(authPath, "utf8").includes("tok"), true, "ChatGPT login untouched");

    const ok = await run(["codex-app", "--yes"], codexDir, configDir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(readFileSync(authPath, "utf8")).OPENAI_API_KEY, MINTED_PLAINTEXT);
    const backup = JSON.parse(readFileSync(`${authPath}.pre-ditto`, "utf8"));
    assert.equal(backup.tokens.id_token, "tok", "ChatGPT login backed up");

    const unset = await run(["codex-app", "--unset"], codexDir, configDir);
    assert.equal(unset.status, 0, unset.stderr);
    assert.equal(JSON.parse(readFileSync(authPath, "utf8")).tokens.id_token, "tok", "ChatGPT login restored");
    assert.equal(existsSync(`${authPath}.pre-ditto`), false, "backup consumed");
  } finally {
    stub.close();
  }
});

test("codex-app --model pins it and --unset restores the previous model", async () => {
  const stub = await startStub();
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  const configPath = path.join(codexDir, "config.toml");
  writeFileSync(configPath, 'model = "gpt-5.6-terra"\n');
  try {
    const wired = await run(["codex-app", "--yes", "--model", "glm-5.3-flash"], codexDir, configDir);
    assert.equal(wired.status, 0, wired.stderr);
    const config = readFileSync(configPath, "utf8");
    assert.match(config, /model = "glm-5\.3-flash"/);
    assert.ok(!config.includes("gpt-5.6-terra"));

    const unset = await run(["codex-app", "--unset"], codexDir, configDir);
    assert.equal(unset.status, 0, unset.stderr);
    assert.match(readFileSync(configPath, "utf8"), /model = "gpt-5\.6-terra"/);
    assert.ok(!readFileSync(configPath, "utf8").includes("openai_base_url"));
  } finally {
    stub.close();
  }
});

test("codex-app --unset leaves a changed auth.json alone", async () => {
  const stub = await startStub();
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  const authPath = path.join(codexDir, "auth.json");
  writeFileSync(path.join(codexDir, "config.toml"), "");
  try {
    assert.equal(await run(["codex-app", "--yes"], codexDir, configDir).then((r) => r.status), 0);
    // The app re-signed in with its own API key after we wired it.
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "sk-user-own-key" }, null, 2));
    const unset = await run(["codex-app", "--unset"], codexDir, configDir);
    assert.equal(unset.status, 0, unset.stderr);
    assert.equal(JSON.parse(readFileSync(authPath, "utf8")).OPENAI_API_KEY, "sk-user-own-key", "foreign key untouched");
    assert.match(unset.stderr, /left auth\.json alone/);
  } finally {
    stub.close();
  }
});
