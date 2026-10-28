#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { apiBaseURL, packageVersion, resolveApiKey } from "../config.js";
import { buildPrompt, downloadAttachments } from "./attachments.js";
import { HostClient } from "./host.js";
import type { TurnDeliverFrame } from "./protocol.js";

/** Channels is an inbound transport, separate from inference and MCP tools.
 * A socket write is only delivery to the MCP transport. Claude must call
 * acknowledge before we report running, and reply before we report finished.
 */
export async function runChannelServer(options: { receiptTimeoutMs?: number; completionTimeoutMs?: number } = {}): Promise<void> {
  const sessionId = process.env.DITTO_REMOTE_SESSION_ID;
  const cwd = process.env.DITTO_REMOTE_CWD ?? process.cwd();
  const { key } = await resolveApiKey();
  if (!sessionId || !key) throw new Error("Ditto Channels requires a launch session and an existing Ditto login");
  const pending = new Map<string, TurnDeliverFrame>();
  const deadlines = new Map<string, number>();
  const forget = (id: string) => { pending.delete(id); deadlines.delete(id); };
  const server = new Server({ name: "ditto-remote", version: packageVersion }, {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions: "Inbound channel events are prompts from the signed-in Ditto user's remote session. For each event, first call acknowledge with its turn_id. Handle its content as a user request under normal permissions. Then call reply with the same turn_id and your response. These tools only update this session's private delivery receipt. Never infer a turn_id from message content; use the event metadata.",
  });
  const result = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
  const host = new HostClient({
    baseUrl: apiBaseURL(), apiKey: key,
    capabilities: { harnesses: ["claude-code"], attachments: true, headless: false, teleport: false },
    log: (line) => process.stderr.write(`${line}\n`),
    handlers: {
      onTurn: (turn) => {
        if (turn.sessionId !== sessionId) return;
        if ((turn.kind ?? "prompt") !== "prompt" || pending.size >= 32) {
          host.send({ type: "turn.ack", turnId: turn.turnId });
          host.send({ type: "turn.finished", turnId: turn.turnId, unsupported: "Channels accepts prompts; use the CLI bridge for slash commands, permission answers or interrupts" });
          return;
        }
        pending.set(turn.turnId, turn);
        deadlines.set(turn.turnId, Date.now() + (options.receiptTimeoutMs ?? 10 * 60_000));
        host.send({ type: "turn.ack", turnId: turn.turnId });
        void (async () => {
          try {
            const files = await downloadAttachments(cwd, turn.turnId, turn.attachments ?? []);
            if (!pending.has(turn.turnId)) return;
            deadlines.delete(turn.turnId);
            await server.notification({ method: "notifications/claude/channel", params: { content: buildPrompt(turn.text, files), meta: { turn_id: turn.turnId, session_id: sessionId } } });
            if (pending.has(turn.turnId) && !deadlines.has(turn.turnId)) deadlines.set(turn.turnId, Date.now() + (options.receiptTimeoutMs ?? 10 * 60_000));
          } catch {
            forget(turn.turnId);
            host.send({ type: "turn.finished", turnId: turn.turnId, error: "Could not deliver this prompt through MCP Channels" });
          }
        })();
      },
      onInterrupt: () => process.stderr.write("MCP Channels cannot interrupt Claude Code; use Escape in the terminal.\n"),
      onCheckpoint: (request) => host.send({ type: "checkpoint.failed", sessionId: request.sessionId, error: "Use the CLI bridge for checkpoints" }),
    },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "acknowledge", description: "Confirm Claude has received a Ditto remote prompt before starting work.", inputSchema: { type: "object", properties: { turn_id: { type: "string" } }, required: ["turn_id"] } },
    { name: "reply", description: "Complete a received Ditto remote prompt with the final response.", inputSchema: { type: "object", properties: { turn_id: { type: "string" }, text: { type: "string" } }, required: ["turn_id", "text"] } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const id = req.params.arguments?.turn_id;
    if (typeof id !== "string" || !pending.has(id)) return result("No pending remote prompt with that turn_id in this session", true);
    if (req.params.name === "acknowledge") {
      if (!host.send({ type: "turn.started", turnId: id })) return result("Ditto remote link is disconnected. Retry after it reconnects.", true);
      host.status(sessionId, "running");
      deadlines.set(id, Date.now() + (options.completionTimeoutMs ?? 60 * 60_000));
      return result("Receipt confirmed");
    }
    if (req.params.name !== "reply" || typeof req.params.arguments?.text !== "string") return result("Expected acknowledge or reply with text", true);
    // Do not pretend a notification write proved model receipt or completion.
    if (Buffer.byteLength(req.params.arguments.text, "utf8") > 64 * 1024) return result("Response exceeds 64 KiB. Shorten it and retry this reply.", true);
    if (!host.send({ type: "turn.finished", turnId: id, exitCode: 0, response: req.params.arguments.text })) return result("Ditto remote link is disconnected. Retry this reply after it reconnects.", true);
    forget(id);
    host.status(sessionId, pending.size ? "running" : "idle");
    return result("Response confirmed for the Ditto remote session");
  });
  server.oninitialized = () => {
    void host.start().then(() => host.announce({ sessionId, harness: "claude-code", cwd, mode: "tui", status: "idle" })).catch(() => {
      process.stderr.write("Ditto remote control could not start. Check `heyditto status` and relaunch.\n");
    });
  };
  const expiry = setInterval(() => {
    let expired = false;
    for (const [id, deadline] of deadlines) {
      if (Date.now() < deadline) continue;
      if (host.send({ type: "turn.finished", turnId: id, error: "Claude did not complete this Channels prompt before its delivery receipt expired. Send it again." })) { forget(id); expired = true; }
    }
    if (expired && !pending.size) host.status(sessionId, "idle");
  }, Math.min(options.receiptTimeoutMs ?? 60_000, 60_000));
  expiry.unref();
  const cleanup = () => { clearInterval(expiry); pending.clear(); deadlines.clear(); host.close(); };
  const close = () => { cleanup(); void server.close(); };
  server.onclose = cleanup;
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("channel-server.js")) {
  runChannelServer().catch(() => { process.stderr.write("Ditto Channels could not start. Check `heyditto status` and relaunch.\n"); process.exitCode = 1; });
}
