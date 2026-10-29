import { readFile } from "node:fs/promises";
import type { Command, Option } from "commander";
import { printProviderMetadata } from "./provider-output.js";
import { getEndpoint } from "./api.js";
import { providerManagementBase, providerManagementFetch, requireProviderKeyId } from "./provider-key-api.js";

interface PoolRoute { keyId: string; weight: number; model?: string; requestsPerMinute?: number }
interface PoolV1 { enabled: boolean; routes: PoolRoute[] }
interface PoolV2 { version: 2; enabled: boolean; modes: { standard: { routes: PoolRoute[] }; fast: { routes: PoolRoute[] } } }
type PoolPolicy = PoolV1 | PoolV2;

/** A policy file names stored key UUIDs, never credentials or arbitrary provider options. */
export function parsePoolPolicy(raw: unknown): PoolPolicy {
  const invalid = () => new Error("pool file must use enabled plus V1 routes, or version 2 with explicit standard and fast mode routes; each enabled set needs 1–16 saved key UUIDs with weight 1–100, optional model and requestsPerMinute 0–6000");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  const policy = raw as Record<string, unknown>;
  if (typeof policy.enabled !== "boolean") throw invalid();
  const parseRoutes = (raw: unknown): PoolRoute[] => {
    if (!Array.isArray(raw) || raw.length > 16 || (policy.enabled && raw.length === 0)) throw invalid();
    const seen = new Set<string>();
    return raw.map(raw => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
      const route = raw as Record<string, unknown>;
      if (Object.keys(route).some(key => !["keyId", "weight", "model", "requestsPerMinute"].includes(key)) || typeof route.keyId !== "string" || !Number.isInteger(route.weight) || Number(route.weight) < 1 || Number(route.weight) > 100) throw invalid();
      const keyId = requireProviderKeyId(route.keyId);
      if (seen.has(keyId)) throw new Error("each mode's pool routes must use distinct saved key UUIDs");
      seen.add(keyId);
      if (route.model !== undefined && (typeof route.model !== "string" || !route.model || route.model.length > 200 || /[\s\x00-\x1f\x7f]/.test(route.model))) throw invalid();
      if (route.requestsPerMinute !== undefined && (!Number.isInteger(route.requestsPerMinute) || Number(route.requestsPerMinute) < 0 || Number(route.requestsPerMinute) > 6000)) throw invalid();
      return { keyId, weight: Number(route.weight), ...(route.model === undefined ? {} : { model: route.model as string }), ...(route.requestsPerMinute === undefined ? {} : { requestsPerMinute: Number(route.requestsPerMinute) }) };
    });
  };
  if (policy.version === undefined) {
    if (Object.keys(policy).some(key => !["enabled", "routes"].includes(key))) throw invalid();
    return { enabled: policy.enabled, routes: parseRoutes(policy.routes) };
  }
  if (policy.version !== 2 || Object.keys(policy).some(key => !["version", "enabled", "modes"].includes(key)) || !policy.modes || typeof policy.modes !== "object" || Array.isArray(policy.modes)) throw invalid();
  const modes = policy.modes as Record<string, unknown>;
  if (Object.keys(modes).length !== 2 || Object.keys(modes).some(key => key !== "standard" && key !== "fast")) throw invalid();
  const modeRoutes = (raw: unknown): { routes: PoolRoute[] } => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "routes")) throw invalid();
    return { routes: parseRoutes((raw as Record<string, unknown>).routes) };
  };
  return { version: 2, enabled: policy.enabled, modes: { standard: modeRoutes(modes.standard), fast: modeRoutes(modes.fast) } };
}

function print(value: unknown, output?: string): void { printProviderMetadata(value, output); }

export function registerRouterPoolCommands(endpoints: Command, outputOption: () => Option): void {
  const pool = endpoints.command("pool").description("configure a private weighted BYOK pool using stored key UUIDs; never changes billing").showHelpAfterError().addHelpText("after", "\nWeights divide new sessions, not individual requests. Existing session affinity and explicit failover remain in force. A probe does not establish provider capacity. Version 2 requires explicit standard and fast route sets; trusted Review context chooses the mode, with no implicit fallback between them. This configures routing pools, not supplier service tiers. Credential rate limits are shared across modes. System-funded Impala is separate from organization-owned custom keys.\n");
  pool.command("show").description("show private pool configuration and billing without changing either").argument("<endpoint>", "endpoint slug or UUID").addOption(outputOption().default("json"))
    .action(async (ref: string, options: { output?: string }) => {
      providerManagementBase();
      const { endpoint } = await getEndpoint(ref);
      const policy = endpoint.providerOptions?.private_upstream_routing;
      let sanitized: PoolPolicy | undefined;
      if (policy !== undefined) {
        try { sanitized = parsePoolPolicy(policy); }
        catch { /* A system-source or newer policy must not be printed or silently rewritten. */ }
      }
      print({ endpointId: endpoint.id, slug: endpoint.slug, billingMode: endpoint.billingMode, pool: sanitized ?? null, ...(policy !== undefined && sanitized === undefined ? { note: "This stored policy is invalid or uses a schema or system source this CLI cannot display. No settings were changed." } : {}), privateRoutingAllowed: (endpoint as unknown as Record<string, unknown>).privateUpstreamRoutingAllowed === true }, options.output);
    });
  pool.command("set").description("replace only the private BYOK pool from a policy file; leave billing and other options unchanged").argument("<endpoint>", "endpoint slug or UUID").requiredOption("--file <path>", "JSON policy containing saved key UUIDs, never credentials").option("--dry-run", "validate and print the edit without saving it").addOption(outputOption().default("json"))
    .action(async (ref: string, options: { file: string; dryRun?: boolean; output?: string }) => {
      providerManagementBase();
      const bytes = await readFile(options.file);
      if (bytes.length > 32_768) throw new Error("pool policy file exceeds 32 KiB");
      let raw: unknown;
      try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("pool policy file must be valid JSON; its contents were not printed"); }
      const policy = parsePoolPolicy(raw);
      const { endpoint } = await getEndpoint(ref);
      if (policy.enabled && endpoint.billingMode !== "byok") throw new Error("this endpoint is not on full BYOK; change billing explicitly before enabling a private pool");
      const existing = endpoint.providerOptions?.private_upstream_routing;
      if (existing && typeof existing === "object" && (existing as Record<string, unknown>).version === 2 && !("version" in policy)) throw new Error("a version 2 pool cannot be replaced by a V1 policy; preserve both modes or use pool disable");
      const patch = { privateUpstreamRouting: policy };
      if (!options.dryRun) await providerManagementFetch(`/api/v5/inference/endpoints/${encodeURIComponent(endpoint.id)}`, { method: "PATCH", body: patch });
      print({ endpointId: endpoint.id, slug: endpoint.slug, billingMode: endpoint.billingMode, pool: policy, saved: !options.dryRun, note: "Only privateUpstreamRouting was submitted. Billing, key selection and failover were not changed." }, options.output);
    });
  pool.command("disable").description("disable this private pool atomically while preserving its version and all route sets").argument("<endpoint>", "endpoint slug or UUID").option("--dry-run", "show the edit without saving it").addOption(outputOption().default("json"))
    .action(async (ref: string, options: { dryRun?: boolean; output?: string }) => {
      providerManagementBase();
      const { endpoint } = await getEndpoint(ref);
      if (!options.dryRun) await providerManagementFetch(`/api/v5/inference/endpoints/${encodeURIComponent(endpoint.id)}/private-routing`, { method: "PATCH", body: { poolEnabled: false } });
      print({ endpointId: endpoint.id, slug: endpoint.slug, billingMode: endpoint.billingMode, poolEnabled: false, saved: !options.dryRun, note: options.dryRun ? "Only the enabled flag will change atomically; pool version, routes, modes and billing will be preserved." : "Only the enabled flag was changed atomically. Pool version, routes, modes and billing were preserved." }, options.output);
    });
}
