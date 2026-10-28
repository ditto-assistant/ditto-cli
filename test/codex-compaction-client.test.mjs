import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Opt in with the exact installed binary. This uses only loopback fixtures:
// it never reads a real Ditto/OpenAI key or sends a provider request.
const binary = process.env.DITTO_TEST_CODEX_BINARY;
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const opener = "You are performing a CONTEXT CHECKPOINT COMPACTION.";
const facts = ["QA-CEDAR-731", "QA-OK-42", "verify the saved receipt"];
const summary = `Fictional Cedar project: marker ${facts[0]}; approval executed with receipt ${facts[1]}. Pending: ${facts[2]}.`;

function rpc(child) {
  let seq = 0;
  const pending = new Map();
  const notices = [];
  const readers = [];
  let stderr = "";
  let stopped = false;
  child.stderr.on("data", c => stderr = (stderr + c).slice(-8000));
  readline.createInterface({ input: child.stdout }).on("line", line => {
    let item;
    try { item = JSON.parse(line); } catch { return; }
    if (item.id !== undefined && pending.has(item.id)) {
      const { resolve, reject, timer } = pending.get(item.id);
      clearTimeout(timer); pending.delete(item.id);
      item.error ? reject(new Error(JSON.stringify(item.error))) : resolve(item.result);
    } else {
      notices.push(item);
      for (const wake of readers.splice(0)) wake();
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  return {
    send,
    async initialize() {
      await send("initialize", { clientInfo: { name: "ditto-local-compaction-test", version: "1.0.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write('{"method":"initialized"}\n');
    },
    async completed() {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const idx = notices.findIndex(n => n.method === "turn/completed");
        if (idx >= 0) {
          const turn = notices.splice(idx, 1)[0].params.turn;
          assert.equal(turn.status, "completed", JSON.stringify(turn));
          return;
        }
        await new Promise(resolve => { const timer = setTimeout(resolve, 100); readers.push(() => { clearTimeout(timer); resolve(); }); });
      }
      throw new Error(`No completed turn: ${JSON.stringify(notices)} ${stderr}`);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("client stopped")); }
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      const exited = new Promise(resolve => child.once("exit", resolve));
      const timer = setTimeout(() => child.kill("SIGTERM"), 1000);
      await exited; clearTimeout(timer);
    },
  };
}

for (const model of ["gpt-6.1-sol", "anthropic/claude-fable-5.1", "z-ai/glm-5.3"]) {
  test(`installed heyditto codex compacts and resumes ${model}`, { skip: !binary, timeout: 90000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "ditto-codex-compaction-"));
    await mkdir(path.join(home, "bin"));
    await mkdir(path.join(home, "work"));
    await mkdir(path.join(home, "codex"));
    await symlink(path.resolve(binary), path.join(home, "bin", "codex"));
    await writeFile(path.join(home, "codex", "config.toml"), `model = ${JSON.stringify(model)}\n[features]\nplugins = false\nremote_plugin = false\napps = false\n`);
    const requests = [];
    let launches = 0;
    let base;
    const server = http.createServer(async (req, res) => {
      let data = "";
      for await (const chunk of req) data += chunk;
      const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url === "/api/v5/companies") return json(200, { companies: [] });
      if (req.url === "/api/v5/inference/endpoints") return json(200, { baseUrl: `${base}/v1`, endpoints: [{ id: "endpoint-qa", companyId: "company-qa", slug: "ditto-dev", name: "QA Ditto Dev", model, status: "active" }] });
      if (req.method === "POST" && req.url.endsWith("/keys")) return json(201, { id: `key-${++launches}`, key: `local-fixture-${launches}`, keyHint: "fake" });
      if (req.method === "DELETE" && req.url.includes("/keys/")) return json(200, {});
      if (req.method !== "POST" || req.url !== "/v1/responses") return json(404, { error: "local fixture route not found" });
      const body = JSON.parse(data);
      const text = JSON.stringify(body.input);
      const compact = body.input.at(-1)?.content?.some?.(p => p.text?.startsWith(opener));
      const n = requests.length + 1;
      requests.push({ body, auth: req.headers.authorization, session: req.headers["x-ditto-session-id"], compact });
      // A response is generated only if the client actually replays every
      // fact. A constant 'recall succeeded' answer would hide lost context.
      if (!facts.every(f => text.includes(f))) return json(400, { error: { message: "fixture detected lost checkpoint facts" } });
      const message = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: summary, annotations: [] }] };
      const response = { id: `resp_${n}`, object: "response", created_at: 1, status: "completed", model, output: [message], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 80 } } };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    // An allowlist prevents inherited credentials or parent-agent context
    // from entering the child. Every endpoint and key below is synthetic.
    const env = { PATH: `${path.join(home, "bin")}${path.delimiter}${process.env.PATH}`, HOME: home, TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8", CODEX_HOME: path.join(home, "codex"), DITTO_CONFIG_DIR: path.join(home, "ditto"), DITTO_API_BASE: base, DITTO_API_KEY: "local-management-only", NO_COLOR: "1", HEYDITTO_REMOTE_CONTROL: "0" };
    const start = () => rpc(spawn(process.execPath, [cli, "codex", "--endpoint", "ditto-dev", "--session", "qa-compaction-session", "--no-remote-control", "--", "--no-daemon", "app-server"], { env, cwd: path.join(home, "work"), stdio: ["pipe", "pipe", "pipe"] }));
    let client;
    try {
      client = start(); await client.initialize();
      const started = await client.send("thread/start", { model, modelProvider: "ditto", cwd: path.join(home, "work"), baseInstructions: "Local synthetic QA. Preserve identifiers. No tools.", approvalPolicy: "never", sandbox: "read-only" });
      const threadId = started.thread.id;
      const turn = async text => { await client.send("turn/start", { threadId, input: [{ type: "text", text }] }); await client.completed(); };
      await turn(summary);
      for (let i = 0; i < 2; i++) {
        await client.send("thread/compact/start", { threadId }); await client.completed();
        await turn("Recall the marker, execution receipt and pending next step. Keep all three.");
      }
      await client.stop(); client = start(); await client.initialize();
      await client.send("thread/resume", { threadId, model, modelProvider: "ditto", cwd: path.join(home, "work"), approvalPolicy: "never", sandbox: "read-only" });
      await turn("After restart, recall the same three facts.");
      assert.equal(requests.length, 6);
      assert.equal(requests.filter(r => r.compact).length, 2);
      assert.ok(requests.every(r => r.body.model === model), "compaction must retain the conversing model");
      assert.ok(requests.every(r => r.session === "qa-compaction-session"), "launch and resume must keep the Ditto session identity");
      assert.equal(new Set(requests.map(r => r.auth)).size, 2, "resume must work with a renewed temporary key");
    } finally {
      if (client) await client.stop();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    }
  });
}
