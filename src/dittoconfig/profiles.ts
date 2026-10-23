/**
 * Router profiles: a `.ditto/endpoints/<name>.toml` declares a Ditto Router
 * endpoint in version control, and `heyditto repo apply` makes the caller's
 * account match it.
 *
 * A profile is materialised per owner, not shared by id. `owner = "@omniaura"`
 * applies it to that organization's endpoint (the caller must be able to manage
 * it there); `owner = "personal"` (the default) applies it to the caller's own
 * endpoint, so anyone who clones the repository gets the same Router setup in
 * their own account, billed to them. The endpoint is found by slug within that
 * owner; there is no id in the file, because ids differ per account.
 *
 * Only keys the file names are written. Settings it leaves out keep whatever
 * the endpoint has, so a profile can pin the prompt and the model without
 * owning the tool list a person curated in the console.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  type EndpointInput,
  type InferenceEndpoint,
  apiFetch,
  createEndpoint,
  listCompanies,
  updateEndpoint,
} from "../api.js";
import type { EndpointDecl } from "./types.js";

/** `[settings]` keys a profile may set, mapped to the PATCH body field. */
const SETTING_FIELDS: Record<string, keyof EndpointInput | "codeMode" | "subagentRoutes" | "tools" | "autoApproveTools" | "requiredConnections" | "toolApprovalMode" | "speculativeCompaction"> = {
  system_prompt: "systemPrompt",
  model_mode: "modelMode",
  routing_mode: "routingMode",
  billing_mode: "billingMode",
  stream_granularity: "streamGranularity",
  context_compaction: "contextCompaction",
  result_compression: "resultCompression",
  speculative_compaction: "speculativeCompaction",
  tool_compression: "toolCompression",
  code_mode: "codeMode",
  precompact_at_tokens: "precompactAtTokens",
  max_tool_rounds: "maxToolRounds",
  memory_depth: "memoryDepth",
  recall: "recallEnabled",
  record: "recordEnabled",
  record_trace: "recordTrace",
  record_attachments: "recordAttachments",
  trace_retention_days: "traceRetentionDays",
  batch: "batchEnabled",
  batch_max_requests: "batchMaxRequests",
  tools: "tools",
  tool_approval_mode: "toolApprovalMode",
  auto_approve_tools: "autoApproveTools",
  tool_deny: "toolDeny",
  required_connections: "requiredConnections",
  kind_routes: "kindRoutes",
  model_routes: "modelRoutes",
  subagent_routes: "subagentRoutes",
  aliases: "aliases",
};

/** Harness prompt settings: stored in providerOptions, text read from a checked-in file. */
const HARNESSES = ["claude", "codex"] as const;
type Harness = (typeof HARNESSES)[number];

export interface HarnessPromptDecl {
  /** Path of the prompt text, relative to the profile file. */
  file?: string;
  /** "replace" (default) swaps the harness's own prompt; "append" adds to it. */
  mode?: "replace" | "append";
  /** Track new harness baselines (only meaningful in append mode). */
  autoupdate?: boolean;
}

export interface ProfileOwner {
  kind: "personal" | "org";
  /** Organization slug without the @, for kind "org". */
  org?: string;
}

/** One planned write: what changes on which endpoint. */
export interface ApplyPlan {
  profile: string;
  slug: string;
  owner: ProfileOwner;
  companyId?: string;
  action: "create" | "update" | "unchanged";
  endpointId?: string;
  /** Field → [current, wanted]. Prompt text is summarised by length. */
  changes: Record<string, [unknown, unknown]>;
  body: Record<string, unknown>;
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export function parseOwner(raw: unknown, profile: string): ProfileOwner {
  if (raw === undefined || raw === "personal") return { kind: "personal" };
  if (typeof raw === "string" && /^@[a-z0-9][a-z0-9-]{0,63}$/.test(raw)) return { kind: "org", org: raw.slice(1) };
  throw new ProfileError(`endpoints.${profile}.settings.owner must be "personal" or "@<org-slug>", got ${JSON.stringify(raw)}`);
}

/**
 * Builds the endpoint body a profile asks for, reading prompt files relative
 * to the profile's directory. Unknown setting keys fail rather than being
 * ignored: a typo in version-controlled config must not silently mean "keep".
 */
export async function profileBody(decl: EndpointDecl, profileDir: string): Promise<{ body: Record<string, unknown>; options: Record<string, unknown | null> }> {
  const settings = { ...(decl.settings ?? {}) } as Record<string, unknown>;
  delete settings.owner;
  const body: Record<string, unknown> = {};
  if (decl.model) body.model = decl.model;
  if (decl.description) body.name = decl.description;
  const options: Record<string, unknown | null> = {};
  for (const harness of HARNESSES) {
    const raw = settings[`${harness}_prompt`];
    delete settings[`${harness}_prompt`];
    if (raw === undefined) continue;
    const p = raw as HarnessPromptDecl;
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      throw new ProfileError(`endpoints.${decl.name}.settings.${harness}_prompt must be a table, e.g. { file = "${harness}.md" }`);
    }
    for (const k of Object.keys(p)) {
      if (!["file", "mode", "autoupdate"].includes(k)) throw new ProfileError(`endpoints.${decl.name}.settings.${harness}_prompt.${k}: unknown key (file, mode, autoupdate)`);
    }
    if (p.file !== undefined) {
      options[`${harness}_system_prompt`] = await readPromptFile(decl.name, harness, profileDir, p.file);
    }
    if (p.mode !== undefined) {
      if (p.mode !== "replace" && p.mode !== "append") throw new ProfileError(`endpoints.${decl.name}.settings.${harness}_prompt.mode must be replace or append`);
      options[`${harness}_prompt_mode`] = p.mode;
    }
    if (p.autoupdate !== undefined) {
      if (typeof p.autoupdate !== "boolean") throw new ProfileError(`endpoints.${decl.name}.settings.${harness}_prompt.autoupdate must be true or false`);
      options[`${harness}_prompt_autoupdate`] = p.autoupdate;
    }
  }
  for (const [key, value] of Object.entries(settings)) {
    const field = SETTING_FIELDS[key];
    if (!field) {
      throw new ProfileError(
        `endpoints.${decl.name}.settings.${key}: unknown setting. Known: owner, claude_prompt, codex_prompt, ${Object.keys(SETTING_FIELDS).join(", ")}`,
      );
    }
    body[field] = field === "toolDeny" ? denyRules(decl.name, value) : value;
  }
  return { body, options };
}

/**
 * Deny rules in the form the server stores them (toolgate.NormalizeDenyRules:
 * trimmed, lower-case, without the mcp__ditto__ prefix, deduplicated), so a
 * profile written either way reads back unchanged instead of re-patching on
 * every apply. The server still validates each rule.
 */
function denyRules(profile: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ProfileError(`endpoints.${profile}.settings.tool_deny must be a list of strings, e.g. ["gmail__send_*", "class:gated"]`);
  }
  const rules = value.map((v: string) => v.trim().toLowerCase().replace(/^mcp__ditto__/, ""));
  return [...new Set(rules)];
}

/**
 * Reads a prompt file that must live inside the repository's `.ditto/`. The
 * check runs on the RESOLVED path: a symlink checked in under `.ditto/` that
 * points at ~/.ssh or a credentials file would otherwise pass a lexical check
 * and send that file's contents to the endpoint as its system prompt.
 */
async function readPromptFile(profile: string, harness: string, profileDir: string, rel: string): Promise<string> {
  const field = `endpoints.${profile}.settings.${harness}_prompt.file`;
  // Anchor to the repository, not to wherever .ditto/ resolves: a .ditto that
  // is itself a symlink to another directory would otherwise become the boundary.
  const repoRoot = await realpath(path.resolve(profileDir, "..", ".."));
  const dittoDir = await realpath(path.resolve(profileDir, ".."));
  if (!dittoDir.startsWith(repoRoot + path.sep)) throw new ProfileError(`${field}: .ditto/ must be a directory inside the repository, not a link out of it`);
  let file: string;
  try {
    file = await realpath(path.resolve(profileDir, rel));
  } catch (e) {
    throw new ProfileError(`endpoints.${profile}: cannot read ${harness} prompt ${rel}: ${(e as Error).message}`);
  }
  if (!file.startsWith(dittoDir + path.sep)) throw new ProfileError(`${field} must stay inside .ditto/ (symlinks included): ${rel}`);
  if (!(await stat(file)).isFile()) throw new ProfileError(`${field} is not a regular file: ${rel}`);
  return readFile(file, "utf8");
}

function summarise(field: string, v: unknown): unknown {
  if (typeof v === "string" && (field.endsWith("_system_prompt") || field === "systemPrompt") && v.length > 80) return `<${v.length} chars>`;
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)));
  return v ?? null;
}

/** Endpoints owned by exactly this owner: an org's catalog, or the caller's personal (no company) ones. */
async function ownerEndpoints(companyId: string | undefined): Promise<InferenceEndpoint[]> {
  const query = companyId ? `?company=${encodeURIComponent(companyId)}` : "";
  const res = await apiFetch<{ endpoints?: InferenceEndpoint[] }>(`/api/v5/inference/endpoints${query}`);
  const all = res.endpoints ?? [];
  return companyId ? all.filter((e) => e.companyId === companyId) : all.filter((e) => !e.companyId);
}

/** Resolves where a profile lives and what writing it would change, without writing. */
export async function planProfile(decl: EndpointDecl, profileDir: string): Promise<ApplyPlan> {
  const owner = parseOwner((decl.settings as Record<string, unknown> | undefined)?.owner, decl.name);
  const slug = decl.slug ?? decl.name;
  let companyId: string | undefined;
  if (owner.kind === "org") {
    const org = (await listCompanies()).find((c) => c.slug === owner.org || c.id === owner.org);
    if (!org) throw new ProfileError(`profile ${decl.name} requires organization @${owner.org}, and you are not a member of it`);
    companyId = org.id;
  }
  const { body, options } = await profileBody(decl, profileDir);
  const current = (await ownerEndpoints(companyId)).find((e) => e.slug === slug);
  const plan: ApplyPlan = { profile: decl.name, slug, owner, companyId, action: "unchanged", endpointId: current?.id, changes: {}, body: {} };
  if (!current) {
    plan.action = "create";
    const merged: Record<string, unknown | null> = { ...options };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    plan.body = { slug, name: decl.description ?? slug, ...body, ...(Object.keys(merged).length ? { providerOptions: merged } : {}), ...(companyId ? { companyId } : {}) };
    for (const [k, v] of Object.entries(plan.body)) plan.changes[k] = [undefined, summarise(k, v)];
    return plan;
  }
  const cur = current as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(body)) {
    if (!same(cur[k], v)) {
      plan.body[k] = v;
      plan.changes[k] = [summarise(k, cur[k]), summarise(k, v)];
    }
  }
  const curOptions = (current.providerOptions ?? {}) as Record<string, unknown>;
  const nextOptions: Record<string, unknown> = { ...curOptions };
  let optionsChanged = false;
  for (const [k, v] of Object.entries(options)) {
    if (same(curOptions[k], v)) continue;
    optionsChanged = true;
    plan.changes[`providerOptions.${k}`] = [summarise(k, curOptions[k]), summarise(k, v)];
    if (v === null) delete nextOptions[k];
    else nextOptions[k] = v;
  }
  if (optionsChanged) plan.body.providerOptions = nextOptions;
  plan.action = Object.keys(plan.body).length ? "update" : "unchanged";
  return plan;
}

/** Performs a plan. Returns the endpoint as the server now has it. */
export async function applyPlan(plan: ApplyPlan): Promise<InferenceEndpoint | undefined> {
  if (plan.action === "unchanged") return undefined;
  if (plan.action === "create") return createEndpoint(plan.body as EndpointInput);
  return updateEndpoint(plan.endpointId as string, plan.body as EndpointInput);
}

export function isHarness(v: string): v is Harness {
  return (HARNESSES as readonly string[]).includes(v);
}

/** Where a launch's repository profile comes from, for the log line and errors. */
export interface RepoProfile {
  /** The profile name from .ditto/endpoints/, or the raw slug when default_endpoint names none. */
  name: string;
  slug: string;
  owner: ProfileOwner;
  repoDir: string;
}

/**
 * The profile a launch should use when no --endpoint was passed: the nearest
 * enclosing repository's `repository.default_endpoint`. Returns undefined when
 * there is no .ditto/config.toml or it names no default, so a launch outside a
 * configured repository behaves exactly as before.
 */
export async function repoDefaultProfile(startDir: string): Promise<RepoProfile | undefined> {
  const { loadDittoConfig, DittoConfigNotFound } = await import("./load.js");
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const eff = await loadDittoConfig(dir);
      const wanted = eff.config.repository.defaultEndpoint;
      if (!wanted) return undefined;
      const decl = eff.endpoints[wanted];
      if (!decl) return { name: wanted, slug: wanted, owner: { kind: "personal" }, repoDir: dir };
      return { name: decl.name, slug: decl.slug ?? decl.name, owner: parseOwner((decl.settings as Record<string, unknown> | undefined)?.owner, decl.name), repoDir: dir };
    } catch (e) {
      if (!(e instanceof DittoConfigNotFound)) throw e;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Picks the endpoint a repository profile names, scoped to its owner. */
export async function findProfileEndpoint(profile: RepoProfile, endpoints: InferenceEndpoint[]): Promise<InferenceEndpoint | undefined> {
  if (profile.owner.kind === "personal") return endpoints.find((e) => e.slug === profile.slug && !e.companyId);
  const org = (await listCompanies()).find((c) => c.slug === profile.owner.org || c.id === profile.owner.org);
  if (!org) throw new ProfileError(`this repository's profile ${profile.name} requires organization @${profile.owner.org}, and you are not a member of it. Pass --endpoint to use another.`);
  return endpoints.find((e) => e.slug === profile.slug && e.companyId === org.id);
}
