import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cliProxyBaseUrl, cliProxyClassifierModel, cliProxyConfigPaths, cliProxyModel, resolveCliProxy } from "../dist/agents/cliproxy.js";
import { planClaude } from "../dist/agents/claude.js";
import { planCodex } from "../dist/agents/codex.js";
import { resolveClaudeLaunchDefaults } from "../dist/agents/launch.js";
import { MCP_KEY_ENV, claudeMcpAttachment } from "../dist/agents/claude-mcp.js";
import { childEnv } from "../dist/agents/types.js";
import { startHeadlessTurn } from "../dist/remote/headless.js";
import { listEndpointsStubHandler } from "./helpers/stub-api.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const LOCAL_KEY = "proxy-local-secret-never-cloud";
const CLOUD_KEY = "ditto-cloud-mcp-only-secret";
const MODELS = ["gpt-6-luna", "claude-sonnet-5"];

async function server(handler) {
  const calls = [];
  const instance = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    handler(req, res, instance);
  });
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${instance.address().port}`, calls, close() { instance.closeAllConnections(); instance.close(); } };
}

async function proxyServer({ status = 200, redirect, models = MODELS } = {}) {
  return server((req, res) => {
    if (redirect) { res.writeHead(302, { Location: redirect }); return res.end(); }
    res.statusCode = req.headers.authorization === `Bearer ${LOCAL_KEY}` ? status : 401;
    res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id })) }));
  });
}

async function cloudServer({ mcpError = false } = {}) {
  return server((req, res, instance) => {
    const json = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.url === "/api/v5/inference/endpoints") return json(200, {
      baseUrl: `http://127.0.0.1:${instance.address().port}/v1`,
      endpoints: [{ id: "alpha-id", slug: "alpha", name: "Alpha", model: "openai/gpt-6-luna", status: "active", providerOptions: { claude_inference: "native" } }],
    });
    if (listEndpointsStubHandler(req, json)) return;
    if (req.url === "/api/v5/inference/endpoints/alpha-id/keys" && req.method === "POST") return json(201, { id: "key-1", key: CLOUD_KEY, keyHint: "cloud" });
    if (req.method === "DELETE") { res.statusCode = 204; return res.end(); }
    if (req.url === "/v1/mcp") return json(mcpError ? 503 : 200, { endpoint: "alpha", servers: [{ name: "ditto", url: "https://cloud.test/v1/mcp/ditto", tools: [{ name: "search_memories", tier: "read", approval: false }] }] });
    return json(404, {});
  });
}

function fixture(proxyUrl) {
  const root = mkdtempSync(path.join(os.tmpdir(), "heyditto-cliproxy-"));
  const bin = path.join(root, "bin"); mkdirSync(bin);
  const configDir = path.join(root, "config"); mkdirSync(configDir);
  const configFile = path.join(root, "proxy.toml");
  writeFileSync(configFile, `host = "127.0.0.1"\nport = ${new URL(proxyUrl).port}\napi-keys = ["${LOCAL_KEY}"]\nmanagement-secret-key = "must-not-use-management-key"\n`);
  const fake = `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('2.1.318 (Claude Code)'); process.exit(0); }\nconst data = {args:process.argv.slice(2), auth:process.env.ANTHROPIC_AUTH_TOKEN, mcp:process.env.DITTO_ROUTER_MCP_KEY, base:process.env.ANTHROPIC_BASE_URL, custom:process.env.ANTHROPIC_CUSTOM_HEADERS, codex:process.env.DITTO_INFERENCE_API_KEY};\nif (process.env.CLIPROXY_CAPTURE) require('node:fs').writeFileSync(process.env.CLIPROXY_CAPTURE, JSON.stringify(data));\nconsole.log(JSON.stringify(data));\n`;
  for (const harness of ["claude", "codex"]) writeFileSync(path.join(bin, harness), fake, { mode: 0o755 });
  return { root, configDir, configFile, env: {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DITTO_CONFIG_DIR: configDir,
    DITTO_API_KEY: "ditto-account-key", CLAUDE_CONFIG_DIR: path.join(root, "claude"), CLIPROXY_CONFIG: configFile,
    CLIPROXY_BASE_URL: "", CLIPROXY_API_KEY: "", NO_COLOR: "1",
  } };
}

async function run(args, env) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const status = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  return { status, stdout, stderr };
}

test("CLIProxy URLs allow only canonical loopback roots and never embedded credentials", () => {
  assert.equal(cliProxyBaseUrl("http://localhost:8317/"), "http://127.0.0.1:8317/v1");
  assert.equal(cliProxyBaseUrl("http://[::1]:8317/v1/"), "http://[::1]:8317/v1");
  for (const value of ["https://example.com/v1", "http://192.168.1.2:8317", "http://user:secret@127.0.0.1", "http://127.0.0.1:8317/v1?secret=x", "http://127.0.0.1:8317/management", "file:///tmp/proxy"]) {
    assert.throws(() => cliProxyBaseUrl(value), /CLIProxy/);
  }
  assert.deepEqual(cliProxyConfigPaths({}, "darwin", "/home/test"), ["/home/test/Library/Application Support/com.cpa.gui/config.toml"]);
});

test("discovery reads the API access key and authenticates the model catalog", async () => {
  const proxy = await proxyServer(); const f = fixture(proxy.url);
  try {
    const found = await resolveCliProxy(true, f.env);
    assert.equal(found.apiKey, LOCAL_KEY); assert.deepEqual(found.models, MODELS);
    assert.equal(proxy.calls[0].headers.authorization, `Bearer ${LOCAL_KEY}`);
    assert.equal(cliProxyModel(found, "claude"), "claude-sonnet-5");
    assert.equal(cliProxyModel(found, "codex"), "gpt-6-luna");
    assert.throws(() => cliProxyModel(found, "claude", "unavailable"), /not in CLIProxy/);
    assert.equal(resolveClaudeLaunchDefaults({ cliproxy: true }, { claude_inference: "native" }).mcpOnly, false);
  } finally { proxy.close(); }
});

test("explicit alternate port cannot silently reuse another local proxy's credential", async () => {
  const proxy = await proxyServer(); const f = fixture(proxy.url);
  try { await assert.rejects(resolveCliProxy("http://127.0.0.1:9", f.env), /No CLIProxy API access key/); }
  finally { proxy.close(); }
});

test("discovery supports EasyCLIProxyAPI annotated API key tables", async () => {
  const proxy = await proxyServer(); const f = fixture(proxy.url);
  writeFileSync(f.configFile, `host = "127.0.0.1"\nport = ${new URL(proxy.url).port}\nmanagement-secret-key = "must-not-use-management-key"\n[[api-keys]]\nkey = ""\nremark = "${LOCAL_KEY}"\n[[api-keys]]\nkey = "${LOCAL_KEY}"\nremark = "must-not-use-remark"\n`);
  try {
    const found = await resolveCliProxy(true, f.env);
    assert.equal(found.apiKey, LOCAL_KEY);
    assert.deepEqual(found.models, MODELS);
    assert.equal(proxy.calls.length, 1);
    assert.equal(proxy.calls[0].headers.authorization, `Bearer ${LOCAL_KEY}`);
  } finally { proxy.close(); }
});

test("discovery refuses redirects before a local key can reach a different endpoint", async () => {
  const destination = await proxyServer();
  const proxy = await proxyServer({ redirect: `${destination.url}/v1/models` }); const f = fixture(proxy.url);
  try {
    await assert.rejects(resolveCliProxy(true, f.env), /not reachable/);
    assert.equal(destination.calls.length, 0);
  } finally { proxy.close(); destination.close(); }
});

test("Claude plans keep local inference auth separate from cloud MCP auth and discard parent headers", () => {
  const mcp = claudeMcpAttachment({ endpoint: "alpha", servers: [{ name: "ditto", url: "https://cloud.test/mcp", tools: [{ name: "search_memories", tier: "read", approval: false }] }] }, "s");
  const plan = planClaude({ baseUrl: "http://127.0.0.1:8317/v1", apiKey: LOCAL_KEY, mcpApiKey: CLOUD_KEY, localInference: true, sessionId: "s", mcp, passthrough: [], env: {} });
  assert.equal(plan.envSet.ANTHROPIC_AUTH_TOKEN, LOCAL_KEY);
  assert.equal(plan.envSet[MCP_KEY_ENV], CLOUD_KEY);
  assert.ok(!plan.args.join(" ").includes(LOCAL_KEY)); assert.ok(!plan.args.join(" ").includes(CLOUD_KEY));
  const env = childEnv(plan, { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer parent-cloud-key", ANTHROPIC_API_KEY: "parent-key", CLAUDE_CODE_OAUTH_TOKEN: "parent-oauth", CLAUDE_CODE_USE_VERTEX: "1" });
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined); assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined); assert.equal(env.CLAUDE_CODE_USE_VERTEX, undefined);
  const codex = planCodex({ baseUrl: "http://127.0.0.1:8317/v1", apiKey: LOCAL_KEY, localInference: true, sessionId: "s", passthrough: [], env: {} });
  assert.ok(codex.args.includes('model_providers.ditto.http_headers={}'));
  assert.equal(codex.envSet.DITTO_INFERENCE_API_KEY, LOCAL_KEY);
});

test("local inference classifies auto-mode tools locally while preserving an explicit caller choice", () => {
  const input = { baseUrl: "http://127.0.0.1:8317/v1", apiKey: LOCAL_KEY, localInference: true, sessionId: "s", passthrough: [], env: {} };
  assert.equal(planClaude(input).envSet.CLAUDE_CODE_AUTO_MODE_SERVER, "0");
  for (const choice of ["0", "1"]) {
    const env = { CLAUDE_CODE_AUTO_MODE_SERVER: choice };
    const plan = planClaude({ ...input, env });
    assert.equal(plan.envSet.CLAUDE_CODE_AUTO_MODE_SERVER, undefined, "the plan must not replace an explicit value");
    assert.equal(childEnv(plan, env).CLAUDE_CODE_AUTO_MODE_SERVER, choice);
  }
});

test("explicit empty or blank CLIProxy values fail before any cloud, proxy or harness activity", async () => {
  const proxy = await proxyServer(); const cloud = await cloudServer(); const f = fixture(proxy.url);
  const marker = path.join(f.root, "harness-was-invoked");
  for (const harness of ["claude", "codex"]) {
    writeFileSync(path.join(f.root, "bin", harness), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected');\n`, { mode: 0o755 });
  }
  try {
    for (const harness of ["claude", "codex"]) {
      for (const value of ["", "   ", "\t"]) {
        const result = await run([harness, `--cliproxy=${value}`, "--endpoint", "alpha", "-p", "test"], { ...f.env, DITTO_API_BASE: cloud.url });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /--cliproxy requires a loopback URL/);
        assert.equal(result.stdout, "");
      }
    }
    assert.equal(cloud.calls.length, 0, "an explicit local request cannot fall back to the cloud");
    assert.equal(proxy.calls.length, 0, "invalid values fail before proxy preflight");
    assert.equal(existsSync(marker), false, "not even a harness version probe runs");
    assert.equal(existsSync(path.join(f.configDir, "sessions")), false, "invalid values create no session");
  } finally { proxy.close(); cloud.close(); }
});

test("dry-run detects CLIProxy, overrides a native default, and prints neither local nor cloud credential", async () => {
  const proxy = await proxyServer(); const cloud = await cloudServer(); const f = fixture(proxy.url);
  try {
    for (const harness of ["claude", "codex"]) {
      const result = await run([harness, "--cliproxy", "--dry-run", "--endpoint", "alpha"], { ...f.env, DITTO_API_BASE: cloud.url });
      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.inference, "cliproxy");
      assert.equal(plan.env[harness === "claude" ? "ANTHROPIC_AUTH_TOKEN" : "DITTO_INFERENCE_API_KEY"], "<key>");
      assert.ok(!`${result.stdout}${result.stderr}`.includes(LOCAL_KEY));
      assert.ok(!`${result.stdout}${result.stderr}`.includes(CLOUD_KEY));
    }
    assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 0);
  } finally { proxy.close(); cloud.close(); }
});

test("real launch gives each destination its own key, persists URL only, and revokes the MCP key", async () => {
  const proxy = await proxyServer(); const cloud = await cloudServer(); const f = fixture(proxy.url);
  try {
    const result = await run(["claude", "--cliproxy", "--endpoint", "alpha", "--no-remote-control", "-p", "test"], { ...f.env, DITTO_API_BASE: cloud.url, ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer wrong-parent-key" });
    assert.equal(result.status, 0, result.stderr);
    const harness = JSON.parse(result.stdout);
    assert.equal(harness.auth, LOCAL_KEY); assert.equal(harness.mcp, CLOUD_KEY);
    assert.equal(harness.custom, undefined);
    assert.equal(cloud.calls.find((call) => call.url === "/v1/mcp").headers.authorization, `Bearer ${CLOUD_KEY}`);
    assert.ok(cloud.calls.some((call) => call.method === "DELETE"));
    assert.ok(cloud.calls.every((call) => !JSON.stringify(call).includes(LOCAL_KEY)));
    assert.ok(proxy.calls.every((call) => !JSON.stringify(call).includes(CLOUD_KEY)));
    const records = readdirSync(path.join(f.configDir, "sessions")).map((name) => readFileSync(path.join(f.configDir, "sessions", name), "utf8"));
    assert.equal(records.length, 1); assert.equal(JSON.parse(records[0]).cliproxy, `${proxy.url}/v1`);
    assert.ok(!records[0].includes(LOCAL_KEY)); assert.ok(!records[0].includes(CLOUD_KEY));
  } finally { proxy.close(); cloud.close(); }
});

test("proxy/MCP failures fail closed without launching or using Router inference", async () => {
  const proxy = await proxyServer({ status: 401 }); const cloud = await cloudServer(); const f = fixture(proxy.url);
  try {
    const result = await run(["claude", "--cliproxy", "--endpoint", "alpha", "--dry-run"], { ...f.env, DITTO_API_BASE: cloud.url });
    assert.equal(result.status, 1); assert.match(result.stderr, /HTTP 401/);
    assert.equal(cloud.calls.length, 0, "local preflight fails before cloud API access");
  } finally { proxy.close(); cloud.close(); }
  const healthy = await proxyServer(); const unavailable = await cloudServer({ mcpError: true }); const f2 = fixture(healthy.url);
  try {
    const result = await run(["claude", "--cliproxy", "--endpoint", "alpha", "--no-remote-control", "-p", "test"], { ...f2.env, DITTO_API_BASE: unavailable.url });
    assert.equal(result.status, 1); assert.match(result.stderr, /no inference Router fallback/);
    assert.equal(result.stdout, "");
    assert.ok(unavailable.calls.some((call) => call.method === "DELETE"));
    assert.ok(!unavailable.calls.some((call) => call.url === "/v1/messages"));
  } finally { healthy.close(); unavailable.close(); }
});

test("Codex resume retains CLIProxy and an explicit --no-cliproxy switches back", async () => {
  const proxy = await proxyServer(); const cloud = await cloudServer(); const f = fixture(proxy.url);
  const sessions = path.join(f.configDir, "sessions"); mkdirSync(sessions);
  writeFileSync(path.join(sessions, "resume-local.json"), JSON.stringify({ id: "resume-local", harness: "codex", cliproxy: `${proxy.url}/v1`, endpointId: "alpha-id", endpointSlug: "alpha", cwd: f.root, createdAt: new Date().toISOString(), lastLaunchedAt: new Date().toISOString(), launches: 1 }));
  try {
    const env = { ...f.env, DITTO_API_BASE: cloud.url };
    const resumed = await run(["codex", "--resume", "resume-local", "--dry-run"], env);
    assert.equal(resumed.status, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).inference, "cliproxy");
    const router = await run(["codex", "--resume", "resume-local", "--no-cliproxy", "--dry-run"], env);
    assert.equal(router.status, 0, router.stderr); assert.equal(JSON.parse(router.stdout).inference, "router");
    const clash = await run(["claude", "--cliproxy", "--mcp-only", "--dry-run"], env);
    assert.equal(clash.status, 1); assert.match(clash.stderr, /choose either/);
  } finally { proxy.close(); cloud.close(); }
});

test("headless turns retain local inference and the separate cloud MCP credential", async () => {
  const f = fixture("http://127.0.0.1:8317"); const capture = path.join(f.root, "capture.json");
  const turn = startHeadlessTurn({ harness: "claude", cwd: f.root, prompt: "test", base: {
    baseUrl: "http://127.0.0.1:8317/v1", apiKey: LOCAL_KEY, mcpApiKey: CLOUD_KEY, localInference: true,
    sessionId: "headless", env: { ...f.env, CLIPROXY_CAPTURE: capture },
    mcp: claudeMcpAttachment({ endpoint: "alpha", servers: [{ name: "ditto", url: "https://cloud.test/mcp", tools: [{ name: "search_memories", tier: "read", approval: false }] }] }, "headless"),
  } });
  assert.equal(await turn.exit, 0);
  const captured = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(captured.auth, LOCAL_KEY); assert.equal(captured.mcp, CLOUD_KEY);
});

const CLASSIFIER = "ditto-auto-mode-classifier";

test("the auto-mode classifier id needs a CLIProxy catalog entry and is never a Claude or main-loop id", () => {
  const proxy = { models: [...MODELS, CLASSIFIER] };
  assert.deepEqual(cliProxyClassifierModel(proxy, undefined), {});
  assert.deepEqual(cliProxyClassifierModel(proxy, "  "), {});
  assert.deepEqual(cliProxyClassifierModel(proxy, CLASSIFIER, "claude-sonnet-5"), { model: CLASSIFIER });
  const missing = cliProxyClassifierModel({ models: MODELS }, CLASSIFIER);
  assert.equal(missing.model, undefined, "an id the proxy does not serve would fail, and so block, every permission check");
  assert.match(missing.notice, /keep Claude Code's default classifier model/);
  assert.throws(() => cliProxyClassifierModel(proxy, "claude-sonnet-5"), /dedicated model id/);
  assert.throws(() => cliProxyClassifierModel(proxy, "Ditto Classifier"), /lowercase/);
  assert.throws(() => cliProxyClassifierModel({ models: [CLASSIFIER] }, CLASSIFIER, CLASSIFIER), /main model/);
});

test("Claude plans set the classifier id and request-class hints only for a vetted CLIProxy id", () => {
  const input = { baseUrl: "http://127.0.0.1:8317/v1", apiKey: LOCAL_KEY, localInference: true, sessionId: "s", passthrough: [], env: {} };
  const off = planClaude(input).envSet;
  assert.equal(off.CLAUDE_CODE_AUTO_MODE_MODEL, undefined);
  assert.equal(off.CLAUDE_CODE_GATEWAY_HINT_HEADERS, undefined, "without the opt-in the CLIProxy route keeps its current headers");
  const on = planClaude({ ...input, autoModeClassifierModel: CLASSIFIER }).envSet;
  assert.equal(on.CLAUDE_CODE_AUTO_MODE_MODEL, CLASSIFIER);
  assert.equal(on.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1");
  assert.equal(on.CLAUDE_CODE_AUTO_MODE_SERVER, "0", "the local classifier still decides");
  const explicit = planClaude({ ...input, autoModeClassifierModel: CLASSIFIER, env: { CLAUDE_CODE_GATEWAY_HINT_HEADERS: "0" } }).envSet;
  assert.equal(explicit.CLAUDE_CODE_GATEWAY_HINT_HEADERS, undefined, "an explicit caller choice stays");
});

test("dry-run applies --auto-mode-classifier or its environment fallback only when CLIProxy lists the id", async () => {
  const listed = await proxyServer({ models: [...MODELS, CLASSIFIER] }); const unlisted = await proxyServer(); const cloud = await cloudServer();
  try {
    const f = fixture(listed.url);
    const flag = await run(["claude", "--cliproxy", "--auto-mode-classifier", CLASSIFIER, "--dry-run", "--endpoint", "alpha"], { ...f.env, DITTO_API_BASE: cloud.url });
    assert.equal(flag.status, 0, flag.stderr);
    const plan = JSON.parse(flag.stdout);
    assert.equal(plan.env.CLAUDE_CODE_AUTO_MODE_MODEL, CLASSIFIER);
    assert.equal(plan.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS, "1");
    assert.match(flag.stderr, /auto-mode classifier=ditto-auto-mode-classifier/);

    const g = fixture(unlisted.url);
    const ambient = await run(["claude", "--cliproxy", "--dry-run", "--endpoint", "alpha"], { ...g.env, DITTO_API_BASE: cloud.url, DITTO_AUTO_MODE_CLASSIFIER: CLASSIFIER });
    assert.equal(ambient.status, 0, ambient.stderr);
    assert.equal(JSON.parse(ambient.stdout).env.CLAUDE_CODE_AUTO_MODE_MODEL, undefined);
    assert.match(ambient.stderr, /not in CLIProxy's model catalog/);

    const router = await run(["claude", "--auto-mode-classifier", CLASSIFIER, "--dry-run", "--endpoint", "alpha"], { ...g.env, DITTO_API_BASE: cloud.url });
    assert.equal(router.status, 1);
    assert.match(router.stderr, /applies only to heyditto claude --cliproxy/);
    const routerAmbient = await run(["claude", "--no-mcp-only", "--dry-run", "--endpoint", "alpha"], { ...g.env, DITTO_API_BASE: cloud.url, DITTO_AUTO_MODE_CLASSIFIER: CLASSIFIER });
    assert.equal(routerAmbient.status, 0, routerAmbient.stderr);
    assert.equal(JSON.parse(routerAmbient.stdout).env.CLAUDE_CODE_AUTO_MODE_MODEL, undefined, "the environment fallback never reaches a Router launch");
  } finally { listed.close(); unlisted.close(); cloud.close(); }
});

test("a launch inside a classifier-routed session drops only the classifier id heyditto injected", () => {
  const base = { baseUrl: "http://127.0.0.1:8317/v1", apiKey: LOCAL_KEY, sessionId: "s", passthrough: [] };
  const injected = { CLAUDE_CODE_AUTO_MODE_MODEL: CLASSIFIER, DITTO_AUTO_MODE_CLASSIFIER_APPLIED: CLASSIFIER };
  const applied = planClaude({ ...base, localInference: true, autoModeClassifierModel: CLASSIFIER, env: {} });
  assert.equal(applied.envSet.DITTO_AUTO_MODE_CLASSIFIER_APPLIED, CLASSIFIER, "an applied id is marked for later launches");
  for (const [name, input] of [
    ["router", { ...base, env: injected }],
    ["cliproxy without the opt-in", { ...base, localInference: true, env: injected }],
    ["native account", { ...base, mcpOnly: true, env: injected }],
  ]) {
    const env = childEnv(planClaude(input), injected);
    assert.equal(env.CLAUDE_CODE_AUTO_MODE_MODEL, undefined, `${name}: the inherited id would reach a model that does not serve it`);
    assert.equal(env.DITTO_AUTO_MODE_CLASSIFIER_APPLIED, undefined, name);
  }
  const own = { CLAUDE_CODE_AUTO_MODE_MODEL: "claude-opus-4-8" };
  assert.equal(childEnv(planClaude({ ...base, env: own }), own).CLAUDE_CODE_AUTO_MODE_MODEL, "claude-opus-4-8", "a value the user chose stays");
  const changed = { CLAUDE_CODE_AUTO_MODE_MODEL: "claude-opus-4-8", DITTO_AUTO_MODE_CLASSIFIER_APPLIED: CLASSIFIER };
  const after = childEnv(planClaude({ ...base, env: changed }), changed);
  assert.equal(after.CLAUDE_CODE_AUTO_MODE_MODEL, "claude-opus-4-8", "a value changed after the marker was set is the user's");
  assert.equal(after.DITTO_AUTO_MODE_CLASSIFIER_APPLIED, undefined);
  const reapplied = childEnv(planClaude({ ...base, localInference: true, autoModeClassifierModel: CLASSIFIER, env: injected }), injected);
  assert.equal(reapplied.CLAUDE_CODE_AUTO_MODE_MODEL, CLASSIFIER, "a nested CLIProxy launch that opts in keeps it");
});

test("an explicitly empty --auto-mode-classifier fails before any proxy or cloud activity", async () => {
  const proxy = await proxyServer({ models: [...MODELS, CLASSIFIER] }); const cloud = await cloudServer(); const f = fixture(proxy.url);
  try {
    for (const value of ["", "   "]) {
      const result = await run(["claude", "--cliproxy", `--auto-mode-classifier=${value}`, "--dry-run", "--endpoint", "alpha"], { ...f.env, DITTO_API_BASE: cloud.url });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /--auto-mode-classifier requires a model id/);
    }
    assert.equal(proxy.calls.length, 0);
    assert.equal(cloud.calls.length, 0);
  } finally { proxy.close(); cloud.close(); }
});

test("classifier errors name the setting that carried the id", async () => {
  const proxy = { models: [...MODELS, CLASSIFIER] };
  assert.throws(() => cliProxyClassifierModel(proxy, "claude-sonnet-5", undefined, "DITTO_AUTO_MODE_CLASSIFIER"), /^Error: DITTO_AUTO_MODE_CLASSIFIER needs a dedicated model id/);
  const listed = await proxyServer({ models: [...MODELS, CLASSIFIER] }); const cloud = await cloudServer(); const f = fixture(listed.url);
  try {
    const ambient = await run(["claude", "--cliproxy", "--dry-run", "--endpoint", "alpha"], { ...f.env, DITTO_API_BASE: cloud.url, DITTO_AUTO_MODE_CLASSIFIER: "Not Valid" });
    assert.equal(ambient.status, 1);
    assert.match(ambient.stderr, /DITTO_AUTO_MODE_CLASSIFIER needs a model id/);
    assert.doesNotMatch(ambient.stderr, /--auto-mode-classifier needs/);
    const flag = await run(["claude", "--cliproxy", "--auto-mode-classifier", "Not Valid", "--dry-run", "--endpoint", "alpha"], { ...f.env, DITTO_API_BASE: cloud.url });
    assert.match(flag.stderr, /--auto-mode-classifier needs a model id/);
  } finally { listed.close(); cloud.close(); }
});
