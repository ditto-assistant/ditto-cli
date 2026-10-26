import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { packageVersion } from "../config.js";
import * as tapi from "./api.js";
import { CHUNK_BYTES, MANIFEST_VERSION, machineInfo, type ChunkRef } from "./types.js";

/**
 * Archive capsules back up trees that only grow: coding-agent session
 * history and local recovery data. Each source is one tar stream, cut into
 * content-defined chunks (gear rolling hash) so an append or an edit only
 * changes the chunks around it, and every chunk is zstd-compressed on its own
 * so it dedupes by content and restores without its neighbours. The manifest
 * lists the chunks in order; restore decompresses and concatenates them.
 */

export interface ArchiveSource {
  /** Unique name in the capsule, e.g. "claude-code". */
  name: string;
  /** Directory whose contents are archived (paths stored relative to it). */
  dir: string;
}

export interface ArchiveEntry {
  name: string;
  format: "tar";
  chunkCompression: "zstd";
  chunks: ChunkRef[];
  entries: number;
  bytes: number;
}

export interface ArchiveManifest {
  v: number;
  capsuleId: string;
  generation: number;
  parentGeneration: number;
  createdAt: string;
  machine: Record<string, unknown>;
  root: { kind: "archive"; name: string };
  repos: [];
  archives: ArchiveEntry[];
  harness: { kind: "none"; chunks: [] };
  totals: { chunks: number; bytes: number; dedupedBytes?: number };
}

const MIN_CHUNK = 512 * 1024;
const AVG_BITS = 21; // ~2 MiB average
const MAX_CHUNK = 8 * 1024 * 1024;
const MASK = (1 << AVG_BITS) - 1;
const NEGOTIATE_BATCH = 200;
const PUT_CONCURRENCY = 4;

/** Deterministic gear table: chunk boundaries must match across machines. */
const GEAR = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    t[i] = createHash("sha256").update(`ditto-archive-gear-${i}`).digest().readUInt32LE(0);
  }
  return t;
})();

/**
 * Content-defined boundaries over a buffer: a cut where the rolling hash's low
 * bits are zero, bounded by MIN_CHUNK and MAX_CHUNK. Exported for tests.
 */
export function cdcBoundaries(buf: Buffer): number[] {
  const cuts: number[] = [];
  let start = 0;
  while (start < buf.length) {
    const end = Math.min(buf.length, start + MAX_CHUNK);
    let cut = end;
    let h = 0;
    for (let i = start + MIN_CHUNK; i < end; i++) {
      h = ((h << 1) + GEAR[buf[i]]) >>> 0;
      if ((h & MASK) === 0) {
        cut = i + 1;
        break;
      }
    }
    cuts.push(cut);
    start = cut;
  }
  return cuts;
}

export interface BuiltArchive {
  entry: ArchiveEntry;
  /** sha256 → compressed bytes on disk, for upload. */
  files: Map<string, string>;
}

/**
 * Tars `src.dir` and writes each compressed chunk into `outDir`. The tar is
 * read through a window of at most MAX_CHUNK + one read, so memory stays
 * bounded however large the source grows; boundaries match cdcBoundaries.
 */
export async function buildArchive(src: ArchiveSource, outDir: string): Promise<BuiltArchive> {
  const tarFile = path.join(outDir, `${safe(src.name)}.tar`);
  const entries = await tarDirectory(src.dir, tarFile);
  const chunks: ChunkRef[] = [];
  const files = new Map<string, string>();
  let bytes = 0;
  const emit = async (piece: Buffer) => {
    const z = zstdCompressSync(piece);
    if (z.length > CHUNK_BYTES) throw new Error(`compressed chunk exceeds ${CHUNK_BYTES} bytes`);
    const sha = createHash("sha256").update(z).digest("hex");
    chunks.push({ sha256: sha, size: z.length });
    if (!files.has(sha)) {
      const file = path.join(outDir, sha);
      await writeFile(file, z);
      files.set(sha, file);
    }
  };
  try {
    let pending: Buffer = Buffer.alloc(0);
    for await (const piece of createReadStream(tarFile, { highWaterMark: 1 << 20 })) {
      const buf = piece as Buffer;
      bytes += buf.length;
      pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
      // A cut is final once MAX_CHUNK bytes follow its start: later data
      // can't move it. Keep the unfinished tail.
      while (pending.length >= MAX_CHUNK) {
        const cut = cdcBoundaries(pending.subarray(0, MAX_CHUNK))[0];
        await emit(Buffer.from(pending.subarray(0, cut)));
        pending = Buffer.from(pending.subarray(cut));
      }
    }
    // The tail is under MAX_CHUNK; its cuts are offsets into this buffer.
    let start = 0;
    for (const cut of cdcBoundaries(pending)) {
      await emit(Buffer.from(pending.subarray(start, cut)));
      start = cut;
    }
  } finally {
    await rm(tarFile, { force: true });
  }
  return { entry: { name: src.name, format: "tar", chunkCompression: "zstd", chunks, entries, bytes }, files };
}

/** tar with paths relative to `dir`; returns the entry count. */
async function tarDirectory(dir: string, outFile: string): Promise<number> {
  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error(`${dir} is not a directory`);
  const list = await run("tar", ["-c", "-f", outFile, "-C", dir, "."]);
  if (list.code !== 0) throw new Error(`tar failed for ${dir}: ${list.stderr.trim()}`);
  const count = await run("tar", ["-t", "-f", outFile]);
  return count.stdout.split("\n").filter((l) => l && !l.endsWith("/")).length;
}

export interface ArchivePushOutput {
  generation: number;
  logicalBytes: number;
  storedBytes: number;
  uploadedBytes: number;
  uploaded: number;
  reused: number;
  archives: { name: string; entries: number; bytes: number; chunks: number }[];
}

/** Builds every source, uploads only chunks the server lacks, commits a generation. */
export async function pushArchive(capsuleId: string, rootName: string, sources: ArchiveSource[], parentGeneration: number): Promise<ArchivePushOutput> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "teleport-archive-"));
  try {
    const archives: ArchiveEntry[] = [];
    const files = new Map<string, string>();
    for (const src of sources) {
      const built = await buildArchive(src, tmp);
      archives.push(built.entry);
      for (const [sha, file] of built.files) files.set(sha, file);
    }
    const all = archives.flatMap((a) => a.chunks);
    const distinct = new Map<string, ChunkRef>();
    for (const c of all) distinct.set(c.sha256, c);
    const generation = parentGeneration + 1;
    const manifest: ArchiveManifest = {
      v: MANIFEST_VERSION,
      capsuleId,
      generation,
      parentGeneration,
      createdAt: new Date().toISOString(),
      machine: machineInfo(packageVersion) as unknown as Record<string, unknown>,
      root: { kind: "archive", name: rootName },
      repos: [],
      archives,
      harness: { kind: "none", chunks: [] },
      totals: { chunks: distinct.size, bytes: [...distinct.values()].reduce((n, c) => n + c.size, 0) },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
    const manifestFile = path.join(tmp, "manifest.json");
    const fh = await open(manifestFile, "w");
    await fh.writeFile(manifestBytes);
    await fh.close();
    files.set(manifestSha, manifestFile);
    distinct.set(manifestSha, { sha256: manifestSha, size: manifestBytes.length });

    const wanted = [...distinct.values()];
    let uploaded = 0;
    let uploadedBytes = 0;
    for (let i = 0; i < wanted.length; i += NEGOTIATE_BATCH) {
      const neg = await tapi.negotiate(capsuleId, wanted.slice(i, i + NEGOTIATE_BATCH));
      await uploadAll(neg.missing, files);
      uploaded += neg.missing.length;
      for (const m of neg.missing) uploadedBytes += m.size;
    }
    const committed = await tapi.commit(capsuleId, { manifest: manifest as never, manifestSha256: manifestSha, committedBy: "cli" });
    return {
      generation: committed.generation?.generation ?? generation,
      logicalBytes: archives.reduce((n, a) => n + a.bytes, 0),
      storedBytes: manifest.totals.bytes,
      uploadedBytes,
      uploaded,
      reused: wanted.length - uploaded,
      archives: archives.map((a) => ({ name: a.name, entries: a.entries, bytes: a.bytes, chunks: a.chunks.length })),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Restores one archive of a generation into `dest` (which must not exist):
 * downloads each chunk, checks its sha256, decompresses and untars.
 */
export async function restoreArchive(capsuleId: string, name: string, dest: string, generation?: number): Promise<{ entries: number; bytes: number }> {
  const res = await tapi.resolveGeneration(capsuleId, generation);
  const manifest = res.manifest as unknown as ArchiveManifest;
  const archive = manifest.archives?.find((a) => a.name === name);
  if (!archive) throw new Error(`generation ${res.generation} has no archive named "${name}"`);
  const urls = new Map(res.chunks.map((c) => [c.sha256, c.getUrl]));
  // Claim the destination atomically: a non-recursive mkdir fails if it exists.
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await mkdir(dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${dest} already exists; restore never overwrites`);
    throw e;
  }
  const tmp = await mkdtemp(path.join(os.tmpdir(), "teleport-archive-restore-"));
  try {
    const tarFile = path.join(tmp, "archive.tar");
    const out = createWriteStream(tarFile);
    const finished = new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.once("finish", resolve);
    });
    finished.catch(() => undefined);
    let bytes = 0;
    for (const c of archive.chunks) {
      const url = urls.get(c.sha256);
      if (!url) throw new Error(`no download URL for chunk ${c.sha256.slice(0, 12)}`);
      const body = Buffer.from(await (await fetchOk(url)).arrayBuffer());
      if (createHash("sha256").update(body).digest("hex") !== c.sha256) throw new Error(`chunk ${c.sha256.slice(0, 12)} failed its checksum`);
      const plain = zstdDecompressSync(body);
      bytes += plain.length;
      if (!out.write(plain)) await Promise.race([new Promise((r) => out.once("drain", r)), finished]);
    }
    out.end();
    await finished;
    const x = await run("tar", ["-x", "-k", "-f", tarFile, "-C", dest]);
    if (x.code !== 0) throw new Error(`tar extract failed: ${x.stderr.trim()}`);
    return { entries: archive.entries, bytes };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function uploadAll(missing: tapi.NegotiateResponse["missing"], files: Map<string, string>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PUT_CONCURRENCY, missing.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= missing.length) return;
      const file = files.get(missing[i].sha256);
      if (!file) throw new Error(`server asked for an unknown chunk ${missing[i].sha256}`);
      const body = await readFile(file);
      let delay = 400;
      for (let attempt = 1; ; attempt++) {
        const r = await fetch(missing[i].putUrl, { method: "PUT", body });
        if (r.ok) break;
        await r.body?.cancel().catch(() => undefined);
        if (attempt >= 4 || (r.status < 500 && r.status !== 429)) throw new Error(`chunk upload failed: HTTP ${r.status}`);
        await new Promise((s) => setTimeout(s, delay));
        delay *= 2;
      }
    }
  });
  await Promise.all(workers);
}

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`chunk download failed: HTTP ${r.status}`);
  return r;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_") || "archive";
}

/** Default sources: agent session history and infinite-disk's retained recovery data. */
export function defaultArchiveSources(home = os.homedir()): ArchiveSource[] {
  return [
    { name: "claude-code", dir: path.join(home, ".claude", "projects") },
    { name: "codex", dir: path.join(home, ".codex", "sessions") },
    { name: "infinite-disk-recovery", dir: path.join(home, ".local", "share", "infinite-disk", "recovery-consolidated") },
    { name: "infinite-disk-sessions", dir: path.join(home, ".local", "share", "infinite-disk", "session-backups") },
  ];
}
