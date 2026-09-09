import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakeCLIs } from "./helpers/fake-cli.mjs";
import { ALPHA, MINTED_PLAINTEXT, startStub } from "./helpers/stub-api.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const BINS = ["gh", "glab", "aws", "gcloud", "az", "op", "vault", "doppler", "wrangler", "vercel", "kubectl", "fly"];

/**
 * Runs the built CLI out-of-process. It has to be async: the API stub lives in
 * this process, so a blocking spawn would deadlock against its own server.
 */
function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: process.env.HOME,
        DITTO_API_KEY: "ditto_mcp_test",
        DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-stores-")),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** One `keys create` run against the API stub with only fake platform CLIs on PATH. */
async function mint(args, { bins = BINS, fail } = {}) {
  const stub = await startStub();
  const fakes = createFakeCLIs(bins);
  try {
    const result = await run(["endpoints", "keys", "create", "alpha", ...args, "--yes"], {
      DITTO_API_BASE: stub.base,
      ...fakes.env(fail ? { FAKE_CLI_FAIL: fail } : {}),
    });
    return { result, stub, fakes };
  } finally {
    stub.close();
  }
}

/** The invocation that carried the key (or the payload wrapping it). */
function storeCall(fakes) {
  const writes = fakes.writes();
  assert.ok(writes.length > 0, `no platform CLI received data on stdin; calls: ${JSON.stringify(fakes.calls())}`);
  return writes[writes.length - 1];
}

// Every store: the argv the platform CLI is invoked with, and the exact shape
// of what reaches its stdin. Anything here that grows an argv-borne secret is
// a security regression, which is what the shared assertions below check.
const CASES = [
  {
    store: "github",
    args: ["--gh-secret", "DITTO_KEY", "--repo", "acme/app"],
    bin: "gh",
    argv: ["secret", "set", "DITTO_KEY", "--repo", "acme/app"],
    stdin: MINTED_PLAINTEXT,
    // GitHub shipped before the registry existed; its key labels stay as they were.
    keyName: "gh:acme/app:DITTO_KEY",
  },
  {
    store: "github (organization)",
    args: ["--gh-secret", "DITTO_KEY", "--org", "acme"],
    bin: "gh",
    argv: ["secret", "set", "DITTO_KEY", "--org", "acme"],
    stdin: MINTED_PLAINTEXT,
  },
  {
    store: "gitlab",
    args: ["--gitlab-var", "DITTO_KEY", "--project", "acme/app"],
    bin: "glab",
    argv: ["variable", "set", "DITTO_KEY", "--masked", "--repo", "acme/app"],
    stdin: MINTED_PLAINTEXT,
  },
  {
    store: "aws",
    args: ["--aws-secret", "ditto-key", "--region", "us-east-1"],
    bin: "aws",
    argv: ["secretsmanager", "create-secret", "--name", "ditto-key", "--secret-string", "file:///dev/stdin", "--region", "us-east-1"],
    stdin: MINTED_PLAINTEXT,
  },
  {
    store: "gcloud",
    args: ["--gcp-secret", "ditto-key", "--project", "my-gcp"],
    bin: "gcloud",
    argv: ["secrets", "create", "ditto-key", "--data-file=-", "--replication-policy=automatic", "--project", "my-gcp"],
    stdin: MINTED_PLAINTEXT,
    keyName: "gcloud:my-gcp:ditto-key",
  },
  {
    store: "azure",
    args: ["--az-secret", "ditto-key", "--key-vault", "my-vault"],
    bin: "az",
    argv: ["keyvault", "secret", "set", "--vault-name", "my-vault", "--name", "ditto-key", "--file", "/dev/stdin", "--encoding", "utf-8", "--output", "none"],
    stdin: MINTED_PLAINTEXT,
  },
  {
    store: "1password",
    args: ["--op-item", "Ditto inference", "--op-vault", "Engineering"],
    bin: "op",
    argv: ["item", "create", "--vault", "Engineering", "-"],
    stdin: `${JSON.stringify({
      title: "Ditto inference",
      category: "API_CREDENTIAL",
      fields: [{ id: "credential", label: "credential", type: "CONCEALED", value: MINTED_PLAINTEXT }],
    })}\n`,
  },
  {
    store: "vault",
    args: ["--vault-secret", "ditto/inference", "--mount", "kv", "--field", "token"],
    bin: "vault",
    argv: ["kv", "patch", "-mount=kv", "ditto/inference", "token=-"],
    stdin: MINTED_PLAINTEXT,
  },
  {
    store: "doppler",
    args: ["--doppler-secret", "DITTO_KEY", "--project", "web", "--doppler-config", "prod"],
    bin: "doppler",
    argv: ["secrets", "set", "DITTO_KEY", "--no-interactive", "--silent", "--project", "web", "--config", "prod"],
    stdin: MINTED_PLAINTEXT,
  },
  {
    store: "cloudflare",
    args: ["--cf-secret", "DITTO_KEY", "--worker", "api"],
    bin: "wrangler",
    argv: ["secret", "put", "DITTO_KEY", "--name", "api"],
    stdin: MINTED_PLAINTEXT,
  },
  {
    store: "vercel",
    args: ["--vercel-env", "DITTO_KEY", "--vercel-target", "preview"],
    bin: "vercel",
    argv: ["env", "add", "DITTO_KEY", "preview", "--force", "--sensitive", "--yes", "--non-interactive"],
    stdin: MINTED_PLAINTEXT,
  },
  {
    store: "kubernetes",
    args: ["--k8s-secret", "ditto-inference", "--namespace", "prod", "--k8s-key", "token"],
    bin: "kubectl",
    argv: ["patch", "secret", "ditto-inference", "--namespace", "prod", "--type", "merge", "--patch-file", "/dev/stdin"],
    stdin: `${JSON.stringify({ stringData: { token: MINTED_PLAINTEXT } })}\n`,
    keyName: "kubernetes:prod/token:ditto-inference",
  },
  {
    store: "fly",
    args: ["--fly-secret", "DITTO_KEY", "--app", "my-app"],
    bin: "fly",
    argv: ["secrets", "import", "--app", "my-app"],
    stdin: `DITTO_KEY=${MINTED_PLAINTEXT}\n`,
  },
];

for (const c of CASES) {
  test(`${c.store}: delegates to ${c.bin} with the key on stdin`, async () => {
    const { result, stub, fakes } = await mint(c.args);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(stub.mints().length, 1);
    assert.equal(stub.revocations().length, 0);

    const call = storeCall(fakes);
    assert.equal(call.bin, c.bin);
    assert.deepEqual(call.args, c.argv);
    assert.equal(call.stdin, c.stdin);

    // The plaintext reaches the platform CLI and nothing else: not argv (where
    // `ps` would show it), not our stdout, not our stderr.
    for (const { args } of fakes.calls()) {
      assert.ok(!args.join(" ").includes(MINTED_PLAINTEXT), `plaintext leaked into ${c.bin} argv: ${args.join(" ")}`);
    }
    assert.ok(!result.stdout.includes(MINTED_PLAINTEXT), "plaintext leaked to stdout");
    assert.ok(!result.stderr.includes(MINTED_PLAINTEXT), "plaintext leaked to stderr");
    if (c.keyName) assert.equal(stub.mints()[0].body.name, c.keyName);
  });
}

test("--store with --secret is the same as the shorthand", async () => {
  const viaStore = await mint(["--store", "aws", "--secret", "ditto-key", "--region", "eu-west-1"]);
  const viaShorthand = await mint(["--aws-secret", "ditto-key", "--region", "eu-west-1"]);
  assert.equal(viaStore.result.status, 0, viaStore.result.stderr);
  assert.equal(viaShorthand.result.status, 0, viaShorthand.result.stderr);
  assert.deepEqual(storeCall(viaStore.fakes).args, storeCall(viaShorthand.fakes).args);
});

test("falls back to the store's update command when creation fails", async () => {
  // `gcloud secrets create` refuses a secret that already exists; the key must
  // still land, as a new version.
  const { result, stub, fakes } = await mint(["--gcp-secret", "ditto-key", "--project", "my-gcp"], { fail: "secrets create" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const attempts = fakes.writes().map((c) => c.args.slice(0, 3).join(" "));
  assert.deepEqual(attempts, ["secrets create ditto-key", "secrets versions add"]);
  assert.equal(stub.revocations().length, 0, "a successful fallback must not revoke the key");
});

test("revokes the key when every attempt fails", async () => {
  const { result, stub, fakes } = await mint(["--gh-secret", "DITTO_KEY", "--repo", "acme/app"], { fail: "secret set" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /could not store DITTO_KEY/);
  assert.equal(stub.mints().length, 1, "the key was minted");
  assert.equal(stub.revocations().length, 1, "the unusable key must be revoked again");
  assert.ok(!result.stderr.includes(MINTED_PLAINTEXT));
  assert.ok(storeCall(fakes));
});

test("a missing platform CLI fails before any key is minted", async () => {
  const { result, stub } = await mint(["--gh-secret", "DITTO_KEY", "--repo", "acme/app"], { bins: BINS.filter((b) => b !== "gh") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs gh on PATH/);
  assert.match(result.stderr, /cli\.github\.com/);
  assert.equal(stub.mints().length, 0, "nothing may be minted when the CLI is missing");
});

test("rejects a scoping flag that belongs to another store", async () => {
  const { result, stub } = await mint(["--aws-secret", "ditto-key", "--repo", "acme/app"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--repo does not apply to AWS Secrets Manager/);
  assert.equal(stub.mints().length, 0);
});

test("rejects two destinations at once", async () => {
  const { result, stub } = await mint(["--gh-secret", "DITTO_KEY", "--repo", "acme/app", "--aws-secret", "ditto-key"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pick one destination/);
  assert.equal(stub.mints().length, 0);
});

test("requires a destination", async () => {
  const { result, stub } = await mint([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pick a destination/);
  assert.equal(stub.mints().length, 0);
});

test("azure requires the vault it stores into", async () => {
  const { result, stub } = await mint(["--az-secret", "ditto-key"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--key-vault/);
  assert.equal(stub.mints().length, 0);
});

test("still rejects invalid GitHub secret names before minting", async () => {
  for (const [name, pattern] of [
    ["2FA", /not a valid GitHub Actions secret name/],
    ["GITHUB_TOKEN", /reserved/],
  ]) {
    const { result, stub } = await mint(["--gh-secret", name, "--repo", "acme/app"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.equal(stub.mints().length, 0);
  }
});

test("--output json reports the store and target without the key", async () => {
  const { result } = await mint(["--gcp-secret", "ditto-key", "--project", "my-gcp", "--output", "json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.store, "gcloud");
  assert.equal(payload.secret.name, "ditto-key");
  assert.equal(payload.secret.project, "my-gcp");
  assert.equal(payload.key.keyHint, "zz99");
  assert.ok(!result.stdout.includes(MINTED_PLAINTEXT));
});

test("keys stores lists every destination and what is installed here", async () => {
  const fakes = createFakeCLIs(["gh", "aws"]);
  const result = await run(["endpoints", "keys", "stores"], fakes.env());
  assert.equal(result.status, 0, result.stderr);
  for (const id of ["github", "gitlab", "aws", "gcloud", "azure", "1password", "vault", "doppler", "cloudflare", "vercel", "kubernetes", "fly"]) {
    assert.match(result.stdout, new RegExp(`^${id}\\s`, "m"), `${id} missing from the table`);
  }
  assert.match(result.stdout, /^github\s+GitHub Actions\s+gh\s+installed/m);
  assert.match(result.stdout, /^gcloud\s+Google Secret Manager\s+gcloud\s+not installed/m);
  assert.match(result.stdout, /Not installed: /);
});

test("keys stores --output json is machine readable", async () => {
  const fakes = createFakeCLIs(["gh"]);
  const result = await run(["endpoints", "keys", "stores", "--output", "json"], fakes.env());
  assert.equal(result.status, 0, result.stderr);
  const stores = JSON.parse(result.stdout);
  assert.equal(stores.length, 12);
  const github = stores.find((s) => s.id === "github");
  assert.equal(github.installed, true);
  assert.equal(github.shorthand, "--gh-secret");
  assert.deepEqual(github.flags, ["--repo", "--env", "--org"]);
  assert.equal(stores.find((s) => s.id === "fly").installed, false);
});

test("fly is found under flyctl too", async () => {
  const { result, fakes } = await mint(["--fly-secret", "DITTO_KEY", "--app", "my-app"], {
    bins: BINS.filter((b) => b !== "fly").concat("flyctl"),
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(storeCall(fakes).bin, "flyctl");
});

test("the endpoint slug is still what identifies the endpoint", async () => {
  const { result } = await mint(["--gh-secret", "DITTO_KEY", "--repo", "acme/app"]);
  assert.match(result.stdout, new RegExp(`on ${ALPHA.slug}`));
});
