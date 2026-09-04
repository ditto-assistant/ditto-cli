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

async function requireKey(): Promise<string> {
  const { key } = await resolveApiKey();
  if (!key) {
    throw new Error(
      "no Ditto API key configured.\n\n" +
        "  Run: heyditto login\n" +
        "  Or save an existing key with: heyditto login <key>\n",
    );
  }
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

export interface InferenceEndpoint {
  id: string;
  slug: string;
  name: string;
  model: string;
  spendPeriod?: string;
  spendLimitTokens?: number | null;
  spentTokens?: number;
  recordTrace?: boolean;
  recallEnabled?: boolean;
  recordEnabled?: boolean;
  tools?: string[];
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

export interface InferenceKey {
  id: string;
  endpointId: string;
  name: string;
  keyHint: string;
  key?: string;
  expiresAt?: string | null;
  spendLimitTokens?: number | null;
  spendPeriod?: string;
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

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const res = await apiFetch<DeviceCode>("/api/v2/mcp/device-code", {
    method: "POST",
    body: {},
    auth: false,
  });
  if (!res.device_code || !res.user_code || !res.verification_url) {
    throw new Error("device login is not available on this API (malformed device-code response)");
  }
  return res;
}

export type DeviceTokenResult =
  | { status: "ok"; accessToken: string }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" };

export async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
  const res = await apiFetch<{ access_token?: string; token_type?: string; error?: string }>(
    "/api/v2/mcp/device-token",
    {
      method: "POST",
      auth: false,
      body: { device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
    },
  );
  if (res.access_token) return { status: "ok", accessToken: res.access_token };
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
