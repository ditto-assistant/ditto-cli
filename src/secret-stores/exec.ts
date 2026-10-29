import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, SecretStore } from "./types.js";
import { writePrivateKey } from "./local-file.js";
import { redactKnownSecrets } from "../secret-redaction.js";

/**
 * Subprocess plumbing shared by every store. Generalized from the original
 * GitHub-only helper: the plaintext goes to the child's stdin, so it never
 * appears in argv, `ps`, shell history or our own output.
 */

export interface RunResult {
  status: number | null;
  /** OS-controlled termination metadata, never child-supplied diagnostics. */
  signal?: NodeJS.Signals;
  errorCode?: string;
  stdout: string;
  stderr: string;
  /** The binary is not on PATH. */
  missing: boolean;
}

/** Keeps platform CLIs quiet and non-interactive; they must never prompt. */
const QUIET_ENV: Record<string, string> = {
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PROMPT_DISABLED: "1",
  GLAB_CHECK_UPDATE: "0",
  NO_COLOR: "1",
  AWS_PAGER: "",
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
  AZURE_CORE_ONLY_SHOW_ERRORS: "true",
  DO_NOT_TRACK: "1",
};

export function run(bin: string, args: string[], input?: string): RunResult {
  const res = spawnSync(bin, args, {
    encoding: "utf8",
    // Always an explicit (possibly empty) stdin: a CLI that reads stdin on a
    // probe like `gh auth status` must see EOF rather than wait for us.
    input: input ?? "",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...QUIET_ENV },
  });
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
  const errorCode = typeof code === "string" && Object.hasOwn(osConstants.errno, code) ? code : undefined;
  const signal = res.signal && Object.hasOwn(osConstants.signals, res.signal) ? res.signal : undefined;
  const missing = code === "ENOENT";
  return { status: res.status, signal, errorCode, stdout: res.stdout ?? "", stderr: res.stderr ?? "", missing };
}

/** Last few stderr lines, clamped — platform CLIs can be very chatty on failure. */
export function trimmedStderr(res: RunResult): string {
  return (res.stderr || res.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

const presence = new Map<string, boolean>();

/**
 * True when `bin` is on PATH. Memoized: `endpoints keys stores` asks about a
 * dozen CLIs, and resolving alternate names asks again.
 */
export function installed(bin: string, versionArgs: readonly string[] = ["--version"]): boolean {
  const cached = presence.get(bin);
  if (cached !== undefined) return cached;
  const found = !run(bin, [...versionArgs]).missing;
  presence.set(bin, found);
  return found;
}

const resolvedBins = new Map<string, string>();

/**
 * Some CLIs ship under more than one name (`fly` and `flyctl`). Picks the
 * first that answers, remembering it so one command spawns the probe once.
 */
export function resolveBin(store: { bin: string; altBins?: readonly string[]; versionArgs?: readonly string[] }): string {
  const cached = resolvedBins.get(store.bin);
  if (cached) return cached;
  const candidates = [store.bin, ...(store.altBins ?? [])];
  const found = candidates.find((bin) => installed(bin, store.versionArgs)) ?? store.bin;
  resolvedBins.set(store.bin, found);
  return found;
}

/**
 * Standard preflight: the binary answers, and the account check exits 0.
 * Runs before anything is minted so a missing CLI costs nothing.
 */
export function preflight(input: {
  bin: string;
  altBins?: readonly string[];
  label: string;
  installHint: string;
  versionArgs?: readonly string[];
  authArgs: string[];
  authHint: string;
}): void {
  const bin = resolveBin(input);
  const version = run(bin, [...(input.versionArgs ?? ["--version"])]);
  if (version.missing) {
    throw new Error(`storing a key in ${input.label} needs ${input.bin} on PATH; ${input.installHint}`);
  }
  const auth = run(bin, input.authArgs);
  if (auth.missing) {
    throw new Error(`storing a key in ${input.label} needs ${input.bin} on PATH; ${input.installHint}`);
  }
  if (auth.status !== 0) {
    throw new Error(
      `${bin} is not signed in (\`${bin} ${input.authArgs.join(" ")}\` failed; authentication diagnostics suppressed). ${input.authHint}`,
    );
  }
}

/** Placeholder in `path` delivery argv, replaced with the file the CLI should read. */
export const PATH_PLACEHOLDER = "{}";

/** POSIX CLIs can read the piped stdin through this path; Windows cannot. */
const STDIN_PATH = "/dev/stdin";

function substitute(args: string[], path: string): string[] {
  return args.map((arg) => arg.split(PATH_PLACEHOLDER).join(path));
}

/**
 * Hands `value` to the store's CLI, trying each attempt in order. Failure copy
 * includes only exit status and allowlisted OS metadata so the caller can revoke
 * its newly minted key without exposing credential-bearing child diagnostics.
 *
 * `path` delivery uses `/dev/stdin` wherever it exists, keeping the plaintext
 * off disk. Only on Windows does it fall back to a 0600 file in a private
 * temp directory, which is overwritten and removed before returning.
 */
export function deliver(store: SecretStore, name: string, attempts: Delivery[], value: string): void {
  const failures: string[] = [];
  for (const attempt of attempts) {
    if (attempt.kind === "local-file") {
      try {
        writePrivateKey(attempt.path, value);
        return;
      } catch (error) {
        failures.push(redactKnownSecrets(`${attempt.note}: ${error instanceof Error ? error.message : "private file delivery failed"}`, [value]));
        continue;
      }
    }
    const payload = attempt.payload ? attempt.payload(value) : value;
    const res = attempt.kind === "stdin" ? runStdin(store, attempt, payload) : runPath(store, attempt, payload);
    if (res.missing) {
      throw new Error(`${store.bin} disappeared from PATH while storing the secret; ${store.installHint}`);
    }
    if (res.status === 0) return;
    // The child has just received a credential. Its stdout/stderr may echo it
    // or encode it in arbitrary ways, so suppress those diagnostics entirely.
    const reason = [res.signal ? `terminated by ${res.signal}` : undefined, res.errorCode ? `OS error ${res.errorCode}` : undefined].filter(Boolean).join(", ") || (res.status === null ? "ended without an exit status" : `exit ${res.status}`);
    failures.push(`${attempt.note}: ${reason}; credential-bearing subprocess diagnostics suppressed`);
  }
  throw new Error(`${store.id === "file" ? store.label : store.bin} could not store ${name} — ${failures.join("; ")}`);
}

function runStdin(store: SecretStore, attempt: Delivery & { kind: "stdin" }, payload: string): RunResult {
  return run(resolveBin(store), attempt.args, payload);
}

function runPath(store: SecretStore, attempt: Delivery & { kind: "path" }, payload: string): RunResult {
  if (process.platform !== "win32") {
    return run(resolveBin(store), substitute(attempt.args, STDIN_PATH), payload);
  }
  const dir = mkdtempSync(join(tmpdir(), "heyditto-secret-"));
  const file = join(dir, "value");
  try {
    writeFileSync(file, payload, { mode: 0o600 });
    return run(resolveBin(store), substitute(attempt.args, file));
  } finally {
    try {
      writeFileSync(file, "0".repeat(payload.length), { mode: 0o600 });
    } catch {
      // Best effort; the directory removal below is what matters.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
