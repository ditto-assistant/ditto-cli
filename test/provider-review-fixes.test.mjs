import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { apiFetch, ApiError, createApp } from "../dist/api.js";
import { inspectionMetadata, probeMetadata, providerManagementFetch } from "../dist/provider-key-api.js";
import { decodeProviderSecret, gcloudInvocation, readProviderSecret, readProviderSecretFromStream } from "../dist/provider-secrets.js";
import { redactKnownSecrets, secretSafeMetadata } from "../dist/secret-redaction.js";
import { publicProviderParams } from "../dist/provider-key-input.js";

const SECRET = "synthetic-secret-review-only";
process.env.DITTO_API_KEY = "ditto_mcp_synthetic_test";
process.env.DITTO_API_BASE = "http://127.0.0.1:1";
async function withTransport(transport, action) {
  const previous = globalThis.fetch;
  globalThis.fetch = transport;
  try { return await action(); } finally { globalThis.fetch = previous; }
}

test("metadata redaction handles quote and trailing-backslash keys without changing JSON structure", () => {
  for (const key of ['"', "a\\", 'a"b\\c']) {
    const result = secretSafeMetadata({ name: key, nested: { [key]: [key, `prefix ${key} suffix`] }, count: 1 }, [key]);
    assert.equal(result.name, "[redacted]"); assert.equal(result.count, 1);
    assert.deepEqual(result.nested["[redacted]"], ["[redacted]", "prefix [redacted] suffix"]);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assert.equal(redactKnownSecrets(JSON.stringify(key), [key]).includes(JSON.stringify(key).slice(1, -1)), false);
  }
});

test("overlapping credentials redact longest-first across every known secret and encoding", () => {
  for (const keys of [["pass", "password"], ["password", "pass"], ["pass", "password", "password/long"]]) {
    assert.equal(redactKnownSecrets("password password/long pass", keys), keys.length === 3 ? "[redacted] [redacted] [redacted]" : "[redacted] [redacted]/long [redacted]");
    assert.equal(redactKnownSecrets("password%2Flong", ["pass", "password/long"]), "[redacted]");
  }
});

test("Windows gcloud batch invocation quotes bounded scope tokens and rejects shell expansion", () => {
  const args = ["auth", "list", "--format=json(account,status)", "--account", "qa+test@example.com"];
  const win = gcloudInvocation(args, "win32");
  assert.equal(win.command, "cmd.exe"); assert.deepEqual(win.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(win.windowsVerbatimArguments, true);
  assert.equal(win.args[3], '\"\"gcloud.cmd\" \"auth\" \"list\" \"--format=json(account,status)\" \"--account\" \"qa+test@example.com\" \"--quiet\" \"--verbosity=none\"\"');
  const posix = gcloudInvocation(args, "linux"); assert.equal(posix.command, "gcloud"); assert.deepEqual(posix.args.slice(0, args.length), args);
  for (const value of ['bad&whoami', '%PATH%', '!PATH!', 'bad|x', 'bad^x', 'bad"x', 'bad`x', 'bad x', `${SECRET}&exit`]) assert.throws(() => gcloudInvocation(["--account", value], "win32"), error => /Windows batch wrapper/.test(error.message) && !error.message.includes(SECRET));
});

test("hidden input backspace removes complete Unicode code points without echo", async () => {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin"), stderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.isRaw = false; input.setRawMode = value => { input.isRaw = value; };
  output.isTTY = true;
  let printed = ""; output.on("data", chunk => printed += chunk);
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stderr", { value: output, configurable: true });
  try {
    const pending = readProviderSecret({});
    input.write(Buffer.from("abc😀\u007fx\bZ\n"));
    assert.equal(await pending, "abcZ"); assert.equal(input.isRaw, false);
    assert.ok(!printed.includes("abc")); assert.ok(!printed.includes("😀"));
  } finally {
    Object.defineProperty(process, "stdin", stdinDescriptor); Object.defineProperty(process, "stderr", stderrDescriptor);
    input.destroy(); output.destroy();
  }
});

test("management body stream failures cannot reflect secret diagnostics", async () => {
  await withTransport(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(SECRET)); } })), async () => {
    await assert.rejects(providerManagementFetch("/api/v5/inference/provider-keys"), error => !error.message.includes(SECRET) && /diagnostics/.test(error.message));
  });
});

test("DELETE accepts empty successful responses but GET still requires JSON", async () => {
  for (const body of [null, ""]) {
    await withTransport(async () => new Response(body, { status: 200 }), async () => assert.equal(await providerManagementFetch("/test", { method: "DELETE" }), undefined));
    await withTransport(async () => new Response(body, { status: 200 }), async () => assert.rejects(providerManagementFetch("/test")));
  }
});

test("secret response redirects remain unfollowed and carry sanitized HTTP status", async () => {
  let calls = 0;
  await withTransport(async (_url, init) => {
    calls++; assert.equal(init.redirect, "manual");
    return new Response(SECRET, { status: 307, headers: { location: `https://example.com/${SECRET}` } });
  }, async () => assert.rejects(apiFetch("/test", { secretResponse: true }), error => error instanceof ApiError && error.status === 307 && error.body === "" && !error.message.includes(SECRET)));
  assert.equal(calls, 1);
});

test("secret response cancellation retains AbortError identity without echoing its reason", async () => {
  const controller = new AbortController();
  await withTransport(async () => new Response(new ReadableStream({ start(stream) { controller.abort(new Error(SECRET)); stream.error(new Error(SECRET)); } })), async () => {
    await assert.rejects(apiFetch("/test", { secretResponse: true, signal: controller.signal }), error => error.name === "AbortError" && !error.message.includes(SECRET));
  });
  await withTransport(async () => { throw new Error(SECRET); }, async () => {
    await assert.rejects(apiFetch("/test", { secretResponse: true }), error => !error.message.includes(SECRET));
  });
});

test("required base URL advice never recommends a forbidden --param", () => {
  assert.throws(() => publicProviderParams([], { params: [{ name: "base_url", required: true }] }), error => error.message.includes("--base-url URL") && !error.message.includes("--param"));
});

test("probe metadata preserves fixed deadline explanations without reflecting arbitrary reasons", () => {
  for (const reason of ["time_limit", "observed_cost_exceeded_quote", "observed_usage_exceeded_quote"]) assert.equal(probeMetadata({ stoppedReason: reason }).stoppedReason, reason);
  const result = probeMetadata({ stoppedReason: SECRET });
  assert.equal(result.stoppedReason, undefined); assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("app creation requires the one-time secret promised by the backend", async () => {
  for (const appSecret of [undefined, null, 42, false, "", "   "]) {
    await withTransport(async () => new Response(JSON.stringify({ appID: "synthetic-app", name: SECRET, ...(appSecret === undefined ? {} : { appSecret }) })), async () => assert.rejects(createApp("Synthetic"), error => /invalid credential metadata/.test(error.message) && !error.message.includes(SECRET)));
  }
  await withTransport(async () => new Response(JSON.stringify({ appID: "synthetic-app", appSecret: SECRET })), async () => assert.equal((await createApp("Synthetic")).appSecret, SECRET));
});

test("all URL percent hex cases and form encoding redact without case-folding credential letters", () => {
  const secret = "Ab/c =?";
  const encoded = encodeURIComponent(secret), lowercaseHex = encoded.replace(/%[a-f0-9]{2}/gi, part => part.toLowerCase());
  const form = new URLSearchParams({ token: secret }).toString().slice("token=".length).replace(/%[a-f0-9]{2}/gi, part => part.toLowerCase());
  for (const value of [encoded, lowercaseHex, encoded.replace("%2F", "%2f"), form]) assert.equal(redactKnownSecrets(`prefix ${value} suffix`, [secret]), "prefix [redacted] suffix");
  assert.equal(redactKnownSecrets("axb a.b", ["a.b"]), "axb [redacted]");
  assert.equal(redactKnownSecrets("ab%2fc", ["Ab/c"]), "ab%2fc");
  assert.deepEqual(secretSafeMetadata({ url: `https://example.com/?token=${lowercaseHex}` }, [secret]), { url: "https://example.com/?token=[redacted]" });
});

test("byte secret ingress rejects malformed UTF8 and wipes the oversized current chunk", async () => {
  const invalid = Buffer.from([0x73, 0x6b, 0xff, 0xfe]);
  assert.throws(() => decodeProviderSecret(invalid), /valid UTF-8/);
  await assert.rejects(readProviderSecretFromStream((async function* () { yield invalid; })()), /valid UTF-8/);
  assert.ok(invalid.every(byte => byte === 0));
  const first = Buffer.from("synthetic-prefix"), oversized = Buffer.alloc(18_000, 65);
  await assert.rejects(readProviderSecretFromStream((async function* () { yield first; yield oversized; })()), /too large/);
  assert.ok(first.every(byte => byte === 0)); assert.ok(oversized.every(byte => byte === 0));
  assert.equal(decodeProviderSecret(Buffer.from("synthetic-é-key")), "synthetic-é-key");
});

test("required public parameters cannot be satisfied by inherited prototype properties", () => {
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) assert.throws(() => publicProviderParams([], { params: [{ name, required: true }] }), /requires the public setting/);
  assert.deepEqual(publicProviderParams(["account_id=synthetic"], { params: [{ name: "account_id", required: true }] }), { account_id: "synthetic" });
});

test("HTTP status metadata is bounded while signed reported wallet balances remain intact", () => {
  for (const value of [-1, 0, 99, 600, 2 ** 32, NaN, Infinity, 200.5, "200"]) {
    assert.equal(inspectionMetadata({ validation: { httpStatus: value } }).validation.httpStatus, undefined);
    assert.equal(probeMetadata({ calls: [{ httpStatus: value }] }).calls[0].httpStatus, undefined);
  }
  for (const value of [100, 200, 429, 599]) assert.equal(inspectionMetadata({ validation: { httpStatus: value } }).validation.httpStatus, value);
  assert.equal(inspectionMetadata({ balance: { status: "reported", amountUsd: -.25, unit: "USD" } }).balance.amountUsd, -.25);
});
