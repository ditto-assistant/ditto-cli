import { apiBase, apiFetch } from "../api.js";

/**
 * Bring-your-own buckets that capsules can mirror to, managed through the
 * teleport API (`/api/v5/teleport/buckets`), which accepts the CLI's
 * ditto_mcp_ key. Any S3-compatible endpoint works (AWS S3, R2, B2, MinIO,
 * Hippius); `providerKind` is detected server-side from the endpoint.
 */
export interface StorageBucket {
  id: string;
  name?: string;
  providerKind?: "s3" | "hippius";
  bucket: string;
  endpoint: string;
  region: string;
  enabled: boolean;
  default: boolean;
  teleportMirror?: boolean;
  keyHint?: string;
  credentialState?: string;
}

export interface AddBucketInput {
  name?: string;
  providerKind?: "s3" | "hippius";
  accessKeyID: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  region?: string;
  enabled?: boolean;
  default?: boolean;
  teleportMirror?: boolean;
}

export interface UpdateBucketInput {
  name?: string;
  enabled?: boolean;
  default?: boolean;
  teleportMirror?: boolean;
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

const BUCKETS = "/api/v5/teleport/buckets";

export async function listBuckets(): Promise<StorageBucket[]> {
  const res = await apiFetch<{ buckets?: StorageBucket[] }>(BUCKETS);
  return res.buckets ?? [];
}

export async function addBucket(input: AddBucketInput): Promise<StorageBucket> {
  return apiFetch<StorageBucket>(BUCKETS, { method: "POST", body: input });
}

export async function updateBucket(id: string, input: UpdateBucketInput): Promise<StorageBucket> {
  return apiFetch<StorageBucket>(`${BUCKETS}/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
}

export async function removeBucket(id: string): Promise<void> {
  await apiFetch<void>(`${BUCKETS}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Tests a stored bucket's credentials. */
export async function testBucket(id: string): Promise<TestResult> {
  return apiFetch<TestResult>(`${BUCKETS}/test`, { method: "POST", body: { bucketId: id } });
}

/** Tests credentials before they are saved. */
export async function testDraft(input: AddBucketInput): Promise<TestResult> {
  return apiFetch<TestResult>(`${BUCKETS}/test`, { method: "POST", body: { settings: input } });
}

/** Resolves a bucket by id or by its friendly name (or, failing that, the bucket name). */
export async function resolveBucket(ref: string): Promise<StorageBucket> {
  const buckets = await listBuckets();
  const hit =
    buckets.find((b) => b.id === ref) ??
    buckets.find((b) => b.name === ref) ??
    buckets.find((b) => b.bucket === ref);
  if (!hit) throw new Error(`no bucket named "${ref}"; see \`heyditto storage list\``);
  return hit;
}

/** Human summary of where a bucket lives, for `storage list`. */
export function bucketEndpointLabel(b: StorageBucket): string {
  try {
    return new URL(b.endpoint).host;
  } catch {
    return b.endpoint || apiBase();
  }
}
