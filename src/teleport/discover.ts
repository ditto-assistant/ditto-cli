import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isGitRepo, repoRoot } from "./git.js";
import type { RootKind } from "./types.js";

/** Directories never descended into while looking for repositories. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".git",
]);

export interface Discovery {
  root: string;
  kind: RootKind;
  /** Repo directories relative to root ("." for a single-repo root). */
  repos: string[];
}

/**
 * Finds the repositories under a root. A root that is itself a repository is a
 * single-repo capsule; otherwise every `.git` up to `depth` levels down counts
 * (worktrees are repositories too and are captured as such).
 */
export async function discoverRepos(rootInput: string, depth = 3): Promise<Discovery> {
  const resolved = path.resolve(rootInput);
  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  // Canonicalize so a symlinked root (e.g. macOS /var → /private/var) matches
  // git's own top-level path.
  const root = await realpath(resolved).catch(() => resolved);
  const top = repoRoot(root);
  if (isGitRepo(root) && top && (await realpath(top).catch(() => top)) === root) {
    return { root, kind: "repo", repos: ["."] };
  }
  const repos: string[] = [];
  await walk(root, root, depth, repos);
  repos.sort();
  if (repos.length === 0) {
    throw new Error(`no git repositories found under ${root} (searched ${depth} levels)`);
  }
  return { root, kind: "folder", repos };
}

async function walk(root: string, dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const hasGit = entries.some((e) => e.name === ".git");
  if (hasGit && dir !== root) {
    out.push(path.relative(root, dir).split(path.sep).join("/"));
    return; // nested repos inside a repo are submodules or vendored: leave them to their parent
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    await walk(root, path.join(dir, e.name), depth - 1, out);
  }
}
