import { lstat, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { git, isGitRepo } from "./git.js";
import * as tapi from "./api.js";
import { discoverRepos } from "./discover.js";
import type { CapturePlan } from "./workspace.js";

export interface UnpushedRepo {
  relPath: string;
  branch: string | null;
  ahead: number;
  reason: string;
}

/**
 * Repositories under `root` that hold work no remote has: commits ahead of an
 * upstream, or a branch with no upstream at all. Offload refuses on these
 * unless the user overrides, because deleting them loses the only copy.
 */
export async function unpushedRepos(root: string): Promise<UnpushedRepo[]> {
  const discovery = await discoverRepos(root);
  const out: UnpushedRepo[] = [];
  for (const rel of discovery.repos) {
    const dir = rel === "." ? discovery.root : path.join(discovery.root, rel);
    if (!isGitRepo(dir)) continue;
    const branchRes = git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir);
    const branch = branchRes.ok ? branchRes.stdout.trim() : null;
    const upstream = branch ? git(["rev-parse", "--abbrev-ref", "@{u}"], dir) : undefined;
    if (!branch) {
      out.push({ relPath: rel, branch, ahead: 0, reason: "detached HEAD" });
      continue;
    }
    if (!upstream?.ok) {
      const hasCommits = git(["rev-parse", "--verify", "HEAD"], dir).ok;
      const configured = git(["config", `branch.${branch}.merge`], dir).ok;
      if (hasCommits && configured) {
        // Upstream is configured but its tracking ref is absent (a capsule
        // restored without upstream tips, or a never-fetched remote): we
        // cannot tell what is pushed, so refuse rather than guess.
        out.push({ relPath: rel, branch, ahead: -1, reason: "tracking state unknown; fetch first or pass --allow-unpushed" });
      } else if (hasCommits) {
        out.push({ relPath: rel, branch, ahead: 0, reason: "branch has no upstream" });
      }
      continue;
    }
    const ahead = git(["rev-list", "--count", "@{u}..HEAD"], dir);
    const n = ahead.ok ? Number(ahead.stdout.trim()) : 0;
    if (n > 0) out.push({ relPath: rel, branch, ahead: n, reason: `${n} commit(s) not on ${upstream.stdout.trim()}` });
  }
  return out;
}

export interface OffloadReadiness {
  ready: boolean;
  mirrors: tapi.MirrorStatus[];
}

/** Polls capsule status until every required mirror is complete + verified, or timeout. */
export async function waitForOffloadReady(
  capsuleId: string,
  opts: { timeoutMs?: number; intervalMs?: number; onPoll?: (s: tapi.CapsuleStatus) => void } = {},
): Promise<OffloadReadiness> {
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const interval = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeout;
  for (;;) {
    const status = await tapi.capsuleStatus(capsuleId);
    opts.onPoll?.(status);
    if (status.offloadReady) return { ready: true, mirrors: status.mirrors };
    if (Date.now() >= deadline) return { ready: false, mirrors: status.mirrors };
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Only catalog-confirmed, excluded, untracked Node dependency trees are disposable. */
export function disposableNodeModules(plan: CapturePlan): string[] {
  const paths = new Set<string>();
  for (const repo of plan.repos) {
    for (const rule of repo.rules) {
      if (rule.source !== "catalog" || !rule.pattern.endsWith("node_modules/")) continue;
      if (!repo.excludes.includes(rule.pattern)) continue;
      const rel = rule.pattern.slice(0, -1);
      if (repo.trackedArtifacts.includes(rel)) continue;
      paths.add(path.posix.join(repo.relPath, rel));
    }
  }
  return [...paths].sort();
}

export interface LocalRemoval {
  method: "trash" | "rm";
  location?: string;
  deletedDependencies: string[];
  retainedDependencies: string[];
}

/**
 * Removes the local root once its capsule is verified. On macOS, project files
 * must reach Trash before selected dependency trees are deleted from that copy.
 * A failed Trash move leaves the source untouched; it never falls back to rm.
 */
export async function deleteLocalRoot(root: string, dependencies: string[] = []): Promise<LocalRemoval> {
  const resolved = path.resolve(root);
  await assertRealDirectory(resolved);
  if (process.platform === "darwin") {
    return moveLocalRootToTrash(resolved, path.join(os.homedir(), ".Trash"), dependencies);
  }
  await rm(resolved, { recursive: true, force: true });
  return { method: "rm", deletedDependencies: [], retainedDependencies: [] };
}

/** Exported separately so the macOS move and cleanup can be exercised in a temporary Trash. */
export async function moveLocalRootToTrash(root: string, trashDir: string, dependencies: string[] = []): Promise<LocalRemoval> {
  const resolved = path.resolve(root);
  await assertRealDirectory(resolved);
  const trash = path.join(trashDir, `${path.basename(resolved)}-teleport-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await rename(resolved, trash);
  const deletedDependencies: string[] = [];
  const retainedDependencies: string[] = [];
  for (const rel of dependencies) {
    try {
      const state = await dependencyDirectoryState(trash, rel);
      if (state === "missing") continue;
      if (state === "unsafe") {
        retainedDependencies.push(rel);
        continue;
      }
      await rm(path.join(trash, rel), { recursive: true });
      deletedDependencies.push(rel);
    } catch {
      // The project is already safely in Trash. Report a cleanup failure instead
      // of leaving the capsule marked active or deleting another path.
      retainedDependencies.push(rel);
    }
  }
  return { method: "trash", location: trash, deletedDependencies, retainedDependencies };
}

export async function assertRealDirectory(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`offload requires a real directory, not a symlink: ${root}`);
  }
}

async function dependencyDirectoryState(root: string, rel: string): Promise<"safe" | "missing" | "unsafe"> {
  const parts = rel.split("/");
  if (parts.at(-1) !== "node_modules" || parts.some((part) => !part || part === "." || part === "..")) return "unsafe";
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) return "missing";
    if (!info.isDirectory() || info.isSymbolicLink()) return "unsafe";
  }
  return "safe";
}
