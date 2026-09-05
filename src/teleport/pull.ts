import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tapi from "./api.js";
import { restoreCapsule, type RestoreResult } from "./restore.js";

const GET_CONCURRENCY = 4;

/**
 * Downloads a generation's chunks and rebuilds the capsule into `destRoot`.
 * Chunks are verified by sha256 as they land; a mismatch aborts the pull.
 */
export async function pullCapsule(
  capsuleId: string,
  generation: number | undefined,
  destRoot: string,
  opts: { restoreHarness?: boolean } = {},
): Promise<RestoreResult> {
  const { manifest, chunks } = await tapi.resolveGeneration(capsuleId, generation);
  const chunkDir = await mkdtemp(path.join(os.tmpdir(), "teleport-chunks-"));
  try {
    await downloadChunks(chunks, chunkDir);
    return await restoreCapsule(manifest, (sha) => path.join(chunkDir, sha), destRoot, opts);
  } finally {
    await rm(chunkDir, { recursive: true, force: true });
  }
}

async function downloadChunks(
  chunks: { sha256: string; getUrl: string }[],
  dir: string,
): Promise<void> {
  const { createHash } = await import("node:crypto");
  let cursor = 0;
  const workers = Array.from({ length: Math.min(GET_CONCURRENCY, chunks.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= chunks.length) return;
      const { sha256, getUrl } = chunks[i];
      const dest = path.join(dir, sha256);
      const buf = await getWithRetry(getUrl);
      const got = createHash("sha256").update(buf).digest("hex");
      if (got !== sha256) throw new Error(`chunk ${sha256} failed integrity check (got ${got})`);
      await writeFile(dest, buf);
    }
  });
  await Promise.all(workers);
}

async function getWithRetry(url: string, attempts = 4): Promise<Buffer> {
  let delay = 400;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (attempt >= attempts || (res.status < 500 && res.status !== 429)) {
      throw new Error(`chunk download failed: HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
}

/** Local record of a capsule's last generation, for thin bundles on the next push. */
export function manifestCachePath(configDir: string, capsuleId: string): string {
  return path.join(configDir, "teleport", `${capsuleId}.json`);
}

export async function readCachedManifest(configDir: string, capsuleId: string) {
  try {
    return JSON.parse(await readFile(manifestCachePath(configDir, capsuleId), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeCachedManifest(configDir: string, capsuleId: string, manifest: unknown): Promise<void> {
  const file = manifestCachePath(configDir, capsuleId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
