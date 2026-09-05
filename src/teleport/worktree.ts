import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { binaryAvailable, git } from "./git.js";
import { type Compression, DEFAULT_EXCLUDES, isExcluded } from "./types.js";

export interface WorktreeCapture {
  file: string;
  compression: Compression;
  entries: number;
  paths: string[];
}

/**
 * The tracked-but-modified and untracked files of a repository, minus excluded
 * paths and anything git ignores (unless force-included). This is the dirty
 * state a plain clone would not reproduce.
 */
export function dirtyPaths(repoDir: string, ignoredIncludes: string[] = []): string[] {
  const modified = git(["diff", "--name-only", "HEAD"], repoDir);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], repoDir);
  const set = new Set<string>();
  for (const out of [modified, untracked]) {
    if (!out.ok) continue;
    for (const raw of out.stdout.split("\n")) {
      const p = raw.trim();
      if (p && !isExcluded(p)) set.add(p);
    }
  }
  // A repo with no commits yet: capture everything git would track.
  if (!git(["rev-parse", "--verify", "HEAD"], repoDir).ok) {
    const all = git(["ls-files", "--others", "--exclude-standard", "--cached"], repoDir);
    if (all.ok) for (const raw of all.stdout.split("\n")) {
      const p = raw.trim();
      if (p && !isExcluded(p)) set.add(p);
    }
  }
  for (const pattern of ignoredIncludes) {
    const forced = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--", pattern], repoDir);
    if (forced.ok) for (const raw of forced.stdout.split("\n")) {
      const p = raw.trim();
      if (p && !isExcluded(p, DEFAULT_EXCLUDES.filter((e) => !matchesForce(pattern, e)))) set.add(p);
    }
  }
  return [...set].sort();
}

function matchesForce(pattern: string, exclude: string): boolean {
  return pattern === exclude || pattern.replace(/\/$/, "") === exclude.replace(/\/$/, "");
}

export function pickCompression(): Compression {
  return binaryAvailable("zstd") ? "zstd" : "gzip";
}

/** Tars the given repo-relative paths into `outFile`, compressed. Empty list → null. */
export async function captureWorktree(
  repoDir: string,
  paths: string[],
  outFile: string,
  compression: Compression = pickCompression(),
): Promise<WorktreeCapture | null> {
  if (paths.length === 0) return null;
  await mkdir(path.dirname(outFile), { recursive: true });
  const flag = compression === "zstd" ? "--zstd" : "--gzip";
  // -T - reads the file list from stdin (NUL-safe), so odd filenames survive.
  const res = spawnSync("tar", ["-c", flag, "-f", outFile, "-C", repoDir, "--null", "-T", "-"], {
    input: `${paths.join("\0")}\0`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    await rm(outFile, { force: true });
    throw new Error(`tar failed for ${repoDir}: ${res.stderr?.toString().trim()}`);
  }
  return { file: outFile, compression, entries: paths.length, paths };
}

/** Extracts a worktree tar into `destDir`. */
export function extractWorktree(file: string, destDir: string, compression: Compression): void {
  const flag = compression === "zstd" ? "--zstd" : "--gzip";
  const res = spawnSync("tar", ["-x", flag, "-f", file, "-C", destDir], { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`tar extract failed: ${res.stderr?.toString().trim()}`);
}

/** Opens a readable stream for a captured file, for chunking. */
export function openFile(file: string): NodeJS.ReadableStream {
  return createReadStream(file);
}
