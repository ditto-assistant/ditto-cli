import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Code's permission rules only govern tools Claude Code runs itself.
 * The Ditto Router executes its own tools server-side, so a
 * `deny: ["mcp__ditto__gmail__*"]` in settings.json would never fire. Those
 * rules are forwarded to the router instead, which enforces them per request
 * and can only ever add a denial (backend toolgate/policy.go).
 */
export const TOOL_DENY_HEADER = "X-Ditto-Tool-Deny";

const NAMESPACE = "mcp__ditto";
const VALID = /^[A-Za-z0-9_.*-]+$/;

/**
 * The deny rules for router tools, from every settings file Claude Code reads
 * for this directory: user, project and local. A bare `mcp__ditto` denies the
 * whole server. A file that is missing or unreadable contributes nothing.
 */
export function claudeDittoDenyRules(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  const files = [path.join(home, "settings.json"), path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")];
  const rules: string[] = [];
  for (const file of files) {
    let deny: unknown;
    try {
      deny = (JSON.parse(readFileSync(file, "utf8")) as { permissions?: { deny?: unknown } }).permissions?.deny;
    } catch {
      continue;
    }
    if (!Array.isArray(deny)) continue;
    for (const entry of deny) {
      if (typeof entry !== "string") continue;
      const rule = entry.trim();
      if (rule.toLowerCase() === NAMESPACE) {
        rules.push("*");
      } else if (rule.toLowerCase().startsWith(`${NAMESPACE}__`) && VALID.test(rule)) {
        rules.push(rule.slice(NAMESPACE.length + 2));
      }
    }
  }
  return [...new Set(rules)];
}
