import { fileURLToPath } from "node:url";
import type { HarnessPlan } from "../agents/types.js";

/** A launch-scoped stdio server. Authentication stays in inherited config,
 * never argv, and the client must explicitly opt this custom channel in. */
export function withChannelServer(plan: HarnessPlan, sessionId: string, cwd: string): HarnessPlan {
  const args = [...plan.args];
  const i = args.indexOf("--mcp-config");
  const config = i >= 0 ? JSON.parse(args[i + 1]) : { mcpServers: {} };
  config.mcpServers["ditto-remote"] = {
    command: process.execPath,
    args: [fileURLToPath(new URL("./channel-server.js", import.meta.url))],
    env: { DITTO_REMOTE_SESSION_ID: sessionId, DITTO_REMOTE_CWD: cwd },
  };
  if (i >= 0) args[i + 1] = JSON.stringify(config);
  else args.push("--mcp-config", JSON.stringify(config));
  args.push("--dangerously-load-development-channels", "server:ditto-remote");
  return { ...plan, args };
}
