#!/usr/bin/env node
/**
 * Hook relay run by the coding harness: `hook.js <socket> <source> [event] [json]`.
 *
 * Claude Code hooks pass their payload on stdin (with `hook_event_name`);
 * Codex's `notify` passes a JSON payload as the last argument. Either way one
 * JSON line goes to the Unix socket the CLI host opened, and the process exits
 * 0 no matter what, so a missing socket can never block the harness.
 */
import net from "node:net";

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function parse(json: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(json) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const [socketPath, source, ...rest] = process.argv.slice(2);
  if (!socketPath || !source) return;
  let event = rest[0] ?? "";
  let payload: Record<string, unknown> | undefined;
  if (source === "codex") {
    // codex appends its JSON payload after our fixed arguments.
    payload = parse(rest[rest.length - 1] ?? "");
    event = typeof payload?.type === "string" ? (payload.type as string) : "agent-turn-complete";
  } else {
    payload = parse(await readStdin(1500));
    if (!event && typeof payload?.hook_event_name === "string") event = payload.hook_event_name as string;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1500);
    const conn = net.createConnection(socketPath, () => {
      conn.end(`${JSON.stringify({ source, event, payload })}\n`, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    conn.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

main().finally(() => process.exit(0));
