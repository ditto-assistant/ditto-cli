import { apiFetch, apiBase } from "../api.js";

/** A user-configured S3-compatible bucket that capsules can mirror to. */
export interface StorageBucket {
  id: string;
  name?: string;
  bucket: string;
  endpoint: string;
  region: string;
  providerKind?: "s3" | "hippius";
  enabled: boolean;
  default: boolean;
  keyHint?: string;
  lastUsedAt?: string | null;
}

export interface StorageStatus {
  configured: boolean;
  defaultBucketID?: string;
  buckets: StorageBucket[];
}

export interface AddBucketInput {
  name?: string;
  accessKeyID: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string;
  region?: string;
  enabled?: boolean;
  default?: boolean;
}

function base(userScoped: string): string {
  return `/api/v2/users/${encodeURIComponent(userScoped)}/storage/hippius`;
}

/** The management routes are user-scoped; the key already identifies the user, so `me`. */
const USER = "me";

export async function getStorage(): Promise<StorageStatus> {
  const res = await apiFetch<StorageStatus>(base(USER));
  return { configured: res.configured ?? false, defaultBucketID: res.defaultBucketID, buckets: res.buckets ?? [] };
}

export async function addBucket(input: AddBucketInput): Promise<StorageBucket> {
  return apiFetch<StorageBucket>(base(USER), { method: "PUT", body: input });
}

export async function removeBucket(bucketID: string): Promise<void> {
  await apiFetch<void>(`${base(USER)}?bucketID=${encodeURIComponent(bucketID)}`, { method: "DELETE" });
}

export interface TestResult {
  ok: boolean;
  error?: string;
}

export async function testBucket(bucketID: string): Promise<TestResult> {
  return apiFetch<TestResult>(`${base(USER)}/test`, { method: "POST", body: { kind: "stored", bucketID } });
}

export async function testDraft(input: AddBucketInput): Promise<TestResult> {
  return apiFetch<TestResult>(`${base(USER)}/test`, { method: "POST", body: { kind: "draft", settings: input } });
}

/** Human summary of where a bucket lives, for `storage list`. */
export function bucketEndpointLabel(b: StorageBucket): string {
  try {
    return new URL(b.endpoint).host;
  } catch {
    return b.endpoint || apiBase();
  }
}
