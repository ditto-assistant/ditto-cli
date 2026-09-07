import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, gitOrThrow, isGitRepo } from "./git.js";
import { restoreClaudeTranscript } from "./harness.js";
import { detectCompression, extractWorktree } from "./worktree.js";
import type { Manifest, RepoManifest } from "./types.js";

export interface RestoreResult {
  root: string;
  repos: string[];
  harnessSessionId: string | null;
  harnessCwd: string | null;
}

/**
 * Rebuilds a capsule from its manifest and the downloaded chunk files (keyed by
 * sha256). Each repo is reconstructed from its bundle(s), branches and
 * upstreams are restored, the dirty worktree is untarred over the checkout, and
 * the harness transcript (if any) is placed under the restored cwd.
 */
export async function restoreCapsule(
  manifest: Manifest,
  chunkPath: (sha256: string) => string,
  destRoot: string,
  opts: { restoreHarness?: boolean } = {},
): Promise<RestoreResult> {
  await mkdir(destRoot, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "teleport-restore-"));
  try {
    const repos: string[] = [];
    for (const repo of manifest.repos) {
      const repoDest = path.resolve(destRoot, repo.relPath);
      await mkdir(repoDest, { recursive: true });
      await restoreRepo(repo, chunkPath, repoDest, tmp);
      repos.push(repo.relPath);
    }
    let harnessCwd: string | null = null;
    if (opts.restoreHarness && manifest.harness.kind !== "none" && manifest.harness.chunks.length > 0) {
      const tar = path.join(tmp, "harness.tar");
      await concatChunks(manifest.harness.chunks.map((c) => c.sha256), chunkPath, tar);
      const originalCwd = manifest.harness.cwd ?? destRoot;
      const targetCwd =
        manifest.root.kind === "repo" ? path.resolve(destRoot, manifest.repos[0]?.relPath ?? ".") : destRoot;
      const compression = detectCompression(tar);
      if (manifest.harness.kind === "claude-code" && manifest.harness.sessionId) {
        await restoreClaudeTranscript(tar, compression, manifest.harness.sessionId, originalCwd, targetCwd);
      } else {
        // Codex keys transcripts on absolute cwd inside a shared home; extract as-is.
        extractWorktree(tar, os.homedir(), compression);
      }
      harnessCwd = targetCwd;
    }
    return { root: destRoot, repos, harnessSessionId: manifest.harness.sessionId ?? null, harnessCwd };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function restoreRepo(
  repo: RepoManifest,
  chunkPath: (sha256: string) => string,
  repoDest: string,
  tmp: string,
): Promise<void> {
  const hasBundle = repo.packs.some((p) => p.chunks.length > 0);
  if (hasBundle) {
    // Reassemble every pack into one bare prerequisite repo, then clone from it
    // (a fetch into a repo whose branch is checked out is refused by git).
    const bundleDir = path.join(tmp, `bundles-${sanitize(repo.relPath)}`);
    await mkdir(bundleDir, { recursive: true });
    const scratch = path.join(tmp, `scratch-${sanitize(repo.relPath)}`);
    gitOrThrow(["init", "--bare", scratch], tmp);
    // Full packs first, then thin packs oldest basis → newest, so every
    // bundle's prerequisites are present before it is fetched.
    const ordered = [...repo.packs].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "full" ? -1 : 1;
      return (a.basisGeneration ?? 0) - (b.basisGeneration ?? 0);
    });
    for (let i = 0; i < ordered.length; i++) {
      const bundleFile = path.join(bundleDir, `pack-${i}.bundle`);
      await concatChunks(ordered[i].chunks.map((c) => c.sha256), chunkPath, bundleFile);
      gitOrThrow(["fetch", "--tags", bundleFile, "+refs/*:refs/*"], scratch);
    }
    // Clone the bare repo into the destination: this copies every branch and
    // tag with a real working tree, without a fetch-into-checked-out-branch.
    gitOrThrow(["clone", scratch, repoDest], tmp);
    // Local tracking branches for every branch the capsule carried, so a later
    // checkout of any of them works offline.
    for (const branch of repo.branches ?? []) {
      if (git(["rev-parse", "--verify", `refs/heads/${branch}`], repoDest).ok) continue;
      git(["branch", "--no-track", branch, `refs/remotes/origin/${branch}`], repoDest);
    }
    git(["remote", "remove", "origin"], repoDest);
  } else if (!isGitRepo(repoDest)) {
    gitOrThrow(["init", repoDest], tmp);
  }
  // Remotes.
  for (const remote of repo.remotes) {
    if (git(["remote", "get-url", remote.name], repoDest).ok) {
      git(["remote", "set-url", remote.name, remote.url], repoDest);
    } else {
      git(["remote", "add", remote.name, remote.url], repoDest);
    }
  }
  // Check out the recorded HEAD/branch and re-establish upstream tracking.
  if (repo.head.branch && (repo.branches ?? []).includes(repo.head.branch)) {
    gitOrThrow(["checkout", "-f", repo.head.branch], repoDest);
    if (repo.head.upstream) restoreUpstream(repoDest, repo, repo.head.branch, repo.head.upstream);
  } else if (repo.head.sha) {
    gitOrThrow(["checkout", "-f", repo.head.sha], repoDest);
  }
  // Dirty worktree over the checkout.
  if (repo.worktree?.chunks?.length) {
    const tar = path.join(tmp, `worktree-${sanitize(repo.relPath)}.tar`);
    await concatChunks(repo.worktree.chunks.map((c) => c.sha256), chunkPath, tar);
    extractWorktree(tar, repoDest);
  }
}

/**
 * Recreates `<remote>/<branch>` tracking without a network fetch. The clone we
 * restore from has no remote-tracking refs (its origin was the scratch repo),
 * so `branch --set-upstream-to` would fail; instead the tracking ref is
 * pointed at the branch tip the capsule recorded, then the upstream is set.
 * The tip is the last state this machine knew of the upstream, so ahead/behind
 * reads 0 until the next fetch. Any failure here is a hard error: silently
 * losing tracking is exactly the bug this guards against.
 */
function restoreUpstream(repoDest: string, repo: RepoManifest, branch: string, upstream: string): void {
  const remote = repo.remotes.find((r) => upstream === r.name || upstream.startsWith(`${r.name}/`));
  if (!remote) {
    throw new Error(`cannot restore upstream ${upstream} for ${branch}: remote is not in the capsule (${repo.remotes.map((r) => r.name).join(", ") || "none"})`);
  }
  const remoteBranch = upstream.slice(remote.name.length + 1);
  if (!remoteBranch) throw new Error(`cannot restore upstream ${upstream}: no branch component`);
  const tip = gitOrThrow(["rev-parse", "--verify", `refs/heads/${branch}`], repoDest).trim();
  gitOrThrow(["update-ref", `refs/remotes/${remote.name}/${remoteBranch}`, tip], repoDest);
  gitOrThrow(["branch", `--set-upstream-to=${upstream}`, branch], repoDest);
}

async function concatChunks(
  shas: string[],
  chunkPath: (sha256: string) => string,
  outFile: string,
): Promise<void> {
  const { createWriteStream } = await import("node:fs");
  const { readFile } = await import("node:fs/promises");
  const ws = createWriteStream(outFile);
  try {
    for (const sha of shas) {
      const buf = await readFile(chunkPath(sha));
      await new Promise<void>((resolve, reject) => ws.write(buf, (err) => (err ? reject(err) : resolve())));
    }
  } finally {
    await new Promise<void>((resolve) => ws.end(resolve));
  }
  void writeFile; // keep import set stable if unused in future edits
}

function sanitize(rel: string): string {
  return rel.replace(/[^A-Za-z0-9._-]/g, "_") || "root";
}
