#!/usr/bin/env node
/**
 * Ditto's Claude Code `Stop` hook: `claude-stop-hook.js <base64url args>`.
 *
 * Claude Code runs it when the agent finishes responding and passes the hook
 * input on stdin. When a repository the profile lists still has uncommitted
 * changes or commits its remote lacks, it prints `{"decision":"block",
 * "reason":…}`, which sends the reason back to Claude so it can push the work
 * or say why it is left. It blocks at most once per stop: when Claude is
 * already continuing because of a Stop hook (`stop_hook_active`), it lets the
 * turn end, so a condition Claude cannot fix never traps the session.
 *
 * It never fails the turn. Any error, an unreadable repository, or a remote
 * that cannot be reached counts as "nothing to report", and the process exits
 * 0 whatever happens. Only facts it established are reported.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeHookArgs, type StopHookArgs } from "./claude-hooks.js";

/** Bounds a hook that walks globs: Claude waits for it. */
const MAX_REPOS = 64;
const GIT_TIMEOUT_MS = 5_000;
const REMOTE_TIMEOUT_MS = 8_000;

export interface RepoFinding {
  /** Path relative to the root, "." for the root itself. */
  repo: string;
  problems: string[];
}

type Git = (cwd: string, args: string[], timeoutMs?: number) => Promise<string | undefined>;

/** Runs git; undefined on any failure, so callers can only ever under-report. */
export const runGit: Git = (cwd, args, timeoutMs = GIT_TIMEOUT_MS) =>
  new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expands the profile's repo patterns under `root`. `*` matches one directory
 * name (hidden ones excluded); anything else is literal. Only directories that
 * hold a `.git` (a clone or a worktree) count. Sorted, deduplicated, bounded.
 */
export async function expandRepos(root: string, patterns: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const pattern of patterns) {
    let dirs = [path.resolve(root)];
    for (const segment of pattern.split(/[\\/]/).filter((s) => s && s !== ".")) {
      const next: string[] = [];
      for (const dir of dirs) {
        if (segment !== "*") {
          const p = path.join(dir, segment);
          if (await isDir(p)) next.push(p);
          continue;
        }
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) next.push(path.join(dir, e.name));
      }
      dirs = next.sort();
    }
    for (const dir of dirs) {
      if (found.size >= MAX_REPOS) break;
      if (await exists(path.join(dir, ".git"))) found.add(dir);
    }
  }
  return [...found].sort();
}

/**
 * What is not yet durable in one repository: uncommitted changes, and commits
 * that are not on its remote. A branch with no upstream is checked against the
 * remote itself, because a single-branch clone pushed with `git push -u` can
 * have no remote-tracking ref and would otherwise always read as unpushed.
 */
export async function unpushedProblems(repo: string, git: Git = runGit): Promise<string[]> {
  const problems: string[] = [];
  const status = await git(repo, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status === undefined) return problems;
  const changed = status.split("\n").filter((l) => l.trim()).length;
  if (changed > 0) problems.push(`${changed} uncommitted change${changed === 1 ? "" : "s"}`);

  const branch = (await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim();
  if (!branch) return problems; // Detached HEAD: no branch to push.
  const head = (await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  if (!head) return problems; // No commits yet.

  const upstream = (await git(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.trim();
  if (upstream) {
    const ahead = Number((await git(repo, ["rev-list", "--count", "@{upstream}..HEAD"]))?.trim());
    if (ahead > 0) problems.push(`${ahead} commit${ahead === 1 ? "" : "s"} on ${branch} not pushed to ${upstream}`);
    return problems;
  }
  const remotes = (await git(repo, ["remote"]))?.split("\n").map((r) => r.trim()).filter(Boolean) ?? [];
  if (remotes.length === 0) return problems; // A local-only repository is a choice, not a lapse.
  // Commits every remote-tracking ref already contains were never ours to push.
  const local = Number((await git(repo, ["rev-list", "--count", "HEAD", "--not", "--remotes"]))?.trim());
  if (!(local > 0)) return problems;
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  const listed = await git(repo, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], REMOTE_TIMEOUT_MS);
  if (listed === undefined) return problems; // Offline or no access: report nothing rather than guess.
  const remoteSha = listed.trim().split(/\s+/)[0];
  if (!remoteSha) problems.push(`branch ${branch} is not on ${remote} (${local} local commit${local === 1 ? "" : "s"})`);
  else if (remoteSha !== head) {
    // The remote may be ahead (someone else pushed) rather than behind; only
    // a remote tip that HEAD does not contain is unpushed work we can name.
    // A remote tip this clone never fetched cannot be compared: say nothing.
    const known = await git(repo, ["cat-file", "-e", `${remoteSha}^{commit}`]);
    const contains = known === undefined ? "" : await git(repo, ["merge-base", "--is-ancestor", head, remoteSha]);
    if (contains === undefined) problems.push(`${remote}/${branch} is at ${remoteSha.slice(0, 12)}, local HEAD ${head.slice(0, 12)} is not on it`);
  }
  return problems;
}

/** Every listed repository's problems; repositories with none are omitted. */
export async function stopFindings(args: StopHookArgs, git: Git = runGit): Promise<RepoFinding[]> {
  if (!args.checks.includes("unpushed")) return [];
  const findings: RepoFinding[] = [];
  for (const repo of await expandRepos(args.root, args.repos)) {
    const problems = await unpushedProblems(repo, git);
    if (problems.length) findings.push({ repo: path.relative(args.root, repo) || ".", problems });
  }
  return findings;
}

/** The text Claude reads when the stop is blocked. */
export function stopReason(findings: RepoFinding[], source: string): string {
  const lines = findings.map((f) => `- ${f.repo}: ${f.problems.join("; ")}`);
  return [
    `Ditto stop check (${source}): work in this repository is not pushed yet.`,
    ...lines,
    "Commit and push it to its branch (open a draft PR if it is unfinished), or tell the user why it is being left. Ditto asks once; the turn can end after your next reply.",
  ].join("\n");
}

/** The hook's stdout for one Stop input, or "" to let the turn end. */
export async function stopHookOutput(input: Record<string, unknown> | undefined, args: StopHookArgs, git: Git = runGit): Promise<string> {
  // Already continuing because a Stop hook blocked: never block twice.
  if (input?.stop_hook_active === true) return "";
  const findings = await stopFindings(args, git);
  if (findings.length === 0) return "";
  return JSON.stringify({ decision: "block", reason: stopReason(findings, args.source) });
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function main(): Promise<void> {
  const args = decodeHookArgs(process.argv[2] ?? "");
  if (!args) return;
  let input: Record<string, unknown> | undefined;
  try {
    const v = JSON.parse(await readStdin(2000)) as unknown;
    if (typeof v === "object" && v !== null) input = v as Record<string, unknown>;
  } catch {
    // No input: treat as a first stop.
  }
  const out = await stopHookOutput(input, args);
  // stdout is an asynchronous pipe on macOS: exit only once it is flushed.
  if (out) await new Promise<void>((resolve) => process.stdout.write(`${out}\n`, () => resolve()));
}

/** Run as a script (by Claude Code), not imported (by tests). */
function invokedDirectly(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
