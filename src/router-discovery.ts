import { apiFetch } from "./api.js";

/** Metadata only. Never fetch or echo raw provider credentials or arbitrary metadata. */
export async function personalProviderKeys() {
  const response = await apiFetch<{ keys: Array<{ id: string; provider: string; label?: string; configured: boolean; enabled: boolean; modelAllow?: string[]; modelDeny?: string[] }> }>("/api/v5/inference/provider-keys");
  if (!response || !Array.isArray(response.keys)) throw new Error("Router returned an invalid provider-key discovery response (expected keys array); no selection was made");
  return { keys: response.keys.map(({ id, provider, label, configured, enabled, modelAllow, modelDeny }) =>
    ({ id, provider, label, configured, enabled, modelAllow, modelDeny })) };
}

/** Reuses the server's GM catalog and filtering; no client-maintained model list. */
export async function gmModels() {
  return apiFetch<{models: Array<{id: string; name?: string}>}>("/api/v5/inference/providers/gm/models?includeLegacy=true");
}

export function providerKeySelection(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const ids = [...new Set(raw.flatMap(value => value.split(",")).map(value => value.trim().toLowerCase()))];
  if (ids.length < 1 || ids.length > 64 || ids.some(id => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))) {
    throw new Error("--provider-key requires 1–64 saved key UUIDs; use endpoints provider-keys to discover them (never pass a raw API key)");
  }
  return ids.sort();
}
