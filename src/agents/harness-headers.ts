import { spawnSync } from "node:child_process";
import { HARNESS_HEADER, HARNESS_VERSION_HEADER, type Harness } from "./types.js";

/**
 * Harness identification for the router. Every launch names its harness in
 * X-Ditto-Harness and, when the installed binary reports one, its version in
 * X-Ditto-Harness-Version. The version is read from `<harness> --version`
 * once per launch; anything that is not a plain X.Y.Z is dropped, because a
 * guessed version would steer the router's compatibility shaping wrong.
 */

/** First X.Y.Z in `--version` output ("2.1.296 (Claude Code)", "codex-cli 0.162.1"). */
export function parseHarnessVersion(output: string | undefined): string | undefined {
  return output?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
}

/**
 * Runs `<command> --version` and returns the X.Y.Z it reports, or undefined
 * when the binary is missing, fails, hangs or prints no version.
 */
export function readHarnessVersion(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const res = spawnSync(command, ["--version"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    if (res.error || res.status !== 0) return undefined;
    return parseHarnessVersion(res.stdout) ?? parseHarnessVersion(res.stderr);
  } catch {
    return undefined;
  }
}

/** The identification headers for one launch, in send order. */
export function harnessHeaders(harness: Harness, version: string | undefined): Array<[string, string]> {
  const headers: Array<[string, string]> = [[HARNESS_HEADER, harness]];
  const parsed = parseHarnessVersion(version);
  if (parsed) headers.push([HARNESS_VERSION_HEADER, parsed]);
  return headers;
}

/**
 * Merges `headers` into a newline-separated ANTHROPIC_CUSTOM_HEADERS value.
 * Every line the caller already had is kept, except one naming a header we
 * set (compared case-insensitively), which ours replaces so the request does
 * not carry two conflicting values.
 */
export function mergeCustomHeaders(existing: string | undefined, headers: Array<[string, string]>): string {
  const ours = new Set(headers.map(([name]) => name.toLowerCase()));
  const kept = (existing ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => {
      const colon = line.indexOf(":");
      return colon === -1 || !ours.has(line.slice(0, colon).trim().toLowerCase());
    });
  return [...kept, ...headers.map(([name, value]) => `${name}: ${value}`)].join("\n");
}
