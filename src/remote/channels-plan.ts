import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writePrivateSettings } from "../agents/claude-mcp.js";
import type { HarnessPlan } from "../agents/types.js";

/** A launch-scoped stdio server. Authentication stays in inherited config,
 * never argv, and the client must explicitly opt this custom channel in. */
export function withChannelServer(plan: HarnessPlan, sessionId: string, cwd: string): HarnessPlan {
  const args: string[] = [];
  const config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
  let fromFile = false;
  const merge = (value: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(value); }
    catch {
      fromFile = true;
      try { parsed = JSON.parse(readFileSync(path.resolve(cwd, value), "utf8")); }
      catch { throw new Error("--mcp-config must contain valid JSON or name a readable JSON file"); }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("--mcp-config must be a JSON object");
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers != null && (typeof servers !== "object" || Array.isArray(servers))) throw new Error("--mcp-config mcpServers must be an object");
    Object.assign(config.mcpServers, servers ?? {});
  };
  for (let i = 0; i < plan.args.length; i++) {
    const arg = plan.args[i];
    if (arg.startsWith("--mcp-config=")) { merge(arg.slice("--mcp-config=".length)); continue; }
    if (arg !== "--mcp-config") { args.push(arg); continue; }
    let count = 0;
    while (i + 1 < plan.args.length && !plan.args[i + 1].startsWith("-")) { merge(plan.args[++i]); count++; }
    if (!count) throw new Error("--mcp-config requires a value");
  }
  if (Object.prototype.hasOwnProperty.call(config.mcpServers, "ditto-remote")) throw new Error("--mcp-config already defines a server named ditto-remote");
  config.mcpServers["ditto-remote"] = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./channel-server.js", import.meta.url))],
    env: { DITTO_REMOTE_SESSION_ID: sessionId, DITTO_REMOTE_CWD: cwd },
  };
  args.push("--mcp-config", fromFile ? writePrivateSettings(JSON.stringify(config)) : JSON.stringify(config));
  args.push("--dangerously-load-development-channels", "server:ditto-remote");
  return { ...plan, args };
}
