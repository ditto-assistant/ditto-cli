import { stat } from "node:fs/promises";
import { git, gitOrThrow } from "./git.js";
import type { RepoHead, RepoManifest, RepoRemote } from "./types.js";

export interface RepoState {
  remotes: RepoRemote[];
  head: RepoHead;
  /** Local branch and tag names (the bundle carries their objects). */
  branches: string[];
  tags: string[];
  stashes: string[];
}

/** Reads remotes, HEAD, branches, tags and stashes of a repository. */
export function readRepoState(repoDir: string): RepoState {
  const remotes: RepoRemote[] = [];
  for (const line of gitOrThrow(["remote", "-v"], repoDir).split("\n")) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) remotes.push({ name: m[1], url: m[2] });
  }
  const headRes = git(["rev-parse", "HEAD"], repoDir);
  const sha = headRes.ok ? headRes.stdout.trim() : "";
  const branchRes = git(["symbolic-ref", "--quiet", "--short", "HEAD"], repoDir);
  const branch = branchRes.ok ? branchRes.stdout.trim() : undefined;
  const upstreamRes = branch ? git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoDir) : undefined;
  const upstream = upstreamRes?.ok ? upstreamRes.stdout.trim() : undefined;
  const branches: string[] = [];
  const tags: string[] = [];
  const refsOut = git(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"], repoDir);
  if (refsOut.ok) {
    for (const line of refsOut.stdout.split("\n")) {
      const ref = line.trim();
      if (!ref) continue;
      if (ref.startsWith("refs/heads/")) branches.push(ref.slice("refs/heads/".length));
      else if (ref.startsWith("refs/tags/")) tags.push(ref.slice("refs/tags/".length));
    }
  }
  const stashRes = git(["stash", "list", "--format=%H"], repoDir);
  const stashes = stashRes.ok ? stashRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const head: RepoHead = { sha };
  if (branch) head.branch = branch;
  if (upstream) head.upstream = upstream;
  return { remotes, head, branches, tags, stashes };
}

export interface BundleResult {
  file: string;
  kind: "full" | "thin";
  bytes: number;
}

/**
 * Writes a git bundle of every branch and tag. When `basisShas` are all known
 * locally the bundle is thin (only objects newer than the previous
 * generation); otherwise a full bundle is produced. An empty repository (no
 * commits) yields no bundle.
 */
export async function createBundle(repoDir: string, outFile: string, basisShas: string[] = []): Promise<BundleResult | null> {
  if (!git(["rev-parse", "--verify", "HEAD"], repoDir).ok) return null;
  const known = basisShas.filter((sha) => git(["cat-file", "-e", `${sha}^{commit}`], repoDir).ok);
  const thin = basisShas.length > 0 && known.length === basisShas.length;
  const args = ["bundle", "create", outFile, "--branches", "--tags", "HEAD"];
  if (thin) for (const sha of known) args.push(`^${sha}`);
  const res = git(args, repoDir);
  if (!res.ok) {
    if (thin && /empty bundle|Refusing to create empty bundle/i.test(res.stderr)) {
      return null; // nothing new since the basis generation
    }
    if (thin) {
      // basis mismatch of some kind: fall back to a full bundle rather than fail the push
      gitOrThrow(["bundle", "create", outFile, "--branches", "--tags", "HEAD"], repoDir);
      return { file: outFile, kind: "full", bytes: (await stat(outFile)).size };
    }
    throw new Error(`git bundle create failed in ${repoDir}: ${res.stderr.trim()}`);
  }
  return { file: outFile, kind: thin ? "thin" : "full", bytes: (await stat(outFile)).size };
}

/** `git bundle verify`; `repoDir` supplies prerequisites for thin bundles. */
export function verifyBundle(file: string, repoDir: string): boolean {
  return git(["bundle", "verify", file], repoDir).ok;
}

/**
 * Commits a thin bundle may assume present: the previous generation's head.
 * The manifest records branch names only, so the head sha is the one durable
 * basis; objects on branches not reachable from it are simply re-sent.
 */
export function basisFromPrevious(prev: RepoManifest | undefined): string[] {
  const sha = prev?.head?.sha;
  return sha ? [sha] : [];
}
