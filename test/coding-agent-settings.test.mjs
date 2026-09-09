import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const ENDPOINT = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "alpha",
  name: "Alpha",
  model: "openai/gpt-5.6-luna",
  status: "active",
};

/** Minimal stub: list one endpoint, capture the PATCH body. */
function startStub(endpoint = ENDPOINT) {
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
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints: [endpoint] });
      }
      const m = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)$/);
      if (m && req.method === "PATCH") return json(200, { ...endpoint, ...JSON.parse(body) });
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => { server.closeAllConnections(); server.close(); },
      });
    });
  });
}

/**
 * Runs the CLI with stdin closed. A piped stdin keeps the process alive, so
 * the suite would hang rather than fail.
 */
function run(base, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DITTO_API_KEY: "ditto_mcp_test",
      DITTO_API_BASE: base,
      DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-agent-")),
    },
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function patchOf(stub) {
  const call = stub.calls.find((c) => c.method === "PATCH");
  assert.ok(call, `no PATCH was sent; calls: ${JSON.stringify(stub.calls.map((c) => `${c.method} ${c.url}`))}`);
  return call.body;
}

test("--codex-models on enables the picker", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--codex-models", "on"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub).providerOptions, { codex_models: true });
  } finally {
    stub.close();
  }
});

test("coding-agent flags merge onto the endpoint's existing providerOptions", async () => {
  const stub = await startStub({ ...ENDPOINT, providerOptions: { codex_models: true, reasoning: { effort: "high" } } });
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--codex-catalog", "on", "--codex-catalog-limit", "12"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub).providerOptions, {
      codex_models: true,
      reasoning: { effort: "high" },
      codex_catalog: true,
      codex_catalog_limit: 12,
    });
  } finally {
    stub.close();
  }
});

test("--codex-prompt reset clears the key so the vendored baseline applies", async () => {
  const stub = await startStub({ ...ENDPOINT, providerOptions: { codex_system_prompt: "old text", codex_models: true } });
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--codex-prompt", "reset"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub).providerOptions, { codex_models: true });
  } finally {
    stub.close();
  }
});

test("an empty --codex-prompt is kept, meaning no system prompt at all", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--codex-prompt", ""]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub).providerOptions, { codex_system_prompt: "" });
  } finally {
    stub.close();
  }
});

test("--codex-prompt @file loads the prompt from disk", async () => {
  const stub = await startStub();
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "heyditto-prompt-")), "prompt.md");
  writeFileSync(file, "You are a house-style agent.\nBe terse.\n");
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--codex-prompt", `@${file}`]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(patchOf(stub).providerOptions.codex_system_prompt, "You are a house-style agent.\nBe terse.\n");
  } finally {
    stub.close();
  }
});

test("--codex-prompt @missing fails loudly instead of writing an empty prompt", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--codex-prompt", "@/no/such/prompt.md"]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /could not read/);
    assert.equal(stub.calls.some((c) => c.method === "PATCH"), false, "nothing may be written when the file is unreadable");
  } finally {
    stub.close();
  }
});

test("auto-update can be pinned off for either harness", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--codex-prompt-autoupdate", "off", "--claude-prompt-autoupdate", "off"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub).providerOptions, { codex_prompt_autoupdate: false, claude_prompt_autoupdate: false });
  } finally {
    stub.close();
  }
});

test("endpoints show reports the coding-agent settings", async () => {
  const stub = await startStub({
    ...ENDPOINT,
    providerOptions: { codex_models: true, codex_catalog: true, codex_catalog_limit: 12, codex_system_prompt: "abc", claude_prompt_autoupdate: false },
  });
  try {
    const out = await run(stub.base, ["endpoints", "show", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /codex picker:\s+on\s+\(catalog 12\)/);
    assert.match(out.stdout, /codex prompt:\s+custom \(3 chars\)/);
    assert.match(out.stdout, /claude prompt:\s+auto-update off/);
  } finally {
    stub.close();
  }
});

test("an untouched endpoint shows no coding-agent noise", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "show", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /codex picker|codex prompt|claude prompt/);
  } finally {
    stub.close();
  }
});

test("a bad --codex-catalog-limit is rejected before anything is written", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--codex-catalog-limit", "-3"]);
    assert.notEqual(out.status, 0);
    assert.equal(stub.calls.some((c) => c.method === "PATCH"), false);
  } finally {
    stub.close();
  }
});
