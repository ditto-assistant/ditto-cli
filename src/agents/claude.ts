import { TOOL_DENY_HEADER } from "./claude-deny.js";
import { MCP_KEY_ENV, TOOL_SURFACE_HEADER, TOOL_SURFACE_MCP, attachmentSettings, withClaudeSettings } from "./claude-mcp.js";
import { type HarnessPlan, type PlanInput, SESSION_HEADER, apiRootOf } from "./types.js";

/**
 * Builds the `claude` invocation.
 *
 * Auth goes through ANTHROPIC_AUTH_TOKEN (sent as `Authorization: Bearer`):
 * unlike ANTHROPIC_API_KEY it never triggers the interactive "use this API
 * key? No (recommended)" approval prompt, so the same plan works headless.
 * Any inherited ANTHROPIC_API_KEY is removed so it cannot re-trigger that
 * prompt or add a stray x-api-key header.
 */
export function planClaude(input: PlanInput): HarnessPlan {
  const args: string[] = [];
  if (input.yolo) args.push("--dangerously-skip-permissions");
  else if (input.yellow) args.push("--permission-mode", "acceptEdits");
  else if (input.plan) args.push("--permission-mode", "plan");

  // A session id of our own is only for a brand-new conversation; Claude
  // rejects it next to its other ways of picking one (--from-pr, a forwarded
  // --session-id).
  const picksOwn = input.passthrough.some((a) => a === "--from-pr" || a.startsWith("--from-pr=") || a === "--session-id" || a.startsWith("--session-id="));
  if (input.resumeId) args.push("--resume", input.resumeId);
  else if (input.resumeLast) args.push("--continue");
  else if (!picksOwn) args.push("--session-id", input.sessionId);

  if (input.model) args.push("--model", input.model);
  if (input.prompt !== undefined) args.push("-p", input.prompt);
  // Native MCP mode: the endpoint's tools as Claude Code's own servers, and
  // the router told not to inject them a second time.
  if (input.mcp) args.push("--mcp-config", input.mcp.config);
  args.push(...input.passthrough);
  const finalArgs = input.mcp ? withClaudeSettings(args, attachmentSettings(input.mcp), { cwd: input.cwd }) : args;

  const deny = input.toolDeny?.length ? `${TOOL_DENY_HEADER}: ${input.toolDeny.join(",")}` : undefined;
  const surface = input.mcp ? `${TOOL_SURFACE_HEADER}: ${TOOL_SURFACE_MCP}` : undefined;
  const headers = [inheritedHeaders(input.env.ANTHROPIC_CUSTOM_HEADERS), `${SESSION_HEADER}: ${input.sessionId}`, deny, surface]
    .filter((h): h is string => Boolean(h))
    .join("\n");

  const envSet: Record<string, string> = {
    ANTHROPIC_BASE_URL: apiRootOf(input.baseUrl),
    ANTHROPIC_AUTH_TOKEN: input.apiKey,
    ANTHROPIC_CUSTOM_HEADERS: headers,
  };
  if (input.model) envSet.ANTHROPIC_MODEL = input.model;
  if (input.mcp) envSet[MCP_KEY_ENV] = input.apiKey;
  if (input.mcpOnly) {
    // Endpoint keys are only MCP credentials in this mode. Never forward one
    // to Anthropic or inherit a parent launch's inference gateway settings.
    return {
      command: "claude", args: finalArgs,
      envSet: input.mcp ? { [MCP_KEY_ENV]: input.apiKey } : {},
      envUnset: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_MODEL", "ANTHROPIC_API_KEY"],
      installHint: "install Claude Code and sign in with `claude auth login`",
    };
  }
  // Claude Code's server-side auto-mode classifier needs the dangerous-tool-use
  // beta and `safeguards` field, which the router does not forward; a rejection
  // denies every auto-mode tool use. Decide locally unless the caller chose.
  if (input.env.CLAUDE_CODE_AUTO_MODE_SERVER === undefined) envSet.CLAUDE_CODE_AUTO_MODE_SERVER = "0";
  // Claude Code only labels requests (x-claude-code-request-class: main,
  // subagent, auxiliary) for gateways when asked. The router uses the label to
  // skip memory recall on housekeeping calls such as the auto-mode classifier.
  if (input.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS === undefined) envSet.CLAUDE_CODE_GATEWAY_HINT_HEADERS = "1";

  return {
    command: "claude",
    args: finalArgs,
    envSet,
    envUnset: ["ANTHROPIC_API_KEY"],
    installHint: "install Claude Code: npm i -g @anthropic-ai/claude-code (or see https://code.claude.com)",
  };
}

/**
 * Claude's own resume flags typed after `--` (`heyditto claude -- -r`). Passed
 * through they collide with the `--session-id` every launch sets ("--session-id
 * can only be used with --continue or --resume if --fork-session is also
 * specified"), so they are lifted out and handled as `--resume` / `--continue`.
 */
export function liftResumeFlags(args: string[]): { args: string[]; resume?: string | true; continue?: boolean } {
  const out: string[] = [];
  let resume: string | true | undefined;
  let cont = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "-r" || a === "--resume") {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        resume = next;
        i += 1;
      } else resume = true;
    } else if (a.startsWith("--resume=")) resume = a.slice("--resume=".length) || true;
    else if (a === "-c" || a === "--continue") cont = true;
    else out.push(a);
  }
  return { args: out, ...(resume !== undefined ? { resume } : {}), ...(cont ? { continue: true } : {}) };
}

/**
 * Headers that describe one launch. A `heyditto claude` started inside another
 * inherits the parent's, and a second session id would file the child's turns
 * under the parent's thread, and a stale tool surface would leave a `--no-mcp`
 * child with no tools at all. Inherited deny rules stay: they only tighten.
 */
const LAUNCH_HEADERS = new Set([SESSION_HEADER, TOOL_SURFACE_HEADER].map((h) => h.toLowerCase()));

/** The caller's own custom headers, minus a parent launch's. */
function inheritedHeaders(raw: string | undefined): string | undefined {
  const kept = (raw ?? "")
    .split("\n")
    .filter((line) => line.trim() && !LAUNCH_HEADERS.has(line.split(":", 1)[0].trim().toLowerCase()));
  return kept.length ? kept.join("\n").trim() : undefined;
}
