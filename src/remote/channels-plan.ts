import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writePrivateSettings } from "../agents/claude-mcp.js";
import type { HarnessPlan } from "../agents/types.js";

/** A launch-scoped stdio server. Authentication stays in inherited config,
 * never argv, and the client must explicitly opt this custom channel in. */
export function withChannelServer(plan: HarnessPlan, sessionId: string, cwd: string): HarnessPlan {
  const args = [...plan.args];
  const i = args.indexOf("--mcp-config");
  const value = i >= 0 ? args[i + 1] : undefined;
  const fromFile = value !== undefined && !value.trimStart().startsWith("{");
  const config = value ? JSON.parse(fromFile ? readFileSync(path.resolve(cwd, value), "utf8") : value) : { mcpServers: {} };
  config.mcpServers ??= {};
  config.mcpServers["ditto-remote"] = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./channel-server.js", import.meta.url))],
    env: { DITTO_REMOTE_SESSION_ID: sessionId, DITTO_REMOTE_CWD: cwd },
  };
  if (i >= 0) args[i + 1] = fromFile ? writePrivateSettings(JSON.stringify(config)) : JSON.stringify(config);
  else args.push("--mcp-config", JSON.stringify(config));
  args.push("--dangerously-load-development-channels", "server:ditto-remote");
  return { ...plan, args };
}
