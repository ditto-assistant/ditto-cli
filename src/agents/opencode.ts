import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { MCP_KEY_ENV, type McpAttachment, TOOL_SURFACE_HEADER, TOOL_SURFACE_MCP } from "./claude-mcp.js";
import { harnessHeaders } from "./harness-headers.js";
import { type HarnessPlan, type PlanInput, SESSION_HEADER } from "./types.js";

/** Env var the Ditto provider reads the endpoint key from (`{env:…}`). */
export const OPENCODE_KEY_ENV = "DITTO_INFERENCE_API_KEY";

/** The provider id OpenCode addresses the endpoint by: `ditto/<model>`. */
export const OPENCODE_PROVIDER_ID = "ditto";

/**
 * OpenCode through Ditto.
 *
 * Everything rides `OPENCODE_CONFIG_CONTENT`, which OpenCode merges over the
 * user's own config for one run, the way cmux's coderouter launches it, so
 * nothing is written to disk:
 *
 *  - a `ditto` provider (`@ai-sdk/openai-compatible`) pointed at the
 *    endpoint's `/v1`, keyed by `{env:DITTO_INFERENCE_API_KEY}`, that sends
 *    the session header on every request;
 *  - with native MCP, one remote MCP server per attached source, keyed by
 *    `{env:DITTO_ROUTER_MCP_KEY}`, and `permission` rules for their tools.
 *    OpenCode names a tool `<server>_<tool>` and allows any tool no rule
 *    names. When Ditto holds gated calls (or --yolo runs them) each server is
 *    allowed whole. When OpenCode decides them (client approvals), each
 *    server asks by default (denies, when nobody can answer: an `opencode
 *    run` without --yolo) and only its listed ungated tools are allowed, so a
 *    tool the server advertises after launch is never covered by an allow.
 */
export function opencodeConfig(input: PlanInput): string {
  const model = input.model ?? OPENCODE_PROVIDER_ID;
  const headers: Record<string, string> = {
    [SESSION_HEADER]: input.sessionId,
    ...Object.fromEntries(harnessHeaders("opencode", input.harnessVersion)),
    // The tools are attached below; the router must not inject them again.
    ...(input.mcp ? { [TOOL_SURFACE_HEADER]: TOOL_SURFACE_MCP } : {}),
  };
  const config: Record<string, unknown> = {
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Ditto",
        options: { baseURL: input.baseUrl, apiKey: `{env:${OPENCODE_KEY_ENV}}`, headers },
        models: { [model]: { name: model } },
      },
    },
    model: `${OPENCODE_PROVIDER_ID}/${model}`,
  };
  if (input.mcp) Object.assign(config, opencodeMcp(input.mcp, Boolean(input.unattended || input.prompt !== undefined)));
  return JSON.stringify(config);
}

/** The `mcp` and `permission` sections for an attachment. */
export function opencodeMcp(mcp: McpAttachment, unattended = false): { mcp: Record<string, unknown>; permission: Record<string, string> } {
  const servers: Record<string, unknown> = {};
  // Later keys win in OpenCode's permission matching, so each server-wide
  // rule comes first and the per-tool rules after it.
  const wide: Record<string, string> = {};
  const listed: Record<string, string> = {};
  for (const server of mcp.attached) {
    servers[server.name] = {
      type: "remote",
      url: server.url,
      enabled: true,
      // The key is Ditto's, never something to sign in for.
      oauth: false,
      headers: { Authorization: `Bearer {env:${MCP_KEY_ENV}}`, ...server.headers },
    };
    if (!mcp.clientAsks) {
      wide[`${server.name}_*`] = "allow";
      continue;
    }
    wide[`${server.name}_*`] = unattended ? "deny" : "ask";
    for (const tool of server.allowTools) listed[`${server.name}_${tool}`] = "allow";
  }
  return { mcp: servers, permission: { ...wide, ...listed } };
}

/**
 * The OpenCode session a launch in `cwd` created, from `opencode session
 * list`: the one session in that directory created at or after `since`.
 * Undefined when there is none or more than one (a parallel run in the same
 * directory), so a resume never names someone else's conversation.
 */
export function findOpencodeSession(cwd: string, since: number, run: typeof spawnSync = spawnSync): string | undefined {
  const res = run("opencode", ["session", "list", "--format", "json"], { cwd, encoding: "utf8", timeout: 15_000 });
  if (res.status !== 0 || typeof res.stdout !== "string") return undefined;
  let dir = cwd;
  try {
    dir = realpathSync(cwd);
  } catch {
    // An unreadable directory is compared as given.
  }
  let sessions: unknown;
  try {
    sessions = JSON.parse(res.stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(sessions)) return undefined;
  const mine = sessions.filter((s): s is { id: string } =>
    typeof s?.id === "string" && typeof s?.created === "number" && s.created >= since && (s.directory === dir || s.directory === cwd));
  return mine.length === 1 ? mine[0].id : undefined;
}

/** Builds the `opencode` invocation: the TUI, or `opencode run` for a prompt. */
export function planOpencode(input: PlanInput): HarnessPlan {
  if (input.yellow) throw new Error("--yellow is not supported for OpenCode; use --yolo (--auto) or its own prompts");
  const args: string[] = [];
  if (input.prompt !== undefined) args.push("run");
  if (input.resumeId) args.push("--session", input.resumeId);
  else if (input.resumeLast) args.push("--continue");
  if (input.plan) args.push("--agent", "plan");
  // --auto approves what is not explicitly denied; deny rules still hold.
  if (input.yolo) args.push("--auto");
  args.push(...input.passthrough);
  if (input.prompt !== undefined) args.push(input.prompt);
  return {
    command: "opencode",
    args,
    envSet: {
      OPENCODE_CONFIG_CONTENT: opencodeConfig(input),
      [OPENCODE_KEY_ENV]: input.apiKey,
      ...(input.mcp ? { [MCP_KEY_ENV]: input.mcpApiKey ?? input.apiKey } : {}),
    },
    envUnset: [],
    installHint: "install OpenCode: npm i -g opencode-ai (or brew install sst/tap/opencode)",
  };
}
