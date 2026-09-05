import type { InferenceEndpoint } from "./api.js";
import { mergeActivationURL } from "./store.js";

/**
 * Renders the backend's activation notice for an endpoint that cannot serve
 * requests yet. The copy comes from the server; the CLI only fills in the
 * agent's claim token when it has one.
 */
export function formatActivation(endpoint: InferenceEndpoint, storedClaimURL: string | undefined): string {
  const a = endpoint.activation;
  if (!a) return `Endpoint ${endpoint.slug} is inactive (${endpoint.status ?? "unknown"}).`;
  const lines = [a.message.trim()];
  if (a.url) lines.push("", `Activation link: ${mergeActivationURL(a.url, storedClaimURL)}`);
  return lines.join("\n");
}

/** Resolved activation link (with the claim token merged in), if the endpoint has one. */
export function activationLink(endpoint: InferenceEndpoint, storedClaimURL: string | undefined): string | undefined {
  const url = endpoint.activation?.url;
  return url ? mergeActivationURL(url, storedClaimURL) : undefined;
}
