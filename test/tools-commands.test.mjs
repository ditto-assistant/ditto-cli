import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractDownloadTarget,
  parseArgValue,
  redactUrl,
  resolveCatalogServer,
  sanitizeFilename,
  sanitizeSecret,
} from "../dist/tools-commands.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const EPHEMERAL_KEY = "ditto_inf_ephemeral_secret_987654321";
const PRESIGNED_SIG = "SUPER_SECRET_S3_SIGNATURE_XYZ";

test("parseArgValue handles JSON literals, objects, arrays, quoted strings, and plain strings", () => {
  assert.equal(parseArgValue("true"), true);
  assert.equal(parseArgValue("false"), false);
  assert.equal(parseArgValue("null"), null);
  assert.equal(parseArgValue("42"), 42);
  assert.equal(parseArgValue("-3.5"), -3.5);
  assert.equal(parseArgValue("00123"), "00123");
  assert.equal(parseArgValue('"12345"'), "12345");
  assert.deepEqual(parseArgValue('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseArgValue('{"limit":5}'), { limit: 5 });
  assert.equal(parseArgValue("application/pdf"), "application/pdf");
  assert.equal(parseArgValue("hello world"), "hello world");
});

test("resolveCatalogServer matches canonical names, short aliases, separator variants, and reports disconnected servers", () => {
  const catalog = {
    endpoint: "dev",
    approvalMode: "park",
    clientApprovals: false,
    servers: [
      { name: "ditto", url: "https://api.test/v1/mcp/ditto", tools: [{ name: "search_memories", tier: "read", approval: false }] },
      { name: "googledrive", url: "https://api.test/v1/mcp/googledrive", tools: [{ name: "download_file", tier: "read", approval: false }] },
      { name: "sn118_backroom", url: "https://api.test/v1/mcp/sn118_backroom", tools: [{ name: "list_runs", tier: "read", approval: false }] },
      { name: "empty", url: "https://api.test/v1/mcp/empty", tools: [] },
    ],
    unavailable: [
      {
        serverId: "srv-jira",
        name: "Jira",
        prefix: "jira",
        reason: "oauth_not_connected",
        reconnectUrl: "https://app.heyditto.ai/connections/mcp?reconnect=srv-jira",
        personal: true,
      },
    ],
  };

  assert.equal(resolveCatalogServer(catalog, "ditto").displayName, "ditto");
  assert.equal(resolveCatalogServer(catalog, "googledrive").displayName, "ditto-googledrive");
  assert.equal(resolveCatalogServer(catalog, "ditto-googledrive").alias, "googledrive");
  assert.equal(resolveCatalogServer(catalog, "google-drive").displayName, "ditto-googledrive");
  assert.equal(resolveCatalogServer(catalog, "Google_Drive").displayName, "ditto-googledrive");
  assert.equal(resolveCatalogServer(catalog, "sn118-backroom").displayName, "ditto-sn118_backroom");

  assert.throws(
    () => resolveCatalogServer(catalog, "jira"),
    /Jira is disconnected.*reconnect: https:\/\/app\.heyditto\.ai\/connections\/mcp\?reconnect=srv-jira/,
  );
  assert.throws(
    () => resolveCatalogServer(catalog, "nope"),
    /no connected MCP server named "nope".*ditto-googledrive \(googledrive\)/,
  );
});

test("extractDownloadTarget, sanitizeFilename, redactUrl, and sanitizeSecret handle download payloads safely", () => {
  const driveResult = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          successful: true,
          data: {
            downloaded_file_content: {
              s3url: `https://s3.example.test/bucket/deck.pdf?X-Amz-Signature=${PRESIGNED_SIG}`,
              name: "Q4 Deck.pdf",
              mimetype: "application/pdf",
            },
          },
        }),
      },
    ],
  };
  const target = extractDownloadTarget(driveResult);
  assert.deepEqual(target, {
    kind: "url",
    url: `https://s3.example.test/bucket/deck.pdf?X-Amz-Signature=${PRESIGNED_SIG}`,
    filename: "Q4 Deck.pdf",
    mimeType: "application/pdf",
  });

  const blobResult = {
    content: [
      {
        type: "resource",
        resource: {
          uri: "file:///exports/report.csv",
          mimeType: "text/csv",
          blob: Buffer.from("a,b\n1,2\n").toString("base64"),
        },
      },
    ],
  };
  assert.deepEqual(extractDownloadTarget(blobResult), {
    kind: "base64",
    data: Buffer.from("a,b\n1,2\n").toString("base64"),
    filename: "report.csv",
    mimeType: "text/csv",
  });

  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("..\\..\\evil.exe"), "evil.exe");
  assert.equal(sanitizeFilename(".."), "download.bin");
  assert.equal(sanitizeFilename("normal report.pdf"), "normal report.pdf");
  assert.equal(
    redactUrl(`https://s3.example.test/bucket/deck.pdf?X-Amz-Signature=${PRESIGNED_SIG}`),
    "https://s3.example.test/bucket/deck.pdf",
  );
  assert.equal(sanitizeSecret(`Bearer ${EPHEMERAL_KEY} failed`, EPHEMERAL_KEY), "Bearer [REDACTED] failed");
});

function startMockEcosystem(opts = {}) {
  const state = {
    requests: [],
    mcpCalls: [],
    presignedRequests: [],
    keyCounter: 0,
    failRevoke: opts.failRevoke ?? false,
    failDownloadStatus: opts.failDownloadStatus ?? 200,
    failToolCallHttp: opts.failToolCallHttp ?? false,
    echoSecretOnError: opts.echoSecretOnError ?? false,
    downloadFilename: opts.downloadFilename ?? "Q4 Deck.pdf",
    binaryPayload: opts.binaryPayload ?? Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]),
  };

  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.on("data", (chunk) => (rawBody += chunk));
    req.on("end", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const urlPath = (req.url ?? "/").split("?")[0];
      state.requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        session: req.headers["x-ditto-session-id"],
      });

      const sendJson = (status, payload, extraHeaders = {}) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };

      // Presigned download route (must NOT receive Ditto Authorization header).
      if (urlPath === "/presigned/deck.pdf") {
        state.presignedRequests.push({
          url: req.url,
          auth: req.headers.authorization,
        });
        if (state.failDownloadStatus !== 200) {
          res.statusCode = state.failDownloadStatus;
          res.end("AccessDenied");
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/pdf");
        res.setHeader("content-disposition", `attachment; filename="${state.downloadFilename}"`);
        res.end(state.binaryPayload);
        return;
      }

      // Management API routes (require first-party key).
      if (urlPath === "/api/v5/companies" && req.method === "GET") {
        if (req.headers.authorization !== "Bearer ditto_mcp_login") return sendJson(401, { message: "unauthorized" });
        return sendJson(200, { companies: [] });
      }
      if (urlPath === "/api/v5/inference/endpoints" && req.method === "GET") {
        if (req.headers.authorization !== "Bearer ditto_mcp_login") return sendJson(401, { message: "unauthorized" });
        return sendJson(200, {
          baseUrl: `${base}/v1`,
          endpoints: [
            { id: "ep-uuid-1", slug: "endpoint-1", name: "Endpoint One", model: "native", status: "active" },
          ],
        });
      }
      if (urlPath === "/api/v5/inference/endpoints/ep-uuid-1/keys" && req.method === "POST") {
        if (req.headers.authorization !== "Bearer ditto_mcp_login") return sendJson(401, { message: "unauthorized" });
        state.keyCounter += 1;
        return sendJson(201, {
          id: `ekey-${state.keyCounter}`,
          endpointId: "ep-uuid-1",
          name: JSON.parse(rawBody).name,
          keyHint: "4321",
          key: EPHEMERAL_KEY,
        });
      }
      if (urlPath.startsWith("/api/v5/inference/endpoints/ep-uuid-1/keys/") && req.method === "DELETE") {
        if (req.headers.authorization !== "Bearer ditto_mcp_login") return sendJson(401, { message: "unauthorized" });
        if (state.failRevoke) return sendJson(503, { message: "revoke unavailable" });
        return sendJson(204);
      }

      // Ephemeral-key authenticated MCP catalog.
      if (urlPath === "/v1/mcp" && req.method === "GET") {
        if (req.headers.authorization !== `Bearer ${EPHEMERAL_KEY}`) return sendJson(401, { message: "bad ephemeral key" });
        return sendJson(200, {
          endpoint: "endpoint-1",
          approvalMode: "park",
          clientApprovals: false,
          servers: [
            {
              name: "ditto",
              url: `${base}/v1/mcp/ditto`,
              tools: [{ name: "search_memories", tier: "read", approval: false }],
            },
            {
              name: "googledrive",
              url: `${base}/v1/mcp/googledrive`,
              tools: [
                { name: "list_files", tier: "read", approval: false },
                { name: "download_file", tier: "read", approval: false },
                { name: "delete_file", tier: "gated", approval: true },
              ],
            },
          ],
          unavailable: [
            {
              serverId: "srv-gmail",
              name: "Gmail",
              prefix: "gmail",
              reason: "oauth_not_connected",
              reconnectUrl: "https://app.heyditto.ai/connections/mcp?reconnect=srv-gmail",
              personal: true,
            },
          ],
        });
      }

      // Streamable HTTP MCP server endpoints.
      if (urlPath === "/v1/mcp/googledrive" || urlPath === "/v1/mcp/ditto") {
        if (req.headers.authorization !== `Bearer ${EPHEMERAL_KEY}`) return sendJson(401, { message: "bad ephemeral key" });
        if (req.method === "DELETE") return sendJson(200, {});
        if (req.method !== "POST") return sendJson(405, { message: "method not allowed" });

        const rpc = rawBody ? JSON.parse(rawBody) : {};
        state.mcpCalls.push({
          path: urlPath,
          method: rpc.method,
          params: rpc.params,
          sessionHeader: req.headers["x-ditto-session-id"],
          mcpSessionId: req.headers["mcp-session-id"],
        });

        if (rpc.method === "initialize") {
          return sendJson(
            200,
            {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: urlPath.split("/").pop(), version: "1.0.0" },
              },
            },
            { "Mcp-Session-Id": "mcp-sess-42" },
          );
        }
        if (rpc.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
          return;
        }
        if (rpc.method === "tools/list") {
          if (urlPath === "/v1/mcp/googledrive") {
            if (!rpc.params?.cursor) {
              return sendJson(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  tools: [
                    {
                      name: "list_files",
                      description: "List files in Google Drive matching an optional query.",
                      inputSchema: {
                        type: "object",
                        properties: {
                          query: { type: "string", description: "Drive search query" },
                          page_size: { type: "integer", description: "Max files to return" },
                        },
                      },
                    },
                  ],
                  nextCursor: "page-2",
                },
              });
            }
            return sendJson(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                tools: [
                  {
                    name: "download_file",
                    description: "Download a file from Google Drive via a presigned S3 link.",
                    inputSchema: {
                      type: "object",
                      required: ["file_id"],
                      properties: {
                        file_id: { type: "string", description: "Google Drive file ID" },
                        mime_type: { type: "string", description: "Optional export MIME type" },
                      },
                    },
                  },
                  {
                    name: "delete_file",
                    description: "Move a Google Drive file to trash.",
                    inputSchema: {
                      type: "object",
                      required: ["file_id"],
                      properties: { file_id: { type: "string", description: "Google Drive file ID" } },
                    },
                  },
                ],
              },
            });
          }
          return sendJson(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tools: [
                {
                  name: "search_memories",
                  description: "Search Ditto memories.",
                  inputSchema: { type: "object", required: ["queries"], properties: { queries: { type: "array", items: { type: "string" } } } },
                },
              ],
            },
          });
        }
        if (rpc.method === "tools/call") {
          if (state.failToolCallHttp) {
            return sendJson(500, {
              error: state.echoSecretOnError ? `upstream boom with ${EPHEMERAL_KEY}` : "internal server error",
            });
          }
          const name = rpc.params?.name;
          const args = rpc.params?.arguments ?? {};
          if (name === "list_files") {
            return sendJson(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ files: [{ id: "file-1", name: "Deck.pdf" }], receivedArgs: args }) }],
              },
            });
          }
          if (name === "download_file") {
            if (args.file_id === "missing") {
              return sendJson(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  isError: true,
                  content: [{ type: "text", text: `File not found (debug token ${EPHEMERAL_KEY})` }],
                },
              });
            }
            if (args.file_id === "blob") {
              return sendJson(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  content: [
                    {
                      type: "resource",
                      resource: {
                        uri: "file:///tmp/notes.txt",
                        mimeType: "text/plain",
                        blob: Buffer.from("hello from blob").toString("base64"),
                      },
                    },
                  ],
                },
              });
            }
            return sendJson(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      downloaded_file_content: {
                        s3url: `${base}/presigned/deck.pdf?X-Amz-Signature=${PRESIGNED_SIG}`,
                        name: state.downloadFilename,
                        mimetype: "application/pdf",
                      },
                    }),
                  },
                ],
              },
            });
          }
          return sendJson(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] },
          });
        }
        return sendJson(400, { error: "unsupported rpc method" });
      }

      sendJson(404, { error: `not found: ${urlPath}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        state,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

function runCli(base, args, { env = {}, stdin, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      DITTO_API_BASE: base,
      DITTO_API_KEY: "ditto_mcp_login",
      DITTO_CLI_AUTO_UPDATE: "0",
      ...env,
    };
    if (!("T3CODE_THREAD_ID" in env)) delete childEnv.T3CODE_THREAD_ID;
    if (!("DITTO_SESSION_ID" in env)) delete childEnv.DITTO_SESSION_ID;

    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: childEnv,
      stdio: [stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

test("heyditto tools lists servers, revokes ephemeral key, and never prints secrets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heyditto-tools-"));
  const mock = await startMockEcosystem();
  try {
    const cfg = path.join(dir, "config");
    const text = await runCli(mock.base, ["tools"], { env: { DITTO_CONFIG_DIR: cfg } });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /ditto-googledrive/);
    assert.match(text.stdout, /googledrive/);
    assert.match(text.stderr, /Gmail is disconnected/);
    assert.ok(!text.stdout.includes(EPHEMERAL_KEY), "ephemeral key leaked to stdout");
    assert.ok(!text.stderr.includes(EPHEMERAL_KEY), "ephemeral key leaked to stderr");

    // Ephemeral key was minted and revoked.
    assert.ok(mock.state.requests.some((r) => r.method === "POST" && r.url === "/api/v5/inference/endpoints/ep-uuid-1/keys"));
    assert.ok(mock.state.requests.some((r) => r.method === "DELETE" && r.url === "/api/v5/inference/endpoints/ep-uuid-1/keys/ekey-1"));

    // Auto-generated session id when T3CODE_THREAD_ID is unset.
    const catalogReq = mock.state.requests.find((r) => r.url === "/v1/mcp");
    assert.match(catalogReq.session, /^cli-tools-/);

    // --json output includes structured servers and unavailable sources without secrets.
    const json = await runCli(mock.base, ["tools", "--json"], {
      env: { DITTO_CONFIG_DIR: cfg, T3CODE_THREAD_ID: "thread-abc-123" },
    });
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.sessionId, "thread-abc-123");
    assert.deepEqual(
      parsed.servers.map((s) => s.name),
      ["ditto", "ditto-googledrive"],
    );
    assert.equal(parsed.unavailable.length, 1);
    assert.ok(!json.stdout.includes(EPHEMERAL_KEY));
    assert.ok(!json.stderr.includes(EPHEMERAL_KEY));
    assert.ok(mock.state.requests.some((r) => r.method === "DELETE" && r.url === "/api/v5/inference/endpoints/ep-uuid-1/keys/ekey-2"));
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("heyditto tools list and describe handle alias matching, pagination, search, and schema output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heyditto-tools-list-"));
  const mock = await startMockEcosystem();
  try {
    const cfg = path.join(dir, "config");

    // All-server catalog list with search.
    const allRes = await runCli(mock.base, ["tools", "list", "--search", "download", "--json"], {
      env: { DITTO_CONFIG_DIR: cfg },
    });
    assert.equal(allRes.code, 0, allRes.stderr);
    const allJson = JSON.parse(allRes.stdout);
    assert.deepEqual(
      allJson.tools.map((t) => `${t.server}:${t.name}`),
      ["ditto-googledrive:download_file"],
    );

    // Single-server list using short alias + pagination + search on description.
    const driveRes = await runCli(mock.base, ["tools", "list", "google-drive", "--search", "presigned", "--json"], {
      env: { DITTO_CONFIG_DIR: cfg },
    });
    assert.equal(driveRes.code, 0, driveRes.stderr);
    const driveJson = JSON.parse(driveRes.stdout);
    assert.equal(driveJson.server, "ditto-googledrive");
    assert.deepEqual(
      driveJson.tools.map((t) => t.name),
      ["download_file"],
    );
    // Verify full Streamable HTTP MCP handshake happened.
    const methods = mock.state.mcpCalls.map((c) => c.method);
    assert.ok(methods.includes("initialize"));
    assert.ok(methods.includes("notifications/initialized"));
    assert.equal(methods.filter((m) => m === "tools/list").length, 2, "expected paginated tools/list");

    // Describe / schema alias.
    const descText = await runCli(mock.base, ["tools", "describe", "googledrive", "download_file"], {
      env: { DITTO_CONFIG_DIR: cfg },
    });
    assert.equal(descText.code, 0, descText.stderr);
    assert.match(descText.stdout, /ditto-googledrive \/ download_file/);
    assert.match(descText.stdout, /file_id/);
    assert.match(descText.stdout, /"required": \[\s*"file_id"\s*\]/);

    const descJson = await runCli(mock.base, ["tools", "schema", "ditto-googledrive", "download_file", "--json"], {
      env: { DITTO_CONFIG_DIR: cfg },
    });
    assert.equal(descJson.code, 0, descJson.stderr);
    const schemaObj = JSON.parse(descJson.stdout);
    assert.equal(schemaObj.tool.name, "download_file");
    assert.deepEqual(schemaObj.tool.inputSchema.required, ["file_id"]);

    // Unknown tool suggests similar tools.
    const missing = await runCli(mock.base, ["tools", "describe", "googledrive", "download"], {
      env: { DITTO_CONFIG_DIR: cfg },
    });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /Matching tools: download_file/);
    assert.ok(!missing.stderr.includes(EPHEMERAL_KEY));
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("heyditto tools call supports --json, @file.json, --stdin, --arg, --raw-arg and revokes key on success and error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heyditto-tools-call-"));
  const mock = await startMockEcosystem();
  try {
    const cfg = path.join(dir, "config");
    const argsFile = path.join(dir, "args.json");
    await writeFile(argsFile, JSON.stringify({ query: "from-file", page_size: 5 }));

    // 1. --json inline + --arg override + --raw-arg string preservation.
    const r1 = await runCli(
      mock.base,
      [
        "tools",
        "call",
        "googledrive",
        "list_files",
        "--json",
        '{"query":"inline","page_size":3}',
        "--arg",
        "page_size=25",
        "--arg",
        "include_trashed=false",
        "--raw-arg",
        "folder_id=00789",
        "--session",
        "custom-sess-1",
        "--output",
        "json",
      ],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.equal(r1.code, 0, r1.stderr);
    const out1 = JSON.parse(r1.stdout);
    assert.deepEqual(out1.receivedArgs, {
      query: "inline",
      page_size: 25,
      include_trashed: false,
      folder_id: "00789",
    });
    const lastCall = mock.state.mcpCalls.filter((c) => c.method === "tools/call").at(-1);
    assert.equal(lastCall.sessionHeader, "custom-sess-1");
    assert.equal(lastCall.mcpSessionId, "mcp-sess-42");

    // 2. Positional @file.json.
    const r2 = await runCli(mock.base, ["tools", "call", "googledrive", "list_files", `@${argsFile}`, "--output", "json"], {
      env: { DITTO_CONFIG_DIR: cfg },
    });
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(JSON.parse(r2.stdout).receivedArgs, { query: "from-file", page_size: 5 });

    // 3. --stdin piped JSON.
    const r3 = await runCli(mock.base, ["tools", "call", "googledrive", "list_files", "--stdin", "--output", "json"], {
      env: { DITTO_CONFIG_DIR: cfg },
      stdin: '{"query":"from-stdin","page_size":7}\n',
    });
    assert.equal(r3.code, 0, r3.stderr);
    assert.deepEqual(JSON.parse(r3.stdout).receivedArgs, { query: "from-stdin", page_size: 7 });

    // 4. MCP tool error (isError: true): fails non-zero, revokes key, and redacts any echoed secret.
    const keyCountBeforeErr = mock.state.keyCounter;
    const rErr = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "download_file", "--arg", "file_id=missing"],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.notEqual(rErr.code, 0);
    assert.equal(rErr.stdout, "");
    assert.match(rErr.stderr, /File not found/);
    assert.ok(!rErr.stderr.includes(EPHEMERAL_KEY), "ephemeral key must be redacted from tool error");
    assert.ok(
      mock.state.requests.some(
        (r) => r.method === "DELETE" && r.url === `/api/v5/inference/endpoints/ep-uuid-1/keys/ekey-${keyCountBeforeErr + 1}`,
      ),
      "ephemeral key must be revoked after tool error",
    );

    // 5. Upstream HTTP 500 error that echoes the secret: revokes key and redacts secret.
    mock.state.failToolCallHttp = true;
    mock.state.echoSecretOnError = true;
    const keyCountBefore500 = mock.state.keyCounter;
    const r500 = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "list_files"],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.notEqual(r500.code, 0);
    assert.equal(r500.stdout, "");
    assert.ok(!r500.stderr.includes(EPHEMERAL_KEY), "ephemeral key must be redacted from HTTP error");
    assert.ok(
      mock.state.requests.some(
        (r) => r.method === "DELETE" && r.url === `/api/v5/inference/endpoints/ep-uuid-1/keys/ekey-${keyCountBefore500 + 1}`,
      ),
      "ephemeral key must be revoked after HTTP failure",
    );

    // 6. Revoke failure warns with key id only, never prints the secret.
    mock.state.failToolCallHttp = false;
    mock.state.failRevoke = true;
    const rWarn = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "list_files", "--output", "json"],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.equal(rWarn.code, 0, rWarn.stderr);
    assert.match(rWarn.stderr, /could not revoke ephemeral MCP key ekey-/);
    assert.ok(!rWarn.stderr.includes(EPHEMERAL_KEY));
    assert.ok(!rWarn.stdout.includes(EPHEMERAL_KEY));

    // 7. Invalid JSON argument fails BEFORE minting a key.
    const keysBeforeBadJson = mock.state.keyCounter;
    const rBad = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "list_files", "--json", "{not-json"],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.notEqual(rBad.code, 0);
    assert.equal(mock.state.keyCounter, keysBeforeBadJson, "must not mint a key for invalid local args");
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("heyditto tools call --download streams presigned and blob payloads without leaking presigned URLs or auth tokens", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "heyditto-tools-dl-"));
  const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xfe, 0xff]);
  const expectedSha = createHash("sha256").update(payload).digest("hex");
  const mock = await startMockEcosystem({ binaryPayload: payload });
  try {
    const cfg = path.join(dir, "config");
    const dlDir = path.join(dir, "out");

    // 1. Download to directory (trailing slash creates dir and uses sanitized filename).
    const rDir = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "download_file", "--arg", "file_id=f1", "--download", `${dlDir}/`, "--output", "json"],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.equal(rDir.code, 0, rDir.stderr);
    const meta = JSON.parse(rDir.stdout);
    assert.equal(meta.downloaded, true);
    assert.equal(meta.filename, "Q4 Deck.pdf");
    assert.equal(meta.bytes, payload.length);
    assert.equal(meta.sha256, expectedSha);
    assert.equal(meta.contentType, "application/pdf");
    assert.deepEqual(await readFile(path.join(dlDir, "Q4 Deck.pdf")), payload);
    // Presigned URL signature & ephemeral key never printed.
    assert.ok(!rDir.stdout.includes(PRESIGNED_SIG), "presigned signature leaked to stdout");
    assert.ok(!rDir.stderr.includes(PRESIGNED_SIG), "presigned signature leaked to stderr");
    assert.ok(!rDir.stdout.includes("s3url"), "s3url leaked to stdout");
    assert.ok(!rDir.stdout.includes(EPHEMERAL_KEY));
    assert.ok(!rDir.stderr.includes(EPHEMERAL_KEY));
    // Presigned fetch received NO Authorization header.
    assert.equal(mock.state.presignedRequests.at(-1).auth, undefined);

    // 2. Download to explicit file path in text mode.
    const explicitFile = path.join(dir, "nested", "custom.pdf");
    const rFile = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "download_file", "--arg", "file_id=f1", "--download", explicitFile],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.equal(rFile.code, 0, rFile.stderr);
    assert.match(rFile.stdout, /Downloaded \d+ bytes to /);
    assert.ok(!rFile.stdout.includes(PRESIGNED_SIG));
    assert.ok(!rFile.stderr.includes(PRESIGNED_SIG));
    assert.deepEqual(await readFile(explicitFile), payload);

    // 3. Path-traversal filename in payload is sanitized inside target directory.
    mock.state.downloadFilename = "../../escape-attempt.bin";
    const safeDir = path.join(dir, "safe-dir");
    const rTrav = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "download_file", "--arg", "file_id=f1", "--download", `${safeDir}/`, "--output", "json"],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.equal(rTrav.code, 0, rTrav.stderr);
    const travMeta = JSON.parse(rTrav.stdout);
    assert.equal(travMeta.path, path.join(safeDir, "escape-attempt.bin"));
    assert.equal(existsSync(path.join(safeDir, "escape-attempt.bin")), true);
    assert.equal(existsSync(path.join(dir, "escape-attempt.bin")), false);

    // 4. Presigned HTTP 403 error strips query string signature from stderr.
    mock.state.failDownloadStatus = 403;
    const r403 = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "download_file", "--arg", "file_id=f1", "--download", path.join(dir, "fail.pdf")],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.notEqual(r403.code, 0);
    assert.match(r403.stderr, /HTTP 403/);
    assert.ok(!r403.stderr.includes(PRESIGNED_SIG), "presigned signature must not leak in download error");
    assert.equal(existsSync(path.join(dir, "fail.pdf")), false);

    // 5. Embedded base64 MCP resource blob downloads cleanly too.
    mock.state.failDownloadStatus = 200;
    const blobOut = path.join(dir, "blob-out");
    const rBlob = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "download_file", "--arg", "file_id=blob", "--download", `${blobOut}/`, "--output", "json"],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.equal(rBlob.code, 0, rBlob.stderr);
    assert.equal(await readFile(path.join(blobOut, "notes.txt"), "utf8"), "hello from blob");

    // 6. Tool returning isError with --download exits non-zero and writes no file.
    const errOut = path.join(dir, "should-not-exist.pdf");
    const rToolErr = await runCli(
      mock.base,
      ["tools", "call", "googledrive", "download_file", "--arg", "file_id=missing", "--download", errOut],
      { env: { DITTO_CONFIG_DIR: cfg } },
    );
    assert.notEqual(rToolErr.code, 0);
    assert.equal(existsSync(errOut), false);
  } finally {
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
