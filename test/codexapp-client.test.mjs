import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const binary = process.env.DITTO_TEST_CODEX_BINARY;

function run(command, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

// This exercises the installed client against an entirely local provider.
// It neither launches the user's Desktop process nor bills a real model.
test("installed Codex uses the Desktop setup key and selected Claude/open model IDs", { skip: !binary }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ditto-desktop-client-"));
  const configDir = mkdtempSync(path.join(os.tmpdir(), "ditto-desktop-login-"));
  const ids = ["openai/gpt-6.1-sol", "anthropic/claude-fable-5.1", "z-ai/glm-5.3-flash"];
  const key = "ditto_inf_local_probe_only";
  const selected = [];
  const descriptors = ["ditto-dev", ...ids].map((slug, priority) => ({
    slug, display_name: slug, description: "local compatibility fixture",
    base_instructions: "You are a coding assistant. Answer the user's request.",
    shell_type: "unified_exec", visibility: "list", priority, supported_in_api: true,
    support_verbosity: false, truncation_policy: { mode: "tokens", limit: 10000 },
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
    default_reasoning_level: "medium", experimental_supported_tools: [], input_modalities: ["text"],
  }));
  let base;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/api/v5/companies") return json(200, { companies: [] });
      if (req.url === "/api/v5/inference/endpoints") return json(200, { baseUrl: `${base}/v1`, endpoints: [{ id: "endpoint-1", companyId: "company-1", slug: "ditto-dev", name: "Ditto Dev", model: ids[0], status: "active", access: {iamEnforced:true,createSession:true,createKey:false,maxSessionSeconds:43200} }] });
      if (req.url.endsWith("/keys")) { assert.equal(JSON.parse(body).expiresIn,"12h"); return json(201, { id: "key-1", key, keyHint: "only" }); }
      if (req.url.startsWith("/v1/models")) return json(200, { models: descriptors });
      if (req.url.startsWith("/v1/responses") && req.method === "POST") {
        assert.equal(req.headers.authorization, `Bearer ${key}`);
        selected.push(JSON.parse(body).model);
        const message = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "gateway-ok", annotations: [] }] };
        const response = { id: "resp_1", object: "response", created_at: 1, status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n`);
        res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: message })}\n\n`);
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
        return;
      }
      json(404, { error: "fixture route not found" });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home,".config"), CODEX_HOME: home, DITTO_CONFIG_DIR: configDir, DITTO_API_BASE: base, DITTO_API_KEY: "local-management-key", NO_COLOR: "1" };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  try {
    const setup = await run(process.execPath, [cliPath, "codex-app", "--endpoint", "ditto-dev"], env, home);
    assert.equal(setup.status, 0, setup.stderr);
    assert.ok(!setup.stderr.includes(key));
    for (const model of ids) {
      const result = await run(binary, ["--no-daemon", "exec", "--skip-git-repo-check", "--ephemeral", "--json", "-m", model, "Reply with exactly gateway-ok"], env, home);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /gateway-ok/);
    }
    assert.deepEqual(selected, ids, "the exact selected IDs reach the gateway with the installed endpoint key");
  } finally { server.closeAllConnections(); server.close(); }
});
