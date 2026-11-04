import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";
import { connectRelay, RelayConnection, relayWebSocketURL, validRelayRequest } from "../dist/relay/client.js";

const request = (patch = {}) => ({ type: "request", id: "11111111-1111-1111-1111-111111111111", path: "/v1/messages", body: Buffer.from('{"model":"test"}').toString("base64"), ...patch });

test("the published command tree exposes the opt-in cloud relay", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "cliproxy", "relay", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--endpoint/);
  assert.match(result.stdout, /--enable/);
  assert.match(result.stdout, /--url/);
  assert.match(result.stdout, /cloud sessions and remote control/);
});

async function server(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test("relay URL never sends account credentials to insecure remote origins", () => {
  assert.equal(relayWebSocketURL("https://api.example.com", "endpoint"), "wss://api.example.com/api/v5/inference/endpoints/endpoint/cliproxy-relay");
  assert.match(relayWebSocketURL("http://127.0.0.1:3400", "endpoint"), /^ws:/);
  for (const base of ["http://api.example.com", "https://user:pass@api.example.com", "https://api.example.com/path", "https://api.example.com?token=secret"]) {
    assert.throws(() => relayWebSocketURL(base, "endpoint"));
  }
});

test("inference relay refuses arbitrary paths, methods and oversized bodies", () => {
  assert.equal(validRelayRequest(request()), true);
  for (const patch of [{ path: "/admin" }, { path: "/v1/messages?x=1" }, { type: "GET" }, { path: "http://169.254.169.254/" }, { body: "*invalid" }, { anthropicBeta: "x\r\nauthorization: secret" }, { body: "a".repeat(12 * 1024 * 1024) }]) {
    assert.equal(validRelayRequest(request(patch)), false);
  }
});

test("relay streams exact bytes with only the local credential at loopback", async (t) => {
  let authorization;
  const baseUrl = await server(t, (req, res) => {
    authorization = req.headers.authorization;
    assert.equal(req.url, "/v1/messages");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.end("data: second\n\n");
  });
  const frames = [];
  const connection = new RelayConnection({ baseUrl, apiKey: "local-only-test-key", models: ["test"] }, async (frame) => { frames.push(frame); });
  await connection.receive(request());
  assert.equal(authorization, "Bearer local-only-test-key");
  assert.equal(frames[0].type, "headers");
  assert.equal(frames[0].status, 200);
  assert.equal(frames.at(-1).type, "end");
  assert.equal(Buffer.concat(frames.filter((f) => f.type === "chunk").map((f) => Buffer.from(f.body, "base64"))).toString(), "data: first\n\ndata: second\n\n");
  assert.equal(JSON.stringify(frames).includes("local-only-test-key"), false);
});

test("a loopback redirect cannot leak the proxy credential", async (t) => {
  let destinationCalled = false;
  const destination = await server(t, (_req, res) => { destinationCalled = true; res.end("unexpected"); });
  const baseUrl = await server(t, (_req, res) => { res.writeHead(307, { location: destination }); res.end(); });
  const frames = [];
  const connection = new RelayConnection({ baseUrl, apiKey: "private-test-key", models: ["test"] }, async (f) => { frames.push(f); });
  await connection.receive(request());
  assert.equal(destinationCalled, false);
  assert.deepEqual(frames, [{ type: "error", id: request().id }]);
});

test("cloud cancellation aborts local inference", async (t) => {
  let started;
  let closed;
  const didStart = new Promise((resolve) => { started = resolve; });
  const didClose = new Promise((resolve) => { closed = resolve; });
  const baseUrl = await server(t, (_req, res) => {
    res.on("close", closed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: pending\n\n");
    started();
  });
  const connection = new RelayConnection({ baseUrl, apiKey: "private-test-key", models: ["test"] }, async () => {});
  const running = connection.receive(request());
  await didStart;
  await connection.receive({ type: "cancel", id: request().id });
  await running;
  await didClose;
});

async function cloudServer(t, connected) {
  const httpServer = http.createServer();
  const sockets = new Set();
  const ws = new WebSocketServer({ server: httpServer });
  ws.on("connection", (socket, request) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    connected(socket, request);
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.terminate(); ws.close(); httpServer.closeAllConnections(); httpServer.close(); });
  return `ws://127.0.0.1:${httpServer.address().port}/relay`;
}

test("real native WebSocket sends account auth only to cloud and streams loopback inference", { timeout: 5_000 }, async (t) => {
  const proxy = { baseUrl: await server(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-key-fixture");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: test-ok\n\n");
  }), apiKey: "local-key-fixture", models: ["test"] };
  const abort = new AbortController();
  const frames = [];
  let auth;
  let sendRequest;
  const url = await cloudServer(t, (socket, req) => {
    auth = req.headers.authorization;
    sendRequest = () => socket.send(JSON.stringify(request()));
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.type === "end") abort.abort();
    });
    socket.send(JSON.stringify({ type: "welcome" }));
  });
  await connectRelay(url, "account-key-fixture", proxy, abort.signal, () => sendRequest());
  assert.equal(auth, "Bearer account-key-fixture", "native WebSocket must support the HTTP Authorization header on the pinned Node runtime");
  assert.equal(frames[0].type, "headers");
  assert.equal(frames.at(-1).type, "end");
  assert.equal(Buffer.concat(frames.filter((f) => f.type === "chunk").map((f) => Buffer.from(f.body, "base64"))).toString(), "data: test-ok\n\n");
  assert.equal(JSON.stringify(frames).includes("local-key-fixture"), false);
  assert.equal(JSON.stringify(frames).includes("account-key-fixture"), false);
});

test("real cloud socket loss aborts pending local inference", { timeout: 5_000 }, async (t) => {
  let socket;
  let closeFetch;
  const fetchClosed = new Promise((resolve) => { closeFetch = resolve; });
  const proxy = { baseUrl: await server(t, (_req, res) => {
    res.on("close", closeFetch);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: waiting\n\n");
  }), apiKey: "local-key-fixture", models: ["test"] };
  const url = await cloudServer(t, (connection) => {
    socket = connection;
    socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "chunk") socket.close();
    });
    socket.send(JSON.stringify({ type: "welcome" }));
  });
  await connectRelay(url, "account-key-fixture", proxy, new AbortController().signal, () => socket.send(JSON.stringify(request())));
  await fetchClosed;
});

test("real cloud socket must welcome within a bounded time", { timeout: 5_000 }, async (t) => {
  const url = await cloudServer(t, () => {});
  const proxy = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "local-key-fixture", models: ["test"] };
  await assert.rejects(connectRelay(url, "account-key-fixture", proxy, new AbortController().signal, () => assert.fail("unwelcomed socket became ready"), 30), /connection failed/);
});

test("relay --enable configures a cross-vendor default before authenticated connection", { timeout: 10_000 }, async (t) => {
  const proxyURL = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-key-fixture");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-test" }] }));
  });
  let patch;
  const endpoint = { id: "11111111-1111-1111-1111-111111111111", slug: "relay-test", model: "old-model", billingMode: "ditto", providerOptions: { claude_inference: "native" } };
  const api = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer ditto_mcp_account_fixture");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v5/companies") return res.end(JSON.stringify({ companies: [] }));
    if (req.method === "PATCH") {
      let body = "";
      for await (const chunk of req) body += chunk;
      patch = JSON.parse(body);
      return res.end(JSON.stringify({ ...endpoint, ...patch }));
    }
    res.end(JSON.stringify({ baseUrl: "https://unused.example/v1", endpoints: [endpoint] }));
  });
  const ws = new WebSocketServer({ server: api });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  let child;
  const sockets = new Set();
  ws.on("connection", (socket, req) => {
    sockets.add(socket);
    assert.equal(req.headers.authorization, "Bearer ditto_mcp_account_fixture");
    assert.equal(patch.modelMode, "default", "a bare Claude model must use the selected GPT model");
    assert.deepEqual(patch.kindRoutes, { agent_summary: "off" }, "the implicit cloud-only summary model must not escape the selected proxy");
    socket.send(JSON.stringify({ type: "welcome" }));
  });
  t.after(() => { child?.kill("SIGTERM"); for (const socket of sockets) socket.terminate(); ws.close(); api.closeAllConnections(); api.close(); });
  child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "cliproxy", "relay", "--endpoint", endpoint.slug, "--enable", "--model", "gpt-test"], {
    env: { ...process.env, DITTO_API_KEY: "ditto_mcp_account_fixture", DITTO_API_BASE: `http://127.0.0.1:${api.address().port}`, CLIPROXY_BASE_URL: proxyURL, CLIPROXY_API_KEY: "local-key-fixture" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk; if (output.includes("cloud relay connected")) child.kill("SIGTERM"); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, output);
  assert.equal(patch.billingMode, "byok");
  assert.equal(patch.model, "gpt-test");
  assert.equal(patch.providerOptions.claude_inference, "router");
  assert.equal(patch.providerOptions.cliproxy_relay, true);
  assert.equal(output.includes("local-key-fixture"), false);
  assert.equal(output.includes("ditto_mcp_account_fixture"), false);
});
