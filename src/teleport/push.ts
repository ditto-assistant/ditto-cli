import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { packageVersion } from "../config.js";
import * as tapi from "./api.js";
import { basisFromPrevious, createBundle, readRepoState } from "./bundle.js";
import { chunkFile, dedupedBytes, readChunk, sha256 } from "./chunks.js";
import { discoverRepos } from "./discover.js";
import { captureHarness, locateHarness } from "./harness.js";
import { captureWorktree, dirtyPaths, pickCompression } from "./worktree.js";
import {
  type ChunkRef,
  type HarnessKind,
  type HarnessState,
  type Manifest,
  type RepoManifest,
  type RepoPack,
  DEFAULT_EXCLUDES,
  MANIFEST_VERSION,
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
  /** Who is committing: the CLI on a user's machine, or the Ditto Code runner. */
  committedBy?: tapi.CommittedBy;
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
      const basis = basisFromPrevious(prev);
      const bundleFile = path.join(tmp, `bundle-${safe(rel)}.bundle`);
      const bundle = await createBundle(repoDir, bundleFile, basis);
      const packChunks = bundle ? await addFileChunks(bundle.file, sources, allChunks) : [];
      const dirty = dirtyPaths(repoDir, input.ignoredIncludes);
      const wtFile = path.join(tmp, `worktree-${safe(rel)}.tar`);
      const capture = await captureWorktree(repoDir, dirty, wtFile, compression);
      const wtChunks = capture ? await addFileChunks(capture.file, sources, allChunks) : [];
      const packs: RepoPack[] = [];
      if (bundle) {
        const pack: RepoPack = { kind: bundle.kind, chunks: packChunks };
        if (bundle.kind === "thin" && input.parentGeneration) pack.basisGeneration = input.parentGeneration;
        packs.push(pack);
      }
      const repo: RepoManifest = {
        head: state.head,
        relPath: rel,
        remotes: state.remotes,
        packs,
        worktree: capture
          ? { chunks: wtChunks, entries: capture.entries, bytes: bundleBytes(wtChunks) }
          : { chunks: [], entries: 0, bytes: 0 },
      };
      if (state.branches.length) repo.branches = state.branches;
      if (state.tags.length) repo.tags = state.tags;
      if (state.stashes.length) repo.stashes = state.stashes;
      if (input.ignoredIncludes.length) repo.ignoredIncludes = input.ignoredIncludes;
      repos.push(repo);
    }

    // Harness transcript.
    const harness: HarnessState = { kind: input.harness.kind, chunks: [] };
    if (input.harness.sessionId) harness.sessionId = input.harness.sessionId;
    if (input.harness.cwd) harness.cwd = input.harness.cwd;
    if (input.harness.kind !== "none" && input.harness.sessionId && input.harness.cwd) {
      const loc = await locateHarness(input.harness.kind, input.harness.sessionId, input.harness.cwd);
      if (loc) {
        const hFile = path.join(tmp, "harness.tar");
        const cap = await captureHarness(loc, hFile, compression);
        if (cap) harness.chunks = await addFileChunks(cap.file, sources, allChunks);
      }
    }

    const bytesTotal = allChunks.reduce((n, c) => n + c.size, 0);
    const manifest: Manifest = {
      v: MANIFEST_VERSION,
      capsuleId: input.capsuleId,
      generation,
      parentGeneration: input.parentGeneration ?? 0,
      createdAt: new Date().toISOString(),
      machine: machineInfo(packageVersion),
      root: { kind: input.rootKind, name: input.rootName },
      repos,
      excludes: [...DEFAULT_EXCLUDES],
      harness,
      totals: { chunks: allChunks.length, bytes: bytesTotal, dedupedBytes: dedupedBytes(allChunks) },
    };

    // The manifest is itself a chunk: write it, hash it, and negotiate it with
    // the rest so commit can reference it by sha256.
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestSha256 = sha256(manifestBytes);
    const manifestFile = path.join(tmp, "manifest.json");
    await writeFile(manifestFile, manifestBytes);
    const manifestRef: ChunkRef = { sha256: manifestSha256, size: manifestBytes.length };
    allChunks.push(manifestRef);
    if (!sources.has(manifestSha256)) sources.set(manifestSha256, { file: manifestFile, index: 0, size: manifestBytes.length });

    // Distinct chunks, negotiate in batches of ≤ 200.
    const distinct = new Map<string, ChunkRef>();
    for (const c of allChunks) distinct.set(c.sha256, c);
    const wanted = [...distinct.values()];
    let uploaded = 0;
    for (let i = 0; i < wanted.length; i += NEGOTIATE_BATCH) {
      const batch = wanted.slice(i, i + NEGOTIATE_BATCH);
      const neg = await tapi.negotiate(
        input.capsuleId,
        batch.map((c) => ({ sha256: c.sha256, size: c.size })),
      );
      await uploadMissing(neg.missing, sources);
      uploaded += neg.missing.length;
    }

    const committed = await tapi.commit(input.capsuleId, {
      manifest,
      manifestSha256,
      committedBy: input.committedBy ?? detectCommitter(),
    });
    return {
      // The server's generation record is authoritative for the number.
      generation: committed.generation?.generation ?? generation,
      bytesTotal,
      dedupedBytes: manifest.totals.dedupedBytes ?? 0,
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

/** The Ditto Code runner authenticates with a ditto_agent_ token and pins the harness session via env. */
export function detectCommitter(): tapi.CommittedBy {
  const key = process.env.DITTO_API_KEY ?? "";
  if (key.startsWith("ditto_agent_") || process.env.TELEPORT_HARNESS_SESSION_ID) return "runner";
  return "cli";
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
