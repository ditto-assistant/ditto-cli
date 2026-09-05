import { apiFetch } from "../api.js";
import type { Manifest } from "./types.js";

// ===== Teleport API types — mirror /api/v5/teleport/* (backend is the source of truth) =====

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

export interface MirrorTarget {
  target: string;
  providerId: string;
  label: string;
  required: boolean;
  available: boolean;
}

export interface TargetsResponse {
  targets: MirrorTarget[];
  quotaGb: number;
  capsuleLimit: number;
}

export interface MirrorStatus {
  target: string;
  providerId?: string;
  generation: number;
  status: "pending" | "copying" | "complete" | "failed" | "stale";
  verifiedAt?: string | null;
  error?: string;
  required?: boolean;
}

export interface CapsuleStatus {
  capsule: Capsule;
  headGeneration: number;
  mirrors: MirrorStatus[];
  offloadReady: boolean;
  bytesTotal?: number;
}

export interface NegotiateResponse {
  missing: { sha256: string; size: number; putUrl: string; expiresAt?: string }[];
  uploadedCount: number;
}

export interface CommitResponse {
  capsule: Capsule;
  generation: number;
  mirrors: MirrorStatus[];
}

export interface ResolveResponse {
  capsule: Capsule;
  manifest: Manifest;
  chunks: { sha256: string; size: number; getUrl: string }[];
  generation: number;
}

export interface GenerationSummary {
  generation: number;
  manifestSha256: string;
  bytes: number;
  chunkCount: number;
  committedAt: string;
  committedBy: string;
}

export interface CloudSessionResponse {
  jobId: string;
  sessionId: string;
  agentId: string;
  threadId: string;
  endpointId: string;
  harness: string;
  harnessSessionId: string;
  generation: number;
}

export type CommittedBy = "cli" | "runner";

function tp(path: string): string {
  return `/api/v5/teleport${path}`;
}

/** `{capsule}` accepts a uuid or the capsule name. */
function cap(ref: string): string {
  return tp(`/capsules/${encodeURIComponent(ref)}`);
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

export async function getCapsule(ref: string): Promise<Capsule> {
  return apiFetch<Capsule>(cap(ref));
}

export async function updateCapsule(
  ref: string,
  body: { name?: string; mirrorPolicy?: Capsule["mirrorPolicy"]; status?: "active" | "offloaded" },
): Promise<Capsule> {
  return apiFetch<Capsule>(cap(ref), { method: "PATCH", body });
}

export async function deleteCapsule(ref: string): Promise<void> {
  await apiFetch<void>(cap(ref), { method: "DELETE" });
}

/** ≤ 200 chunks per call; chunks ≤ 24 MiB. */
export async function negotiate(ref: string, chunks: { sha256: string; size: number }[]): Promise<NegotiateResponse> {
  return apiFetch<NegotiateResponse>(`${cap(ref)}/negotiate`, { method: "POST", body: { chunks } });
}

/** The manifest must already be uploaded as a chunk (its sha256 is `manifestSha256`). */
export async function commit(
  ref: string,
  body: { manifest: Manifest; manifestSha256: string; committedBy: CommittedBy },
): Promise<CommitResponse> {
  return apiFetch<CommitResponse>(`${cap(ref)}/commit`, { method: "POST", body });
}

export async function resolveGeneration(ref: string, generation?: number): Promise<ResolveResponse> {
  const q = generation === undefined ? "" : `?generation=${generation}`;
  return apiFetch<ResolveResponse>(`${cap(ref)}/resolve${q}`);
}

export async function listGenerations(ref: string): Promise<GenerationSummary[]> {
  const res = await apiFetch<{ generations?: GenerationSummary[] }>(`${cap(ref)}/generations`);
  return res.generations ?? [];
}

export async function capsuleStatus(ref: string): Promise<CapsuleStatus> {
  return apiFetch<CapsuleStatus>(`${cap(ref)}/status`);
}

export async function verifyCapsule(ref: string): Promise<CapsuleStatus> {
  return apiFetch<CapsuleStatus>(`${cap(ref)}/verify`, { method: "POST", body: {} });
}

export async function launchCloudSession(
  ref: string,
  body: { prompt: string; harness?: string; endpointId?: string; generation?: number; model?: string; fresh?: boolean },
): Promise<CloudSessionResponse> {
  return apiFetch<CloudSessionResponse>(`${cap(ref)}/cloud-session`, { method: "POST", body });
}

export async function listTargets(): Promise<TargetsResponse> {
  const res = await apiFetch<Partial<TargetsResponse>>(tp("/targets"));
  return { targets: res.targets ?? [], quotaGb: res.quotaGb ?? 0, capsuleLimit: res.capsuleLimit ?? 0 };
}

export async function setMirrorPolicy(ref: string, policy: { mode: "all" | "some"; targets?: string[] }): Promise<Capsule> {
  return updateCapsule(ref, { mirrorPolicy: policy });
}

export function appThreadUrl(threadId: string): string {
  const base = (process.env.DITTO_APP_URL || "https://app.heyditto.ai").replace(/\/+$/, "");
  return `${base}/chat/${encodeURIComponent(threadId)}`;
}
