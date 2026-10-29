/** Fixed, documented read-only destinations. Never derive a destination from key bytes. */
const DESTINATIONS = {
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer", kind: "models" },
  anthropic: { url: "https://api.anthropic.com/v1/models", auth: "x-api-key", kind: "models" },
  openrouter: { url: "https://openrouter.ai/api/v1/key", auth: "bearer", kind: "key" },
  gm: { url: "https://api.saygm.com/v1/credits", auth: "bearer", kind: "balance" },
} as const;

export type IdentificationProvider = keyof typeof DESTINATIONS;
export type IdentificationStatus = "models_advertised" | "accepted_read_only" | "rejected" | "rate_limited" | "unknown";
export interface IdentificationResult { provider: IdentificationProvider; destination: string; status: IdentificationStatus; httpStatus?: number }
const MAX_RESPONSE_BYTES = 65_536;
const TIMEOUT_MS = 5000;

/** No registry call or provider traffic. Strong prefixes are advisory, never authentication. */
export function localProviderHints(key: string): string[] {
  if (key.startsWith("sk-proj-") || key.startsWith("sk-svcacct-")) return ["openai"];
  if (key.startsWith("sk-ant-")) return ["anthropic"];
  if (key.startsWith("sk-or-v1-")) return ["openrouter"];
  if (key.startsWith("sk-engy-")) return ["engy"];
  return [];
}

export function identificationPlan(providers: string[], confirmed: boolean, dryRun = false): { provider: IdentificationProvider; destination: string; method: "GET"; credentialHeader: string }[] {
  if (providers.length > 4 || new Set(providers).size !== providers.length || providers.some(id => !Object.hasOwn(DESTINATIONS, id))) {
    throw new Error("choose at most four distinct --try-provider values: openai, anthropic, openrouter or gm");
  }
  if (providers.length && !confirmed && !dryRun) throw new Error("network identification requires --confirm-key-sharing for the exact --try-provider shortlist; review destinations with --dry-run first");
  return providers.map(id => {
    const provider = id as IdentificationProvider, entry = DESTINATIONS[provider];
    return { provider, destination: entry.url, method: "GET", credentialHeader: entry.auth === "bearer" ? "Authorization" : "x-api-key" };
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function numeric(value: unknown): boolean {
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
}
function successStatus(provider: IdentificationProvider, raw: unknown): IdentificationStatus {
  const data = object(raw);
  if (!data || data.error !== undefined) return "unknown";
  if (DESTINATIONS[provider].kind === "models") {
    // Even a plausible public catalog is not proof that the key is accepted.
    return Array.isArray(data.data) && data.data.every(row => typeof object(row)?.id === "string") ? "models_advertised" : "unknown";
  }
  if (provider === "openrouter") {
    const key = object(data.data);
    return key && typeof key.label === "string" && numeric(key.usage) && (key.limit === null || numeric(key.limit)) ? "accepted_read_only" : "unknown";
  }
  return data.object === "credit_balance" && numeric(object(data.balance)?.usd) ? "accepted_read_only" : "unknown";
}

async function boundedJSON(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body) throw new Error("invalid identification response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { part.value.fill(0); throw new Error("invalid identification response"); }
      chunks.push(part.value);
    }
    const buffer = Buffer.concat(chunks);
    try { return JSON.parse(buffer.toString("utf8")) as unknown; }
    finally { buffer.fill(0); }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    void reader.cancel().catch(() => {});
  }
}

/** Transport injection is test-only; the CLI exposes no URL/transport override. */
export async function checkIdentificationProvider(provider: IdentificationProvider, key: string, transport: typeof fetch = fetch): Promise<IdentificationResult> {
  const entry = DESTINATIONS[provider], result: IdentificationResult = { provider, destination: entry.url, status: "unknown" };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response | undefined;
  try {
    const headers = entry.auth === "bearer" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01" };
    response = await transport(entry.url, { method: "GET", headers, redirect: "error", signal: controller.signal });
    // A supplied test transport can return redirects rather than reject them.
    if (response.redirected || response.status >= 300 && response.status < 400) return result;
    result.httpStatus = response.status;
    if (response.status === 401) result.status = "rejected";
    else if (response.status === 429) result.status = "rate_limited";
    else if (response.status === 200) result.status = successStatus(provider, await boundedJSON(response));
    return result;
  } catch { return result; } // Never expose provider text, JSON parse errors, or transport diagnostics.
  finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    controller.abort();
  }
}
