import { apiFetch } from "../api.js";
import type { Manifest } from "./types.js";

// ===== Teleport API types (mirror /api/v5/teleport/*) =====

export interface Capsule {
  id: string;
  name: string;
  rootKind: "repo" | "folder";
  harnessKind?: string;
  harnessSessionId?: string | null;
  headGeneration: number;
  mirrorPolicy?: { mode: "all" | "some"; targets?: string[] };
  bytesTotal?: number;
  chunkCount?: number;
  agentId?: string | null;
  threadId?: string | null;
  status?: "active" | "offloaded" | "deleted";
  createdAt?: string;
  updatedAt?: string;
  lastPushedAt?: string | null;
}

export interface MirrorStatus {
  target: string;
  provider?: string;
  generation: number;
  status: "pending" | "copying" | "complete" | "failed" | "stale";
  verifiedAt?: string | null;
  error?: string;
}

export interface CapsuleStatus {
  headGeneration: number;
  mirrors: MirrorStatus[];
  offloadReady: boolean;
  bytesTotal?: number;
}

export interface NegotiateResponse {
  missing: { sha256: string; putUrl: string; expiresAt?: string }[];
  uploadedCount: number;
}

export interface ResolveResponse {
  manifest: Manifest;
  chunks: { sha256: string; getUrl: string }[];
}

export interface CloudSessionResponse {
  jobId: string;
  threadId: string;
  agentId: string;
  appUrl?: string;
}

export interface StorageMirror {
  id: string;
  target: string;
  name?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  providerKind?: string;
  default?: boolean;
  enabled?: boolean;
}

function tp(path: string): string {
  return `/api/v5/teleport${path}`;
}

export async function listCapsules(): Promise<Capsule[]> {
  const res = await apiFetch<{ capsules?: Capsule[] }>(tp("/capsules"));
  return res.capsules ?? [];
}

export async function createCapsule(input: {
  name: string;
  rootKind: "repo" | "folder";
  harnessKind?: string;
  harnessSessionId?: string;
  mirrorPolicy?: Capsule["mirrorPolicy"];
}): Promise<Capsule> {
  return apiFetch<Capsule>(tp("/capsules"), { method: "POST", body: input });
}

export async function getCapsule(id: string): Promise<Capsule> {
  return apiFetch<Capsule>(tp(`/capsules/${encodeURIComponent(id)}`));
}

export async function deleteCapsule(id: string): Promise<void> {
  await apiFetch<void>(tp(`/capsules/${encodeURIComponent(id)}`), { method: "DELETE" });
}

export async function negotiate(
  id: string,
  body: { generation: number; parentGeneration: number | null; chunks: { sha256: string; size: number }[] },
): Promise<NegotiateResponse> {
  return apiFetch<NegotiateResponse>(tp(`/capsules/${encodeURIComponent(id)}/negotiate`), { method: "POST", body });
}

export async function commit(
  id: string,
  body: { generation: number; manifest: Manifest },
): Promise<{ generation: number; mirrors: MirrorStatus[] }> {
  return apiFetch<{ generation: number; mirrors: MirrorStatus[] }>(
    tp(`/capsules/${encodeURIComponent(id)}/commit`),
    { method: "POST", body },
  );
}

export async function resolveGeneration(id: string, generation: number): Promise<ResolveResponse> {
  return apiFetch<ResolveResponse>(tp(`/capsules/${encodeURIComponent(id)}/generations/${generation}`));
}

export async function capsuleStatus(id: string): Promise<CapsuleStatus> {
  return apiFetch<CapsuleStatus>(tp(`/capsules/${encodeURIComponent(id)}/status`));
}

export async function verifyCapsule(id: string): Promise<CapsuleStatus> {
  return apiFetch<CapsuleStatus>(tp(`/capsules/${encodeURIComponent(id)}/verify`), { method: "POST", body: {} });
}

export async function launchCloudSession(
  id: string,
  body: { harness: string; endpointId?: string; prompt?: string },
): Promise<CloudSessionResponse> {
  return apiFetch<CloudSessionResponse>(tp(`/capsules/${encodeURIComponent(id)}/cloud-sessions`), {
    method: "POST",
    body,
  });
}

export async function listStorageMirrors(): Promise<StorageMirror[]> {
  const res = await apiFetch<{ mirrors?: StorageMirror[] }>(tp("/mirrors"));
  return res.mirrors ?? [];
}

export async function setMirrorPolicy(
  id: string,
  policy: { mode: "all" | "some"; targets?: string[] },
): Promise<Capsule> {
  return apiFetch<Capsule>(tp(`/capsules/${encodeURIComponent(id)}`), {
    method: "PATCH",
    body: { mirrorPolicy: policy },
  });
}
