/**
 * Teleport data model. A capsule is one teleportable root (a repo or a folder
 * of repos) plus the coding-harness session that was working in it. Every
 * push appends an immutable generation; only content-addressed chunks
 * (≤ 24 MiB) ever reach object storage, and the manifest is itself a chunk.
 */

import os from "node:os";

/** Chunk size: below the storage providers' 25 MB single-object cap. */
export const CHUNK_BYTES = 24 * 1024 * 1024;
export const MANIFEST_VERSION = 1;

export type RootKind = "repo" | "folder";
export type HarnessKind = "claude-code" | "codex" | "none";
export type Compression = "zstd" | "gzip";

export interface ChunkRef {
  sha256: string;
  size: number;
}

export interface RepoPack {
  kind: "full" | "thin";
  basisGeneration?: number;
  chunks: ChunkRef[];
}

export interface RepoRemote {
  name: string;
  url: string;
}

export interface RepoHead {
  sha: string;
  /** Current branch, or null when detached. */
  branch: string | null;
  /** Upstream ref such as origin/main, when configured. */
  upstream: string | null;
}

export interface RepoRefs {
  /** Local branch name → commit sha. */
  branches: Record<string, string>;
  tags: Record<string, string>;
}

export interface RepoManifest {
  relPath: string;
  remotes: RepoRemote[];
  head: RepoHead;
  refs: RepoRefs;
  stashes: string[];
  packs: RepoPack[];
  worktree: {
    compression: Compression;
    chunks: ChunkRef[];
    entries: number;
    bytes: number;
  } | null;
  ignoredIncludes: string[];
}

export interface HarnessState {
  kind: HarnessKind;
  sessionId: string | null;
  /** Absolute working directory the harness session was recorded under. */
  cwd: string | null;
  compression: Compression | null;
  chunks: ChunkRef[];
}

export interface Manifest {
  version: number;
  capsuleId: string;
  generation: number;
  parentGeneration: number | null;
  createdAt: string;
  machine: { hostname: string; os: string; arch: string; cliVersion: string };
  root: { kind: RootKind; name: string };
  repos: RepoManifest[];
  harness: HarnessState;
  excludes: string[];
  totals: { chunks: number; bytes: number; dedupedBytes: number };
}

/** Paths that never travel in a capsule: secrets, caches and build output. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  ".npmrc",
  ".netrc",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "target/",
  "dist/",
  "build/",
  ".next/",
  ".turbo/",
  ".cache/",
  ".gobuildtmp/",
  ".worktrees/",
];

/** Claude Code keys its project dir on the absolute cwd with `/` and `:` replaced by `-`. */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/[:\\/]/g, "-");
}

export function machineInfo(cliVersion: string): Manifest["machine"] {
  return { hostname: os.hostname(), os: process.platform, arch: process.arch, cliVersion };
}

/** True when a repo-relative path matches one of the exclude globs. */
export function isExcluded(relPath: string, excludes: readonly string[] = DEFAULT_EXCLUDES): boolean {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1];
  for (const pattern of excludes) {
    if (pattern.endsWith("/")) {
      const dir = pattern.slice(0, -1);
      if (segments.slice(0, -1).includes(dir)) return true;
      continue;
    }
    if (globMatch(pattern, base)) return true;
  }
  return false;
}

/** Minimal glob: `*` matches within a name; `?` one char. Case-sensitive. */
export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split("")
      .map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  );
  return re.test(name);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
