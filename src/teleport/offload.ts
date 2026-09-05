import { rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, isGitRepo } from "./git.js";
import * as tapi from "./api.js";
import { discoverRepos } from "./discover.js";

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
      if (hasCommits) out.push({ relPath: rel, branch, ahead: 0, reason: "branch has no upstream" });
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

/**
 * Removes the local root once its capsule is verified. On macOS the root is
 * moved into the user's Trash so it is trivially recoverable; elsewhere it is
 * deleted. Never called unless `waitForOffloadReady` returned ready.
 */
export async function deleteLocalRoot(root: string): Promise<{ method: "trash" | "rm"; location?: string }> {
  const resolved = path.resolve(root);
  await stat(resolved); // throws if already gone
  if (process.platform === "darwin") {
    const trash = path.join(os.homedir(), ".Trash", `${path.basename(resolved)}-teleport-${Date.now()}`);
    try {
      await rename(resolved, trash);
      return { method: "trash", location: trash };
    } catch {
      // cross-device rename into Trash can fail; fall back to rm
    }
  }
  await rm(resolved, { recursive: true, force: true });
  return { method: "rm" };
}
