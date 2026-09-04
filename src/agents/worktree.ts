import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Harness } from "./types.js";

/** Folder inside the repository that holds the CLI's worktrees (kept out of git). */
export const WORKTREES_DIR = ".worktrees";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `<harness>-<yyyymmdd-hhmm>`, e.g. `claude-20260904-1530`. */
export function defaultWorktreeName(harness: Harness, now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${harness}-${stamp}`;
}

export function validWorktreeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,80}$/.test(name) && !name.includes("..");
}

function git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: res.status === 0, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() };
}

export function repoRoot(cwd: string): string | undefined {
  const res = git(["rev-parse", "--show-toplevel"], cwd);
  return res.ok && res.out ? res.out : undefined;
}

/** Adds `.worktrees/` to the repo root .gitignore when it is not already listed. */
export async function ensureGitignore(root: string): Promise<boolean> {
  const file = path.join(root, ".gitignore");
  let current = "";
  try {
    current = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const listed = current
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === WORKTREES_DIR || l === `${WORKTREES_DIR}/` || l === `/${WORKTREES_DIR}` || l === `/${WORKTREES_DIR}/`);
  if (listed) return false;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await appendFile(file, `${prefix}# Coding-agent worktrees created by heyditto\n${WORKTREES_DIR}/\n`);
  return true;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  created: boolean;
}

/**
 * Creates (or reuses) `<repo>/.worktrees/<name>` on a branch of the same
 * name, mirroring how Claude Code keeps worktrees inside the repository.
 */
export async function ensureWorktree(cwd: string, name: string): Promise<WorktreeResult> {
  const root = repoRoot(cwd);
  if (!root) throw new Error(`--worktree needs a git repository (no repo found at ${cwd})`);
  if (!validWorktreeName(name)) throw new Error(`invalid worktree name: ${name}`);
  await ensureGitignore(root);
  const dir = path.join(root, WORKTREES_DIR, name);
  await mkdir(path.dirname(dir), { recursive: true });

  const existing = git(["worktree", "list", "--porcelain"], root);
  if (existing.ok && existing.out.split("\n").includes(`worktree ${dir}`)) {
    return { path: dir, branch: name, created: false };
  }
  const branchExists = git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], root).ok;
  const add = branchExists
    ? git(["worktree", "add", dir, name], root)
    : git(["worktree", "add", "-b", name, dir], root);
  if (!add.ok) throw new Error(`git worktree add failed: ${add.err || add.out}`);
  return { path: dir, branch: name, created: true };
}
