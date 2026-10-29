import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkIdentificationProvider, identificationPlan, localProviderHints } from "../dist/provider-key-identify.js";
import { probeMetadata } from "../dist/provider-key-api.js";

const SECRET = "sk-proj-synthetic-identification-only";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("offline hints are narrow and never imply credential ownership", () => {
  for (const [key, expected] of [[SECRET, "openai"], ["sk-svcacct-test", "openai"], ["sk-ant-test", "anthropic"], ["sk-or-v1-test", "openrouter"], ["sk-engy-test", "engy"]]) assert.deepEqual(localProviderHints(key), [expected]);
  for (const value of ["opaque", "sk-ambiguous", "gm-unknown"]) assert.deepEqual(localProviderHints(value), []);
});

test("shortlist requires explicit consent and fixed unique provider IDs", () => {
  assert.deepEqual(identificationPlan([], false), []);
  assert.throws(() => identificationPlan(["openai"], false), /confirm-key-sharing/);
  for (const values of [[SECRET], ["__proto__"], ["constructor"], ["custom"], ["impala"], ["openai", "openai"], Array(5).fill("gm")]) {
    assert.throws(() => identificationPlan(values, true), error => !error.message.includes(SECRET));
  }
  const plan = identificationPlan(["openai", "anthropic", "openrouter", "gm"], false, true);
  assert.deepEqual(plan.map(row => row.destination), ["https://api.openai.com/v1/models", "https://api.anthropic.com/v1/models", "https://openrouter.ai/api/v1/key", "https://api.saygm.com/v1/credits"]);
  assert.ok(plan.every(row => row.method === "GET"));
});

test("checks use only fixed GET endpoints and private headers, with redirect rejection and a deadline", async () => {
  for (const provider of ["openai", "anthropic", "openrouter", "gm"]) {
    let count = 0;
    const result = await checkIdentificationProvider(provider, SECRET, async (url, init) => {
      count++;
      assert.equal(url, identificationPlan([provider], true)[0].destination);
      assert.equal(init.method, "GET"); assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.body, undefined);
      if (provider === "anthropic") { assert.equal(init.headers["x-api-key"], SECRET); assert.equal(init.headers["anthropic-version"], "2023-06-01"); }
      else assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
      return json({ data: [], debug: SECRET });
    });
    assert.equal(count, 1);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.equal(result.status, ["openai", "anthropic"].includes(provider) ? "models_advertised" : "unknown");
  }
});

test("only typed authenticated key/balance responses count as read-only acceptance", async () => {
  const accepted = await checkIdentificationProvider("openrouter", SECRET, async () => json({ data: { label: SECRET, usage: 0, limit: null }, debug: SECRET }));
  const gm = await checkIdentificationProvider("gm", SECRET, async () => json({ object: "credit_balance", balance: { usd: "-0.001" }, debug: SECRET }));
  assert.equal(accepted.status, "accepted_read_only"); assert.equal(gm.status, "accepted_read_only");
  assert.ok(!JSON.stringify([accepted, gm]).includes(SECRET));
  for (const raw of [{}, { data: [] }, { data: { label: SECRET } }, { error: SECRET, data: { label: "a", usage: 0, limit: null } }]) {
    assert.equal((await checkIdentificationProvider("openrouter", SECRET, async () => json(raw))).status, "unknown");
  }
});

test("errors, denied permission, redirects, oversized and malformed responses never expose upstream text", async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    const result = await checkIdentificationProvider("gm", SECRET, async () => new Response(SECRET, { status, headers: { location: `https://example.com/${SECRET}` } }));
    assert.equal(result.status, status === 401 ? "rejected" : status === 429 ? "rate_limited" : "unknown");
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
  for (const transport of [async () => { throw new Error(SECRET); }, async () => new Response(SECRET), async () => new Response("x".repeat(65_537)), async () => new Response("{}", { headers: { "content-length": "65537" } })]) {
    const result = await checkIdentificationProvider("openrouter", SECRET, transport);
    assert.equal(result.status, "unknown"); assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test("real fetch cannot follow a redirect carrying the key to a second origin", async t => {
  let secondCalls = 0;
  const second = http.createServer((req, res) => { secondCalls++; res.end("{}"); });
  await new Promise(resolve => second.listen(0, "127.0.0.1", resolve));
  const first = http.createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${second.address().port}/` }); res.end(); });
  await new Promise(resolve => first.listen(0, "127.0.0.1", resolve));
  t.after(async () => { first.closeAllConnections(); second.closeAllConnections(); await Promise.all([new Promise(resolve => first.close(resolve)), new Promise(resolve => second.close(resolve))]); });
  const result = await checkIdentificationProvider("openrouter", SECRET, (_url, init) => fetch(`http://127.0.0.1:${first.address().port}/`, init));
  assert.equal(result.status, "unknown"); assert.equal(secondCalls, 0);
});

test("slow response bodies stop at the five-second deadline without diagnostics", async () => {
  const start = Date.now();
  const result = await checkIdentificationProvider("gm", SECRET, async (_url, init) => new Response(new ReadableStream({ start(controller) { init.signal.addEventListener("abort", () => controller.error(new Error(SECRET)), { once: true }); } })));
  assert.equal(result.status, "unknown"); assert.ok(Date.now() - start < 7000); assert.ok(!JSON.stringify(result).includes(SECRET));
});

async function subprocess(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heyditto-identify-")), log = path.join(dir, "calls.jsonl"), preload = path.join(dir, "transport.mjs");
  // This test-only transport logs fixed URLs, never headers or credentials.
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  appendFileSync(process.env.IDENTIFY_TEST_LOG, JSON.stringify({url, method:init?.method})+'\\n');
  if (process.env.IDENTIFY_TEST_MODE === 'throw') throw new Error(process.env.IDENTIFY_TEST_SECRET);
  if (url === 'https://openrouter.ai/api/v1/key') return new Response(JSON.stringify({data:{label:process.env.IDENTIFY_TEST_SECRET,usage:0,limit:null}}));
  if (url === 'https://api.saygm.com/v1/credits') return new Response(JSON.stringify({object:'credit_balance',balance:{usd:'0'}}));
  throw new Error(process.env.IDENTIFY_TEST_SECRET);
};`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = (args, input = "", extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", preload, cli, "--no-auto-update", "provider-keys", ...args], { env: { ...process.env, DITTO_API_KEY: "", DITTO_CONFIG_DIR: dir, IDENTIFY_TEST_LOG: log, IDENTIFY_TEST_SECRET: SECRET, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.on("error", () => {}); child.stdin.end(input);
  });
  return { run, calls: async () => { try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === "ENOENT") return []; throw error; } } };
}

test("CLI default and dry run never contact any network or need Ditto login", async t => {
  const f = await subprocess(t);
  const offline = await f.run(["identify", "--key-env", "IDENTIFY_TEST_SECRET"]);
  assert.equal(offline.code, 0, offline.stderr); assert.deepEqual(JSON.parse(offline.stdout).hints, ["openai"]);
  const dry = await f.run(["detect", "--dry-run", "--try-provider", "openrouter", "--try-provider", "gm"], "", { IDENTIFY_TEST_SECRET: "" });
  assert.equal(dry.code, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).keyRead, false);
  assert.equal(JSON.parse(dry.stdout).destinations.length, 2); assert.deepEqual(await f.calls(), []);
  assert.ok(!`${offline.stdout}${offline.stderr}${dry.stdout}${dry.stderr}`.includes(SECRET));
});

test("CLI refuses missing consent, custom destinations and invalid secret sources before networking", async t => {
  const f = await subprocess(t);
  for (const args of [["identify", "--try-provider", "openai"], ["identify", "--try-provider", "custom", "--dry-run"], ["identify", "--try-provider", "gm", "--confirm-key-sharing", "--stdin", "--key-env", "IDENTIFY_TEST_SECRET"]]) {
    const result = await f.run(args, SECRET); assert.equal(result.code, 1); assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
  }
  assert.deepEqual(await f.calls(), []);
});

test("CLI explicit multiple accepted providers never select, save, or print a credential", async t => {
  const f = await subprocess(t);
  const result = await f.run(["identify", "--stdin", "--try-provider", "openrouter", "--try-provider", "gm", "--confirm-key-sharing"], SECRET);
  assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(data.checks.map(row => row.status), ["accepted_read_only", "accepted_read_only"]);
  assert.equal(data.selectedProvider, null); assert.equal(data.stored, false); assert.equal(data.generationCallsMade, 0);
  assert.deepEqual((await f.calls()).map(call => call.url), ["https://openrouter.ai/api/v1/key", "https://api.saygm.com/v1/credits"]);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
});

test("CLI suppresses credential-bearing transport exceptions", async t => {
  const f = await subprocess(t);
  const result = await f.run(["identify", "--key-env", "IDENTIFY_TEST_SECRET", "--try-provider", "gm", "--confirm-key-sharing"], "", { IDENTIFY_TEST_MODE: "throw" });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).checks[0].status, "unknown"); assert.ok(!`${result.stdout}${result.stderr}`.includes(SECRET));
});

test("probe metric basis is a fixed enum, never reflected upstream text", () => {
  const raw = { calls: [{ model: "safe", tokensPerSecond: 10, tokensPerSecondBasis: "end_to_end_output_tokens" }, { model: "safe", tokensPerSecond: 12, tokensPerSecondBasis: SECRET }] };
  const result = probeMetadata(raw);
  assert.equal(result.calls[0].tokensPerSecondBasis, "end_to_end_output_tokens");
  assert.equal(result.calls[1].tokensPerSecondBasis, undefined); assert.ok(!JSON.stringify(result).includes(SECRET));
});
