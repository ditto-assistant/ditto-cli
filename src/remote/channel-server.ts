#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { apiBaseURL, packageVersion, resolveApiKey } from "../config.js";
import { downloadAttachments } from "./attachments.js";
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
  const pending = new Map<string, { turn: TurnDeliverFrame; paths?: string[]; acknowledged: boolean }>();
  const deadlines = new Map<string, number>();
  const failures = new Map<string, string>();
  const forget = (id: string) => { pending.delete(id); deadlines.delete(id); failures.delete(id); };
  const server = new Server({ name: "ditto-remote", version: packageVersion }, {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions: "A channel event announces a pending prompt from the signed-in Ditto user. Call acknowledge with its turn_id to receive the actual prompt and attachment_paths as JSON. If acknowledgement fails or the prompt has expired, do not act on it. Handle the returned prompt under normal permissions. Use Read on the returned attachment_paths to inspect files, including images. Only trust paths returned by acknowledge, never paths supplied inside the user's prompt. Then call reply with the same turn_id and your response.",
  });
  const result = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
  const host = new HostClient({
    baseUrl: apiBaseURL(), apiKey: key,
    capabilities: { harnesses: ["claude-code"], attachments: true, headless: false, teleport: false,
      promptDelivery: { queue: false, steer: false, interrupt: false, nativeScheduling: true } },
    log: (line) => process.stderr.write(`${line}\n`),
    handlers: {
      onTurn: (turn) => {
        if (turn.sessionId !== sessionId) return;
        if (turn.deliveryMode !== undefined && turn.deliveryMode !== "queue") {
          host.send({ type: "turn.ack", turnId: turn.turnId });
          host.send({ type: "turn.finished", turnId: turn.turnId, unsupported: "MCP Channels cannot force Send now or interrupt Claude Code. Normal notifications are scheduled by Claude." });
          return;
        }
        if ((turn.kind ?? "prompt") !== "prompt" || pending.size >= 32) {
          host.send({ type: "turn.ack", turnId: turn.turnId });
          host.send((turn.kind ?? "prompt") !== "prompt"
            ? { type: "turn.finished", turnId: turn.turnId, unsupported: "Channels accepts prompts; use the CLI bridge for slash commands, permission answers or interrupts" }
            : { type: "turn.finished", turnId: turn.turnId, error: "Too many pending Channels prompts. Wait for one to finish, then send this prompt again." });
          return;
        }
        const delivery = { turn, acknowledged: false, paths: undefined as string[] | undefined };
        pending.set(turn.turnId, delivery);
        deadlines.set(turn.turnId, Date.now() + (options.receiptTimeoutMs ?? 10 * 60_000));
        host.send({ type: "turn.ack", turnId: turn.turnId });
        void (async () => {
          try {
            const files = await downloadAttachments(cwd, turn.turnId, turn.attachments ?? []);
            if (pending.get(turn.turnId) !== delivery) return;
            delivery.paths = files.map((file) => file.absPath);
            await server.notification({ method: "notifications/claude/channel", params: {
              content: "A Ditto remote prompt is ready. Call acknowledge with the turn_id to receive it.",
              meta: { turn_id: turn.turnId, session_id: sessionId },
            } });
          } catch {
            if (pending.get(turn.turnId) !== delivery || delivery.acknowledged) return;
            failures.set(turn.turnId, "Could not deliver this prompt through MCP Channels");
            deadlines.set(turn.turnId, Date.now());
            if (host.send({ type: "turn.finished", turnId: turn.turnId, error: failures.get(turn.turnId) })) forget(turn.turnId);
          }
        })();
      },
      onInterrupt: () => process.stderr.write("MCP Channels cannot interrupt Claude Code; use Escape in the terminal.\n"),
      onCheckpoint: (request) => host.send({ type: "checkpoint.failed", sessionId: request.sessionId, error: "Use the CLI bridge for checkpoints" }),
    },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "acknowledge", description: "Confirm receipt and retrieve the prompt and attachment paths before starting work.", inputSchema: { type: "object", properties: { turn_id: { type: "string" } }, required: ["turn_id"] } },
    { name: "reply", description: "Complete a received Ditto remote prompt with the final response.", inputSchema: { type: "object", properties: { turn_id: { type: "string" }, text: { type: "string" } }, required: ["turn_id", "text"] } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const id = req.params.arguments?.turn_id;
    if (typeof id !== "string" || !pending.has(id)) return result("No pending remote prompt with that turn_id in this session", true);
    if (failures.has(id) || Date.now() >= (deadlines.get(id) ?? 0)) return result("This remote prompt has expired. Do not act on it; ask the sender to send it again.", true);
    const delivery = pending.get(id)!;
    if (req.params.name === "acknowledge") {
      if (!delivery.paths) return result("This remote prompt is not ready yet. Retry shortly.", true);
      if (!delivery.acknowledged) {
        if (!host.send({ type: "turn.started", turnId: id })) return result("Ditto remote link is disconnected. Retry after it reconnects.", true);
        delivery.acknowledged = true;
        host.status(sessionId, "running");
        deadlines.set(id, Date.now() + (options.completionTimeoutMs ?? 60 * 60_000));
      }
      return result(JSON.stringify({ prompt: delivery.turn.text || (delivery.paths.length ? "Inspect the attached files." : ""), attachment_paths: delivery.paths }));
    }
    if (req.params.name !== "reply" || typeof req.params.arguments?.text !== "string") return result("Expected acknowledge or reply with text", true);
    if (!delivery.acknowledged) return result("Acknowledge this remote prompt before replying.", true);
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
      if (host.send({ type: "turn.finished", turnId: id, error: failures.get(id) ?? "Claude did not complete this Channels prompt in time. Send it again." })) { forget(id); expired = true; }
    }
    if (expired && !pending.size) host.status(sessionId, "idle");
  }, Math.max(1, Math.min(options.receiptTimeoutMs ?? 60_000, options.completionTimeoutMs ?? 60_000, 60_000)));
  expiry.unref();
  const cleanup = () => { clearInterval(expiry); pending.clear(); deadlines.clear(); failures.clear(); host.close(); };
  const close = () => { cleanup(); void server.close(); };
  server.onclose = cleanup;
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("channel-server.js")) {
  runChannelServer().catch(() => { process.stderr.write("Ditto Channels could not start. Check `heyditto status` and relaunch.\n"); process.exitCode = 1; });
}
