import { type Command, Option } from "commander";
import { createKey, revokeKey } from "../api.js";
import { SESSION_ID_PATTERN } from "../mcp-session.js";
import { resolveMcpEndpoint } from "../tools-commands.js";
import { claudeMcpAttachment, fetchMcpCatalog, mcpUnavailableLines, type McpCatalog } from "./claude-mcp.js";

export type McpConfigFormat = "sdk" | "antigravity";

/** SDKs need concrete headers, unlike CLI configs that expand environment variables. */
export function sdkMcpConfig(catalog: McpCatalog, sessionId: string, apiKey: string, format: McpConfigFormat = "sdk") {
  const attachment = claudeMcpAttachment(catalog, sessionId);
  if (attachment.skipped.length) throw new Error("MCP catalog contains unsupported server names");
  return { mcpServers: Object.fromEntries(attachment.attached.map(server => [server.name, format === "antigravity" ? {
    disabled: false,
    serverUrl: server.url,
    headers: { Authorization: `Bearer ${apiKey}`, ...server.headers },
  } : {
    type: "http" as const,
    url: server.url,
    headers: { Authorization: `Bearer ${apiKey}`, ...server.headers },
  }])) };
}

export async function exportMcpConfig(options: { endpoint?: string; session?: string; format?: string }): Promise<void> {
  const format = (options.format ?? "sdk") as McpConfigFormat;
  if (format !== "sdk" && format !== "antigravity") throw new Error("--format must be sdk or antigravity");
  const sessionId = options.session ?? process.env.T3CODE_THREAD_ID;
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) throw new Error("mcp-config needs --session or T3CODE_THREAD_ID");
  const { endpoint, baseUrl } = await resolveMcpEndpoint({ endpoint: options.endpoint });
  const key = await createKey(endpoint.id, { name: `sdk-mcp:${sessionId}`, expiresIn: "1h" });
  if (!key.key) throw new Error("MCP key response did not contain a key");
  try {
    const catalog = await fetchMcpCatalog(baseUrl, key.key, sessionId);
    for (const line of mcpUnavailableLines(catalog)) process.stderr.write(`${line}\n`);
    process.stdout.write(`${JSON.stringify(sdkMcpConfig(catalog, sessionId, key.key, format))}\n`);
  } catch (error) {
    await revokeKey(endpoint.id, key.id).catch(() => {
      process.stderr.write(`warning: could not revoke MCP key ${key.id}; it may remain valid until its one-hour expiry\n`);
    });
    throw error;
  }
}

export function registerMcpConfigCommand(program: Command): void {
  program.command("mcp-config")
    .description("emit credential-bearing SDK MCP JSON to a trusted parent process (keys expire in one hour)")
    .option("--endpoint <endpoint>", "override repository .ditto and personal defaults")
    .option("--session <id>", "session id (default: T3CODE_THREAD_ID)")
    .addOption(new Option("--format <format>", "output schema (sdk: {type,url}; antigravity: {disabled,serverUrl})").choices(["sdk", "antigravity"]).default("sdk"))
    .action(exportMcpConfig);
}
