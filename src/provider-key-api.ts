import { apiBase, NO_KEY_MESSAGE } from "./api.js";
import { packageName, packageVersion, resolveApiKey } from "./config.js";

export type ProviderProtocol = "openai_chat" | "anthropic_messages";
export type BalanceProvider = "impala" | "openrouter" | "gm" | "vercel_ai_gateway";
export const BALANCE_PROVIDERS: readonly BalanceProvider[] = ["impala", "openrouter", "gm", "vercel_ai_gateway"];
export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  keyPrefixHints: string[];
  protocols: string[];
  routable: boolean;
  requiresBaseUrl?: boolean;
  modelDiscovery?: boolean;
  balanceSupported?: boolean;
  params?: Array<{ name: string; label: string; required: boolean }>;
}
export interface ProviderKeyMetadata {
  id: string;
  provider: string;
  label?: string;
  keyHint?: string;
  enabled: boolean;
  configured: boolean;
  priority?: number;
  baseUrl?: string;
  protocol?: ProviderProtocol;
  balanceProvider?: BalanceProvider;
  modelAllow?: string[];
  modelDeny?: string[];
}
export interface ProviderKeyInput {
  companyId?: string;
  provider: string;
  key: string;
  label?: string;
  baseUrl?: string;
  protocol?: ProviderProtocol;
  balanceProvider?: BalanceProvider;
  priority?: number;
  modelAllow?: string[];
  modelDeny?: string[];
  templateParams?: Record<string, string>;
}
export interface ProviderProbeInput {
  companyId?: string;
  models: string[];
  requests: number;
  concurrency: number;
  requestsPerMinute: number;
  maxOutputTokens: number;
  confirmSpend: boolean;
  maxCostUsd?: number;
  allowUnknownCost?: boolean;
}

const path = "/api/v5/inference/provider-keys";
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export function requireProviderKeyId(id: string): string {
  if (!UUID.test(id)) throw new Error("select a saved provider key UUID; never pass a raw API key as an identifier");
  return id.toLowerCase();
}

/** Secret-bearing uploads never follow a redirect or silently trust an arbitrary API override. */
export function providerManagementBase(raw = apiBase()): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid Ditto management API URL"); }
  const production = url.protocol === "https:" && url.hostname === "api.heyditto.ai" && (!url.port || url.port === "443");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol);
  if ((!production && !local) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("provider-key management accepts https://api.heyditto.ai or an explicit loopback test API only; check DITTO_API_BASE");
  }
  return url.origin;
}

/** Ignore arbitrary HTTP error bodies: even a broken server must not echo a submitted key. */
export async function providerManagementFetch<T>(route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const base = providerManagementBase();
  const { key } = await resolveApiKey();
  if (!key) throw new Error(NO_KEY_MESSAGE);
  let response: Response;
  try {
    response = await fetch(`${base}${route}`, {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${key}`, "User-Agent": `${packageName}/${packageVersion}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: AbortSignal.timeout(35_000),
    });
  } catch {
    throw new Error("provider-key management request failed or timed out; no credential or response diagnostics were printed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`provider-key management returned HTTP ${response.status}; no response body was printed${response.status === 401 ? "; check heyditto login" : response.status === 403 ? "; check your organization role and pilot access" : ""}`);
  }
  if (response.status === 204) return undefined as T;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider-key management returned an empty response");
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2_000_000) { await reader.cancel(); throw new Error("provider-key management response exceeded its size limit"); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T; }
  catch { throw new Error("provider-key management returned an invalid JSON response; no response body was printed"); }
}

function object(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}
function safeText(raw: unknown, secret?: string, max = 250): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = secret ? raw.split(secret).join("[redacted]") : raw;
  return value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);
}
function stringList(raw: unknown, secret?: string): string[] | undefined {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").slice(0, 1000).map(v => safeText(v, secret)!) : undefined;
}

/** Only these metadata fields may reach the terminal, even if a server returns a plaintext `key`. */
export function providerKeyMetadata(raw: unknown, secret?: string): ProviderKeyMetadata {
  const data = object(raw);
  if (typeof data.id !== "string" || !UUID.test(data.id) || typeof data.provider !== "string" || !/^[a-z0-9_-]{1,80}$/.test(data.provider)) {
    throw new Error("provider-key management returned invalid key metadata; no response body was printed");
  }
  if (secret && (data.id.includes(secret) || data.provider.includes(secret))) throw new Error("provider-key management returned unsafe key metadata; no response body was printed");
  const protocol = data.protocol === "openai_chat" || data.protocol === "anthropic_messages" ? data.protocol : undefined;
  const base = data.baseUrl ?? data.baseUrlOverride;
  let baseUrl: string | undefined;
  if (typeof base === "string" && base) {
    try { const parsed = new URL(base); if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) baseUrl = safeText(parsed.toString(), secret, 2000); } catch { /* omit invalid metadata */ }
  }
  return {
    id: data.id.toLowerCase(), provider: data.provider,
    ...(safeText(data.label, secret) === undefined ? {} : { label: safeText(data.label, secret) }),
    ...(typeof data.keyHint === "string" ? { keyHint: safeText(data.keyHint.slice(-4), secret, 4) } : {}),
    enabled: data.enabled === true, configured: data.configured === true,
    ...(typeof data.priority === "number" && Number.isSafeInteger(data.priority) ? { priority: data.priority } : {}),
    ...(baseUrl ? { baseUrl } : {}), ...(protocol ? { protocol } : {}),
    ...(typeof data.balanceProvider === "string" && BALANCE_PROVIDERS.includes(data.balanceProvider as BalanceProvider) ? { balanceProvider: data.balanceProvider as BalanceProvider } : {}),
    ...(Array.isArray(data.modelAllow) ? { modelAllow: stringList(data.modelAllow, secret) } : {}),
    ...(Array.isArray(data.modelDeny) ? { modelDeny: stringList(data.modelDeny, secret) } : {}),
  };
}

export async function listProviderKeys(companyId?: string): Promise<{ keys: ProviderKeyMetadata[]; canManage: boolean }> {
  const response = object(await providerManagementFetch(`${path}${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}`));
  if (!Array.isArray(response.keys)) throw new Error("provider-key management returned an invalid key list");
  return { keys: response.keys.map(key => providerKeyMetadata(key)), canManage: response.canManage === true };
}
export async function providerCatalog(): Promise<ProviderCatalogEntry[]> {
  const response = object(await providerManagementFetch(`${path}/providers`));
  if (!Array.isArray(response.providers)) throw new Error("provider-key management returned an invalid provider catalog");
  return response.providers.map(raw => {
    const row = object(raw);
    return { id: safeText(row.id) ?? "", displayName: safeText(row.displayName) ?? "", keyPrefixHints: stringList(row.keyPrefixHints) ?? [], protocols: stringList(row.protocols) ?? [], routable: row.routable === true, requiresBaseUrl: row.requiresBaseUrl === true, modelDiscovery: row.modelDiscovery === true, balanceSupported: row.balanceSupported === true, params: Array.isArray(row.params) ? row.params.slice(0, 20).map(raw => { const param = object(raw); return { name: safeText(param.name) ?? "", label: safeText(param.label) ?? "", required: param.required === true }; }).filter(param => /^[a-z][a-z0-9_]{0,63}$/.test(param.name)) : [] };
  }).filter(row => /^[a-z0-9_-]{1,80}$/.test(row.id));
}
export async function addProviderKey(input: ProviderKeyInput): Promise<ProviderKeyMetadata> {
  return providerKeyMetadata(await providerManagementFetch(path, { method: "POST", body: input }), input.key);
}
export async function setProviderKey(id: string, input: { companyId?: string; enabled?: boolean; priority?: number; key?: string }): Promise<ProviderKeyMetadata> {
  return providerKeyMetadata(await providerManagementFetch(`${path}/${requireProviderKeyId(id)}`, { method: "PATCH", body: input }), input.key);
}
export async function removeProviderKey(id: string, companyId?: string): Promise<void> {
  await providerManagementFetch(`${path}/${requireProviderKeyId(id)}${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}`, { method: "DELETE" });
}

/** Diagnostics expose statuses and numeric observations, never arbitrary provider messages or completions. */
export function inspectionMetadata(raw: unknown): Record<string, unknown> {
  const data = object(raw), validation = object(data.validation), models = object(data.models), balance = object(data.balance);
  const status = (raw: unknown, allowed: string[]) => typeof raw === "string" && allowed.includes(raw) ? raw : "unknown";
  const balanceAmount = (raw: unknown) => typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  return {
    keyId: typeof data.keyId === "string" && UUID.test(data.keyId) ? data.keyId : undefined,
    checkedAt: timestamp(data.checkedAt),
    validation: { status: status(validation.status, ["valid", "rejected", "unknown", "unsupported"]), ...(Number.isInteger(validation.httpStatus) ? { httpStatus: validation.httpStatus } : {}) },
    models: { status: status(models.status, ["advertised", "unsupported", "unknown"]), models: Array.isArray(models.models) ? models.models.slice(0, 1000).map(raw => ({ id: safeText(object(raw).id) })).filter(row => row.id) : [], truncated: models.truncated === true },
    balance: { status: status(balance.status, ["reported", "unsupported", "unknown"]), amountUsd: balanceAmount(balance.amountUsd), unit: balance.unit === "USD" ? "USD" : undefined, source: balance.source === "key_limit_remaining" || balance.source === "payg_wallet" || balance.source === "account_wallet" ? balance.source : undefined, checkedAt: timestamp(balance.checkedAt) },
  };
}
export async function inspectProviderKey(id: string, companyId?: string): Promise<Record<string, unknown>> {
  return inspectionMetadata(await providerManagementFetch(`${path}/${requireProviderKeyId(id)}/inspect`, { method: "POST", body: { companyId } }));
}
export async function probeProviderKey(id: string, input: ProviderProbeInput): Promise<unknown> {
  return providerManagementFetch(`${path}/${requireProviderKeyId(id)}/probe`, { method: "POST", body: input });
}

export function probeMetadata(raw: unknown): Record<string, unknown> {
  const data = object(raw);
  const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    startedAt: timestamp(data.startedAt), elapsedMs: numeric(data.elapsedMs), requestLimit: numeric(data.requestLimit), outputTokenLimit: numeric(data.outputTokenLimit), requestsPerMinute: numeric(data.requestsPerMinute), attemptedRequests: numeric(data.attemptedRequests), httpResponses: numeric(data.httpResponses), successfulRequests: numeric(data.successfulRequests),
    costBoundAvailable: data.costBoundAvailable === true, capacityVerified: data.capacityVerified === true,
    observedRequestsPerSecond: numeric(data.observedRequestsPerSecond),
    calls: Array.isArray(data.calls) ? data.calls.slice(0, 20).map(raw => {
      const call = object(raw);
      return { model: safeText(call.model), status: typeof call.status === "string" && ["unavailable", "rejected", "rate_limited", "locally_limited", "invalid_request", "incomplete", "completed", "provider_error"].includes(call.status) ? call.status : "unknown", attempted: call.attempted === true, httpStatus: numeric(call.httpStatus), latencyMs: numeric(call.latencyMs), ttftMs: numeric(call.ttftMs), inputTokens: numeric(call.inputTokens), outputTokens: numeric(call.outputTokens), cachedInputTokens: numeric(call.cachedInputTokens), providerReportedCostUsd: numeric(call.providerReportedCostUsd), inputTokenAccounting: typeof call.inputTokenAccounting === "string" && ["inclusive", "exclusive", "unknown"].includes(call.inputTokenAccounting) ? call.inputTokenAccounting : "unknown", tokensPerSecond: numeric(call.tokensPerSecond) };
    }) : [],
  };
}

function timestamp(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return undefined;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
