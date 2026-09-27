import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, DeliveryEffect, SecretStore } from "./types.js";

/**
 * Subprocess plumbing shared by every store. Generalized from the original
 * GitHub-only helper: the plaintext goes to the child's stdin, so it never
 * appears in argv, `ps`, shell history or our own output.
 */

export interface RunResult {
  status: number | null;
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
  const missing = res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ENOENT";
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", missing };
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
    const detail = trimmedStderr(auth);
    throw new Error(
      `${bin} is not signed in (\`${bin} ${input.authArgs.join(" ")}\` failed${detail ? `: ${detail}` : ""}). ${input.authHint}`,
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

/** What `deliver` did with the value. */
export interface DeliveryReport {
  /** The attempt that stored the value; undefined when every attempt failed. */
  stored?: Delivery;
  /** Whether that attempt created the secret or added a version, when the store says. */
  effect?: DeliveryEffect;
  /** `note: reason` for every attempt that failed, in order. */
  failures: string[];
}

/** The operator-facing error for a report whose attempts all failed. */
export function describeFailures(store: SecretStore, name: string, report: DeliveryReport): string {
  return `${store.bin} could not store ${name} — ${report.failures.join("; ")}`;
}

/**
 * Hands `value` to the store's CLI, trying each attempt in order, and reports
 * which one stored it. When every attempt fails, `stored` is undefined and
 * `failures` carries each attempt's own last stderr lines, so the caller can
 * revoke the key it just minted and the operator can see why.
 *
 * `path` delivery uses `/dev/stdin` wherever it exists, keeping the plaintext
 * off disk. Only on Windows does it fall back to a 0600 file in a private
 * temp directory, which is overwritten and removed before returning.
 */
export function deliver(store: SecretStore, name: string, attempts: Delivery[], value: string): DeliveryReport {
  const failures: string[] = [];
  for (const attempt of attempts) {
    const payload = attempt.payload ? attempt.payload(value) : value;
    trace(store, attempt, payload);
    const res = attempt.kind === "stdin" ? runStdin(store, attempt, payload) : runPath(store, attempt, payload);
    if (res.missing) {
      throw new Error(`${store.bin} disappeared from PATH while storing the secret; ${store.installHint}`);
    }
    if (res.status === 0) return { stored: attempt, effect: attempt.effect, failures };
    const detail = trimmedStderr(res);
    failures.push(`${attempt.note}: ${detail || `exit ${res.status}`}`);
  }
  return { failures };
}

/**
 * `HEYDITTO_DEBUG=stores` prints every platform CLI call `deliver` makes to
 * stderr, for working out why a store rejected an attempt.
 */
function trace(store: SecretStore, attempt: Delivery, payload: string): void {
  if (!/(^|,)stores(,|$)/.test(process.env.HEYDITTO_DEBUG ?? "")) return;
  // Templates are shown so a malformed patch or env line can be spotted; a bare value only by length.
  const body = attempt.payload ? payload.trimEnd() : `<${payload.length} bytes>`;
  process.stderr.write(`[heyditto] ${resolveBin(store)} ${attempt.args.join(" ")} (${attempt.kind}) <<< ${body}\n`);
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
