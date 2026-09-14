import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  CONFIG_FILE,
  DITTO_CONFIG_VERSION,
  DITTO_DIR,
  type DittoConfig,
  type DittoConfigSummary,
  ENDPOINTS_DIR,
  type EffectiveConfig,
  type EndpointDecl,
  LOCAL_FILE,
  type Layer,
  MISE_FILE,
  SECRET_REF_PREFIX,
  type Source,
  defaults,
} from "./types.js";

/** A single, user-fixable problem in a `.ditto/` document. Mirrors Go's ValidationError. */
export class DittoConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
    readonly field?: string,
  ) {
    super(`dittoconfig: ${file ? `${file}: ` : ""}${field ? `${field}: ` : ""}${message}`);
    this.name = "DittoConfigError";
  }
}

export class DittoConfigNotFound extends Error {
  constructor(readonly dir: string) {
    super(`no ${DITTO_DIR}/${CONFIG_FILE} in ${dir}`);
    this.name = "DittoConfigNotFound";
  }
}

export interface LoadOptions {
  /** Parent folder whose `.ditto/config.toml` supplies defaults below the repository's. */
  workspaceDir?: string;
  /** Dotted-key overrides applied last, e.g. `{ "teleport.harness.kind": "codex" }`. */
  overrides?: Record<string, string>;
}

type Table = Record<string, unknown>;

const TOP_LEVEL = new Set(["repository", "teleport", "environment", "tasks", "policy"]);

/** TOML snake_case keys → the camelCase field names used by the JSON schema and the Go types. */
const KEY_MAP: Record<string, string> = {
  default_endpoint: "defaultEndpoint",
  api_base: "apiBase",
  capture_roots: "captureRoots",
  required_mirrors: "requiredMirrors",
  mise_config: "miseConfig",
  max_attempts: "maxAttempts",
  install_only: "installOnly",
};

const KNOWN_KEYS: Record<string, Set<string>> = {
  repository: new Set(["name", "default_endpoint", "bindings"]),
  "repository.bindings.*": new Set(["api_base"]),
  teleport: new Set(["capture_roots", "exclude", "include", "harness", "required_mirrors", "offload"]),
  "teleport.harness": new Set(["kind", "session"]),
  "teleport.offload": new Set(["unpushed", "destination"]),
  environment: new Set(["mise_config", "services", "vars", "secrets"]),
  "environment.services[]": new Set(["name", "image", "command", "port", "healthcheck"]),
  tasks: new Set(["setup", "build", "test", "lint", "dev"]),
  policy: new Set(["repair"]),
  "policy.repair": new Set(["max_attempts", "install_only"]),
};

const ENDPOINT_KEYS = new Set(["managed", "name", "slug", "description", "model", "fallbacks", "settings"]);

/** Loads `.ditto/` for a repository with the same layering and validation as the backend. */
export async function loadDittoConfig(repoDir: string, opts: LoadOptions = {}): Promise<EffectiveConfig> {
  const sources: Record<string, Source> = {};
  for (const t of TOP_LEVEL) sources[t] = { layer: "default" };
  const layers: Array<{ layer: Layer; dir: string; file: string }> = [];
  if (opts.workspaceDir) layers.push({ layer: "workspace", dir: opts.workspaceDir, file: CONFIG_FILE });
  layers.push({ layer: "repo", dir: repoDir, file: CONFIG_FILE }, { layer: "local", dir: repoDir, file: LOCAL_FILE });

  const merged: Table = {};
  const contributing: Layer[] = [];
  const warnings: string[] = [];
  let found = false;
  for (const l of layers) {
    const file = path.join(l.dir, DITTO_DIR, l.file);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (l.layer === "repo") found = true;
    let doc: Table;
    try {
      doc = parseToml(raw) as Table;
    } catch (err) {
      throw new DittoConfigError(`invalid TOML: ${(err as Error).message}`, file);
    }
    checkKnownKeys(file, doc);
    if (l.layer !== "local") {
      if (!("version" in doc)) throw new DittoConfigError("missing; set version = 1", file, "version");
      if (doc.version !== DITTO_CONFIG_VERSION) {
        throw new DittoConfigError(`unsupported schema version ${String(doc.version)} (this tool understands ${DITTO_CONFIG_VERSION})`, file, "version");
      }
    }
    delete doc.version;
    deepMerge(merged, doc);
    contributing.push(l.layer);
    for (const k of Object.keys(doc)) sources[k] = { layer: l.layer, path: file };
    if (l.layer === "local" && !(await gitIgnored(repoDir, `${DITTO_DIR}/${LOCAL_FILE}`))) {
      warnings.push(`${DITTO_DIR}/${LOCAL_FILE} is not git-ignored; machine-local overrides should never be committed`);
    }
  }
  if (!found && !opts.workspaceDir) throw new DittoConfigNotFound(repoDir);

  const config = toConfig(merged);
  if (opts.overrides && Object.keys(opts.overrides).length > 0) {
    for (const [k, v] of Object.entries(opts.overrides).sort()) {
      applyOverride(config, k, v);
      sources[k.split(".")[0]] = { layer: "override" };
    }
    contributing.push("override");
  }

  const endpoints = await loadEndpoints(repoDir, sources);
  const misePath = await resolveMise(repoDir, config.environment.miseConfig);
  const eff: EffectiveConfig = { config, endpoints, misePath, sources, layers: contributing, warnings };
  validateEffective(eff);
  if (!config.repository.name) config.repository.name = slugify(path.basename(path.resolve(repoDir)));
  return eff;
}

/** Digest identical to the Go package's: sha256 of the canonical JSON of {config, endpoints, misePath}. */
export function digest(eff: EffectiveConfig): string {
  const canon = { config: eff.config, endpoints: Object.keys(eff.endpoints).length ? eff.endpoints : undefined, misePath: eff.misePath || undefined };
  return createHash("sha256").update(canonicalJson(canon)).digest("hex");
}

export function summarize(eff: EffectiveConfig): DittoConfigSummary {
  const out: DittoConfigSummary = { version: DITTO_CONFIG_VERSION, digest: digest(eff) };
  if (eff.misePath) out.misePath = eff.misePath;
  if (eff.layers.length) out.layers = [...eff.layers];
  return out;
}

// ---------------------------------------------------------------------------

function checkKnownKeys(file: string, doc: Table): void {
  for (const k of Object.keys(doc)) {
    if (k !== "version" && !TOP_LEVEL.has(k)) {
      throw new DittoConfigError("unknown top-level table (known: repository, teleport, environment, tasks, policy)", file, k);
    }
  }
  const check = (prefix: string, schemaKey: string, table: unknown): void => {
    if (!isTable(table)) return;
    const known = KNOWN_KEYS[schemaKey];
    if (!known) return;
    for (const k of Object.keys(table)) {
      if (!known.has(k)) throw new DittoConfigError("unknown key", file, `${prefix}.${k}`);
    }
  };
  check("repository", "repository", doc.repository);
  if (isTable(doc.repository) && isTable(doc.repository.bindings)) {
    for (const [label, b] of Object.entries(doc.repository.bindings)) check(`repository.bindings.${label}`, "repository.bindings.*", b);
  }
  check("teleport", "teleport", doc.teleport);
  if (isTable(doc.teleport)) {
    check("teleport.harness", "teleport.harness", doc.teleport.harness);
    check("teleport.offload", "teleport.offload", doc.teleport.offload);
  }
  check("environment", "environment", doc.environment);
  if (isTable(doc.environment) && Array.isArray(doc.environment.services)) {
    doc.environment.services.forEach((s, i) => check(`environment.services[${i}]`, "environment.services[]", s));
  }
  check("tasks", "tasks", doc.tasks);
  check("policy", "policy", doc.policy);
  if (isTable(doc.policy)) check("policy.repair", "policy.repair", doc.policy.repair);
}

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Nested tables merge by key; scalars and arrays are replaced by the higher layer. */
function deepMerge(dst: Table, src: Table): void {
  for (const [k, v] of Object.entries(src)) {
    const d = dst[k];
    if (isTable(v) && isTable(d)) {
      deepMerge(d, v);
      continue;
    }
    dst[k] = v;
  }
}

function camel(table: Table): Table {
  const out: Table = {};
  for (const [k, v] of Object.entries(table)) {
    const key = KEY_MAP[k] ?? k;
    if (k === "bindings" && isTable(v)) {
      // Labels are user data (kept verbatim); each binding's own keys are schema keys.
      out[key] = Object.fromEntries(Object.entries(v).map(([label, b]) => [label, isTable(b) ? camel(b) : b]));
      continue;
    }
    out[key] = isTable(v) && !isEnvMap(k) ? camel(v) : Array.isArray(v) ? v.map((x) => (isTable(x) ? camel(x) : x)) : v;
  }
  return out;
}

/** Tables whose keys are user data, not schema keys: never renamed. */
function isEnvMap(key: string): boolean {
  return key === "vars" || key === "secrets" || key === "settings";
}

function toConfig(merged: Table): DittoConfig {
  const base = defaults();
  const c = camel(merged) as Partial<DittoConfig> & Table;
  const config: DittoConfig = {
    version: DITTO_CONFIG_VERSION,
    repository: { ...base.repository, ...(c.repository ?? {}) },
    teleport: {
      ...base.teleport,
      ...(c.teleport ?? {}),
      harness: { ...base.teleport.harness, ...((c.teleport as Table | undefined)?.harness as object | undefined) },
      offload: { ...base.teleport.offload, ...((c.teleport as Table | undefined)?.offload as object | undefined) },
    },
    environment: { ...base.environment, ...(c.environment ?? {}) },
    tasks: { ...base.tasks, ...(c.tasks ?? {}) },
    policy: { repair: { ...base.policy.repair, ...((c.policy as Table | undefined)?.repair as object | undefined) } },
  };
  return config;
}

function applyOverride(c: DittoConfig, key: string, value: string): void {
  switch (key) {
    case "repository.default_endpoint":
      c.repository.defaultEndpoint = value;
      break;
    case "teleport.harness.kind":
      c.teleport.harness.kind = value as DittoConfig["teleport"]["harness"]["kind"];
      break;
    case "teleport.harness.session":
      c.teleport.harness.session = value as DittoConfig["teleport"]["harness"]["session"];
      break;
    case "teleport.offload.unpushed":
      c.teleport.offload.unpushed = value as DittoConfig["teleport"]["offload"]["unpushed"];
      break;
    case "teleport.offload.destination":
      c.teleport.offload.destination = value;
      break;
    case "environment.mise_config":
      c.environment.miseConfig = value;
      break;
    default:
      throw new DittoConfigError("unsupported override key", undefined, key);
  }
}

async function loadEndpoints(repoDir: string, sources: Record<string, Source>): Promise<Record<string, EndpointDecl>> {
  const dir = path.join(repoDir, DITTO_DIR, ENDPOINTS_DIR);
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((n) => n.endsWith(".toml")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const out: Record<string, EndpointDecl> = {};
  for (const name of entries) {
    const file = path.join(dir, name);
    let doc: Table;
    try {
      doc = parseToml(await readFile(file, "utf8")) as Table;
    } catch (err) {
      throw new DittoConfigError(`invalid TOML: ${(err as Error).message}`, file);
    }
    for (const k of Object.keys(doc)) {
      if (!ENDPOINT_KEYS.has(k)) throw new DittoConfigError("unknown key; put endpoint settings under [settings]", file, k);
    }
    const ep = doc as unknown as EndpointDecl;
    if (!ep.name) ep.name = name.replace(/\.toml$/, "");
    if (out[ep.name]) throw new DittoConfigError(`duplicate endpoint name ${ep.name}`, file, "name");
    out[ep.name] = ep;
    sources[`endpoints.${ep.name}`] = { layer: "repo", path: file };
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function resolveMise(repoDir: string, declared: string | undefined): Promise<string> {
  const inDitto = `${DITTO_DIR}/${MISE_FILE}`;
  if (declared) {
    if (!(await exists(path.join(repoDir, declared)))) {
      throw new DittoConfigError(`${declared} does not exist`, undefined, "environment.mise_config");
    }
    return declared.split(path.sep).join("/");
  }
  const a = await exists(path.join(repoDir, inDitto));
  const b = await exists(path.join(repoDir, MISE_FILE));
  if (a && b) {
    throw new DittoConfigError("both .ditto/mise.toml and mise.toml exist; set environment.mise_config to the one Ditto should use", undefined, "environment.mise_config");
  }
  return a ? inDitto : b ? MISE_FILE : "";
}

async function gitIgnored(repoDir: string, rel: string): Promise<boolean> {
  for (const f of [".gitignore", `${DITTO_DIR}/.gitignore`]) {
    let raw: string;
    try {
      raw = await readFile(path.join(repoDir, f), "utf8");
    } catch {
      continue;
    }
    for (let line of raw.split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      const l = line.replace(/^\//, "");
      if (l === rel || l === path.basename(rel) || (f !== ".gitignore" && l === LOCAL_FILE)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation (same rules as Go Validate; first problem wins)

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SVC_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SECRET_KEY_RE = /(^|[_.-])(key|token|secret|password|passwd|credential|apikey)s?([_.-]|$)|_?(api_?key|auth_?token)$/i;
const MIRROR_RE = /^(ditto-primary|ditto-secondary|user:[a-z0-9-]{1,64}|[a-z0-9][a-z0-9._-]{0,63})$/;

export function validateEffective(eff: EffectiveConfig): void {
  const c = eff.config;
  const fail = (field: string, msg: string): never => {
    throw new DittoConfigError(msg, undefined, field);
  };
  if (c.version !== DITTO_CONFIG_VERSION) fail("version", `unsupported schema version ${c.version}`);
  if (c.repository.name && !NAME_RE.test(c.repository.name)) fail("repository.name", "must be a lowercase slug (a-z 0-9 . _ -), max 64 chars");
  for (const [label, b] of Object.entries(c.repository.bindings ?? {})) {
    if (!SLUG_RE.test(label)) fail(`repository.bindings.${label}`, "environment label must be a lowercase slug");
    const u = b?.apiBase ?? "";
    if (!(u.startsWith("https://") || u.startsWith("http://localhost") || u.startsWith("http://127.0.0.1"))) {
      fail(`repository.bindings.${label}.api_base`, "must be an https origin (http only for localhost)");
    }
  }
  (c.teleport.captureRoots ?? []).forEach((p, i) => safeRelPath(p, `teleport.capture_roots[${i}]`));
  (c.teleport.exclude ?? []).forEach((p, i) => safePattern(p, `teleport.exclude[${i}]`));
  (c.teleport.include ?? []).forEach((p, i) => safePattern(p, `teleport.include[${i}]`));
  if (!["auto", "claude-code", "codex", "none"].includes(c.teleport.harness.kind)) fail("teleport.harness.kind", "must be auto, claude-code, codex or none");
  if (!["latest", "explicit"].includes(c.teleport.harness.session)) fail("teleport.harness.session", "must be latest or explicit");
  if (!["refuse", "acknowledge"].includes(c.teleport.offload.unpushed)) fail("teleport.offload.unpushed", "must be refuse or acknowledge");
  (c.teleport.requiredMirrors ?? []).forEach((m, i) => {
    if (!MIRROR_RE.test(m)) fail(`teleport.required_mirrors[${i}]`, "must be ditto-primary, ditto-secondary, user:<bucket id> or a bucket name");
  });
  if (c.environment.miseConfig) safeRelPath(c.environment.miseConfig, "environment.mise_config");
  const seen = new Set<string>();
  (c.environment.services ?? []).forEach((s, i) => {
    if (!SVC_RE.test(s.name ?? "")) fail(`environment.services[${i}].name`, "must be a lowercase slug starting with a letter, max 32 chars");
    if (seen.has(s.name)) fail(`environment.services[${i}].name`, `duplicate service ${s.name}`);
    seen.add(s.name);
    if (!s.image && !s.command) fail(`environment.services[${i}]`, "set image or command");
    if (s.port !== undefined && (s.port < 1 || s.port > 65535)) fail(`environment.services[${i}].port`, "must be 1..65535");
  });
  for (const [k, v] of Object.entries(c.environment.vars ?? {})) {
    if (!ENV_RE.test(k)) fail(`environment.vars.${k}`, "must be an UPPER_SNAKE environment variable name");
    if (SECRET_KEY_RE.test(k) && !isReference(String(v))) fail(`environment.vars.${k}`, "looks like a credential; move it to [environment.secrets] as a secret:// reference");
  }
  for (const [k, v] of Object.entries(c.environment.secrets ?? {})) {
    if (!ENV_RE.test(k)) fail(`environment.secrets.${k}`, "must be an UPPER_SNAKE environment variable name");
    if (!String(v).startsWith(SECRET_REF_PREFIX)) fail(`environment.secrets.${k}`, "must be a secret:// reference to Ditto Secrets, never a literal value");
  }
  for (const [f, v] of Object.entries(c.tasks)) {
    if (typeof v === "string" && v.startsWith("mise:") && !/^mise:[A-Za-z0-9:_.-]+$/.test(v)) fail(`tasks.${f}`, "mise task reference must be mise:<task-name>");
  }
  const r = c.policy.repair;
  if (r.maxAttempts < 0 || r.maxAttempts > 10) fail("policy.repair.max_attempts", "must be 0..10");
  if (c.repository.defaultEndpoint && !(c.repository.defaultEndpoint in eff.endpoints) && !SLUG_RE.test(c.repository.defaultEndpoint)) {
    fail("repository.default_endpoint", "must name an endpoint in .ditto/endpoints/ or an existing endpoint slug");
  }
  for (const [name, ep] of Object.entries(eff.endpoints)) {
    if (typeof ep.managed !== "boolean") fail(`endpoints.${name}.managed`, "required (true = managed by heyditto deploy)");
    if (!NAME_RE.test(ep.name)) fail(`endpoints.${name}.name`, "must be a lowercase slug (a-z 0-9 . _ -), max 64 chars");
    if (ep.slug && !SLUG_RE.test(ep.slug)) fail(`endpoints.${name}.slug`, "must be a lowercase slug (a-z 0-9 -), max 64 chars");
    checkSecretLiterals(`endpoints.${name}.settings`, ep.settings ?? {});
  }
}

function safeRelPath(p: string, field: string): void {
  if (!p) throw new DittoConfigError("empty path", undefined, field);
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) throw new DittoConfigError(`must be repository-relative, not absolute: ${p}`, undefined, field);
  const clean = path.posix.normalize(p.replace(/\\/g, "/"));
  if (clean === ".." || clean.startsWith("../")) throw new DittoConfigError(`must stay inside the repository: ${p}`, undefined, field);
}

function safePattern(p: string, field: string): void {
  if (!p) throw new DittoConfigError("empty pattern", undefined, field);
  if (p.startsWith("/")) throw new DittoConfigError(`patterns are repository-relative; drop the leading /: ${p}`, undefined, field);
  if (p.replace(/\/$/, "").split("/").includes("..")) throw new DittoConfigError(`must stay inside the repository: ${p}`, undefined, field);
}

function isReference(v: string): boolean {
  return v.startsWith(SECRET_REF_PREFIX) || (v.startsWith("${") && v.endsWith("}"));
}

function checkSecretLiterals(prefix: string, m: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(m)) {
    const field = `${prefix}.${k}`;
    if (typeof v === "string") {
      if (SECRET_KEY_RE.test(k) && !isReference(v)) throw new DittoConfigError("looks like a credential; use a secret:// reference", undefined, field);
    } else if (isTable(v)) {
      checkSecretLiterals(field, v);
    }
  }
}

/** Canonical JSON: object keys sorted recursively, undefined dropped — matches Go's encoding/json map ordering for our shapes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return (out || "repo").slice(0, 64);
}
