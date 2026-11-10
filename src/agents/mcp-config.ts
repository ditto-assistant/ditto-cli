import type { Command } from "commander";
import { createKey, findEndpoint, listEndpoints, revokeKey, type InferenceEndpoint } from "../api.js";
import { explicitProfileEndpoint, readDefaultEndpoint } from "../profiles.js";
import { findProfileEndpoint, repoDefaultProfile } from "../dittoconfig/profiles.js";
import { SESSION_ID_PATTERN } from "../mcp-session.js";
import { claudeMcpAttachment, fetchMcpCatalog, mcpUnavailableLines, type McpCatalog } from "./claude-mcp.js";

/** SDKs need concrete headers, unlike CLI configs that expand environment variables. */
export function sdkMcpConfig(catalog: McpCatalog, sessionId: string, apiKey: string) {
  const attachment = claudeMcpAttachment(catalog, sessionId);
  if (attachment.skipped.length) throw new Error("MCP catalog contains unsupported server names");
  return { mcpServers: Object.fromEntries(attachment.attached.map(server => [server.name, {
    type: "http" as const,
    url: server.url,
    headers: { Authorization: `Bearer ${apiKey}`, ...server.headers },
  }])) };
}

export async function exportMcpConfig(options: { endpoint?: string; session?: string }): Promise<void> {
  const sessionId = options.session ?? process.env.T3CODE_THREAD_ID;
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) throw new Error("mcp-config needs --session or T3CODE_THREAD_ID");
  const { endpoints, baseUrl } = await listEndpoints();
  const explicit = options.endpoint?.trim() || (await explicitProfileEndpoint())?.endpoint;
  let endpoint: InferenceEndpoint | undefined;
  if (explicit) endpoint = findEndpoint(endpoints, explicit);
  else {
    const profile = await repoDefaultProfile(process.cwd());
    if (profile) {
      endpoint = await findProfileEndpoint(profile, endpoints);
      if (!endpoint) throw new Error("Repository .ditto profile has no applied endpoint; run heyditto repo apply");
    } else {
      const saved = await readDefaultEndpoint();
      endpoint = saved ? findEndpoint(endpoints, saved) : endpoints.length === 1 ? endpoints[0] : undefined;
    }
  }
  if (!endpoint) throw new Error("No unambiguous MCP endpoint; select one with --endpoint or heyditto endpoints use");
  const key = await createKey(endpoint.id, { name: `sdk-mcp:${sessionId}`, expiresIn: "1h" });
  if (!key.key) throw new Error("MCP key response did not contain a key");
  try {
    const catalog = await fetchMcpCatalog(baseUrl, key.key, sessionId);
    for (const line of mcpUnavailableLines(catalog)) process.stderr.write(`${line}\n`);
    process.stdout.write(`${JSON.stringify(sdkMcpConfig(catalog, sessionId, key.key))}\n`);
  } catch (error) {
    await revokeKey(endpoint.id, key.id).catch(() => {});
    throw error;
  }
}

export function registerMcpConfigCommand(program: Command): void {
  program.command("mcp-config")
    .description("emit credential-bearing SDK MCP JSON to a trusted parent process (keys expire in one hour)")
    .option("--endpoint <endpoint>", "override repository .ditto and personal defaults")
    .option("--session <id>", "session id (default: T3CODE_THREAD_ID)")
    .action(exportMcpConfig);
}
