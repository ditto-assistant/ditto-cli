import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { apiFetch, ApiError } from "../dist/api.js";
import { providerManagementFetch } from "../dist/provider-key-api.js";
import { gcloudInvocation, readProviderSecret } from "../dist/provider-secrets.js";
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

test("Windows gcloud batch invocation quotes bounded scope tokens and rejects shell expansion", () => {
  const args = ["auth", "list", "--format=json(account,status)", "--account", "qa+test@example.com"];
  const win = gcloudInvocation(args, "win32");
  assert.equal(win.command, "cmd.exe"); assert.deepEqual(win.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(win.windowsVerbatimArguments, true);
  assert.equal(win.args[3], '\"\"gcloud.cmd\" \"auth\" \"list\" \"--format=json(account,status)\" \"--account\" \"qa+test@example.com\" \"--quiet\" \"--verbosity=none\"\"');
  const posix = gcloudInvocation(args, "linux"); assert.equal(posix.command, "gcloud"); assert.deepEqual(posix.args.slice(0, args.length), args);
  for (const value of ['bad&whoami', '%PATH%', '!PATH!', 'bad|x', 'bad^x', 'bad"x', 'bad`x', 'bad x', `${SECRET}&exit`]) assert.throws(() => gcloudInvocation(["--account", value], "win32"), error => !error.message.includes(SECRET));
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
