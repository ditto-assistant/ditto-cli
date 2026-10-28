import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { providerKeyHints, providerURLInput, publicProviderParams } from "../dist/provider-key-input.js";
import { inspectionMetadata, probeMetadata, providerKeyMetadata, providerManagementBase } from "../dist/provider-key-api.js";
import { parseGCloudSecretReference, readProviderSecretFromStream, validateProviderSecret } from "../dist/provider-secrets.js";
import { parsePoolPolicy } from "../dist/router-pool-commands.js";
import { redactKnownSecrets, secretSafeMetadata } from "../dist/secret-redaction.js";

const ID = "11111111-1111-1111-1111-111111111111";
const SECRET = "sk-proj-synthetic-input-only";

test("secret input accepts one token and never includes rejected content in errors", async () => {
  assert.equal(await readProviderSecretFromStream(Readable.from([Buffer.from(`  ${SECRET}\n`)])), SECRET);
  for (const raw of [`${SECRET}\nsecond`, `${SECRET} value`, `${SECRET}\x00`, " "]) {
    assert.throws(() => validateProviderSecret(raw), error => !error.message.includes(SECRET));
  }
  await assert.rejects(readProviderSecretFromStream(Readable.from([Buffer.alloc(18_000, 65)])), /too large/);
});

test("prefix hints never treat broad sk- as proof and preserve ambiguity", () => {
  const row = (id, keyPrefixHints) => ({ id, keyPrefixHints, displayName: id, protocols: [], routable: true });
  const catalog = [row("openai", ["sk-", "sk-proj-"]), row("anthropic", ["sk-ant-"]), row("clone", ["sk-proj-"])];
  assert.deepEqual(providerKeyHints("sk-unknown", catalog), []);
  assert.deepEqual(providerKeyHints("sk-ant-synthetic", catalog), ["anthropic"]);
  assert.deepEqual(providerKeyHints(SECRET, catalog), ["clone", "openai"]);
  const actualStrongHints = [row("openai", ["sk-proj-", "sk-svcacct-", "sk-"]), row("engy", ["sk-engy-"])];
  assert.deepEqual(providerKeyHints("sk-svcacct-synthetic", actualStrongHints), ["openai"]);
  assert.deepEqual(providerKeyHints("sk-engy-synthetic", actualStrongHints), ["engy"]);
  assert.deepEqual(providerKeyHints("sk-ambiguous", actualStrongHints), []);
});

test("custom URLs preserve paths and infer protocols without guessing version prefixes", () => {
  assert.deepEqual(providerURLInput(" api.example.com/customer/path "), { baseUrl: "https://api.example.com/customer/path" });
  assert.deepEqual(providerURLInput("https://api.example.com/prefix/v1/messages"), { baseUrl: "https://api.example.com/prefix/v1/messages", protocolHint: "anthropic_messages" });
  assert.equal(providerURLInput("https://api.example.com/prefix/chat/completions").protocolHint, "openai_chat");
  for (const url of ["http://api.example.com", "https://user:pass@api.example.com", "https://api.example.com?key=secret", "https://api.example.com#secret", "https://127.0.0.1/v1", "https://metadata.google.internal/v1", "https://api.example.com/\nsecret"]) assert.throws(() => providerURLInput(url));
});

test("upload destinations reject arbitrary overrides and embedded credentials", () => {
  assert.equal(providerManagementBase("https://api.heyditto.ai"), "https://api.heyditto.ai");
  assert.equal(providerManagementBase("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
  for (const base of ["https://evil.example", "http://api.heyditto.ai", "https://api.heyditto.ai.evil.example", "https://user@api.heyditto.ai", "https://api.heyditto.ai/?key=secret", "https://api.heyditto.ai/prefix"]) assert.throws(() => providerManagementBase(base));
});

test("key success serialization excludes secrets, arbitrary fields and unsafe URLs", () => {
  const metadata = providerKeyMetadata({ id: ID, provider: "custom_openai", label: `label ${SECRET}`, key: SECRET, keyHint: SECRET, templateParams: { api_key: SECRET }, lastError: SECRET, metadata: { key: SECRET }, enabled: true, configured: true, baseUrl: `https://${SECRET}@api.example.com` }, SECRET);
  assert.ok(!JSON.stringify(metadata).includes(SECRET));
  assert.equal(metadata.keyHint, SECRET.slice(-4));
  assert.equal(metadata.baseUrl, undefined);
  assert.equal(metadata.key, undefined);
  assert.throws(() => providerKeyMetadata({ id: ID, provider: SECRET }, SECRET), error => !error.message.includes(SECRET));
  assert.throws(() => providerKeyMetadata({ id: ID, provider: "openai" }, ID), error => !error.message.includes(ID));
});

test("inspection and probe status, units, source and date fields cannot reflect arbitrary errors", () => {
  const inspection = inspectionMetadata({ checkedAt: SECRET, validation: { status: SECRET }, models: { status: SECRET }, balance: { status: SECRET, source: SECRET, unit: SECRET, checkedAt: SECRET } });
  assert.ok(!JSON.stringify(inspection).includes(SECRET));
  assert.equal(inspection.balance.status, "unknown");
  const probe = probeMetadata({ startedAt: SECRET, calls: [{ status: SECRET }] });
  assert.ok(!JSON.stringify(probe).includes(SECRET));
  assert.equal(probe.calls[0].status, "unknown");
  assert.equal(inspectionMetadata({ checkedAt: "2026-10-28T13:00:00.123456Z", balance: { status: "reported", unit: "USD", source: "payg_wallet", amountUsd: 0 } }).checkedAt, "2026-10-28T13:00:00.123Z");
  assert.equal(inspectionMetadata({ balance: { status: "reported", unit: "USD", source: "payg_wallet", amountUsd: -0.25 } }).balance.amountUsd, -0.25);
  assert.equal(probeMetadata({ calls: [{ providerReportedCostUsd: -0.25 }] }).calls[0].providerReportedCostUsd, undefined);
  assert.equal(inspectionMetadata({ balance: { status: "reported", unit: "USD", source: "account_wallet", amountUsd: -0.25 } }).balance.source, "account_wallet");
  for (const status of ["invalid_request", "locally_limited"]) assert.equal(probeMetadata({ calls: [{ status }] }).calls[0].status, status);
  for (const balanceProvider of ["impala", "openrouter", "gm", "vercel_ai_gateway"]) assert.equal(providerKeyMetadata({ id: ID, provider: "custom_openai", balanceProvider }).balanceProvider, balanceProvider);
});

test("GCP references require explicit scope and reject conflicts before any child runs", () => {
  assert.deepEqual(parseGCloudSecretReference({ secret: "projects/my-project/secrets/impala-key/versions/4" }), { project: "my-project", secret: "impala-key", version: "4" });
  assert.deepEqual(parseGCloudSecretReference({ secret: "impala-key", project: "my-project" }), { project: "my-project", secret: "impala-key", version: "latest" });
  for (const input of [{ secret: "impala-key" }, { secret: "projects/my-project/secrets/key", project: "other-project" }, { secret: "projects/my-project/secrets/key/versions/2", version: "3" }, { secret: "--bad", project: "my-project", version: "--debug" }]) assert.throws(() => parseGCloudSecretReference(input));
});

test("pool policies accept only saved key UUIDs and bounded route fields", () => {
  const policy = { enabled: true, routes: [{ keyId: ID, weight: 75, requestsPerMinute: 80 }] };
  assert.deepEqual(parsePoolPolicy(policy), policy);
  for (const raw of [null, { ...policy, billingMode: "ditto" }, { enabled: true, routes: [{ keyId: SECRET, weight: 1 }] }, { enabled: true, routes: [{ sourceId: "impala-review", weight: 1 }] }, { enabled: true, routes: [{ keyId: ID, weight: 101 }] }, { enabled: true, routes: [policy.routes[0], policy.routes[0]] }, { enabled: true, routes: [] }]) assert.throws(() => parsePoolPolicy(raw));
});

test("known minted credentials are redacted from every occurrence and nested metadata", () => {
  const value = `${SECRET} then ${SECRET} and ${encodeURIComponent(SECRET)}`;
  assert.ok(!redactKnownSecrets(value, [SECRET]).includes(SECRET));
  const metadata = secretSafeMetadata({ name: SECRET, nested: { [SECRET]: [SECRET, `again ${SECRET}`] } }, [SECRET]);
  assert.ok(!JSON.stringify(metadata).includes(SECRET));
});

test("public settings must be declared by the selected provider and never credential names", () => {
  const entry = { params: [{ name: "account_id", required: true }, { name: "api_key", required: false }] };
  assert.deepEqual(publicProviderParams(["account_id=public-id"], entry), { account_id: "public-id" });
  for (const params of [["api_key=value"], ["undeclared=value"], ["account_id=one", "account_id=two"], [`account_id=${SECRET}`], [`account_id=${"a".repeat(513)}`], []]) assert.throws(() => publicProviderParams(params, entry, undefined, SECRET));
});
