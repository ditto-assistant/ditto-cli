import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { launchHarness, pickEndpoint } from "./agents/launch.js";
import { listSessions, removeSession } from "./agents/sessions.js";
import { DEFAULT_LAUNCH_EXPIRY, HARNESSES, type Harness, KEY_EXPIRIES, type KeyExpiry, apiRootOf } from "./agents/types.js";
import {
  BILLING_MODES,
  CONTEXT_COMPACTION_LEVELS,
  type ChatAgent,
  type EndpointInput,
  type InferenceEndpoint,
  MAX_ALIASES,
  MAX_ALIAS_TARGET_LEN,
  MAX_BATCH_MAX_REQUESTS,
  MAX_MEMORY_DEPTH,
  MAX_MODEL_ROUTES,
  MAX_MODEL_ROUTE_LEN,
  MAX_PRECOMPACT_AT_TOKENS,
  MAX_TOOL_ROUNDS,
  MAX_TRACE_RETENTION_DAYS,
  MODEL_MODES,
  RESULT_COMPRESSION_LEVELS,
  ROUTABLE_KINDS,
  ROUTING_MODES,
  STREAM_GRANULARITIES,
  createEndpoint,
  createKey,
  deleteEndpoint,
  findEndpoint,
  getEndpoint,
  isEndpointPending,
  listChatAgents,
  listEndpoints,
  listKeys,
  revokeKey,
  updateEndpoint,
} from "./api.js";
import { openInBrowser } from "./browser.js";
import { endpointURL } from "./config.js";
import { activationLink, formatActivation } from "./endpoint-format.js";
import {
  STORE_IDS,
  type SecretStore,
  type StoreId,
  type StoreTarget,
  VERCEL_TARGETS,
  deliver,
  probeStores,
  selectStore,
} from "./secret-stores/index.js";
import {
  SESSION_ENV,
  SESSION_ID_HEADER,
  endSession,
  readSessionHistory,
  resolveActiveSession,
  startSession,
  useSession,
} from "./mcp-session.js";
import { readStoredAuth, updateStoredAuth } from "./store.js";

interface EndpointsOptions {
  output?: string;
  setDefault?: string;
  clearDefault?: boolean;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Left-aligned columns sized to their widest cell; the last column is not padded. */
export function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]))).join("  ");
  process.stdout.write(`${line(header)}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
}

function spendColumn(e: InferenceEndpoint): string {
  const used = (e.spentTokens ?? 0).toLocaleString();
  if (e.spendLimitTokens == null || e.spendLimitTokens < 0) return `${used} / ∞`;
  return `${used} / ${e.spendLimitTokens.toLocaleString()}${e.spendPeriod && e.spendPeriod !== "never" ? ` ${e.spendPeriod}` : ""}`;
}

export function isJSON(options: { output?: string }): boolean {
  return options.output === "json" || options.output === "raw";
}

/**
 * Endpoint controls spend the user's credits, so anything destructive asks
 * the operator to type the slug back. `--yes` skips it for scripts; without a
 * terminal and without `--yes` the command refuses.
 */
async function confirmElevated(action: string, slug: string, yes: boolean | undefined): Promise<void> {
  await confirmTyped({ action: `${action} "${slug}"`, expected: slug, label: "the endpoint slug", yes });
}

/**
 * Generic typed confirmation: the operator must type `expected` back (or pass
 * `--yes`). Refuses without a terminal so scripts cannot stumble into it.
 */
export async function confirmTyped(input: { action: string; expected: string; label: string; yes: boolean | undefined; preview?: string }): Promise<void> {
  if (input.yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(`refusing to ${input.action} without confirmation. Re-run with --yes to confirm.`);
  }
  if (input.preview) process.stderr.write(`${input.preview}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const typed = (await rl.question(`Type ${input.label} (${input.expected}) to ${input.action}: `)).trim();
    if (typed !== input.expected) throw new Error(`aborted: "${typed}" did not match "${input.expected}"`);
  } finally {
    rl.close();
  }
}

/** Prints the backend's activation notice (with the claim token merged in) for inactive endpoints. */
async function noteActivation(endpoints: InferenceEndpoint[]): Promise<void> {
  const pending = endpoints.filter(isEndpointPending);
  if (pending.length === 0) return;
  const stored = await readStoredAuth();
  for (const e of pending) {
    process.stderr.write(`\n! ${e.slug} is not active yet.\n${formatActivation(e, stored?.claimURL)}\n\n`);
  }
}

/** JSON view of an endpoint with the activation link resolved for this install. */
async function endpointJSON(e: InferenceEndpoint): Promise<Record<string, unknown>> {
  const stored = await readStoredAuth();
  const link = activationLink(e, stored?.claimURL);
  return {
    ...e,
    ...(e.activation ? { activation: { ...e.activation, ...(link ? { url: link } : {}) } } : {}),
  };
}

export async function cmdEndpoints(options: EndpointsOptions): Promise<void> {
  if (options.setDefault && options.clearDefault) throw new Error("use either --set-default or --clear-default");
  const catalog = await listEndpoints();
  if (options.clearDefault) {
    await updateStoredAuth({ defaultEndpoint: undefined });
    process.stderr.write("Cleared the default endpoint.\n");
  }
  if (options.setDefault) {
    const wanted = options.setDefault.trim();
    const match = findEndpoint(catalog.endpoints, wanted);
    if (!match) {
      throw new Error(`no endpoint named "${wanted}". Available: ${catalog.endpoints.map((e) => e.slug).join(", ") || "(none)"}`);
    }
    await updateStoredAuth({ defaultEndpoint: match.slug });
    process.stderr.write(`Default endpoint set to ${match.slug}.\n`);
  }
  const defaultSlug = (await readStoredAuth())?.defaultEndpoint;
  if (isJSON(options)) {
    const endpoints = await Promise.all(catalog.endpoints.map(endpointJSON));
    process.stdout.write(`${JSON.stringify({ ...catalog, endpoints, defaultEndpoint: defaultSlug ?? null }, null, 2)}\n`);
    return;
  }
  if (catalog.endpoints.length === 0) {
    process.stdout.write(
      `No inference endpoints yet. Create one with \`heyditto endpoints create\`, or at ${endpointURL()}.\n`,
    );
    return;
  }
  const rows = catalog.endpoints.map((e) => [
    e.slug === defaultSlug ? "*" : " ",
    e.slug,
    e.model,
    spendColumn(e),
    [isEndpointPending(e) ? "inactive" : "", e.recordTrace ? "traces" : ""].filter(Boolean).join(" "),
  ]);
  const widths = [1, 0, 0, 0];
  for (const r of rows) for (let i = 1; i < 4; i++) widths[i] = Math.max(widths[i], r[i].length);
  process.stdout.write(`  ${pad("SLUG", widths[1])}  ${pad("MODEL", widths[2])}  ${pad("SPEND (tokens)", widths[3])}\n`);
  for (const r of rows) {
    process.stdout.write(`${r[0]} ${pad(r[1], widths[1])}  ${pad(r[2], widths[2])}  ${pad(r[3], widths[3])}  ${r[4]}\n`);
  }
  process.stdout.write(`\nGateway: ${catalog.baseUrl}${defaultSlug ? `  (* = default)` : ""}\n`);
  await noteActivation(catalog.endpoints);
}

interface EndpointCreateOptions {
  output?: string;
  name?: string;
  slug?: string;
  model?: string;
  default?: boolean;
}

export async function cmdEndpointCreate(options: EndpointCreateOptions): Promise<void> {
  const input: EndpointInput = {};
  if (options.name?.trim()) input.name = options.name.trim();
  if (options.slug?.trim()) input.slug = options.slug.trim().toLowerCase();
  if (options.model?.trim()) input.model = options.model.trim();
  const created = await createEndpoint(input);
  const stored = await readStoredAuth();
  const makeDefault = options.default || !stored?.defaultEndpoint;
  if (makeDefault) await updateStoredAuth({ defaultEndpoint: created.slug });
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ ...(await endpointJSON(created)), defaultEndpoint: makeDefault ? created.slug : (stored?.defaultEndpoint ?? null) }, null, 2)}\n`);
  } else {
    process.stdout.write(`Created endpoint ${created.slug} (model ${created.model})${makeDefault ? " — now the default" : ""}.\n`);
    if (!isEndpointPending(created)) {
      process.stdout.write(`Launch with: heyditto claude --endpoint ${created.slug}\n`);
    }
  }
  await noteActivation([created]);
}

export async function cmdEndpointShow(ref: string, options: { output?: string }): Promise<void> {
  const { endpoint, catalog } = await getEndpoint(ref);
  const defaultSlug = (await readStoredAuth())?.defaultEndpoint;
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ ...(await endpointJSON(endpoint)), baseUrl: catalog.baseUrl, isDefault: endpoint.slug === defaultSlug }, null, 2)}\n`);
    return;
  }
  const lines = [
    `slug:          ${endpoint.slug}${endpoint.slug === defaultSlug ? "  (default)" : ""}`,
    `name:          ${endpoint.name}`,
    `id:            ${endpoint.id}`,
    `model:         ${endpoint.model}${endpoint.modelMode ? `  (${endpoint.modelMode})` : ""}`,
    `status:        ${endpoint.status ?? "active"}`,
    `spend:         ${spendColumn(endpoint)}`,
    `memory:        recall ${endpoint.recallEnabled === false ? "off" : "on"}, record ${endpoint.recordEnabled === false ? "off" : "on"}${endpoint.memoryDepth !== undefined ? `, depth ${endpoint.memoryDepth}` : ""}`,
    `traces:        ${endpoint.recordTrace ? "on" : "off"}, attachments ${flagWord(endpoint.recordAttachments)}, kept ${retentionWord(endpoint.traceRetentionDays)}`,
    `routing:       ${textWord(endpoint.routingMode)}, model mode ${textWord(endpoint.modelMode)}, billing ${textWord(endpoint.billingMode)}`,
    `compaction:    context ${textWord(endpoint.contextCompaction)}, results ${textWord(endpoint.resultCompression)}, tools ${flagWord(endpoint.toolCompression)}, precompact ${precompactWord(endpoint.precompactAtTokens)}`,
    `tool rounds:   ${endpoint.maxToolRounds ?? "unset"}`,
    `stream:        ${textWord(endpoint.streamGranularity)}`,
    `batches:       ${flagWord(endpoint.batchEnabled)}${endpoint.batchMaxRequests !== undefined ? `, max ${endpoint.batchMaxRequests || "unlimited"} per batch` : ""}`,
    `kind routes:   ${mapWord(endpoint.kindRoutes)}`,
    `model routes:  ${mapWord(endpoint.modelRoutes)}`,
    `aliases:       ${mapWord(endpoint.aliases)}`,
    `tools:         ${(endpoint.tools ?? []).join(", ") || "(none)"}`,
    `gateway:       ${catalog.baseUrl}`,
    `web:           ${endpointURL(endpoint.id)}`,
  ];
  if (endpoint.systemPrompt) lines.push(`system prompt: ${endpoint.systemPrompt.length > 120 ? `${endpoint.systemPrompt.slice(0, 117)}…` : endpoint.systemPrompt}`);
  lines.push(...codingAgentLines(endpoint));
  process.stdout.write(`${lines.join("\n")}\n`);
  await noteActivation([endpoint]);
}

/**
 * Display helpers for `endpoints show`. A field the server did not send reads
 * as "unset" rather than being guessed at a default, so the text view never
 * claims a setting the endpoint may not actually have.
 */
function flagWord(v: boolean | undefined): string {
  return v === undefined ? "unset" : v ? "on" : "off";
}

function textWord(v: string | undefined): string {
  return v && v.trim() !== "" ? v : "unset";
}

function retentionWord(days: number | undefined): string {
  if (days === undefined) return "unset";
  return days === 0 ? "forever" : `${days} days`;
}

function precompactWord(tokens: number | undefined): string {
  if (tokens === undefined) return "unset";
  return tokens === 0 ? "off" : `${tokens.toLocaleString()} tokens`;
}

/** `a=x, b=y` in key order, so two runs of `show` diff cleanly. */
function mapWord(map: Record<string, string> | undefined): string {
  const entries = Object.entries(map ?? {});
  if (entries.length === 0) return "(none)";
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/**
 * Renders the endpoint's coding-agent settings. Only the harnesses that were
 * configured are shown, so an untouched endpoint stays quiet — but once a
 * prompt is customised it is always reported, because an agent silently
 * running on someone's edited prompt is exactly the surprise worth avoiding.
 */
function codingAgentLines(endpoint: InferenceEndpoint): string[] {
  const options = endpoint.providerOptions ?? {};
  const lines: string[] = [];
  if (options.codex_models === true) {
    const extras: string[] = [];
    if (options.codex_catalog === true) {
      const limit = typeof options.codex_catalog_limit === "number" ? options.codex_catalog_limit : 40;
      extras.push(`catalog ${limit}`);
    }
    lines.push(`codex picker:  on${extras.length ? `  (${extras.join(", ")})` : ""}`);
  }
  for (const harness of ["codex", "claude"] as const) {
    const prompt = options[`${harness}_system_prompt`];
    const auto = options[`${harness}_prompt_autoupdate`];
    const bits: string[] = [];
    const mode = options[`${harness}_prompt_mode`] === "append" ? "append" : "replace";
    if (typeof prompt === "string") bits.push(prompt === "" ? "none (no system prompt)" : `${mode} (${prompt.length} chars)`);
    if (auto === false) bits.push("auto-update off");
    if (bits.length) lines.push(`${harness} prompt:  ${bits.join(", ")}`);
  }
  return lines;
}

export async function cmdEndpointUse(ref: string, options: { output?: string }): Promise<void> {
  const { endpoint } = await getEndpoint(ref);
  await updateStoredAuth({ defaultEndpoint: endpoint.slug });
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ defaultEndpoint: endpoint.slug }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Default endpoint set to ${endpoint.slug}.\n`);
  await noteActivation([endpoint]);
}

export async function cmdEndpointPick(options: { output?: string }): Promise<void> {
  const catalog = await listEndpoints();
  if (catalog.endpoints.length === 0) {
    throw new Error("you have no inference endpoints yet. Create one with `heyditto endpoints create`.");
  }
  const stored = (await readStoredAuth())?.defaultEndpoint;
  const picked = await pickEndpoint(catalog.endpoints, stored);
  await updateStoredAuth({ defaultEndpoint: picked.slug });
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ defaultEndpoint: picked.slug }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Default endpoint set to ${picked.slug}.\n`);
  await noteActivation([picked]);
}

export async function cmdEndpointOpen(ref: string | undefined, options: { print?: boolean }): Promise<void> {
  // The developer console addresses endpoints by id; resolve the slug (or the
  // stored default) through the catalog. No target → the endpoints list.
  const target = ref ?? (await readStoredAuth())?.defaultEndpoint;
  const id = target ? (await getEndpoint(target)).endpoint.id : undefined;
  const url = endpointURL(id);
  process.stdout.write(`${url}\n`);
  if (!options.print) {
    process.stderr.write("Opening in your browser…\n");
    openInBrowser(url);
  }
}

interface EndpointSetOptions {
  output?: string;
  name?: string;
  model?: string;
  systemPrompt?: string;
  spendLimit?: string;
  spendPeriod?: string;
  recordTrace?: string;
  recordAttachments?: string;
  recall?: string;
  record?: string;
  memoryDepth?: string;
  maxToolRounds?: string;
  modelMode?: string;
  billingMode?: string;
  routing?: string;
  streamGranularity?: string;
  contextCompaction?: string;
  resultCompression?: string;
  toolCompression?: string;
  precompactAt?: string;
  traceRetention?: string;
  batch?: string;
  batchMaxRequests?: string;
  kindRoute?: string[];
  modelRoute?: string[];
  alias?: string[];
  clearKindRoutes?: boolean;
  clearModelRoutes?: boolean;
  clearAliases?: boolean;
  codexModels?: string;
  codexCatalog?: string;
  codexCatalogLimit?: string;
  codexPrompt?: string;
  codexPromptMode?: string;
  codexPromptAutoupdate?: string;
  claudePrompt?: string;
  claudePromptMode?: string;
  claudePromptAutoupdate?: string;
  yes?: boolean;
}

/**
 * Reads a prompt flag. `@path` loads a file, so a full agent prompt never has
 * to survive shell quoting; `reset` clears the endpoint's own text and puts it
 * back on the vendored baseline the harness ships with; an explicit empty
 * string means "send no system prompt at all".
 */
/** Validates a prompt mode; a typo must not silently mean "replace". */
function promptMode(flag: string, raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value !== "append" && value !== "replace") throw new Error(`${flag} must be append or replace`);
  return value;
}

async function promptValue(flag: string, raw: string | undefined): Promise<string | null | undefined> {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.toLowerCase() === "reset" || value.toLowerCase() === "baseline") return null;
  if (value.startsWith("@")) {
    const path = value.slice(1);
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      throw new Error(`${flag}: could not read ${path}: ${(err as Error).message}`);
    }
  }
  return raw;
}

function onOff(flag: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "false" || v === "no") return false;
  throw new Error(`${flag} must be on or off`);
}

/** Reads a bounded integer flag; separators are tolerated (50_000, 50,000). */
function intValue(flag: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim().replace(/[_,]/g, ""));
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}, got "${raw}"`);
  }
  return n;
}

/**
 * commander collector for a repeatable option. The default lives on the
 * parameter rather than on `.option(..., [])` so `--help` does not advertise
 * a meaningless "(default: [])" for every route flag.
 */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Parses repeated `key=value` flags into a map. Only the first `=` splits, so
 * a target may contain one. An empty value ("--kind-route aside=") marks the
 * key for removal from the merged map, which is how a single route is cleared
 * without rewriting the rest.
 */
function pairMap(flag: string, raw: string[] | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const at = entry.indexOf("=");
    const key = at < 0 ? "" : entry.slice(0, at).trim();
    if (!key) throw new Error(`${flag} must be key=value, got "${entry}"`);
    out[key] = entry.slice(at + 1).trim();
  }
  return out;
}

/**
 * Applies parsed `key=value` entries onto the endpoint's current map. The
 * server stores these maps whole, so a patch that sent only the new entries
 * would silently drop every route the user did not repeat on the command
 * line. `clear` replaces the map with an empty one instead.
 */
function mergeMap(
  current: Record<string, string> | undefined,
  entries: Record<string, string> | undefined,
  clear: boolean | undefined,
): Record<string, string> | undefined {
  if (clear) return {};
  if (entries === undefined) return undefined;
  const merged: Record<string, string> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(entries)) {
    if (value === "") delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Alias names follow the endpoint slug rule (inference.ValidSlug). */
const ALIAS_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Mirrors validateKindRoutes / validateModelRoutes / validateAliases. */
function checkRoutes(flag: string, map: Record<string, string>, limit: number, targetLen: number): void {
  const size = Object.keys(map).length;
  if (size > limit) throw new Error(`${flag}: at most ${limit} entries are allowed (got ${size})`);
  for (const [key, target] of Object.entries(map)) {
    if (key.length > MAX_MODEL_ROUTE_LEN) throw new Error(`${flag}: key "${key}" is longer than ${MAX_MODEL_ROUTE_LEN} characters`);
    if (target.length > targetLen) throw new Error(`${flag}: target for "${key}" is longer than ${targetLen} characters`);
  }
}

function checkKindRoutes(map: Record<string, string>): void {
  for (const kind of Object.keys(map)) {
    if (!(ROUTABLE_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`--kind-route: "${kind}" is not a routable request kind. Use one of: ${ROUTABLE_KINDS.join(", ")}`);
    }
  }
  checkRoutes("--kind-route", map, ROUTABLE_KINDS.length, MAX_MODEL_ROUTE_LEN);
}

function checkAliases(map: Record<string, string>, slug: string): void {
  for (const name of Object.keys(map)) {
    if (!ALIAS_NAME.test(name)) {
      throw new Error(`--alias: "${name}" must be 2-64 lowercase letters, digits or dashes and start with a letter or digit`);
    }
    if (name === slug || name === "ditto" || name === "auto") {
      throw new Error(`--alias: "${name}" is reserved (the endpoint slug, "ditto" and "auto" cannot be aliased)`);
    }
  }
  checkRoutes("--alias", map, MAX_ALIASES, MAX_ALIAS_TARGET_LEN);
}

export async function cmdEndpointSet(ref: string, options: EndpointSetOptions): Promise<void> {
  const patch: EndpointInput = {};
  if (options.name !== undefined) patch.name = options.name.trim();
  if (options.model !== undefined) patch.model = options.model.trim();
  if (options.systemPrompt !== undefined) patch.systemPrompt = options.systemPrompt;
  if (options.spendLimit !== undefined) {
    const raw = options.spendLimit.trim().toLowerCase();
    if (raw === "none" || raw === "unlimited" || raw === "off") {
      patch.spendLimitTokens = null;
    } else {
      const n = Number(raw.replace(/[_,]/g, ""));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--spend-limit must be a positive integer token count or "none", got "${options.spendLimit}"`);
      patch.spendLimitTokens = n;
    }
  }
  if (options.spendPeriod !== undefined) patch.spendPeriod = options.spendPeriod;
  const recordTrace = onOff("--record-trace", options.recordTrace);
  if (recordTrace !== undefined) patch.recordTrace = recordTrace;
  const recall = onOff("--recall", options.recall);
  if (recall !== undefined) patch.recallEnabled = recall;
  const record = onOff("--record", options.record);
  if (record !== undefined) patch.recordEnabled = record;
  if (options.memoryDepth !== undefined) {
    const n = Number(options.memoryDepth);
    if (!Number.isInteger(n) || n < 0 || n > MAX_MEMORY_DEPTH) throw new Error(`--memory-depth must be an integer from 0 to ${MAX_MEMORY_DEPTH}`);
    patch.memoryDepth = n;
  }
  const recordAttachments = onOff("--record-attachments", options.recordAttachments);
  if (recordAttachments !== undefined) patch.recordAttachments = recordAttachments;
  const toolCompression = onOff("--tool-compression", options.toolCompression);
  if (toolCompression !== undefined) patch.toolCompression = toolCompression;
  const batch = onOff("--batch", options.batch);
  if (batch !== undefined) patch.batchEnabled = batch;
  // Enum flags are already constrained by commander's .choices(); trim so a
  // quoted value with stray whitespace still matches the server's enum.
  if (options.modelMode !== undefined) patch.modelMode = options.modelMode.trim();
  if (options.billingMode !== undefined) patch.billingMode = options.billingMode.trim();
  if (options.routing !== undefined) patch.routingMode = options.routing.trim();
  if (options.streamGranularity !== undefined) patch.streamGranularity = options.streamGranularity.trim();
  if (options.contextCompaction !== undefined) patch.contextCompaction = options.contextCompaction.trim();
  if (options.resultCompression !== undefined) patch.resultCompression = options.resultCompression.trim();
  const maxToolRounds = intValue("--max-tool-rounds", options.maxToolRounds, 0, MAX_TOOL_ROUNDS);
  if (maxToolRounds !== undefined) patch.maxToolRounds = maxToolRounds;
  const precompactAt = intValue("--precompact-at", options.precompactAt, 0, MAX_PRECOMPACT_AT_TOKENS);
  if (precompactAt !== undefined) patch.precompactAtTokens = precompactAt;
  const traceRetention = intValue("--trace-retention", options.traceRetention, 0, MAX_TRACE_RETENTION_DAYS);
  if (traceRetention !== undefined) patch.traceRetentionDays = traceRetention;
  const batchMax = intValue("--batch-max-requests", options.batchMaxRequests, 0, MAX_BATCH_MAX_REQUESTS);
  if (batchMax !== undefined) patch.batchMaxRequests = batchMax;
  // Route and alias entries are parsed (not yet merged) before any network
  // call, so a malformed pair fails without touching the endpoint.
  const kindEntries = pairMap("--kind-route", options.kindRoute);
  const routeEntries = pairMap("--model-route", options.modelRoute);
  const aliasEntries = pairMap("--alias", options.alias);
  const touchesMaps =
    kindEntries !== undefined ||
    routeEntries !== undefined ||
    aliasEntries !== undefined ||
    Boolean(options.clearKindRoutes) ||
    Boolean(options.clearModelRoutes) ||
    Boolean(options.clearAliases);
  // Coding-agent settings live in providerOptions. They are merged onto what
  // the endpoint already has, so setting one flag never silently drops the
  // others; `reset` removes a key rather than writing an empty one, which is
  // the difference between "use the harness's own prompt" and "no prompt".
  const agent: Record<string, unknown> = {};
  const codexModels = onOff("--codex-models", options.codexModels);
  if (codexModels !== undefined) agent.codex_models = codexModels;
  const codexCatalog = onOff("--codex-catalog", options.codexCatalog);
  if (codexCatalog !== undefined) agent.codex_catalog = codexCatalog;
  if (options.codexCatalogLimit !== undefined) {
    const n = Number(options.codexCatalogLimit);
    if (!Number.isInteger(n) || n < 0) throw new Error("--codex-catalog-limit must be a non-negative integer");
    agent.codex_catalog_limit = n;
  }
  const codexPrompt = await promptValue("--codex-prompt", options.codexPrompt);
  if (codexPrompt !== undefined) {
    agent.codex_system_prompt = codexPrompt;
    // `reset` returns the endpoint to the vendored baseline, so the mode that
    // described the removed text goes with it. Leaving it behind parks a
    // setting that reads as configured, describes nothing, and silently takes
    // effect again the next time a prompt is set.
    if (codexPrompt === null) agent.codex_prompt_mode = null;
  }
  if (options.codexPromptMode !== undefined) agent.codex_prompt_mode = promptMode("--codex-prompt-mode", options.codexPromptMode);
  const codexAuto = onOff("--codex-prompt-autoupdate", options.codexPromptAutoupdate);
  if (codexAuto !== undefined) agent.codex_prompt_autoupdate = codexAuto;
  const claudePrompt = await promptValue("--claude-prompt", options.claudePrompt);
  if (claudePrompt !== undefined) {
    agent.claude_system_prompt = claudePrompt;
    if (claudePrompt === null) agent.claude_prompt_mode = null;
  }
  if (options.claudePromptMode !== undefined) agent.claude_prompt_mode = promptMode("--claude-prompt-mode", options.claudePromptMode);
  const claudeAuto = onOff("--claude-prompt-autoupdate", options.claudePromptAutoupdate);
  if (claudeAuto !== undefined) agent.claude_prompt_autoupdate = claudeAuto;

  if (Object.keys(patch).length === 0 && Object.keys(agent).length === 0 && !touchesMaps) {
    throw new Error("nothing to change; pass at least one --flag (see `heyditto endpoints set --help`)");
  }

  const { endpoint } = await getEndpoint(ref);
  // The server replaces these maps wholesale, so merge onto what the endpoint
  // has now and validate the result the way the backend will.
  const kindRoutes = mergeMap(endpoint.kindRoutes, kindEntries, options.clearKindRoutes);
  if (kindRoutes !== undefined) {
    checkKindRoutes(kindRoutes);
    patch.kindRoutes = kindRoutes;
  }
  const modelRoutes = mergeMap(endpoint.modelRoutes, routeEntries, options.clearModelRoutes);
  if (modelRoutes !== undefined) {
    checkRoutes("--model-route", modelRoutes, MAX_MODEL_ROUTES, MAX_MODEL_ROUTE_LEN);
    patch.modelRoutes = modelRoutes;
  }
  const aliases = mergeMap(endpoint.aliases, aliasEntries, options.clearAliases);
  if (aliases !== undefined) {
    checkAliases(aliases, endpoint.slug);
    patch.aliases = aliases;
  }
  if (Object.keys(agent).length > 0) {
    const merged: Record<string, unknown> = { ...(endpoint.providerOptions ?? {}) };
    for (const [key, value] of Object.entries(agent)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    patch.providerOptions = merged;
  }
  // Raising or removing a spend cap lets the endpoint spend more credits.
  const raisesSpend =
    patch.spendLimitTokens === null ||
    (typeof patch.spendLimitTokens === "number" &&
      endpoint.spendLimitTokens != null &&
      endpoint.spendLimitTokens >= 0 &&
      patch.spendLimitTokens > endpoint.spendLimitTokens) ||
    (patch.spendPeriod !== undefined && patch.spendPeriod !== endpoint.spendPeriod && patch.spendPeriod === "never");
  if (raisesSpend) await confirmElevated("raise the spend limit of", endpoint.slug, options.yes);

  const updated = await updateEndpoint(endpoint.id, patch);
  if (updated.slug !== endpoint.slug && (await readStoredAuth())?.defaultEndpoint === endpoint.slug) {
    await updateStoredAuth({ defaultEndpoint: updated.slug });
  }
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify(await endpointJSON(updated), null, 2)}\n`);
    return;
  }
  process.stdout.write(`Updated ${updated.slug}: ${Object.keys(patch).join(", ")}.\n`);
  // Trace retention is clamped to the owner's plan ceiling server-side; say so
  // rather than let the endpoint quietly keep a shorter window than asked for.
  if (patch.traceRetentionDays !== undefined && updated.traceRetentionDays !== undefined && updated.traceRetentionDays !== patch.traceRetentionDays) {
    process.stderr.write(
      `! trace retention was set to ${updated.traceRetentionDays === 0 ? "permanent" : `${updated.traceRetentionDays} days`}, not ${patch.traceRetentionDays}: your plan caps it.\n`,
    );
  }
  await noteActivation([updated]);
}

export async function cmdEndpointDelete(ref: string, options: { yes?: boolean; output?: string }): Promise<void> {
  const { endpoint } = await getEndpoint(ref);
  await confirmElevated("delete", endpoint.slug, options.yes);
  await deleteEndpoint(endpoint.id);
  const stored = await readStoredAuth();
  if (stored?.defaultEndpoint === endpoint.slug || stored?.defaultEndpoint === endpoint.id) {
    await updateStoredAuth({ defaultEndpoint: undefined });
  }
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ deleted: endpoint.id, slug: endpoint.slug }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Deleted endpoint ${endpoint.slug}. Its keys stop working immediately; threads and traces are kept.\n`);
}

export async function cmdEndpointKeys(ref: string, options: { output?: string }): Promise<void> {
  const { endpoint } = await getEndpoint(ref);
  const keys = await listKeys(endpoint.id);
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ endpoint: { id: endpoint.id, slug: endpoint.slug }, keys }, null, 2)}\n`);
    return;
  }
  if (keys.length === 0) {
    process.stdout.write(`No keys on ${endpoint.slug}. \`heyditto claude\` mints a temporary one per session.\n`);
    return;
  }
  const rows = keys.map((k) => [
    k.id,
    `…${k.keyHint}`,
    k.name,
    k.revokedAt ? "revoked" : k.expiresAt ? `expires ${k.expiresAt.slice(0, 10)}` : "no expiry",
    k.lastUsedAt ? `used ${k.lastUsedAt.slice(0, 16).replace("T", " ")}` : "",
  ]);
  const header = ["ID", "KEY", "NAME", "STATE", "LAST USED"];
  printTable(header, rows);
}

export async function cmdEndpointKeysRevoke(ref: string, keyId: string, options: { yes?: boolean; output?: string }): Promise<void> {
  const { endpoint } = await getEndpoint(ref);
  await confirmElevated(`revoke key ${keyId} on`, endpoint.slug, options.yes);
  await revokeKey(endpoint.id, keyId);
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ revoked: keyId, endpoint: endpoint.slug }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Revoked key ${keyId} on ${endpoint.slug}.\n`);
}

export interface KeysCreateOptions {
  output?: string;
  /** Canonical destination selector; every store also has a shorthand flag. */
  store?: string;
  secret?: string;
  ghSecret?: string;
  gitlabVar?: string;
  awsSecret?: string;
  gcpSecret?: string;
  azSecret?: string;
  opItem?: string;
  vaultSecret?: string;
  dopplerSecret?: string;
  cfSecret?: string;
  vercelEnv?: string;
  k8sSecret?: string;
  flySecret?: string;
  repo?: string;
  env?: string;
  org?: string;
  region?: string;
  project?: string;
  keyVault?: string;
  opVault?: string;
  mount?: string;
  field?: string;
  dopplerConfig?: string;
  worker?: string;
  vercelTarget?: string;
  namespace?: string;
  k8sKey?: string;
  app?: string;
  name?: string;
  expires?: string;
  budget?: string;
  spendPeriod?: string;
  yes?: boolean;
}

/** Shorthand flag values keyed by the store they select. */
export function shorthandsOf(options: KeysCreateOptions): Partial<Record<StoreId, string>> {
  return {
    github: options.ghSecret,
    gitlab: options.gitlabVar,
    aws: options.awsSecret,
    gcloud: options.gcpSecret,
    azure: options.azSecret,
    "1password": options.opItem,
    vault: options.vaultSecret,
    doppler: options.dopplerSecret,
    cloudflare: options.cfSecret,
    vercel: options.vercelEnv,
    kubernetes: options.k8sSecret,
    fly: options.flySecret,
  };
}

function parseKeyBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--budget must be a positive integer token count, got "${raw}"`);
  return n;
}

function parseKeyExpiry(raw: string | undefined): KeyExpiry {
  const value = (raw ?? "1y").trim();
  if ((KEY_EXPIRIES as readonly string[]).includes(value)) return value as KeyExpiry;
  throw new Error(`--expires must be one of: ${KEY_EXPIRIES.join(", ")}`);
}

/**
 * Mints a key on an endpoint and hands the plaintext straight to the platform
 * CLI over stdin (`gh secret set`, `gcloud secrets create --data-file=-`, …).
 * The key is never printed, logged or stored locally; when the platform CLI
 * fails it is revoked again so nothing usable is left behind.
 */
export async function cmdEndpointKeysCreate(ref: string, options: KeysCreateOptions): Promise<void> {
  const { store, name: secretName } = selectStore({ ...options, shorthands: shorthandsOf(options) });
  const budget = parseKeyBudget(options.budget);
  const expiresIn = parseKeyExpiry(options.expires);
  if (options.spendPeriod !== undefined && budget === undefined) throw new Error("--spend-period only applies together with --budget");
  const spendPeriod = budget !== undefined ? (options.spendPeriod ?? "monthly") : undefined;

  // Everything that can fail cheaply happens before any write: the platform
  // CLI is present and signed in, its target is known, the endpoint exists,
  // and the operator confirmed.
  store.preflight();
  const target = store.resolveTarget(options);
  const { endpoint, catalog } = await getEndpoint(ref);
  const keyName = options.name?.trim() || defaultKeyName(store, target, secretName);
  const plan = `Will mint key "${keyName}" on ${endpoint.slug} (expires ${expiresIn}${budget !== undefined ? `, budget ${budget.toLocaleString()} tokens ${spendPeriod}` : ""}) and store ${secretName} in ${target.describe}.`;
  await confirmTyped({ action: `mint a key on ${endpoint.slug} and store ${secretName} in ${store.label}`, expected: secretName, label: `the ${store.nameLabel.toLowerCase()}`, yes: options.yes, preview: plan });

  const minted = await createKey(endpoint.id, {
    name: keyName,
    expiresIn,
    ...(budget !== undefined ? { spendLimitTokens: budget, spendPeriod } : {}),
  });
  // Split the plaintext off immediately; only `plaintext` may reach the
  // platform CLI's stdin.
  const { key: plaintext, ...key } = minted;
  try {
    deliver(store, secretName, store.deliveries(secretName, target), plaintext ?? "");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      await revokeKey(endpoint.id, key.id);
    } catch (revokeErr) {
      const detail = revokeErr instanceof Error ? revokeErr.message : String(revokeErr);
      throw new Error(
        `${reason}\nMinted key ${key.id} (…${key.keyHint}) on ${endpoint.slug} could NOT be revoked (${detail}). Revoke it now: heyditto endpoints keys revoke ${endpoint.slug} ${key.id} --yes, or at ${endpointURL(endpoint.id)}`,
      );
    }
    throw new Error(`${reason}\nThe key minted for it (…${key.keyHint}) was revoked again; nothing was stored.`);
  }

  const anthropicBaseUrl = apiRootOf(catalog.baseUrl);
  const openaiBaseUrl = catalog.baseUrl;
  const gateway = { anthropicBaseUrl, openaiBaseUrl };
  if (isJSON(options)) {
    process.stdout.write(
      `${JSON.stringify(
        {
          endpoint: { id: endpoint.id, slug: endpoint.slug },
          key: {
            id: key.id,
            name: key.name ?? keyName,
            keyHint: key.keyHint,
            expiresIn,
            expiresAt: key.expiresAt ?? null,
            spendLimitTokens: key.spendLimitTokens ?? budget ?? null,
            spendPeriod: key.spendPeriod ?? spendPeriod ?? null,
          },
          store: store.id,
          secret: {
            name: secretName,
            ...target.fields,
            describe: target.describe,
            ...(store.snippet ? { snippet: store.snippet(secretName, target) } : {}),
          },
          gateway: { baseUrl: catalog.baseUrl, anthropicBaseUrl, openaiBaseUrl },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(
    [
      `Minted key …${key.keyHint} (${key.name ?? keyName}) on ${endpoint.slug}: expires ${expiresIn}${budget !== undefined ? `, budget ${budget.toLocaleString()} tokens ${spendPeriod}` : ", no spend cap"}.`,
      `Stored ${secretName} in ${target.describe} via ${store.bin}. The key was not printed and is not kept locally.`,
      "",
      ...store.usage(secretName, target, gateway),
      "",
      `Revoke later with: heyditto endpoints keys revoke ${endpoint.slug} ${key.id}`,
    ].join("\n") + "\n",
  );
}

/** Key label in the Ditto app: which store, which target, which name. */
export function defaultKeyName(store: SecretStore, target: StoreTarget, secretName: string): string {
  if (store.keyName) return store.keyName(secretName, target);
  const scope = Object.entries(target.fields)
    .filter(([key, value]) => key !== "kind" && value)
    .map(([, value]) => value)
    .join("/");
  return `${store.id}:${scope ? `${scope}:` : ""}${secretName}`;
}

/** Lists every destination and whether this machine can delegate to it. */
export async function cmdEndpointKeyStores(options: { output?: string }): Promise<void> {
  const probes = probeStores();
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify(probes, null, 2)}\n`);
    return;
  }
  const header = ["STORE", "DESTINATION", "CLI", "STATUS", "FLAGS"];
  const rows = probes.map((p) => [
    p.id,
    p.label,
    p.resolvedBin,
    p.installed ? "installed" : "not installed",
    [`${p.shorthand} <${p.nameLabel}>`, ...p.flags].join(" "),
  ]);
  printTable(header, rows);
  const missing = probes.filter((p) => !p.installed);
  if (missing.length > 0) {
    process.stdout.write(
      `\nNot installed: ${missing.map((p) => p.bin).join(", ")}. Install the one you need, or store the key by hand from the console.\n`,
    );
  }
}

/** Registers the `endpoints` group; bare `heyditto endpoints [flags]` still lists. */
export function registerEndpointCommands(
  program: Command,
  addExamples: (c: Command, ex: string) => Command,
  outputOption: () => Option,
): void {
  const endpoints = program
    .command("endpoints")
    .description("manage the inference endpoints used by heyditto claude / codex")
    .summary("manage inference endpoints")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Endpoint controls spend your Ditto credits, so delete, key revocation and
spend-limit increases ask you to type the slug back (or pass --yes).
'keys create' mints a key straight into a secret manager via its own CLI
through the gh CLI; the plaintext never reaches your terminal.`,
    );
  addExamples(
    endpoints
      .command("list", { isDefault: true })
      .description("list your inference endpoints (* = default)")
      .option("--set-default <slug>", "endpoint to use when --endpoint is omitted")
      .option("--clear-default", "forget the default endpoint")
      .addOption(outputOption())
      .action(cmdEndpoints),
    `  heyditto endpoints
  heyditto endpoints --set-default my-endpoint
  heyditto endpoints list --output json`,
  );
  addExamples(
    endpoints
      .command("create")
      .description("create an endpoint (one click: name, slug and model are generated when omitted)")
      .option("--name <name>", "display name")
      .option("--slug <slug>", "url-safe slug (lowercase letters, digits, dashes)")
      .option("--model <id>", "default model id (default: the gateway's default model)")
      .option("--default", "make it the default for heyditto claude / codex (automatic when you have no default yet)")
      .addOption(outputOption())
      .action(cmdEndpointCreate),
    `  heyditto endpoints create
  heyditto endpoints create --name "Work laptop" --model anthropic/claude-sonnet-5 --default`,
  );
  endpoints
    .command("show")
    .description("show one endpoint's settings")
    .argument("<endpoint>", "endpoint slug or id")
    .addOption(outputOption())
    .action(cmdEndpointShow);
  endpoints
    .command("use")
    .description("make an endpoint the default for heyditto claude / codex")
    .argument("<endpoint>", "endpoint slug or id")
    .addOption(outputOption())
    .action(cmdEndpointUse);
  endpoints
    .command("pick")
    .description("choose the default endpoint interactively")
    .addOption(outputOption())
    .action(cmdEndpointPick);
  endpoints
    .command("open")
    .description("open the endpoint editor in the Ditto app (default endpoint when omitted)")
    .argument("[endpoint]", "endpoint slug or id")
    .option("--print", "print the URL without opening a browser")
    .action(cmdEndpointOpen);
  addExamples(
    endpoints
      .command("set")
      .description("change an endpoint's settings (mirror of the web editor)")
      .argument("<endpoint>", "endpoint slug or id")
      .option("--name <name>", "display name")
      .option("--model <id>", "default model id")
      .option("--system-prompt <text>", "system prompt prepended to every request")
      .option("--codex-models <on|off>", "list this endpoint's models in Codex's /model picker")
      .option("--codex-catalog <on|off>", "also list the provider catalog (Claude, Gemini, …) in Codex")
      .option("--codex-catalog-limit <n>", "how many catalog models to list in Codex (default 40)")
      .option("--codex-prompt <text|@file|reset>", "Codex system prompt; reset restores the vendored baseline")
      .option("--codex-prompt-mode <append|replace>", "add the prompt to Codex's own, or replace it (default replace)")
      .option("--codex-prompt-autoupdate <on|off>", "track new Codex baselines (default on); off pins the current one")
      .option("--claude-prompt <text|@file|reset>", "Claude Code system prompt; reset restores the vendored baseline")
      .option("--claude-prompt-mode <append|replace>", "add the prompt to Claude Code's own, or replace it (default replace)")
      .option("--claude-prompt-autoupdate <on|off>", "track new Claude Code baselines (default on)")
      .option("--spend-limit <tokens|none>", "spend cap in Ditto tokens, or none")
      .addOption(new Option("--spend-period <period>", "window the spend cap resets on").choices(["daily", "weekly", "monthly", "yearly", "never"]))
      .option("--record-trace <on|off>", "store raw request/response traces")
      .option("--record-attachments <on|off>", "store images sent on the user turn so the thread shows them")
      .option("--trace-retention <days>", "days recorded traces are kept; 0 = forever (clamped to your plan)")
      .option("--recall <on|off>", "recall memories into requests")
      .option("--record <on|off>", "record new memories from requests")
      .option("--memory-depth <n>", `memories recalled per request (0-${MAX_MEMORY_DEPTH})`)
      .addOption(new Option("--context-compaction <level>", "how eagerly finished tool results are digested").choices([...CONTEXT_COMPACTION_LEVELS]))
      .addOption(new Option("--result-compression <level>", "compress tool results at ingestion").choices([...RESULT_COMPRESSION_LEVELS]))
      .option("--tool-compression <on|off>", "replace harness tool descriptions with stored condensed rewrites")
      .option("--precompact-at <tokens>", "start a background compaction snapshot at this prompt size; 0 = off")
      .addOption(new Option("--routing <mode>", "how a provider is picked for a model").choices([...ROUTING_MODES]))
      .addOption(new Option("--model-mode <mode>", "what happens to an unknown request model").choices([...MODEL_MODES]))
      .addOption(new Option("--billing-mode <mode>", "whose provider keys pay for requests").choices([...BILLING_MODES]))
      .addOption(new Option("--stream-granularity <level>", "how much server-side tool activity the stream shows").choices([...STREAM_GRANULARITIES]))
      .option("--max-tool-rounds <n>", `server-side tool loop cap per request (0-${MAX_TOOL_ROUNDS})`)
      .option("--batch <on|off>", "admit batch submissions")
      .option("--batch-max-requests <n>", `requests one batch may carry (0-${MAX_BATCH_MAX_REQUESTS}; 0 disables)`)
      .option("--kind-route <kind=model>", `pin a request kind to a model (${ROUTABLE_KINDS.join(", ")}); repeatable, empty value removes one`, collect)
      .option("--model-route <requested=target>", "map a requested model id to a provider model; repeatable, empty value removes one", collect)
      .option("--alias <name=model>", "name a model on this endpoint; repeatable, empty value removes one", collect)
      .option("--clear-kind-routes", "remove every kind route")
      .option("--clear-model-routes", "remove every model route")
      .option("--clear-aliases", "remove every alias")
      .option("--yes", "skip the confirmation when raising a spend limit")
      .addOption(outputOption())
      .action(cmdEndpointSet),
    `  heyditto endpoints set my-endpoint --model openai/gpt-5.6-luna --record-trace on
  heyditto endpoints set my-endpoint --spend-limit 5000000 --spend-period monthly
  heyditto endpoints set my-endpoint --context-compaction aggressive --result-compression grouped
  heyditto endpoints set my-endpoint --routing cheap --model-mode passthrough --max-tool-rounds 16
  heyditto endpoints set my-endpoint --kind-route aside=openai/gpt-5.6-nano --kind-route probe=openai/gpt-5.6-nano
  heyditto endpoints set my-endpoint --alias fast=openai/gpt-5.6-nano --model-route gpt-4o=openai/gpt-5.6-luna
  heyditto endpoints set my-endpoint --codex-models on --codex-catalog on
  heyditto endpoints set my-endpoint --codex-prompt @prompt.md
  heyditto endpoints set my-endpoint --codex-prompt reset --codex-prompt-autoupdate off`,
  );
  endpoints
    .command("delete")
    .description("delete an endpoint (keys stop working; threads and traces are kept)")
    .argument("<endpoint>", "endpoint slug or id")
    .option("--yes", "skip the confirmation prompt")
    .addOption(outputOption())
    .action(cmdEndpointDelete);
  const keys = endpoints
    .command("keys")
    .description("list an endpoint's API keys")
    .argument("<endpoint>", "endpoint slug or id")
    .addOption(outputOption())
    .action(cmdEndpointKeys);
  addExamples(
    keys
      .command("create")
      .description("mint a key and store it straight into a secret manager through its own CLI (the key is never printed)")
      .argument("<endpoint>", "endpoint slug or id")
      .addOption(new Option("--store <destination>", "where the key goes").choices([...STORE_IDS]))
      .option("--secret <NAME>", "name of the secret, variable, item or path to store (with --store)")
      .option("--gh-secret <NAME>", "shorthand for --store github --secret NAME")
      .option("--gitlab-var <NAME>", "shorthand for --store gitlab --secret NAME")
      .option("--aws-secret <NAME>", "shorthand for --store aws --secret NAME")
      .option("--gcp-secret <NAME>", "shorthand for --store gcloud --secret NAME")
      .option("--az-secret <NAME>", "shorthand for --store azure --secret NAME")
      .option("--op-item <TITLE>", "shorthand for --store 1password --secret TITLE")
      .option("--vault-secret <PATH>", "shorthand for --store vault --secret PATH")
      .option("--doppler-secret <NAME>", "shorthand for --store doppler --secret NAME")
      .option("--cf-secret <NAME>", "shorthand for --store cloudflare --secret NAME")
      .option("--vercel-env <NAME>", "shorthand for --store vercel --secret NAME")
      .option("--k8s-secret <NAME>", "shorthand for --store kubernetes --secret NAME")
      .option("--fly-secret <NAME>", "shorthand for --store fly --secret NAME")
      .option("--repo <owner/repo>", "github: repository for the secret (default: the repo of the current directory)")
      .option("--env <environment>", "github: deployment environment; gitlab: variable environment scope")
      .option("--org <org>", "github: organization secret; gitlab: group variable (cannot be combined with --repo/--env)")
      .option("--region <region>", "aws: region for the secret (default: the configured region)")
      .option("--project <project>", "gitlab, gcloud, doppler: project (default: the CLI's configured project)")
      .option("--key-vault <name>", "azure: Key Vault the secret goes into (required)")
      .option("--op-vault <name>", "1password: vault for the item (default: Private)")
      .option("--mount <mount>", "vault: kv mount (default: secret)")
      .option("--field <field>", "vault: field at the path (default: token)")
      .option("--doppler-config <config>", "doppler: config within the project, e.g. prod")
      .option("--worker <name>", "cloudflare: Worker name (default: the local wrangler config)")
      .addOption(new Option("--vercel-target <target>", "vercel: environment").choices([...VERCEL_TARGETS]))
      .option("--namespace <namespace>", "kubernetes: namespace (default: default)")
      .option("--k8s-key <key>", "kubernetes: key within the secret (default: key)")
      .option("--app <app>", "fly: app name (default: the local fly.toml)")
      .option("--name <label>", "key name shown in the Ditto app (default: <store>:<target>:<NAME>)")
      .addOption(new Option("--expires <duration>", "server-side key expiry").choices([...KEY_EXPIRIES]).default("1y"))
      .option("--budget <tokens>", "spend cap for the key, in Ditto tokens")
      .addOption(new Option("--spend-period <period>", "window the key's spend cap resets on (with --budget; default monthly)").choices(["daily", "weekly", "monthly", "yearly", "never"]))
      .option("--yes", "skip the confirmation prompt (required without a terminal)")
      .addOption(outputOption())
      .action(cmdEndpointKeysCreate),
    `  heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY                  # repo of the current directory
  heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY --repo acme/app --budget 5000000
  heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY --org acme --expires 6mo --output json
  heyditto endpoints keys create my-endpoint --store aws --secret DITTO_KEY --region us-east-1
  heyditto endpoints keys create my-endpoint --gcp-secret DITTO_KEY --project my-gcp-project
  heyditto endpoints keys create my-endpoint --az-secret DITTO_KEY --key-vault my-vault
  heyditto endpoints keys create my-endpoint --op-item "Ditto inference" --op-vault Engineering
  heyditto endpoints keys create my-endpoint --vault-secret ditto/inference --mount secret --field token
  heyditto endpoints keys create my-endpoint --gitlab-var DITTO_KEY --project acme/app
  heyditto endpoints keys create my-endpoint --k8s-secret ditto-inference --namespace prod`,
  );
  keys
    .command("stores")
    .description("list the secret managers keys can be minted into, and whether their CLI is installed here")
    .addOption(outputOption())
    .action(cmdEndpointKeyStores);
  keys
    .command("revoke")
    .description("revoke one key")
    .argument("<endpoint>", "endpoint slug or id")
    .argument("<keyId>", "key id (see `heyditto endpoints keys <endpoint>`)")
    .option("--yes", "skip the confirmation prompt")
    .addOption(outputOption())
    .action(cmdEndpointKeysRevoke);
}

interface SessionsOptions {
  json?: boolean;
  all?: boolean;
}

export async function cmdSessions(options: SessionsOptions): Promise<void> {
  const records = await listSessions();
  const shown = options.all ? records : records.slice(0, 20);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
    return;
  }
  if (shown.length === 0) {
    process.stdout.write("No coding-agent sessions yet. Start one with `heyditto claude` or `heyditto codex`.\n");
    return;
  }
  for (const s of shown) {
    const state = s.endedAt ? `exited ${s.exitCode ?? "?"}` : "running/unknown";
    process.stdout.write(
      `${s.id}  ${pad(s.harness, 6)}  ${pad(s.endpointSlug, 16)}  ${s.lastLaunchedAt.slice(0, 16).replace("T", " ")}  ${state}\n`,
    );
    process.stdout.write(`  ${s.worktree ?? s.cwd}${s.launches > 1 ? `  (${s.launches} launches)` : ""}\n`);
  }
  if (!options.all && records.length > shown.length) {
    process.stdout.write(`\n…and ${records.length - shown.length} more (use --all)\n`);
  }
  process.stdout.write(`\nResume: heyditto <claude|codex> --resume <id>\n`);
}

export async function cmdSessionsRm(id: string): Promise<void> {
  const removed = await removeSession(id);
  if (!removed) throw new Error(`no local session "${id}"`);
  process.stdout.write(`Removed local session record ${id} (the Ditto thread and traces are kept).\n`);
}

/** Registers `claude` and `codex` on the program (which must have enablePositionalOptions()). */
export function registerHarnessCommands(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  for (const harness of HARNESSES) {
    const other: Harness = harness === "claude" ? "codex" : "claude";
    const cmd = program
      .command(`${harness} [args...]`)
      .description(
        `launch ${harness === "claude" ? "Claude Code" : "Codex"} through a Ditto inference endpoint with a temporary key`,
      )
      .summary(`launch ${harness === "claude" ? "Claude Code" : "Codex"} through a Ditto endpoint`)
      .option("-e, --endpoint <slug>", "inference endpoint slug or id (default: saved default, or a picker)")
      .option("--budget <tokens>", "spend cap for this session's key, in Ditto tokens")
      .addOption(
        new Option("--expires <duration>", "server-side safety expiry for the key (revoked on exit anyway unless --keep-key)")
          .choices([...KEY_EXPIRIES])
          .default(DEFAULT_LAUNCH_EXPIRY),
      )
      .option("--keep-key", "do not revoke the key when the agent exits")
      .option("--session <id>", "reuse a Ditto session id (X-Ditto-Session-Id) for the traces thread")
      .option("--resume [id]", "resume a local session (default: the most recent one); mints a fresh key")
      .option("-c, --continue", `continue the most recent ${harness} conversation in this directory`)
      .option("--yolo", `bypass all permission prompts (${harness === "claude" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox"})`)
      .option("--yellow", `auto-accept edits (${harness === "claude" ? "--permission-mode acceptEdits" : "-a on-request -s workspace-write"})`)
      // The machine-readable flag differs per harness: Claude Code takes
      // --output-format, Codex takes --json. Naming the wrong one sends people
      // to "error: unexpected argument", which is what this used to do for
      // Codex.
      .option(
        "-p, --prompt <text>",
        `headless run (${harness === "claude" ? "claude -p" : "codex exec"}); pair with ${harness === "claude" ? "--output-format json" : "--json"} for machine-readable output`,
      )
      .option("-m, --model <id>", `model id (default: let the endpoint route ${harness === "codex" ? "Codex's" : "Claude's"} own model ids)`)
      .option("-w, --worktree [name]", "run inside <repo>/.worktrees/<name> (created on a branch of the same name)")
      .option("--name <label>", "key name shown in the Ditto app (default: cli:<harness>:<hostname>)")
      .option("--dry-run", "print the command, args and env (key masked) without minting a key")
      .allowUnknownOption()
      .passThroughOptions();
    if (harness === "claude") cmd.option("--plan", "start in plan mode (--permission-mode plan)");
    cmd.action(async (args: string[], options) => {
      await launchHarness(harness, args, options);
    });
    addExamples(
      cmd,
      `  heyditto ${harness}                       first run: sign in + pick an endpoint in the browser, then launch
  heyditto ${harness} --endpoint my-endpoint --budget 500000
  heyditto ${harness} --yellow --worktree feature-x
  heyditto ${harness} -p "summarize this repo" ${harness === "claude" ? "--output-format json" : "--json"}
  heyditto ${harness} --resume                 reopen the last session in its thread
  heyditto ${harness} -- --verbose             forward flags to ${harness}
  (see also: heyditto ${other})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Explicit MCP sessions: `heyditto session …`
// ---------------------------------------------------------------------------

interface SessionOutputOptions {
  output?: string;
}

function jsonOut(options: SessionOutputOptions): boolean {
  return options.output === "json" || options.output === "raw";
}

function sessionOutputOption(): Option {
  return new Option("--output <format>", "output format").choices(["text", "json"]).default("text");
}

function relativeAge(iso: string | undefined | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export async function cmdSessionNew(nameParts: string[], options: SessionOutputOptions & { id?: string }): Promise<void> {
  const name = nameParts.join(" ").trim() || undefined;
  const record = await startSession(name, options.id);
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify({ active: true, ...record }, null, 2)}\n`);
    return;
  }
  process.stderr.write(
    `Started session ${record.id}${record.name ? ` (${record.name})` : ""}.\n` +
      `Memory commands now send ${SESSION_ID_HEADER}; end it with \`heyditto session end\`.\n`,
  );
  process.stdout.write(`${record.id}\n`);
}

export async function cmdSessionList(options: SessionOutputOptions & { all?: boolean }): Promise<void> {
  const [history, active] = await Promise.all([readSessionHistory(), resolveActiveSession()]);
  const rows = options.all ? history : history.slice(0, 20);
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify({ active: active ?? null, sessions: rows }, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No MCP sessions yet. Start one with `heyditto session new [name]`.\n");
    return;
  }
  for (const r of rows) {
    const mark = active?.id === r.id ? "*" : " ";
    const state = r.endedAt ? "ended" : active?.id === r.id ? "active" : "idle";
    process.stdout.write(
      `${mark} ${r.id}  ${pad(state, 6)}  ${pad(relativeAge(r.lastUsedAt ?? r.createdAt), 9)}  ${r.name ?? ""}\n`,
    );
  }
  if (active?.source === "env") process.stdout.write(`\n${SESSION_ENV} pins session ${active.id} for this shell.\n`);
}

export async function cmdSessionUse(id: string, options: SessionOutputOptions): Promise<void> {
  const record = await useSession(id);
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify({ active: true, ...record }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`Using session ${record.id}${record.name ? ` (${record.name})` : ""}.\n`);
  process.stdout.write(`${record.id}\n`);
}

export async function cmdSessionCurrent(options: SessionOutputOptions): Promise<void> {
  const active = await resolveActiveSession();
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify(active ?? null, null, 2)}\n`);
    if (!active) process.exitCode = 1;
    return;
  }
  if (!active) {
    process.stderr.write("No active session. Start one with `heyditto session new [name]`.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${active.id}\n`);
  if (active.name) process.stderr.write(`name: ${active.name}\n`);
  if (active.source === "env") process.stderr.write(`(pinned by ${SESSION_ENV})\n`);
}

export async function cmdSessionEnd(options: SessionOutputOptions): Promise<void> {
  const ended = await endSession();
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify(ended ?? null, null, 2)}\n`);
    return;
  }
  if (!ended) {
    process.stderr.write("No active session.\n");
    return;
  }
  process.stderr.write(`Ended session ${ended.id}. Memory commands go back to the implicit session.\n`);
}

export function registerSessionCommands(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  const session = program
    .command("session")
    .description("explicit MCP sessions: group saves and searches into one thread")
    .summary("manage the explicit MCP session")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Without a session, MCP saves fall into a time-based implicit session on the
server. 'session new' pins an explicit one: every request carries
${SESSION_ID_HEADER} (and the name once, as X-Ditto-Session-Name). Set
${SESSION_ENV} to pin a session for one shell or script.`,
    );
  addExamples(
    session
      .command("new")
      .description("start a new session and make it active")
      .argument("[name...]", "optional name; becomes the thread title")
      .option("--id <id>", "use this session id instead of a random uuid")
      .addOption(sessionOutputOption())
      .action(cmdSessionNew),
    `  heyditto session new "refactor auth module"
  heyditto session new --output json | jq -r .id`,
  );
  session
    .command("list")
    .description("list local sessions (newest first; * = active)")
    .option("--all", "show every record, not just the latest 20")
    .addOption(sessionOutputOption())
    .action(cmdSessionList);
  session
    .command("use")
    .description("make an existing session active")
    .argument("<id>", "session id (a unique prefix of at least 6 chars works)")
    .addOption(sessionOutputOption())
    .action(cmdSessionUse);
  session
    .command("current")
    .description("print the active session id (exit 1 when none)")
    .addOption(sessionOutputOption())
    .action(cmdSessionCurrent);
  session
    .command("end")
    .description("end the active session (history is kept)")
    .addOption(sessionOutputOption())
    .action(cmdSessionEnd);
}

// ---------------------------------------------------------------------------
// Chat agents: `heyditto agents`
// ---------------------------------------------------------------------------

function connectionsColumn(a: ChatAgent): string {
  const live = (a.connections ?? []).filter((c) => !c.revokedAt);
  return live.map((c) => `${c.kind}${c.name ? `:${c.name}` : ""}`).join(", ");
}

export async function cmdAgents(options: SessionOutputOptions): Promise<void> {
  const agents = await listChatAgents();
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify({ agents }, null, 2)}\n`);
    return;
  }
  if (agents.length === 0) {
    process.stdout.write("No agents yet.\n");
    return;
  }
  const rows = agents.map((a) => [
    a.id,
    a.kind,
    a.name,
    String(a.threadCount ?? ""),
    relativeAge(a.lastActivityAt ?? a.updatedAt),
    connectionsColumn(a),
  ]);
  const header = ["ID", "KIND", "NAME", "THREADS", "LAST ACTIVITY", "CONNECTIONS"];
  printTable(header, rows);
}
