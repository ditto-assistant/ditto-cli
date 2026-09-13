import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness } from "../agents/types.js";

/**
 * Turn boundaries come from the harnesses themselves, not from parsing their
 * screens: Claude Code runs its `UserPromptSubmit` and `Stop` hooks, Codex runs
 * its `notify` command when a turn ends. Both are pointed at a tiny script
 * (dist/remote/hook.js) that writes one JSON line to a Unix socket this
 * process listens on. Nothing in the hook can stall the harness: the script
 * exits 0 whatever happens.
 */

export interface HookEvent {
  source: Harness;
  /** Claude: UserPromptSubmit | Stop. Codex: agent-turn-complete (as notify reports it). */
  event: string;
  payload?: Record<string, unknown>;
}

export interface HookServer {
  socketPath: string;
  events: EventEmitter;
  close(): Promise<void>;
}

/** Absolute path of the compiled hook script next to this module. */
export function hookScriptPath(): string {
  return fileURLToPath(new URL("./hook.js", import.meta.url));
}

export async function startHookServer(): Promise<HookServer> {
  const socketPath = path.join(os.tmpdir(), `heyditto-hook-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
  const events = new EventEmitter();
  const server = net.createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) emitLine(events, line);
        nl = buf.indexOf("\n");
      }
    });
    conn.on("end", () => {
      const line = buf.trim();
      buf = "";
      if (line) emitLine(events, line);
    });
    conn.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  server.unref();
  return {
    socketPath,
    events,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true }).catch(() => undefined);
    },
  };
}

function emitLine(events: EventEmitter, line: string): void {
  try {
    const parsed = JSON.parse(line) as HookEvent;
    if (parsed && typeof parsed.event === "string") events.emit("hook", parsed);
  } catch {
    /* ignore malformed hook lines */
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `--settings <json>` value that makes Claude Code report turn boundaries to `socketPath`. */
export function claudeHookSettings(socketPath: string, script = hookScriptPath(), node = process.execPath): string {
  const command = (event: string) => `${shellQuote(node)} ${shellQuote(script)} ${shellQuote(socketPath)} claude ${event}`;
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: command("UserPromptSubmit"), timeout: 5 }] }],
      Stop: [{ hooks: [{ type: "command", command: command("Stop"), timeout: 5 }] }],
      // Permission dialogs arrive as notification_type "permission_prompt".
      Notification: [{ hooks: [{ type: "command", command: command("Notification"), timeout: 5 }] }],
      // AskUserQuestion carries its question and options in tool_input.
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: command("PreToolUse"), timeout: 5 }] }],
    },
  };
  return JSON.stringify(settings);
}

/** The `-c notify=[...]` override that makes Codex report `agent-turn-complete` to `socketPath`. */
export function codexNotifyOverride(socketPath: string, script = hookScriptPath(), node = process.execPath): string {
  const toml = (s: string) => JSON.stringify(s);
  return `notify=[${[node, script, socketPath, "codex"].map(toml).join(",")}]`;
}

/** Inserts flags where each harness accepts them: after Codex's leading subcommand words (before its positional prompt), anywhere for Claude. */
export function withHookArgs(harness: Harness, args: string[], extra: string[]): string[] {
  if (extra.length === 0) return args;
  if (harness === "claude") return [...args, ...extra];
  let i = 0;
  while (i < args.length && (args[i] === "exec" || args[i] === "resume")) i += 1;
  return [...args.slice(0, i), ...extra, ...args.slice(i)];
}
