/** Shared types for the coding-agent launchers. Pure data, no I/O. */

export type Harness = "claude" | "codex";

export const HARNESSES: readonly Harness[] = ["claude", "codex"];

export const KEY_EXPIRIES = [
  "1h",
  "4h",
  "8h",
  "12h",
  "1d",
  "1w",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "never",
] as const;
export type KeyExpiry = (typeof KEY_EXPIRIES)[number];

/** Header the Ditto gateway groups turns by; every launch sends one. */
export const SESSION_HEADER = "X-Ditto-Session-Id";

/** Env var the Codex provider reads the endpoint key from. */
export const CODEX_KEY_ENV = "DITTO_INFERENCE_API_KEY";

/** Everything a harness planner needs to build argv + env. */
export interface PlanInput {
  /** Inference gateway base URL ending in /v1, e.g. https://api.heyditto.ai/v1 */
  baseUrl: string;
  /** Plaintext endpoint key (already minted) or a placeholder for --dry-run. */
  apiKey: string;
  /** Ditto session id sent as X-Ditto-Session-Id. */
  sessionId: string;
  /** Model id to request; undefined leaves the harness default (gateway routes it). */
  model?: string;
  /** Harness-native session/thread id to resume, when resuming. */
  resumeId?: string;
  /** Resume the most recent harness session (claude --continue / codex resume --last). */
  resumeLast?: boolean;
  /** Headless prompt: claude -p / codex exec. */
  prompt?: string;
  yolo?: boolean;
  yellow?: boolean;
  plan?: boolean;
  /** Extra argv forwarded verbatim to the harness. */
  passthrough: string[];
  /** Parent environment to derive the child environment from. */
  env: NodeJS.ProcessEnv;
}

export interface HarnessPlan {
  command: string;
  args: string[];
  /** Env vars set on the child (in addition to the inherited environment). */
  envSet: Record<string, string>;
  /** Env vars removed from the child environment. */
  envUnset: string[];
  /** Human-readable install hint when the binary is missing. */
  installHint: string;
}

/** Strips the first `--` separator commander leaves in a variadic passthrough list. */
export function stripSeparator(args: string[]): string[] {
  const i = args.indexOf("--");
  if (i === -1) return args;
  return [...args.slice(0, i), ...args.slice(i + 1)];
}

/** Applies a plan's env changes to a copy of the given environment. */
export function childEnv(plan: HarnessPlan, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const k of plan.envUnset) delete env[k];
  Object.assign(env, plan.envSet);
  return env;
}

/** Base URL with a trailing /v1 removed: what ANTHROPIC_BASE_URL expects. */
export function apiRootOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "…";
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}
