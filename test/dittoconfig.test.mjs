import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const load = await import(path.join(root, "dist/dittoconfig/load.js"));
const { loadDittoConfig, DittoConfigError, DittoConfigNotFound, digest, summarize, canonicalJson } = load;

/**
 * Pinned checksum of src/dittoconfig/schema.json, the JSON Schema exported by
 * backend `go run ./cmd/dittoconfig-schema`. Regenerate the file AND update this
 * constant together when the Go schema changes.
 */
const SCHEMA_SHA256 = "d416b38ba974a89243a176e1174163d4e6bd9e62eed7b6811e32d4b576be1c48";

async function repo(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dittoconfig-"));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
}

const VALID = `version = 1
[repository]
name = "ditto-cli"
default_endpoint = "work"
[repository.bindings.preview]
api_base = "https://pr-2547-api.heyditto.ai"
[teleport]
exclude = ["fixtures/large/"]
include = ["vendor/"]
required_mirrors = ["ditto-primary", "ditto-secondary"]
[teleport.harness]
kind = "claude-code"
[environment]
mise_config = ".ditto/mise.toml"
[[environment.services]]
name = "postgres"
image = "postgres:17"
port = 5432
[environment.vars]
DITTO_ENV = "local"
[environment.secrets]
OPENAI_API_KEY = "secret://openai/api-key"
[tasks]
test = "npm test"
[policy.repair]
max_attempts = 2
install_only = true
`;
const ENDPOINT = `managed = true
name = "work"
slug = "work"
model = "anthropic/claude-opus-5"
[settings]
recordTraces = true
budgetUsd = 25
`;

test("vendored schema matches the pinned backend export", async () => {
  const raw = await readFile(path.join(root, "src/dittoconfig/schema.json"));
  assert.equal(createHash("sha256").update(raw).digest("hex"), SCHEMA_SHA256, "src/dittoconfig/schema.json changed; regenerate from backend `go run ./cmd/dittoconfig-schema` and update SCHEMA_SHA256");
  const doc = JSON.parse(raw.toString("utf8"));
  assert.equal(doc.$id, "https://heyditto.ai/schemas/dittoconfig/v1.json");
  for (const def of ["Endpoint", "Teleport", "Environment", "Service", "RepairPolicy"]) assert.ok(doc.$defs[def], `schema lacks ${def}`);
});

test("loads a valid repository with endpoints, mise and sources", async () => {
  const dir = await repo({ ".ditto/config.toml": VALID, ".ditto/endpoints/work.toml": ENDPOINT, ".ditto/mise.toml": "[tools]\nnode = '22'\n" });
  const eff = await loadDittoConfig(dir);
  assert.equal(eff.config.repository.name, "ditto-cli");
  assert.equal(eff.config.teleport.harness.kind, "claude-code");
  assert.equal(eff.config.teleport.harness.session, "latest", "default filled in");
  assert.equal(eff.config.policy.repair.maxAttempts, 2);
  assert.equal(eff.misePath, ".ditto/mise.toml");
  assert.equal(eff.endpoints.work.model, "anthropic/claude-opus-5");
  assert.equal(eff.endpoints.work.settings.budgetUsd, 25);
  assert.equal(eff.sources.teleport.layer, "repo");
  assert.equal(eff.sources["endpoints.work"].layer, "repo");
  assert.deepEqual(eff.layers, ["repo"]);
  assert.deepEqual(eff.warnings, []);
  const sum = summarize(eff);
  assert.equal(sum.version, 1);
  assert.match(sum.digest, /^[0-9a-f]{64}$/);
});

test("missing .ditto is a distinct error", async () => {
  const dir = await repo({});
  await assert.rejects(loadDittoConfig(dir), (e) => e instanceof DittoConfigNotFound);
});

test("rejects unsupported version, unknown keys and typos naming the key", async () => {
  await assert.rejects(loadDittoConfig(await repo({ ".ditto/config.toml": "version = 2\n" })), (e) => e instanceof DittoConfigError && e.field === "version");
  await assert.rejects(loadDittoConfig(await repo({ ".ditto/config.toml": "version = 1\n[teleport]\nexlcude = ['x/']\n" })), /exlcude/);
  await assert.rejects(loadDittoConfig(await repo({ ".ditto/config.toml": "version = 1\n[telport]\n" })), /telport/);
  await assert.rejects(loadDittoConfig(await repo({ ".ditto/config.toml": "version = 1\n", ".ditto/endpoints/a.toml": "managed = true\nname = 'a'\nunknown = 1\n" })), /unknown key/);
});

test("layers merge recursively: workspace < repo < local < override", async () => {
  const ws = await repo({ ".ditto/config.toml": "version = 1\n[teleport]\nrequired_mirrors = ['ditto-primary']\n[tasks]\ntest = 'make test'\n" });
  const dir = await repo({
    ".ditto/config.toml": "version = 1\n[teleport]\nrequired_mirrors = ['ditto-primary', 'ditto-secondary']\n",
    ".ditto/local.toml": "[teleport.offload]\nunpushed = 'acknowledge'\n",
    ".gitignore": ".ditto/local.toml\n",
  });
  const eff = await loadDittoConfig(dir, { workspaceDir: ws, overrides: { "teleport.harness.kind": "codex" } });
  assert.deepEqual(eff.config.teleport.requiredMirrors, ["ditto-primary", "ditto-secondary"], "repo replaces the workspace array");
  assert.equal(eff.config.tasks.test, "make test", "workspace table survives when the repo omits it");
  assert.equal(eff.sources.tasks.layer, "workspace");
  assert.equal(eff.config.teleport.offload.unpushed, "acknowledge", "local merges into the teleport table without dropping required_mirrors");
  assert.equal(eff.config.teleport.harness.kind, "codex");
  assert.equal(eff.sources.teleport.layer, "override");
  assert.deepEqual(eff.layers, ["workspace", "repo", "local", "override"]);
  assert.deepEqual(eff.warnings, []);
});

test("un-ignored local.toml warns; mise conflict is surfaced; explicit choice resolves it", async () => {
  const warned = await loadDittoConfig(await repo({ ".ditto/config.toml": "version = 1\n", ".ditto/local.toml": "[tasks]\ndev = 'npm start'\n" }));
  assert.equal(warned.warnings.length, 1);
  assert.match(warned.warnings[0], /not git-ignored/);
  await assert.rejects(loadDittoConfig(await repo({ ".ditto/config.toml": "version = 1\n", ".ditto/mise.toml": "[tools]\n", "mise.toml": "[tools]\n" })), /both \.ditto\/mise\.toml and mise\.toml exist/);
  const eff = await loadDittoConfig(await repo({ ".ditto/config.toml": "version = 1\n[environment]\nmise_config = 'mise.toml'\n", ".ditto/mise.toml": "[tools]\n", "mise.toml": "[tools]\n" }));
  assert.equal(eff.misePath, "mise.toml");
});

test("secret literals and unsafe paths are rejected; references pass", async () => {
  for (const body of [
    "version = 1\n[environment.vars]\nOPENAI_API_KEY = 'sk-live-123'\n",
    "version = 1\n[environment.secrets]\nDB_PASSWORD = 'hunter2'\n",
    "version = 1\n[teleport]\ncapture_roots = ['../other']\n",
    "version = 1\n[teleport]\nexclude = ['/abs/']\n",
    "version = 1\n[teleport]\ninclude = ['a/../../b']\n",
    "version = 1\n[teleport.harness]\nkind = 'cursor'\n",
    "version = 1\n[[environment.services]]\nname = 'db'\n",
  ]) {
    await assert.rejects(loadDittoConfig(await repo({ ".ditto/config.toml": body })), DittoConfigError, body);
  }
  await assert.rejects(loadDittoConfig(await repo({ ".ditto/config.toml": "version = 1\n", ".ditto/endpoints/bad.toml": "managed = true\nname = 'bad'\n[settings]\napiKey = 'sk-live'\n" })), /endpoints\.bad\.settings\.apiKey/);
  const ok = await loadDittoConfig(await repo({ ".ditto/config.toml": "version = 1\n[environment.vars]\nAPI_TOKEN = '${API_TOKEN}'\n[environment.secrets]\nDB_PASSWORD = 'secret://db/password'\n" }));
  assert.equal(ok.config.environment.secrets.DB_PASSWORD, "secret://db/password");
});

test("digest is content-only and canonical JSON sorts keys", async () => {
  const a = await loadDittoConfig(await repo({ ".ditto/config.toml": VALID, ".ditto/endpoints/work.toml": ENDPOINT, ".ditto/mise.toml": "" }));
  const b = await loadDittoConfig(await repo({ ".ditto/config.toml": VALID, ".ditto/endpoints/work.toml": ENDPOINT, ".ditto/mise.toml": "" }));
  assert.equal(digest(a), digest(b));
  const c = await loadDittoConfig(await repo({ ".ditto/config.toml": VALID.replace("max_attempts = 2", "max_attempts = 3"), ".ditto/endpoints/work.toml": ENDPOINT, ".ditto/mise.toml": "" }));
  assert.notEqual(digest(a), digest(c));
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }], e: undefined }), '{"a":[{"c":3,"d":2}],"b":1}');
});
