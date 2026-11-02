import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ApiError, apiFetch } from "../dist/api.js";

async function failWith(status, body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { base: process.env.DITTO_API_BASE, key: process.env.DITTO_API_KEY };
  process.env.DITTO_API_BASE = `http://127.0.0.1:${server.address().port}`;
  process.env.DITTO_API_KEY = "ditto_mcp_test";
  try {
    await apiFetch("/api/v5/inference/endpoints");
    assert.fail("expected an ApiError");
  } catch (err) {
    assert.ok(err instanceof ApiError);
    return err.message;
  } finally {
    for (const [name, value] of [["DITTO_API_BASE", env.base], ["DITTO_API_KEY", env.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((r) => server.close(r));
  }
}

test("a coded 403 shows the server's message without the generic hint", async () => {
  const message = await failWith(403, {
    code: "api_key_limited",
    action: "update_settings",
    message: "This key cannot manage the CLI. Run `heyditto login` or unset DITTO_API_KEY.",
  });
  assert.match(message, /HTTP 403 - This key cannot manage the CLI\. Run `heyditto login` or unset DITTO_API_KEY\.$/);
  assert.doesNotMatch(message, /not allowed to perform this action/);
});

test("an unexplained 403 keeps the generic hint", async () => {
  assert.match(await failWith(403, "forbidden"), /HTTP 403 - forbidden \(your account or key is not allowed to perform this action\)$/);
  assert.match(await failWith(403, { message: "nope" }), /not allowed to perform this action/);
});
