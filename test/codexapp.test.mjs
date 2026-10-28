import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";

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
function startStub({ endpoint = ALPHA, catalogStatus = 200, models, pages } = {}) {
  const calls = [];
  let minted = 1;
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
        return json(200, { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, endpoints: [endpoint], limit: 5, used: 1 });
      }
      if (req.url.startsWith("/v1/models") && req.method === "GET") {
        assert.equal(req.headers.authorization, `Bearer ${MINTED_PLAINTEXT}`);
        assert.equal(req.headers["x-ditto-codex-models"], "true");
        if (pages) {
          const cursor = new URL(req.url, "http://stub").searchParams.get("codex_cursor") ?? "first";
          return json(200, pages[cursor]);
        }
        return json(catalogStatus, { models: models ?? [{ slug: endpoint.slug }, { slug: "openai/gpt-5.6-luna" }, { slug: "glm-5.3-flash" }] });
      }
      if (listEndpointsStubHandler(req, json)) return;
      const m = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)(\/keys(?:\/([^/]+))?)?$/);
      if (m && m[2] === "/keys" && req.method === "POST") {
        const input = JSON.parse(body);
        if (endpoint.access?.iamEnforced && !endpoint.access.createKey && !["1h","4h","8h","12h"].includes(input.expiresIn)) return json(403,{message:"this role permits temporary session keys only"});
        return json(201, { id: `key-${++minted}`, endpointId: m[1], name: input.name, keyHint: "zz99", key: MINTED_PLAINTEXT, expiresAt: "2027-09-05T00:00:00Z", spendLimitTokens: input.spendLimitTokens ?? null, spendPeriod: input.spendPeriod ?? "never" });
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
    assert.equal(plan.baseUrl, `${stub.base}/v1`);
    assert.equal(plan.write[path.join(codexDir, "config.toml")].openai_base_url, `${stub.base}/v1`);
    assert.equal(plan.changesEndpointSettings, false);
    assert.equal(plan.write[path.join(codexDir, "config.toml")].model_provider, "openai");
    assert.equal(plan.write[path.join(codexDir, "config.toml")].model, "alpha");
    assert.equal(plan.enableModelPicker, true);
    assert.equal(existsSync(path.join(codexDir, "config.toml")), false, "config.toml untouched");
    assert.equal(existsSync(path.join(codexDir, "auth.json")), false, "auth.json untouched");
    assert.equal(stub.mints().length, 0, "no key minted on dry-run");
  } finally {
    stub.close();
  }
});

test("codex-app wires config.toml + auth.json and a local picker without changing the endpoint, and --unset restores", async () => {
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
    assert.equal(parseToml(config).openai_base_url, `${stub.base}/v1`);
    assert.match(config, /forced_login_method = "api"/);
    assert.match(config, /# added by `heyditto codex-app`/);
    assert.equal(parseToml(config).model, "alpha", "unavailable model replaced by endpoint default");
    assert.equal(parseToml(config).model_provider, "openai");
    const catalog = JSON.parse(readFileSync(parseToml(config).model_catalog_json, "utf8"));
    assert.equal(catalog.models.length, 3);
    assert.ok(config.includes("[projects."), "existing tables preserved");
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(auth.OPENAI_API_KEY, MINTED_PLAINTEXT);
    assert.equal(stub.patches().length, 0, "setup never modifies endpoint settings");
    assert.ok(!first.stderr.includes("Sign in with an API key"), "no second login step");
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
    assert.ok(!restored.includes("forced_login_method"), "forced_login_method removed");
    assert.ok(restored.includes('model = "gpt-5.6-terra"'), "model preserved");
    assert.ok(restored.includes("[projects."), "tables preserved");
    assert.equal(existsSync(authPath), false, "codex-app's auth.json removed");
    assert.equal(stub.revocations().length, 2, "key revoked on unset");
    assert.deepEqual(stub.revocations().map((call) => call.url.split("/").at(-1)), ["key-2", "key-3"], "rotation revokes old ID and unset revokes new ID");
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
    assert.ok(!readFileSync(configPath, "utf8").includes("forced_login_method"));
  } finally {
    stub.close();
  }
});

test("codex-app restores a pre-existing forced_login_method on --unset", async () => {
  const stub = await startStub();
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  const configPath = path.join(codexDir, "config.toml");
  writeFileSync(configPath, 'forced_login_method = "chatgpt"\n');
  try {
    const wired = await run(["codex-app", "--yes"], codexDir, configDir);
    assert.equal(wired.status, 0, wired.stderr);
    assert.match(readFileSync(configPath, "utf8"), /forced_login_method = "api"/);

    const unset = await run(["codex-app", "--unset"], codexDir, configDir);
    assert.equal(unset.status, 0, unset.stderr);
    assert.match(readFileSync(configPath, "utf8"), /forced_login_method = "chatgpt"/, "previous value restored");
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

test("company setup replaces an old provider and restores provider, picker and model on unset", async () => {
  const stub = await startStub({ endpoint: { ...ALPHA, companyId: "company-1" } });
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  const configPath = path.join(codexDir, "config.toml");
  const original = 'model_provider = "old-router"\nmodel = "old-model"\nmodel_catalog_json = "/original/catalog.json"\n[model_providers.old-router]\nname = "Old router"\nbase_url = "https://old.test/v1"\n';
  writeFileSync(configPath, original);
  try {
    const wired = await run(["codex-app", "--endpoint", "alpha", "--yes"], codexDir, configDir);
    assert.equal(wired.status, 0, wired.stderr);
    const config = parseToml(readFileSync(configPath, "utf8"));
    assert.equal(config.model_provider, "openai");
    assert.equal(config.model, "alpha");
    assert.equal(config.model_providers["old-router"].base_url, "https://old.test/v1");
    assert.equal(stub.patches().length, 0, "member never needs manager access");
    assert.match(wired.stderr, /company router/);
    assert.ok(!wired.stderr.includes(MINTED_PLAINTEXT), "no credential printed by default");
    assert.match(wired.stderr, /models ready/);
    const second = await run(["codex-app", "--endpoint", "alpha", "--yes"], codexDir, configDir);
    assert.equal(second.status, 0, second.stderr);
    assert.equal((await run(["codex-app", "--unset"], codexDir, configDir)).status, 0);
    assert.equal(readFileSync(configPath, "utf8"), original, "re-running does not overwrite the original settings to restore");
  } finally { stub.close(); }
});

test("setup keeps a model chosen in the app when the new catalog includes it", async () => {
  const stub = await startStub();
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  const configPath = path.join(codexDir, "config.toml");
  writeFileSync(configPath, 'model = "glm-5.3-flash"\n');
  try {
    const wired = await run(["codex-app", "--endpoint", "alpha", "--yes"], codexDir, configDir);
    assert.equal(wired.status, 0, wired.stderr);
    assert.equal(parseToml(readFileSync(configPath, "utf8")).model, "glm-5.3-flash");
  } finally { stub.close(); }
});

for (const fixture of [{ catalogStatus: 503 }, { models: [] }]) {
  test(`catalog failure ${JSON.stringify(fixture)} preserves the previous login and revokes the unused key`, async () => {
    const stub = await startStub(fixture);
    STUB_BASE = stub.base;
    const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
    const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
    const configPath = path.join(codexDir, "config.toml");
    const authPath = path.join(codexDir, "auth.json");
    const original = 'model_provider = "old"\nmodel = "original"\n';
    const auth = '{"tokens":{"id_token":"previous-login"}}';
    writeFileSync(configPath, original);
    writeFileSync(authPath, auth);
    try {
      const result = await run(["codex-app", "--endpoint", "alpha", "--yes"], codexDir, configDir);
      assert.equal(result.status, 1);
      assert.equal(readFileSync(configPath, "utf8"), original);
      assert.equal(readFileSync(authPath, "utf8"), auth);
      assert.equal(stub.mints().length, 1);
      assert.equal(stub.revocations().length, 1);
      assert.equal(stub.patches().length, 0);
      assert.ok(!result.stderr.includes(MINTED_PLAINTEXT));
    } finally { stub.close(); }
  });
}

test("adding a top-level provider does not rewrite a nested provider setting", () => {
  const original = '[profiles.other]\nmodel_provider = "other"\n';
  const config = parseToml(upsertTopLevelString(original, "model_provider", "openai"));
  assert.equal(config.model_provider, "openai");
  assert.equal(config.profiles.other.model_provider, "other");
});

test("Desktop downloads every catalog page, including Claude and open models", async () => {
  const stub = await startStub({ pages: {
    first: { models: [{ slug: "alpha" }, { slug: "openai/gpt-6.1-sol" }], next_cursor: "2" },
    "2": { models: [{ slug: "anthropic/claude-fable-5.1" }], next_cursor: "3" },
    "3": { models: [{ slug: "z-ai/glm-5.3-flash" }] },
  } });
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  try {
    const result = await run(["codex-app", "--endpoint", "alpha"], codexDir, configDir);
    assert.equal(result.status, 0, result.stderr);
    const config = parseToml(readFileSync(path.join(codexDir, "config.toml"), "utf8"));
    assert.deepEqual(JSON.parse(readFileSync(config.model_catalog_json, "utf8")).models.map(m => m.slug), ["alpha", "openai/gpt-6.1-sol", "anthropic/claude-fable-5.1", "z-ai/glm-5.3-flash"]);
    assert.equal(stub.calls.filter(c => c.url.startsWith("/v1/models")).length, 3);
    assert.equal(stub.patches().length, 0);
  } finally { stub.close(); }
});

test("repeated catalog cursors fail without saving a partial model picker", async () => {
  const stub = await startStub({ pages: {
    first: { models: [{ slug: "alpha" }], next_cursor: "0" },
    "0": { models: [{ slug: "alpha" }], next_cursor: "0" },
  } });
  STUB_BASE = stub.base;
  const codexDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-home-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "heyditto-codexapp-cfg-"));
  try {
    const result = await run(["codex-app", "--endpoint", "alpha"], codexDir, configDir);
    assert.equal(result.status, 1);
    assert.equal(existsSync(path.join(codexDir, "config.toml")), false);
    assert.equal(stub.revocations().length, 1);
  } finally { stub.close(); }
});


test("IAM use-only Desktop setup defaults to a bounded key and never patches shared settings", async () => {
  const stub=await startStub({endpoint:{...ALPHA,companyId:"company-1",access:{iamEnforced:true,createSession:true,createKey:false,maxSessionSeconds:43200}}});STUB_BASE=stub.base;
  const home=mkdtempSync(path.join(os.tmpdir(),"iam-codex-home-"));const cfg=mkdtempSync(path.join(os.tmpdir(),"iam-codex-cfg-"));
  try{
    const result=await run(["codex-app","--endpoint","alpha"],home,cfg);
    assert.equal(result.status,0,result.stderr);assert.equal(stub.mints()[0].body.expiresIn,"12h");assert.equal(stub.patches().length,0);
    assert(existsSync(path.join(home,"ditto-models.json")));
  }finally{stub.close();}
});

test("an explicit overlong use-only Desktop expiry is refused once without replacing local login", async () => {
  const stub=await startStub({endpoint:{...ALPHA,companyId:"company-1",access:{iamEnforced:true,createSession:true,createKey:false,maxSessionSeconds:43200}}});STUB_BASE=stub.base;
  const home=mkdtempSync(path.join(os.tmpdir(),"iam-codex-home-"));const cfg=mkdtempSync(path.join(os.tmpdir(),"iam-codex-cfg-"));const before='model = "old"\n';writeFileSync(path.join(home,"config.toml"),before);
  try{
    const result=await run(["codex-app","--endpoint","alpha","--expires","1mo"],home,cfg);
    assert.equal(result.status,1);assert.match(result.stderr,/temporary session keys/);assert.equal(stub.mints().length,1);assert.equal(stub.mints()[0].body.expiresIn,"1mo");assert.equal(stub.patches().length,0);assert.equal(readFileSync(path.join(home,"config.toml"),"utf8"),before);assert(!existsSync(path.join(home,"auth.json")));
  }finally{stub.close();}
});
