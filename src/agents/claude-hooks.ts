import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ditto's own Claude Code hooks (DITTO-2479).
 *
 * `heyditto claude` already shapes a session through `--settings`: native MCP
 * puts the endpoint's tools and permission rules there, and Remote Control
 * adds the hooks that relay turn boundaries to the app. This adds hooks that
 * Ditto owns as policy, declared per repository in the endpoint profile:
 *
 *   # .ditto/endpoints/dev.toml
 *   [settings]
 *   claude_hooks = { stop = { checks = ["unpushed"], repos = [".", "workspaces/*\/*"] } }
 *
 * They are read from the checked-in profile at launch and never sent to the
 * endpoint: `repos` are paths in this repository, meaningless anywhere else,
 * so a launch outside the repository (or `--no-hooks`) gets none.
 *
 * Only `Stop` is implemented. Its one check, `unpushed`, asks Claude to keep
 * going once when a listed repository has uncommitted changes or commits its
 * remote does not have. See docs/claude-hooks.md for the survey of the other
 * events and why they wait.
 */

export const STOP_CHECKS = ["unpushed"] as const;
export type StopCheck = (typeof STOP_CHECKS)[number];

export interface StopHookConfig {
  checks: StopCheck[];
  /** Directories relative to the repository root; `*` matches one path segment. */
  repos: string[];
}

export interface ClaudeHooksConfig {
  stop?: StopHookConfig;
}

/** What the hook script receives (argv, base64url JSON): no secrets, only paths and check names. */
export interface StopHookArgs {
  root: string;
  checks: StopCheck[];
  repos: string[];
  /** Where the policy came from, quoted back to Claude so it knows whose rule it is. */
  source: string;
}

/** The longest a Stop hook may take: Claude waits for it before the turn ends. */
export const STOP_HOOK_TIMEOUT_S = 60;

export class ClaudeHooksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeHooksError";
  }
}

function isTable(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !s.trim())) throw new ClaudeHooksError(`${field} must be a list of non-empty strings`);
  return [...new Set(v.map((s: string) => s.trim()))];
}

/**
 * Validates `settings.claude_hooks`. Unknown keys and checks fail: a typo in
 * version-controlled policy must not silently mean "no hook".
 */
export function parseClaudeHooks(raw: unknown, where: string): ClaudeHooksConfig | undefined {
  if (raw === undefined) return undefined;
  const field = `${where}.claude_hooks`;
  if (!isTable(raw)) throw new ClaudeHooksError(`${field} must be a table, e.g. { stop = { checks = ["unpushed"] } }`);
  const out: ClaudeHooksConfig = {};
  for (const [event, value] of Object.entries(raw)) {
    if (event !== "stop") throw new ClaudeHooksError(`${field}.${event}: unknown hook (only "stop" is supported)`);
    if (!isTable(value)) throw new ClaudeHooksError(`${field}.stop must be a table, e.g. { checks = ["unpushed"] }`);
    for (const k of Object.keys(value)) {
      if (k !== "checks" && k !== "repos") throw new ClaudeHooksError(`${field}.stop.${k}: unknown key (checks, repos)`);
    }
    const checks = stringList(value.checks ?? [], `${field}.stop.checks`);
    for (const check of checks) {
      if (!(STOP_CHECKS as readonly string[]).includes(check)) throw new ClaudeHooksError(`${field}.stop.checks: unknown check "${check}" (known: ${STOP_CHECKS.join(", ")})`);
    }
    const repos = value.repos === undefined ? ["."] : stringList(value.repos, `${field}.stop.repos`);
    for (const r of repos) {
      if (path.isAbsolute(r) || r.split(/[\\/]/).includes("..")) throw new ClaudeHooksError(`${field}.stop.repos: "${r}" must be a path inside the repository`);
    }
    // An empty check list is an explicit "off", kept so the banner can say so.
    out.stop = { checks: checks as StopCheck[], repos };
  }
  return out;
}

/** Absolute path of the compiled Stop hook next to this module. */
export function stopHookScriptPath(): string {
  return fileURLToPath(new URL("./claude-stop-hook.js", import.meta.url));
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function encodeHookArgs(args: StopHookArgs): string {
  return Buffer.from(JSON.stringify(args)).toString("base64url");
}

export function decodeHookArgs(raw: string): StopHookArgs | undefined {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as StopHookArgs;
    if (typeof v.root !== "string" || !Array.isArray(v.checks) || !Array.isArray(v.repos)) return undefined;
    return v;
  } catch {
    return undefined;
  }
}

/** What a launch attaches: the `--settings` fragment and a banner summary. */
export interface ClaudeHookAttachment {
  settings: { hooks: Record<string, unknown[]> };
  /** e.g. ["Stop (unpushed)"]. */
  summary: string[];
}

/**
 * The `--settings` hooks for a repository's config, or undefined when it asks
 * for none. Hooks from `--settings` are added next to the user's own Claude
 * Code hooks: withClaudeSettings merges this into the one `--settings` value,
 * and Remote Control's relay hooks concatenate onto the same event lists.
 */
export function claudeHookAttachment(
  config: ClaudeHooksConfig | undefined,
  opts: { root: string; source: string; script?: string; node?: string },
): ClaudeHookAttachment | undefined {
  const stop = config?.stop;
  if (!stop || stop.checks.length === 0) return undefined;
  const args: StopHookArgs = { root: path.resolve(opts.root), checks: stop.checks, repos: stop.repos, source: opts.source };
  const command = [opts.node ?? process.execPath, opts.script ?? stopHookScriptPath(), encodeHookArgs(args)].map(shellQuote).join(" ");
  return {
    settings: { hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: STOP_HOOK_TIMEOUT_S }] }] } },
    summary: [`Stop (${stop.checks.join(", ")})`],
  };
}
