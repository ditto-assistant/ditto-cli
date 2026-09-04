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

  if (input.resumeId) args.push("--resume", input.resumeId);
  else if (input.resumeLast) args.push("--continue");
  else args.push("--session-id", input.sessionId);

  if (input.model) args.push("--model", input.model);
  if (input.prompt !== undefined) args.push("-p", input.prompt);
  args.push(...input.passthrough);

  const headers = [input.env.ANTHROPIC_CUSTOM_HEADERS?.trim(), `${SESSION_HEADER}: ${input.sessionId}`]
    .filter((h): h is string => Boolean(h))
    .join("\n");

  const envSet: Record<string, string> = {
    ANTHROPIC_BASE_URL: apiRootOf(input.baseUrl),
    ANTHROPIC_AUTH_TOKEN: input.apiKey,
    ANTHROPIC_CUSTOM_HEADERS: headers,
  };
  if (input.model) envSet.ANTHROPIC_MODEL = input.model;

  return {
    command: "claude",
    args,
    envSet,
    envUnset: ["ANTHROPIC_API_KEY"],
    installHint: "install Claude Code: npm i -g @anthropic-ai/claude-code (or see https://code.claude.com)",
  };
}
