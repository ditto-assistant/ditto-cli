import { spawn, spawnSync } from "node:child_process";

export interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs git synchronously; never throws, callers check `ok`. */
export function git(args: string[], cwd: string, input?: string): GitResult {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  return { ok: res.status === 0, status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function gitOrThrow(args: string[], cwd: string, input?: string): string {
  const res = git(args, cwd, input);
  if (!res.ok) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout;
}

export function isGitRepo(dir: string): boolean {
  const res = git(["rev-parse", "--is-inside-work-tree"], dir);
  return res.ok && res.stdout.trim() === "true";
}

/** Top-level directory of the repository containing `dir`. */
export function repoRoot(dir: string): string | undefined {
  const res = git(["rev-parse", "--show-toplevel"], dir);
  return res.ok ? res.stdout.trim() : undefined;
}

export function binaryAvailable(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

/** Runs a command asynchronously with inherited env, resolving on exit. */
export function runAsync(
  command: string,
  args: string[],
  opts: { cwd?: string; input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) => resolve({ ok: status === 0, status, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}
