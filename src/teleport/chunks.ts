import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { CHUNK_BYTES, type ChunkRef } from "./types.js";

/**
 * Splits a file into content-addressed chunks of at most CHUNK_BYTES. Returns
 * one ChunkRef per chunk in order; the caller uploads by sha256 and records the
 * sequence in the manifest so the file can be reassembled.
 */
export async function chunkFile(file: string): Promise<ChunkRef[]> {
  const refs: ChunkRef[] = [];
  const stream = createReadStream(file, { highWaterMark: CHUNK_BYTES });
  let carry: Buffer = Buffer.alloc(0);
  const flush = (buf: Buffer) => {
    refs.push({ sha256: sha256(buf), size: buf.length });
  };
  for await (const piece of stream) {
    const buf = Buffer.from(piece as Buffer);
    carry = carry.length === 0 ? buf : Buffer.concat([carry, buf]);
    while (carry.length >= CHUNK_BYTES) {
      flush(Buffer.from(carry.subarray(0, CHUNK_BYTES)));
      carry = Buffer.from(carry.subarray(CHUNK_BYTES));
    }
  }
  if (carry.length > 0 || refs.length === 0) flush(carry);
  return refs;
}

/** Reads chunk N of a file (N-th CHUNK_BYTES window). */
export async function readChunk(file: string, index: number): Promise<Buffer> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, index * CHUNK_BYTES);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256String(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Total distinct bytes across a set of chunk refs, deduped by sha256. */
export function dedupedBytes(refs: ChunkRef[]): number {
  const seen = new Map<string, number>();
  for (const r of refs) seen.set(r.sha256, r.size);
  let total = 0;
  for (const size of seen.values()) total += size;
  return total;
}
