import os from "node:os";
import { packageName, packageVersion, resolveApiKey } from "./config.js";

/** Minimal authenticated REST client for the Ditto management API. */

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function apiBase(): string {
  return (process.env.DITTO_API_BASE || "https://api.heyditto.ai").replace(/\/+$/, "");
}

function userAgent(): string {
  return `${packageName}/${packageVersion}`;
}

/** Shared "not logged in" message: browser login first, then the alternatives. */
export const NO_KEY_MESSAGE =
  "no Ditto API key configured.\n\n" +
  "  Run: heyditto login                 (opens your browser)\n" +
  "  Or:  heyditto login <key>           (save an existing key)\n" +
  "  Or:  heyditto init --json           (create a claimable agent account, no browser)\n";

async function requireKey(): Promise<string> {
  const { key } = await resolveApiKey();
  if (!key) throw new Error(NO_KEY_MESSAGE);
  return key;
}

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": userAgent(),
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth !== false) headers.Authorization = `Bearer ${await requireKey()}`;
  const response = await fetch(`${apiBase()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      detail = parsed.message || parsed.error || text;
    } catch {
      /* raw body */
    }
    const hint =
      response.status === 401
        ? " (is the saved key valid? run `heyditto login`)"
        : response.status === 403
          ? " (the key is not allowed to manage inference endpoints)"
          : "";
    throw new ApiError(
      `${init.method ?? "GET"} ${path} failed: HTTP ${response.status}${detail ? ` - ${detail.slice(0, 300)}` : ""}${hint}`,
      response.status,
      text,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ===== Inference endpoints =====

export type EndpointStatus = "active" | "pending_plan";

/** Backend-controlled copy explaining why an endpoint cannot serve requests yet. */
export interface EndpointActivation {
  state: string;
  reason: "agent_unclaimed" | "plan_required" | string;
  requiredTier?: number;
  requiredTierName?: string;
  priceHint?: string;
  message: string;
  /** Link to hand to the user; for agent accounts the CLI adds the claim token (see mergeActivationURL). */
  url?: string;
}

export interface InferenceEndpoint {
  id: string;
  slug: string;
  name: string;
  model: string;
  systemPrompt?: string;
  spendPeriod?: string;
  spendLimitTokens?: number | null;
  spentTokens?: number;
  memoryDepth?: number;
  maxToolRounds?: number;
  recordTrace?: boolean;
  recordAttachments?: boolean;
  recallEnabled?: boolean;
  recordEnabled?: boolean;
  tools?: string[];
  modelMode?: string;
  billingMode?: string;
  status?: EndpointStatus | string;
  activation?: EndpointActivation;
  createdAt?: string;
  updatedAt?: string;
}

/** Partial body for POST / PATCH /api/v5/inference/endpoints. */
export interface EndpointInput {
  name?: string;
  slug?: string;
  model?: string;
  systemPrompt?: string;
  spendLimitTokens?: number | null;
  spendPeriod?: string;
  recordTrace?: boolean;
  recallEnabled?: boolean;
  recordEnabled?: boolean;
  memoryDepth?: number;
}

export function isEndpointPending(e: InferenceEndpoint): boolean {
  return e.status === "pending_plan" || (e.status !== undefined && e.status !== "active");
}

export interface InferenceEndpointsResponse {
  baseUrl: string;
  endpoints: InferenceEndpoint[];
  limit?: number;
  used?: number;
}

export async function listEndpoints(): Promise<InferenceEndpointsResponse> {
  const res = await apiFetch<InferenceEndpointsResponse>("/api/v5/inference/endpoints");
  return {
    baseUrl: (res.baseUrl || `${apiBase()}/v1`).replace(/\/+$/, ""),
    endpoints: res.endpoints ?? [],
    limit: res.limit,
    used: res.used,
  };
}

const endpointsPath = "/api/v5/inference/endpoints";

function endpointPath(id: string): string {
  return `${endpointsPath}/${encodeURIComponent(id)}`;
}

export async function createEndpoint(input: EndpointInput = {}): Promise<InferenceEndpoint> {
  return apiFetch<InferenceEndpoint>(endpointsPath, { method: "POST", body: input });
}

export async function updateEndpoint(id: string, patch: EndpointInput): Promise<InferenceEndpoint> {
  return apiFetch<InferenceEndpoint>(endpointPath(id), { method: "PATCH", body: patch });
}

export async function deleteEndpoint(id: string): Promise<void> {
  await apiFetch<void>(endpointPath(id), { method: "DELETE" });
}

/** Finds one endpoint by slug or id from the catalog (there is no GET-by-id route). */
export function findEndpoint(endpoints: InferenceEndpoint[], ref: string): InferenceEndpoint | undefined {
  const wanted = ref.trim();
  return endpoints.find((e) => e.slug === wanted || e.id === wanted);
}

export async function getEndpoint(ref: string): Promise<{ endpoint: InferenceEndpoint; catalog: InferenceEndpointsResponse }> {
  const catalog = await listEndpoints();
  const endpoint = findEndpoint(catalog.endpoints, ref);
  if (!endpoint) {
    throw new Error(
      `no endpoint named "${ref.trim()}". Available: ${catalog.endpoints.map((e) => e.slug).join(", ") || "(none — create one with `heyditto endpoints create`)"}`,
    );
  }
  return { endpoint, catalog };
}

export async function listKeys(endpointId: string): Promise<InferenceKey[]> {
  const res = await apiFetch<{ keys?: InferenceKey[] } | InferenceKey[]>(`${endpointPath(endpointId)}/keys`);
  return Array.isArray(res) ? res : (res.keys ?? []);
}

export interface InferenceKey {
  id: string;
  endpointId: string;
  name: string;
  keyHint: string;
  key?: string;
  expiresAt?: string | null;
  spendLimitTokens?: number | null;
  spendPeriod?: string;
  spentTokens?: number;
  createdAt?: string;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface CreateKeyInput {
  name: string;
  expiresIn: string;
  spendLimitTokens?: number;
  spendPeriod?: string;
}

export async function createKey(endpointId: string, input: CreateKeyInput): Promise<InferenceKey> {
  const key = await apiFetch<InferenceKey>(
    `/api/v5/inference/endpoints/${encodeURIComponent(endpointId)}/keys`,
    { method: "POST", body: input },
  );
  if (!key.key) throw new Error("key creation succeeded but no plaintext key was returned");
  return key;
}

export async function revokeKey(endpointId: string, keyId: string): Promise<void> {
  await apiFetch<void>(
    `/api/v5/inference/endpoints/${encodeURIComponent(endpointId)}/keys/${encodeURIComponent(keyId)}`,
    { method: "DELETE" },
  );
}

export interface InferenceSession {
  id: string;
  endpointId: string;
  sessionKey: string;
  threadId?: string;
  harness?: string;
  model?: string;
  turnCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export async function listRemoteSessions(endpointId: string): Promise<InferenceSession[]> {
  const res = await apiFetch<{ sessions?: InferenceSession[] }>(
    `/api/v5/inference/endpoints/${encodeURIComponent(endpointId)}/sessions`,
  );
  return res.sessions ?? [];
}

// ===== Device login (RFC 8628 style) =====

/** What the CLI was asked to do; the web page specializes its onboarding on it. */
export type DeviceIntent = "login" | "claude" | "codex";

export const DEVICE_CLIENT = "heyditto-cli";

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  /** Backend-built URL carrying the code and the intent (RFC 8628 §3.3.1). */
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(input: { intent: DeviceIntent }): Promise<DeviceCode> {
  const res = await apiFetch<DeviceCode>("/api/v2/mcp/device-code", {
    method: "POST",
    body: {
      client: DEVICE_CLIENT,
      client_version: packageVersion,
      intent: input.intent,
      hostname: os.hostname().slice(0, 128),
    },
    auth: false,
  });
  if (!res.device_code || !res.user_code || !res.verification_url) {
    throw new Error("device login is not available on this API (malformed device-code response)");
  }
  return res;
}

/** Endpoint the browser picked for the CLI during the device flow. */
export interface SelectedEndpoint {
  id: string;
  slug: string;
  name?: string;
  model?: string;
}

export type DeviceTokenResult =
  | { status: "ok"; accessToken: string; endpoint?: SelectedEndpoint; setDefault?: boolean }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" };

export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
  const res = await apiFetch<{
    access_token?: string;
    token_type?: string;
    error?: string;
    endpoint?: SelectedEndpoint | null;
    set_default?: boolean;
  }>("/api/v2/mcp/device-token", {
    method: "POST",
    auth: false,
    body: { device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
  });
  if (res.access_token) {
    const endpoint = res.endpoint && res.endpoint.id && res.endpoint.slug ? res.endpoint : undefined;
    return { status: "ok", accessToken: res.access_token, endpoint, setDefault: Boolean(res.set_default) };
  }
  switch (res.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied" };
    default:
      return { status: "expired" };
  }
}

// ---------------------------------------------------------------------------
// Chat agents (/api/v5/chat-agents)
// ---------------------------------------------------------------------------

export interface AgentConnection {
  id: string;
  agentId: string;
  kind: string;
  refId: string;
  name: string;
  sessionCooldownSeconds?: number;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}

export interface ChatAgent {
  id: string;
  kind: string;
  name: string;
  mainThreadId: string;
  kgId?: string;
  status: string;
  pinned?: boolean;
  threadCount?: number;
  lastActivityAt?: string | null;
  createdAt: string;
  updatedAt: string;
  connections?: AgentConnection[];
}

export async function listChatAgents(): Promise<ChatAgent[]> {
  const out = await apiFetch<{ agents?: ChatAgent[] }>("/api/v5/chat-agents");
  return out.agents ?? [];
}
