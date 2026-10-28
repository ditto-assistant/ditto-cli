import type { ProviderCatalogEntry, ProviderProtocol } from "./provider-key-api.js";

export function parseProviderProtocol(raw?: string): ProviderProtocol | undefined {
  if (raw === undefined) return undefined;
  if (raw === "openai" || raw === "openai_chat") return "openai_chat";
  if (raw === "anthropic" || raw === "anthropic_messages") return "anthropic_messages";
  throw new Error("--protocol must be openai or anthropic");
}

/** Local hints select no network destination. Broad shared prefixes such as sk- remain ambiguous. */
export function providerKeyHints(key: string, catalog: ProviderCatalogEntry[]): string[] {
  const matches = catalog.flatMap(provider => provider.keyPrefixHints.filter(prefix => prefix.length >= 4 && key.startsWith(prefix)).map(prefix => ({ id: provider.id, length: prefix.length })));
  const longest = Math.max(0, ...matches.map(match => match.length));
  return [...new Set(matches.filter(match => match.length === longest).map(match => match.id))].sort();
}

export function providerURLInput(raw: string): { baseUrl: string; protocolHint?: ProviderProtocol } {
  const value = raw.trim();
  if (!value || value.length > 2000 || /[\x00-\x20\x7f]/.test(value)) throw new Error("--base-url must be one public HTTPS URL without credentials or query parameters");
  let url: URL;
  try { url = new URL(value.includes("://") ? value : `https://${value}`); }
  catch { throw new Error("--base-url must be a valid public HTTPS URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.startsWith("[") || /^[0-9.]+$/.test(host)) {
    throw new Error("--base-url must be a public HTTPS hostname without credentials, query parameters or a fragment");
  }
  const protocolHint = /\/messages\/?$/.test(url.pathname) ? "anthropic_messages" : /\/(?:chat\/completions|responses)\/?$/.test(url.pathname) ? "openai_chat" : undefined;
  // The backend owns method-suffix normalization, DNS admission and its network
  // boundary. Keep custom prefixes intact rather than guessing a /v1 path here.
  return { baseUrl: url.toString(), ...(protocolHint ? { protocolHint } : {}) };
}

export function boundedInteger(value: string | undefined, label: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

export function publicProviderParams(raw: string[], entry?: ProviderCatalogEntry, baseUrl?: string, secret?: string): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (const argument of raw) {
    const split = argument.indexOf("=");
    const name = argument.slice(0, split);
    if (split < 1 || !/^[a-z][a-z0-9_]{0,63}$/.test(name) || /key|token|secret|password|authorization/.test(name) || ["constructor", "prototype", "base_url"].includes(name) || !entry?.params?.some(param => param.name === name)) {
      throw new Error("--param accepts only this provider's declared public settings; use --base-url for URLs and hidden input for credentials");
    }
    const value = argument.slice(split + 1);
    if (Object.hasOwn(params, name) || !value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value) || (secret && value.includes(secret))) throw new Error("invalid or duplicate public provider parameter; no values were printed");
    params[name] = value;
  }
  for (const param of entry?.params ?? []) {
    if (param.required && !(param.name === "base_url" && baseUrl) && !Object.hasOwn(params, param.name)) throw new Error(`this provider requires the public setting ${param.name}; use ${param.name === "base_url" ? "--base-url URL" : `--param ${param.name}=VALUE`}`);
  }
  return Object.keys(params).length ? params : undefined;
}
