import { spawnSync } from "node:child_process";
import { closeSync, createReadStream, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
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
export function dirtyPaths(repoDir: string, ignoredIncludes: string[] = [], excludes: readonly string[] = DEFAULT_EXCLUDES): string[] {
  const modified = git(["diff", "--name-only", "HEAD"], repoDir);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], repoDir);
  const set = new Set<string>();
  for (const out of [modified, untracked]) {
    if (!out.ok) continue;
    for (const raw of out.stdout.split("\n")) {
      const p = raw.trim();
      if (p && !isExcluded(p, excludes)) set.add(p);
    }
  }
  // A repo with no commits yet: capture everything git would track.
  if (!git(["rev-parse", "--verify", "HEAD"], repoDir).ok) {
    const all = git(["ls-files", "--others", "--exclude-standard", "--cached"], repoDir);
    if (all.ok) for (const raw of all.stdout.split("\n")) {
      const p = raw.trim();
      if (p && !isExcluded(p, excludes)) set.add(p);
    }
  }
  for (const pattern of ignoredIncludes) {
    const forced = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--", pattern], repoDir);
    if (forced.ok) for (const raw of forced.stdout.split("\n")) {
      const p = raw.trim();
      if (p && !isExcluded(p, excludes.filter((e) => !matchesForce(pattern, e)))) set.add(p);
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
  // COPYFILE_DISABLE keeps macOS tar from emitting ._* AppleDouble entries.
  const res = spawnSync("tar", ["-c", flag, "-f", outFile, "-C", repoDir, "--null", "-T", "-"], {
    input: `${paths.join("\0")}\0`,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (res.status !== 0) {
    await rm(outFile, { force: true });
    throw new Error(`tar failed for ${repoDir}: ${res.stderr?.toString().trim()}`);
  }
  return { file: outFile, compression, entries: paths.length, paths };
}

/** Reads the compression of a captured tar from its magic bytes (the manifest does not record it). */
export function detectCompression(file: string): Compression {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    const n = readSync(fd, head, 0, 4, 0);
    if (n >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return "zstd";
    return "gzip";
  } finally {
    closeSync(fd);
  }
}

/** Extracts a worktree tar into `destDir`; compression is detected from the file when not given. */
export interface ExtractOptions {
  /** Override zstd binary detection (tests). */
  zstdAvailable?: boolean;
  /** Allow decompressing with Node's zlib when the zstd binary is missing (default true). */
  allowNodeFallback?: boolean;
}

export function extractWorktree(
  file: string,
  destDir: string,
  compression: Compression = detectCompression(file),
  opts: ExtractOptions = {},
): void {
  if (compression === "zstd") {
    const haveBinary = opts.zstdAvailable ?? binaryAvailable("zstd");
    if (!haveBinary) {
      const zstdDecompressSync = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
      if ((opts.allowNodeFallback ?? true) && typeof zstdDecompressSync === "function") {
        // No zstd binary here, but this Node can inflate zstd itself.
        const plain = `${file}.tar`;
        writeFileSync(plain, zstdDecompressSync(readFileSync(file)));
        try {
          extractPlainTar(plain, destDir);
        } finally {
          rmSync(plain, { force: true });
        }
        return;
      }
      throw new Error(
        "this capsule's worktree is zstd-compressed but the 'zstd' binary is not installed on this machine " +
          "(install it: `brew install zstd` on macOS, `apt install zstd` on Debian/Ubuntu) and this Node version " +
          "cannot decompress zstd itself (needs zlib.zstdDecompressSync).",
      );
    }
  }
  const flag = compression === "zstd" ? "--zstd" : "--gzip";
  const res = spawnSync("tar", ["-x", flag, "-f", file, "-C", destDir], { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`tar extract failed: ${res.stderr?.toString().trim()}`);
}

function extractPlainTar(file: string, destDir: string): void {
  const res = spawnSync("tar", ["-x", "-f", file, "-C", destDir], { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`tar extract failed: ${res.stderr?.toString().trim()}`);
}

/** Opens a readable stream for a captured file, for chunking. */
export function openFile(file: string): NodeJS.ReadableStream {
  return createReadStream(file);
}
