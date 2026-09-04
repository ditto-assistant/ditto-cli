import { CODEX_KEY_ENV, type HarnessPlan, type PlanInput, SESSION_HEADER } from "./types.js";

/** Quotes a string as a TOML basic string for `codex -c key=value`. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
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
  if (input.prompt !== undefined) args.push("exec");
  else if (input.resumeId || input.resumeLast) args.push("resume");

  args.push(
    "-c",
    `model_provider=${tomlString("ditto")}`,
    "-c",
    `model_providers.ditto.name=${tomlString("Ditto")}`,
    "-c",
    `model_providers.ditto.base_url=${tomlString(input.baseUrl)}`,
    "-c",
    `model_providers.ditto.env_key=${tomlString(CODEX_KEY_ENV)}`,
    "-c",
    `model_providers.ditto.wire_api=${tomlString("responses")}`,
    "-c",
    `model_providers.ditto.http_headers={${tomlString(SESSION_HEADER)}=${tomlString(input.sessionId)}}`,
  );
  if (input.model) args.push("-m", input.model);

  if (input.yolo) args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (input.yellow) args.push("-a", "on-request", "-s", "workspace-write");

  if (input.prompt !== undefined) {
    args.push("--skip-git-repo-check", ...input.passthrough, input.prompt);
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
    envSet: { [CODEX_KEY_ENV]: input.apiKey },
    envUnset: [],
    installHint: "install Codex: npm i -g @openai/codex (or brew install codex)",
  };
}
