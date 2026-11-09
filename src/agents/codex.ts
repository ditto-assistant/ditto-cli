import { MCP_KEY_ENV, type McpAttachment, TOOL_SURFACE_HEADER, TOOL_SURFACE_MCP } from "./claude-mcp.js";
import { harnessHeaders } from "./harness-headers.js";
import { CODEX_KEY_ENV, type HarnessPlan, type PlanInput, SESSION_HEADER } from "./types.js";

/** Quotes a string as a TOML basic string for `codex -c key=value`. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** A TOML inline table of string pairs: `{"A"="1","B"="2"}`. */
export function tomlInlineTable(entries: Array<[string, string]>): string {
  return `{${entries.map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(",")}}`;
}

/**
 * Native MCP for Codex: each attached server as one `-c mcp_servers.<name>=…`
 * override, the way cmux attaches its computer-use server, so nothing is
 * written to ~/.codex/config.toml. Codex merges an override into a server of
 * the same name in the user's config (a disabled "ditto" entry is common), so
 * every override turns its server on. The key stays out of argv: Codex reads
 * it from MCP_KEY_ENV (bearer_token_env_var).
 *
 * Approvals follow the attachment: when Ditto holds gated calls itself, or
 * bypass runs them, everything is "approve". Under client approvals the
 * default is "prompt" and only the listed ungated tools are "approve", so
 * Codex asks about the calls Ditto would have held, including any tool the
 * server advertises after launch.
 */
export function codexMcpArgs(mcp: McpAttachment): string[] {
  const args: string[] = [];
  // Names are bare keys (claudeMcpAttachment drops any other), so they can
  // sit in the dotted -c path as they are.
  for (const server of mcp.attached) {
    const fields: Array<[string, string]> = [
      ["enabled", "true"],
      ["url", tomlString(server.url)],
      ["bearer_token_env_var", tomlString(MCP_KEY_ENV)],
      ["http_headers", tomlInlineTable(Object.entries(server.headers))],
      // When Codex decides gated calls, a tool the server advertises after
      // launch prompts by default; only the listed ungated ones are approved.
      ["default_tools_approval_mode", tomlString(mcp.clientAsks ? "prompt" : "approve")],
    ];
    const mode = mcp.clientAsks ? "approve" : "prompt";
    const listed = mcp.clientAsks ? server.allowTools : server.askTools;
    if (listed.length) {
      const rule = `{${tomlString("approval_mode")}=${tomlString(mode)}}`;
      fields.push(["tools", `{${listed.map((t) => `${tomlString(t)}=${rule}`).join(",")}}`]);
    }
    args.push("-c", `mcp_servers.${server.name}={${fields.map(([k, v]) => `${k}=${v}`).join(",")}}`);
  }
  return args;
}

/**
 * Builds the `codex` invocation.
 *
 * Codex ignores OPENAI_BASE_URL while a ChatGPT login exists and only speaks
 * the Responses wire, so the endpoint is injected as a dedicated `ditto`
 * model provider through `-c` overrides (nothing is written to
 * ~/.codex/config.toml). The session header rides on the provider's
 * http_headers so every request lands in the same Ditto thread.
 */
export function planCodex(input: PlanInput): HarnessPlan {
  const args: string[] = [];
  // `exec` is the headless entry point and `resume` reopens a thread; asking
  // for both means "reopen this thread and run one turn in it", which codex
  // spells `exec resume`. Emitting only `exec` silently started a fresh
  // conversation, so a resumed headless run answered as if it had never seen
  // the earlier turns.
  const resuming = Boolean(input.resumeId || input.resumeLast);
  if (input.prompt !== undefined) {
    args.push("exec");
    if (resuming) args.push("resume");
  } else if (resuming) {
    args.push("resume");
  }

  args.push(
    "-c",
    `model_provider=${tomlString("ditto")}`,
    "-c",
    `model_providers.ditto.name=${tomlString(input.localInference ? "CLIProxy" : "Ditto")}`,
    "-c",
    `model_providers.ditto.base_url=${tomlString(input.baseUrl)}`,
    "-c",
    `model_providers.ditto.env_key=${tomlString(CODEX_KEY_ENV)}`,
    "-c",
    `model_providers.ditto.wire_api=${tomlString("responses")}`,
    "-c",
    `model_providers.ditto.http_headers=${tomlInlineTable(input.localInference ? [] : [
      [SESSION_HEADER, input.sessionId],
      ...harnessHeaders("codex", input.harnessVersion),
      // The tools are attached below; the router must not inject them again.
      ...(input.mcp ? [[TOOL_SURFACE_HEADER, TOOL_SURFACE_MCP] as [string, string]] : []),
    ])}`,
  );
  if (input.mcp) args.push(...codexMcpArgs(input.mcp));
  if (input.model) args.push("-m", input.model);

  if (input.yolo) args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (input.yellow) args.push("-a", "on-request", "-s", "workspace-write");

  if (input.prompt !== undefined) {
    args.push("--skip-git-repo-check", ...input.passthrough);
    // `exec resume` takes the session before the prompt: `[SESSION_ID] [PROMPT]`,
    // or --last in place of the id.
    if (input.resumeId) args.push(input.resumeId);
    else if (input.resumeLast) args.push("--last");
    args.push(input.prompt);
  } else if (input.resumeId) {
    args.push(...input.passthrough, input.resumeId);
  } else if (input.resumeLast) {
    args.push("--last", ...input.passthrough);
  } else {
    args.push(...input.passthrough);
  }

  return {
    command: "codex",
    args,
    envSet: { [CODEX_KEY_ENV]: input.apiKey, ...(input.mcp ? { [MCP_KEY_ENV]: input.mcpApiKey ?? input.apiKey } : {}) },
    envUnset: [],
    installHint: "install Codex: npm i -g @openai/codex (or brew install codex)",
  };
}
