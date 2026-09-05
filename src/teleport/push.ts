import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageVersion } from "../config.js";
import * as tapi from "./api.js";
import { basisFromRefs, createBundle, readRepoState } from "./bundle.js";
import { chunkFile, dedupedBytes } from "./chunks.js";
import { discoverRepos } from "./discover.js";
import { locateHarness } from "./harness.js";
import { readChunk } from "./chunks.js";
import { captureWorktree, dirtyPaths, pickCompression } from "./worktree.js";
import { captureHarness } from "./harness.js";
import {
  type ChunkRef,
  type HarnessKind,
  type Manifest,
  type RepoManifest,
  DEFAULT_EXCLUDES,
  machineInfo,
} from "./types.js";

const PUT_CONCURRENCY = 4;
const NEGOTIATE_BATCH = 200;

export interface PushInput {
  root: string;
  capsuleId: string;
  parentGeneration: number | null;
  /** Previous generation's manifest, for thin bundles. */
  previousManifest?: Manifest;
  harness: { kind: HarnessKind; sessionId?: string; cwd?: string };
  ignoredIncludes: string[];
  rootName: string;
  rootKind: "repo" | "folder";
}

export interface PushOutput {
  generation: number;
  bytesTotal: number;
  dedupedBytes: number;
  chunkCount: number;
  uploaded: number;
  reused: number;
}

/** Maps a chunk sha256 to the local file + window it came from, for upload. */
interface ChunkSource {
  file: string;
  index: number;
  size: number;
}

/**
 * Builds a generation, negotiates which chunks are missing, uploads them via
 * presigned PUTs, then commits the manifest. The manifest is content-addressed
 * too, so a re-push with no changes uploads nothing.
 */
export async function pushCapsule(input: PushInput): Promise<PushOutput> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "teleport-push-"));
  const compression = pickCompression();
  const generation = (input.parentGeneration ?? 0) + 1;
  const sources = new Map<string, ChunkSource>();
  const allChunks: ChunkRef[] = [];
  try {
    const discovery = await discoverRepos(input.root);
    const prevByRel = new Map<string, RepoManifest>();
    for (const r of input.previousManifest?.repos ?? []) prevByRel.set(r.relPath, r);

    const repos: RepoManifest[] = [];
    for (const rel of discovery.repos) {
      const repoDir = rel === "." ? discovery.root : path.join(discovery.root, rel);
      const state = readRepoState(repoDir);
      const prev = prevByRel.get(rel);
      const basis = basisFromRefs(prev?.refs);
      const bundleFile = path.join(tmp, `bundle-${safe(rel)}.bundle`);
      const bundle = await createBundle(repoDir, bundleFile, basis);
      const packChunks = bundle ? await addFileChunks(bundle.file, sources, allChunks) : [];
      const dirty = dirtyPaths(repoDir, input.ignoredIncludes);
      const wtFile = path.join(tmp, `worktree-${safe(rel)}.tar`);
      const capture = await captureWorktree(repoDir, dirty, wtFile, compression);
      const wtChunks = capture ? await addFileChunks(capture.file, sources, allChunks) : [];
      repos.push({
        relPath: rel,
        remotes: state.remotes,
        head: state.head,
        refs: state.refs,
        stashes: state.stashes,
        packs: bundle ? [{ kind: bundle.kind, basisGeneration: bundle.kind === "thin" ? input.parentGeneration ?? undefined : undefined, chunks: packChunks }] : [],
        worktree: capture ? { compression, chunks: wtChunks, entries: capture.entries, bytes: bundleBytes(wtChunks) } : null,
        ignoredIncludes: input.ignoredIncludes,
      });
    }

    // Harness transcript.
    let harnessChunks: ChunkRef[] = [];
    let harnessCompression: Manifest["harness"]["compression"] = null;
    let harnessSessionId = input.harness.sessionId ?? null;
    let harnessCwd = input.harness.cwd ?? null;
    if (input.harness.kind !== "none" && input.harness.sessionId && input.harness.cwd) {
      const loc = await locateHarness(input.harness.kind, input.harness.sessionId, input.harness.cwd);
      if (loc) {
        const hFile = path.join(tmp, "harness.tar");
        const cap = await captureHarness(loc, hFile, compression);
        if (cap) {
          harnessChunks = await addFileChunks(cap.file, sources, allChunks);
          harnessCompression = compression;
        }
      }
    }

    const bytesTotal = allChunks.reduce((n, c) => n + c.size, 0);
    const manifest: Manifest = {
      version: 1,
      capsuleId: input.capsuleId,
      generation,
      parentGeneration: input.parentGeneration,
      createdAt: new Date().toISOString(),
      machine: machineInfo(packageVersion),
      root: { kind: input.rootKind, name: input.rootName },
      repos,
      harness: { kind: input.harness.kind, sessionId: harnessSessionId, cwd: harnessCwd, compression: harnessCompression, chunks: harnessChunks },
      excludes: [...DEFAULT_EXCLUDES],
      totals: { chunks: allChunks.length, bytes: bytesTotal, dedupedBytes: dedupedBytes(allChunks) },
    };

    // Distinct chunks, negotiate in batches.
    const distinct = new Map<string, ChunkRef>();
    for (const c of allChunks) distinct.set(c.sha256, c);
    const wanted = [...distinct.values()];
    let uploaded = 0;
    for (let i = 0; i < wanted.length; i += NEGOTIATE_BATCH) {
      const batch = wanted.slice(i, i + NEGOTIATE_BATCH);
      const neg = await tapi.negotiate(input.capsuleId, {
        generation,
        parentGeneration: input.parentGeneration,
        chunks: batch.map((c) => ({ sha256: c.sha256, size: c.size })),
      });
      await uploadMissing(neg.missing, sources);
      uploaded += neg.missing.length;
    }

    await tapi.commit(input.capsuleId, { generation, manifest });
    return {
      generation,
      bytesTotal,
      dedupedBytes: manifest.totals.dedupedBytes,
      chunkCount: distinct.size,
      uploaded,
      reused: distinct.size - uploaded,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function addFileChunks(
  file: string,
  sources: Map<string, ChunkSource>,
  all: ChunkRef[],
): Promise<ChunkRef[]> {
  const refs = await chunkFile(file);
  refs.forEach((r, index) => {
    all.push(r);
    if (!sources.has(r.sha256)) sources.set(r.sha256, { file, index, size: r.size });
  });
  return refs;
}

async function uploadMissing(
  missing: tapi.NegotiateResponse["missing"],
  sources: Map<string, ChunkSource>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PUT_CONCURRENCY, missing.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= missing.length) return;
      const item = missing[i];
      const src = sources.get(item.sha256);
      if (!src) throw new Error(`server asked for an unknown chunk ${item.sha256}`);
      const body = await readChunk(src.file, src.index);
      await putWithRetry(item.putUrl, body);
    }
  });
  await Promise.all(workers);
}

async function putWithRetry(url: string, body: Buffer, attempts = 4): Promise<void> {
  let delay = 400;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: "PUT", body });
    if (res.ok) return;
    if (attempt >= attempts || (res.status < 500 && res.status !== 429)) {
      throw new Error(`chunk upload failed: HTTP ${res.status}`);
    }
    await sleep(delay);
    delay *= 2;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bundleBytes(chunks: ChunkRef[]): number {
  return chunks.reduce((n, c) => n + c.size, 0);
}

function safe(rel: string): string {
  return rel.replace(/[^A-Za-z0-9._-]/g, "_") || "root";
}
