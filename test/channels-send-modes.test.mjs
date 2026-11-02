import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { startHostStub } from "./helpers/host-stub.mjs";

test("Channels advertises native scheduling and refuses steering without emitting a notification", { timeout: 8000 }, async () => {
  const stub = await startHostStub();
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ditto-channel-modes-"));
  const script = `import {runChannelServer} from ${JSON.stringify(new URL("../dist/remote/channel-server.js", import.meta.url).href)}; await runChannelServer();`;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--input-type=module", "-e", script], env: { ...process.env, DITTO_API_BASE: stub.base, DITTO_API_KEY: "ditto_mcp_test", DITTO_CONFIG_DIR: cwd, DITTO_REMOTE_SESSION_ID: "channel-session", DITTO_REMOTE_CWD: cwd }, stderr: "pipe" });
  const client = new Client({ name: "owned-mode-fixture", version: "test" });
  const events = [];
  client.setNotificationHandler(z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }), (event) => events.push(event));
  try {
    await client.connect(transport);
    await stub.waitFor((f) => f.type === "session.announce");
    assert.deepEqual(stub.frames.find((f) => f.type === "hello").capabilities.promptDelivery, { queue: false, steer: false, interrupt: false, nativeScheduling: true });
    for (const [turnId, extra] of [["steer", { deliveryMode: "steer" }], ["unknown", { deliveryMode: "invented" }], ["command", { kind: "command", deliveryMode: "queue" }]]) {
      stub.send({ type: "turn.deliver", sessionId: "channel-session", turnId, text: "synthetic input", ...extra });
      const receipt = await stub.waitFor((f) => f.type === "turn.finished" && f.turnId === turnId);
      assert.match(receipt.unsupported, turnId === "command" ? /Channels accepts prompts.*CLI bridge/ : /cannot force Send now/);
    }
    assert.equal(events.length, 0, "refused modes must not become ordinary notifications");
    stub.send({ type: "turn.deliver", sessionId: "channel-session", turnId: "normal", text: "normal native scheduling", deliveryMode: "queue" });
    const deadline = Date.now() + 2000;
    while (!events.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(events.length, 1);
    assert.equal(events[0].params.content, "normal native scheduling");
    assert.equal(stub.frames.some((f) => f.type === "turn.started"), false, "transport write is not native scheduling evidence");
  } finally { await client.close(); await stub.close(); await rm(cwd, { recursive: true, force: true }); }
});
