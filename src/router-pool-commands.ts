import { readFile } from "node:fs/promises";
import type { Command, Option } from "commander";
import { getEndpoint } from "./api.js";
import { providerManagementBase, providerManagementFetch, requireProviderKeyId } from "./provider-key-api.js";

interface PoolRoute { keyId: string; weight: number; model?: string; requestsPerMinute?: number }
interface PoolPolicy { enabled: boolean; routes: PoolRoute[] }

/** A policy file names stored key UUIDs, never credentials or arbitrary provider options. */
export function parsePoolPolicy(raw: unknown): PoolPolicy {
  const invalid = () => new Error("pool file must contain only enabled and up to 16 routes with saved keyId UUIDs, weight 1–100, optional model and requestsPerMinute 0–6000");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const policy = raw as Record<string, unknown>;
  if (Object.keys(policy).some(key => !["enabled", "routes"].includes(key)) || typeof policy.enabled !== "boolean" || !Array.isArray(policy.routes) || policy.routes.length > 16 || (policy.enabled && policy.routes.length === 0)) throw invalid();
  const seen = new Set<string>();
  const routes = policy.routes.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
    const route = raw as Record<string, unknown>;
    if (Object.keys(route).some(key => !["keyId", "weight", "model", "requestsPerMinute"].includes(key)) || typeof route.keyId !== "string" || !Number.isInteger(route.weight) || Number(route.weight) < 1 || Number(route.weight) > 100) throw invalid();
    const keyId = requireProviderKeyId(route.keyId);
    if (seen.has(keyId)) throw new Error("pool routes must use distinct saved key UUIDs");
    seen.add(keyId);
    if (route.model !== undefined && (typeof route.model !== "string" || !route.model || route.model.length > 200 || /[\s\x00-\x1f\x7f]/.test(route.model))) throw invalid();
    if (route.requestsPerMinute !== undefined && (!Number.isInteger(route.requestsPerMinute) || Number(route.requestsPerMinute) < 0 || Number(route.requestsPerMinute) > 6000)) throw invalid();
    return { keyId, weight: Number(route.weight), ...(route.model === undefined ? {} : { model: route.model as string }), ...(route.requestsPerMinute === undefined ? {} : { requestsPerMinute: Number(route.requestsPerMinute) }) };
  });
  return { enabled: policy.enabled, routes };
}

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

export function registerRouterPoolCommands(endpoints: Command, outputOption: () => Option): void {
  const pool = endpoints.command("pool").description("configure a private weighted BYOK pool using stored key UUIDs; never changes billing").showHelpAfterError().addHelpText("after", "\nWeights divide new sessions, not individual requests. Existing session affinity and explicit failover remain in force. A probe does not establish provider capacity. System-funded Impala is separate from organization-owned custom keys.\n");
  pool.command("show").description("show private pool configuration and billing without changing either").argument("<endpoint>", "endpoint slug or UUID").addOption(outputOption())
    .action(async (ref: string) => {
      providerManagementBase();
      const { endpoint } = await getEndpoint(ref);
      const policy = endpoint.providerOptions?.private_upstream_routing;
      let sanitized: PoolPolicy | undefined;
      if (policy !== undefined) {
        try { sanitized = parsePoolPolicy(policy); }
        catch { /* A system-source or newer policy must not be printed or silently rewritten. */ }
      }
      print({ endpointId: endpoint.id, slug: endpoint.slug, billingMode: endpoint.billingMode, pool: sanitized ?? null, ...(policy !== undefined && sanitized === undefined ? { note: "This policy contains a system source or a newer schema. No settings were changed." } : {}), privateRoutingAllowed: (endpoint as unknown as Record<string, unknown>).privateUpstreamRoutingAllowed === true });
    });
  pool.command("set").description("replace only the private BYOK pool from a policy file; leave billing and other options unchanged").argument("<endpoint>", "endpoint slug or UUID").requiredOption("--file <path>", "JSON policy containing saved key UUIDs, never credentials").option("--dry-run", "validate and print the edit without saving it").addOption(outputOption())
    .action(async (ref: string, options: { file: string; dryRun?: boolean }) => {
      providerManagementBase();
      const bytes = await readFile(options.file);
      if (bytes.length > 32_768) throw new Error("pool policy file exceeds 32 KiB");
      let raw: unknown;
      try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("pool policy file must be valid JSON; its contents were not printed"); }
      const policy = parsePoolPolicy(raw);
      const { endpoint } = await getEndpoint(ref);
      if (policy.enabled && endpoint.billingMode !== "byok") throw new Error("this endpoint is not on full BYOK; change billing explicitly before enabling a private pool");
      const patch = { privateUpstreamRouting: policy };
      if (!options.dryRun) await providerManagementFetch(`/api/v5/inference/endpoints/${encodeURIComponent(endpoint.id)}`, { method: "PATCH", body: patch });
      print({ endpointId: endpoint.id, slug: endpoint.slug, billingMode: endpoint.billingMode, pool: policy, saved: !options.dryRun, note: "Only privateUpstreamRouting was submitted. Billing, key selection and failover were not changed." });
    });
  pool.command("disable").description("disable and clear this private pool without changing billing or provider key storage").argument("<endpoint>", "endpoint slug or UUID").option("--dry-run", "show the edit without saving it").addOption(outputOption())
    .action(async (ref: string, options: { dryRun?: boolean }) => {
      providerManagementBase();
      const { endpoint } = await getEndpoint(ref);
      const policy: PoolPolicy = { enabled: false, routes: [] };
      if (!options.dryRun) await providerManagementFetch(`/api/v5/inference/endpoints/${encodeURIComponent(endpoint.id)}`, { method: "PATCH", body: { privateUpstreamRouting: policy } });
      print({ endpointId: endpoint.id, slug: endpoint.slug, billingMode: endpoint.billingMode, pool: policy, saved: !options.dryRun });
    });
}
