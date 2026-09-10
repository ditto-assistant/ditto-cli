import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/**
 * The endpoint as the v5 API returns it: every settings field is present on a
 * real response, which is what lets `endpoints show` print them all.
 */
const ENDPOINT = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "alpha",
  name: "Alpha",
  model: "openai/gpt-5.6-luna",
  status: "active",
  modelMode: "default",
  billingMode: "ditto",
  routingMode: "balanced",
  streamGranularity: "tool",
  contextCompaction: "balanced",
  resultCompression: "off",
  toolCompression: false,
  precompactAtTokens: 0,
  traceRetentionDays: 30,
  recordTrace: true,
  recordAttachments: false,
  batchEnabled: true,
  batchMaxRequests: 1000,
  maxToolRounds: 8,
  kindRoutes: {},
  modelRoutes: {},
  aliases: {},
};

/** Minimal stub: list one endpoint, echo the PATCH back merged. */
function startStub(endpoint = ENDPOINT, { patchResponse } = {}) {
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
      if (/^\/api\/v5\/inference\/endpoints\/[^/]+$/.test(req.url) && req.method === "PATCH") {
        const merged = { ...endpoint, ...JSON.parse(body) };
        return json(200, patchResponse ? { ...merged, ...patchResponse } : merged);
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/** Runs the CLI with stdin closed so a prompt fails rather than hangs. */
function run(base, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DITTO_API_KEY: "ditto_mcp_test",
      DITTO_API_BASE: base,
      DITTO_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), "heyditto-settings-")),
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

function noPatch(stub) {
  assert.equal(stub.calls.some((c) => c.method === "PATCH"), false, "nothing may be written when the input is rejected");
}

test("every scalar setting reaches the PATCH under its API field name", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, [
      "endpoints", "set", "alpha",
      "--context-compaction", "aggressive",
      "--result-compression", "grouped",
      "--tool-compression", "on",
      "--routing", "cheap",
      "--model-mode", "passthrough",
      "--billing-mode", "both",
      "--stream-granularity", "full",
      "--max-tool-rounds", "16",
      "--precompact-at", "120000",
      "--trace-retention", "30",
      "--record-attachments", "on",
      "--batch", "off",
      "--batch-max-requests", "250",
    ]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub), {
      recordAttachments: true,
      toolCompression: true,
      batchEnabled: false,
      modelMode: "passthrough",
      billingMode: "both",
      routingMode: "cheap",
      streamGranularity: "full",
      contextCompaction: "aggressive",
      resultCompression: "grouped",
      maxToolRounds: 16,
      precompactAtTokens: 120000,
      traceRetentionDays: 30,
      batchMaxRequests: 250,
    });
  } finally {
    stub.close();
  }
});

test("an unknown enum value is rejected by the flag itself, before any call", async () => {
  const stub = await startStub();
  try {
    for (const [flag, bad] of [
      ["--context-compaction", "extreme"],
      ["--result-compression", "maximum"],
      ["--routing", "cheapest"],
      ["--model-mode", "proxy"],
      ["--stream-granularity", "verbose"],
      ["--billing-mode", "invoice"],
    ]) {
      const out = await run(stub.base, ["endpoints", "set", "alpha", flag, bad]);
      assert.notEqual(out.status, 0, `${flag} ${bad} should fail`);
      assert.match(out.stderr, /Allowed choices/i);
    }
    noPatch(stub);
  } finally {
    stub.close();
  }
});

test("out-of-range integers are rejected client-side with the backend's bounds", async () => {
  const stub = await startStub();
  try {
    const cases = [
      ["--max-tool-rounds", "33", /0 to 32/],
      ["--memory-depth", "26", /0 to 25/],
      ["--batch-max-requests", "50001", /0 to 50000/],
      ["--precompact-at", "-1", /must be an integer/],
      ["--trace-retention", "not-a-number", /must be an integer/],
    ];
    for (const [flag, bad, expected] of cases) {
      const out = await run(stub.base, ["endpoints", "set", "alpha", flag, bad]);
      assert.notEqual(out.status, 0, `${flag} ${bad} should fail`);
      assert.match(out.stderr, expected);
    }
    noPatch(stub);
  } finally {
    stub.close();
  }
});

test("--batch-max-requests accepts separators", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--batch-max-requests", "10_000"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(patchOf(stub).batchMaxRequests, 10000);
  } finally {
    stub.close();
  }
});

test("kind routes merge onto the endpoint's existing map instead of replacing it", async () => {
  const stub = await startStub({ ...ENDPOINT, kindRoutes: { probe: "openai/gpt-5.6-nano", chat: "openai/gpt-5.6-luna" } });
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--kind-route", "aside=openai/gpt-5.6-nano"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub).kindRoutes, {
      probe: "openai/gpt-5.6-nano",
      chat: "openai/gpt-5.6-luna",
      aside: "openai/gpt-5.6-nano",
    });
  } finally {
    stub.close();
  }
});

test("a repeated route flag sets several entries at once", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, [
      "endpoints", "set", "alpha",
      "--kind-route", "aside=openai/gpt-5.6-nano",
      "--kind-route", "probe=openai/gpt-5.6-nano",
      "--model-route", "gpt-4o=openai/gpt-5.6-luna",
      "--alias", "fast=openai/gpt-5.6-nano",
    ]);
    assert.equal(out.status, 0, out.stderr);
    const patch = patchOf(stub);
    assert.deepEqual(patch.kindRoutes, { aside: "openai/gpt-5.6-nano", probe: "openai/gpt-5.6-nano" });
    assert.deepEqual(patch.modelRoutes, { "gpt-4o": "openai/gpt-5.6-luna" });
    assert.deepEqual(patch.aliases, { fast: "openai/gpt-5.6-nano" });
  } finally {
    stub.close();
  }
});

test("an empty value removes one entry and keeps the rest", async () => {
  const stub = await startStub({
    ...ENDPOINT,
    kindRoutes: { aside: "a", probe: "b" },
    aliases: { fast: "x", slow: "y" },
  });
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--kind-route", "aside=", "--alias", "slow="]);
    assert.equal(out.status, 0, out.stderr);
    const patch = patchOf(stub);
    assert.deepEqual(patch.kindRoutes, { probe: "b" });
    assert.deepEqual(patch.aliases, { fast: "x" });
  } finally {
    stub.close();
  }
});

test("--clear-* wipes a whole map", async () => {
  const stub = await startStub({
    ...ENDPOINT,
    kindRoutes: { aside: "a" },
    modelRoutes: { "gpt-4o": "b" },
    aliases: { fast: "c" },
  });
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--clear-kind-routes", "--clear-model-routes", "--clear-aliases"]);
    assert.equal(out.status, 0, out.stderr);
    const patch = patchOf(stub);
    assert.deepEqual(patch.kindRoutes, {});
    assert.deepEqual(patch.modelRoutes, {});
    assert.deepEqual(patch.aliases, {});
  } finally {
    stub.close();
  }
});

test("a non-routable kind is rejected rather than silently dropped by the server", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--kind-route", "title=openai/gpt-5.6-nano"]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /not a routable request kind/);
    assert.match(out.stderr, /structured_output/);
    noPatch(stub);
  } finally {
    stub.close();
  }
});

test("a pair without = is rejected before the endpoint is even fetched", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--model-route", "gpt-4o"]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /must be key=value/);
    assert.equal(stub.calls.length, 0, "a malformed pair must not cost a round trip");
  } finally {
    stub.close();
  }
});

test("reserved and malformed alias names are refused with the backend's rule", async () => {
  for (const [name, expected] of [
    ["ditto", /reserved/],
    ["alpha", /reserved/],
    ["Fast", /lowercase/],
    ["-x", /lowercase/],
  ]) {
    const stub = await startStub();
    try {
      const out = await run(stub.base, ["endpoints", "set", "alpha", "--alias", `${name}=openai/gpt-5.6-nano`]);
      assert.notEqual(out.status, 0, `alias ${name} should fail`);
      assert.match(out.stderr, expected);
      noPatch(stub);
    } finally {
      stub.close();
    }
  }
});

test("more than 64 model routes is refused locally", async () => {
  const existing = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`m${i}`, "openai/gpt-5.6-luna"]));
  const stub = await startStub({ ...ENDPOINT, modelRoutes: existing });
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--model-route", "one-too-many=openai/gpt-5.6-luna"]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /at most 64 entries/);
    noPatch(stub);
  } finally {
    stub.close();
  }
});

test("endpoints show prints every setting the web editor exposes", async () => {
  const stub = await startStub({
    ...ENDPOINT,
    contextCompaction: "aggressive",
    resultCompression: "grouped",
    toolCompression: true,
    precompactAtTokens: 120000,
    routingMode: "cheap",
    modelMode: "passthrough",
    billingMode: "byok",
    streamGranularity: "full",
    maxToolRounds: 16,
    traceRetentionDays: 0,
    recordAttachments: true,
    batchEnabled: false,
    batchMaxRequests: 250,
    kindRoutes: { probe: "openai/gpt-5.6-nano", aside: "openai/gpt-5.6-mini" },
    modelRoutes: { "gpt-4o": "openai/gpt-5.6-luna" },
    aliases: { fast: "openai/gpt-5.6-nano" },
  });
  try {
    const out = await run(stub.base, ["endpoints", "show", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /traces:\s+on, attachments on, kept forever/);
    assert.match(out.stdout, /routing:\s+cheap, model mode passthrough, billing byok/);
    assert.match(out.stdout, /compaction:\s+context aggressive, results grouped, tools on, precompact 120,000 tokens/);
    assert.match(out.stdout, /tool rounds:\s+16/);
    assert.match(out.stdout, /stream:\s+full/);
    assert.match(out.stdout, /batches:\s+off, max 250 per batch/);
    // Maps are printed in key order so two runs diff cleanly.
    assert.match(out.stdout, /kind routes:\s+aside=openai\/gpt-5\.6-mini, probe=openai\/gpt-5\.6-nano/);
    assert.match(out.stdout, /model routes:\s+gpt-4o=openai\/gpt-5\.6-luna/);
    assert.match(out.stdout, /aliases:\s+fast=openai\/gpt-5\.6-nano/);
  } finally {
    stub.close();
  }
});

test("endpoints show reports empty maps rather than hiding the field", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "show", "alpha"]);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /kind routes:\s+\(none\)/);
    assert.match(out.stdout, /model routes:\s+\(none\)/);
    assert.match(out.stdout, /aliases:\s+\(none\)/);
    assert.match(out.stdout, /traces:\s+on, attachments off, kept 30 days/);
  } finally {
    stub.close();
  }
});

test("a plan-clamped trace retention is reported instead of passing silently", async () => {
  const stub = await startStub(ENDPOINT, { patchResponse: { traceRetentionDays: 7 } });
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--trace-retention", "365"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(patchOf(stub).traceRetentionDays, 365);
    assert.match(out.stderr, /trace retention was set to 7 days, not 365/);
  } finally {
    stub.close();
  }
});

test("routing settings do not disturb the endpoint's providerOptions", async () => {
  const stub = await startStub({ ...ENDPOINT, providerOptions: { codex_models: true } });
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--routing", "fast"]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(patchOf(stub), { routingMode: "fast" });
  } finally {
    stub.close();
  }
});

test("no flags at all is still an error", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha"]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /nothing to change/);
    noPatch(stub);
  } finally {
    stub.close();
  }
});

/**
 * Regression guard for the shape of the write, not just its contents.
 *
 * `endpoints set` is a PATCH: it sends only the fields the operator named and
 * relies on the server keeping the rest (UpdateInferenceEndpoint seeds its
 * params from the current row and overrides only non-nil request fields). A
 * change that started echoing fetched state back — say, spreading the endpoint
 * into the patch to merge route maps — would turn every `set` into a
 * last-write-wins full-object write: concurrent console edits would be
 * clobbered, and server-clamped values (traceRetentionDays) would be written
 * back as if the operator had asked for them.
 *
 * So: assert the exact key set on the wire, not merely that the flag arrived.
 */
test("a single-flag set puts that field and nothing else on the wire", async () => {
  const cases = [
    [["--context-compaction", "off"], ["contextCompaction"]],
    [["--routing", "cheap"], ["routingMode"]],
    [["--record-trace", "off"], ["recordTrace"]],
    [["--max-tool-rounds", "4"], ["maxToolRounds"]],
    [["--kind-route", "aside=openai/gpt-5.6-nano"], ["kindRoutes"]],
  ];
  for (const [args, expected] of cases) {
    const stub = await startStub();
    try {
      const out = await run(stub.base, ["endpoints", "set", "alpha", ...args]);
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(Object.keys(patchOf(stub)).sort(), expected.sort(), `${args.join(" ")} sent the wrong field set`);
    } finally {
      stub.close();
    }
  }
});

/**
 * The exact scenario reported against 2.8.0: an endpoint with recall, record
 * and trace recording all off, changed with one unrelated flag. None of the
 * three may appear in the request at all — naming them is what would let a
 * server default decide their value.
 */
test("changing compaction never mentions the memory or trace booleans", async () => {
  const off = { ...ENDPOINT, slug: "screener", recallEnabled: false, recordEnabled: false, recordTrace: false, recordAttachments: false, batchEnabled: false };
  const stub = await startStub(off);
  try {
    const out = await run(stub.base, ["endpoints", "set", "screener", "--context-compaction", "off"]);
    assert.equal(out.status, 0, out.stderr);
    const body = patchOf(stub);
    for (const key of ["recallEnabled", "recordEnabled", "recordTrace", "recordAttachments", "batchEnabled"]) {
      assert.ok(!(key in body), `${key} must not be sent; body was ${JSON.stringify(body)}`);
    }
    assert.deepEqual(body, { contextCompaction: "off" });
  } finally {
    stub.close();
  }
});

/** The PATCH must go to the endpoint's id, never the create route. */
test("set targets the endpoint's own PATCH route", async () => {
  const stub = await startStub();
  try {
    const out = await run(stub.base, ["endpoints", "set", "alpha", "--routing", "fast"]);
    assert.equal(out.status, 0, out.stderr);
    const writes = stub.calls.filter((c) => c.method !== "GET");
    assert.equal(writes.length, 1, `expected exactly one write, got ${JSON.stringify(writes)}`);
    assert.equal(writes[0].method, "PATCH");
    assert.equal(writes[0].url, `/api/v5/inference/endpoints/${ENDPOINT.id}`);
  } finally {
    stub.close();
  }
});
