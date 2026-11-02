import { execFile } from "node:child_process";
import { HARNESS_HEADER, HARNESS_VERSION_HEADER, type Harness } from "./types.js";

/**
 * Harness identification for the router. Every launch names its harness in
 * X-Ditto-Harness and, when the installed binary reports one, its version in
 * X-Ditto-Harness-Version. The version is read from `<harness> --version`
 * once per launch and sent exactly as reported, pre-release suffix included
 * ("0.163.0-alpha.2"): the router serves that release's prompts, so a
 * rounded-off version would name a release the user does not have.
 */

/**
 * The version in `--version` output ("2.1.316 (Claude Code)",
 * "codex-cli 0.166.0", "codex-cli 0.163.0-alpha.2"), or undefined. A dotted
 * triple that is part of a longer token (an IP address, a four-part number)
 * is not a version.
 */
export function parseHarnessVersion(output: string | undefined): string | undefined {
  return output?.match(/(?<![\w.])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*[0-9A-Za-z])?)(?![\w.])/)?.[1];
}

/**
 * Runs `<command> --version` and resolves the version it reports, or
 * undefined when the binary is missing, fails, hangs past `timeoutMs` or
 * prints no version. It runs asynchronously so a stalled harness never
 * blocks the event loop. No shell is used, so on Windows an npm `.cmd` shim
 * does not resolve and the header is left out (the router then reads the
 * User-Agent instead).
 */
export function readHarnessVersion(command: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(command, ["--version"], { env, encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return resolve(undefined);
        resolve(parseHarnessVersion(stdout) ?? parseHarnessVersion(stderr));
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** The identification headers for one launch, in send order. */
export function harnessHeaders(harness: Harness, version: string | undefined): Array<[string, string]> {
  const headers: Array<[string, string]> = [[HARNESS_HEADER, harness]];
  const parsed = parseHarnessVersion(version);
  if (parsed) headers.push([HARNESS_VERSION_HEADER, parsed]);
  return headers;
}
