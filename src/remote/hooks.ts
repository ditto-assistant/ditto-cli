import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withClaudeSettings } from "../agents/claude-mcp.js";
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

/** Homebrew resolves process.execPath to a versioned Cellar path, removed on
 * upgrade. Prefer its stable opt link only when it resolves to this exact Node.
 * Other installations keep their original executable rather than selecting an
 * unrelated executable from the shell's PATH.
 */
export function hookNodeExecutable(executable = process.execPath): string {
  const match = executable.match(/^(.*)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/);
  if (!match) return executable;
  const stable = path.join(match[1], "opt", match[2], "bin", "node");
  try { if (realpathSync(stable) === realpathSync(executable)) return stable; }
  catch { /* Keep the known working executable when no matching stable link exists. */ }
  return executable;
}

/** The `--settings <json>` value that makes Claude Code report turn boundaries to `socketPath`. */
export function claudeHookSettings(socketPath: string, script = hookScriptPath(), node = hookNodeExecutable()): string {
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
export function codexNotifyOverride(socketPath: string, script = hookScriptPath(), node = hookNodeExecutable()): string {
  const toml = (s: string) => JSON.stringify(s);
  return `notify=[${[node, script, socketPath, "codex"].map(toml).join(",")}]`;
}

/** Inserts flags where each harness accepts them: after Codex's leading subcommand words (before its positional prompt), anywhere for Claude. */
export function withHookArgs(harness: Harness, args: string[], extra: string[]): string[] {
  if (extra.length === 0) return args;
  if (harness === "claude") {
    // A `--settings` JSON already in the argv (native MCP permissions)
    // absorbs the hooks: Claude Code honours one --settings, not two.
    const i = extra.findIndex((a) => a === "--settings" || a.startsWith("--settings="));
    // Merge into a --settings that is inline JSON or an absolute file (native
    // MCP's private copy). A relative user file without MCP keeps the old
    // append: the hooks do not know Claude's launch directory to read it.
    const mergeable = (v: string | undefined) => v !== undefined && (v.trim().startsWith("{") || path.isAbsolute(v));
    const hasInline = args.some((a, j) => (a === "--settings" && mergeable(args[j + 1])) || (a.startsWith("--settings=") && mergeable(a.slice("--settings=".length))));
    const inlineExtra = i >= 0 && extra[i].startsWith("--settings=");
    const extraValue = i < 0 ? undefined : inlineExtra ? extra[i].slice("--settings=".length) : extra[i + 1];
    if (hasInline && extraValue?.trim().startsWith("{")) {
      const rest = [...extra.slice(0, i), ...extra.slice(i + (inlineExtra ? 1 : 2))];
      return [...withClaudeSettings(args, JSON.parse(extraValue) as Record<string, unknown>), ...rest];
    }
    return [...args, ...extra];
  }
  let i = 0;
  while (i < args.length && (args[i] === "exec" || args[i] === "resume")) i += 1;
  return [...args.slice(0, i), ...extra, ...args.slice(i)];
}
