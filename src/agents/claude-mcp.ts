import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Native MCP mode for Claude Code (DITTO-1497).
 *
 * The router normally runs an endpoint's tools itself: injected into each
 * request, or behind Code Mode's search_tools/run_code sandbox. In this mode
 * the endpoint's tools arrive as Claude Code's own MCP servers instead, one
 * per source ("ditto" for Ditto's built-ins, "ditto-github", "ditto-linear",
 * …), so Claude Code discovers them with its own ToolSearch and calls them
 * natively. Every call still executes on Ditto (`/v1/mcp/{server}`) with the
 * credentials Ditto holds, behind the endpoint's approval gate and deny rules.
 *
 * Who asks before a gated call is the endpoint's choice (`clientApprovals`):
 *
 *  - off (default): Ditto holds gated calls itself, so every Ditto server is
 *    allowed here and nobody is asked twice;
 *  - on: Ditto holds nothing on this surface. Calls Ditto would have held get
 *    an `ask` rule, and `--yolo` (bypass) runs them without one.
 */

/** Tells the router this session attached the tools itself, so it injects none. */
export const TOOL_SURFACE_HEADER = "X-Ditto-Tool-Surface";
export const TOOL_SURFACE_MCP = "mcp";

/**
 * The endpoint key reaches Claude Code's MCP headers through this variable,
 * which Claude Code expands in `--mcp-config` (`${VAR}`), so the key never
 * lands in a file or in argv.
 */
export const MCP_KEY_ENV = "DITTO_ROUTER_MCP_KEY";

export interface McpCatalogTool {
  name: string;
  tier: string;
  /** Ditto's policy holds this call for a person. */
  approval: boolean;
}

export interface McpCatalogServer {
  name: string;
  url: string;
  tools: McpCatalogTool[];
}

/** GET /v1/mcp. */
export interface McpCatalog {
  endpoint: string;
  approvalMode: string;
  clientApprovals: boolean;
  servers: McpCatalogServer[];
}

/** What a Claude launch needs to attach the catalog. */
export interface ClaudeMcpAttachment {
  /** The `--mcp-config` JSON. */
  config: string;
  /** permissions.allow / permissions.ask for `--settings`. */
  allow: string[];
  ask: string[];
  servers: number;
  tools: number;
  clientApprovals: boolean;
}

/** Claude Code server name for a catalog server: the built-ins keep "ditto", the rest are "ditto-<source>". */
export function claudeServerName(server: string): string {
  return server === "ditto" ? "ditto" : `ditto-${server}`;
}

/** A stalled catalog read must not hold up Claude's launch; the caller falls back to the router. */
const CATALOG_TIMEOUT_MS = 15_000;

/** Reads the endpoint's MCP catalog with the session's own key. */
export async function fetchMcpCatalog(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CATALOG_TIMEOUT_MS,
): Promise<McpCatalog> {
  const url = `${baseUrl.replace(/\/+$/, "")}/mcp`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-Ditto-Session-Id": sessionId, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      // A body that is not JSON adds nothing the status does not say.
    }
    throw new Error(`GET ${url} → ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const catalog = (await res.json()) as McpCatalog;
  if (!Array.isArray(catalog.servers)) throw new Error(`GET ${url}: not an MCP catalog`);
  return catalog;
}

/**
 * The Claude Code configuration for a catalog: one http MCP server per
 * source, and the permission rules that put the endpoint's approval policy
 * into Claude Code's own prompts.
 */
export function claudeMcpAttachment(catalog: McpCatalog, sessionId: string, opts: { yolo?: boolean } = {}): ClaudeMcpAttachment {
  const mcpServers: Record<string, unknown> = {};
  const allow: string[] = [];
  const ask: string[] = [];
  let tools = 0;
  for (const server of catalog.servers) {
    if (server.tools.length === 0) continue;
    const name = claudeServerName(server.name);
    mcpServers[name] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer \${${MCP_KEY_ENV}}`, "X-Ditto-Session-Id": sessionId },
    };
    tools += server.tools.length;
    if (!catalog.clientApprovals) {
      // Ditto's gate is the authority here; a Claude prompt on top would ask twice.
      allow.push(`mcp__${name}`);
      continue;
    }
    for (const tool of server.tools) {
      const rule = `mcp__${name}__${tool.name}`;
      if (!tool.approval) allow.push(rule);
      // Under bypass the user chose not to be asked; an ask rule would still prompt.
      else if (!opts.yolo) ask.push(rule);
    }
  }
  return {
    config: JSON.stringify({ mcpServers }),
    allow,
    ask,
    servers: Object.keys(mcpServers).length,
    tools,
    clientApprovals: catalog.clientApprovals,
  };
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge key by key, arrays concatenate without duplicates, anything else: b wins. */
export function mergeSettings(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = Object.prototype.hasOwnProperty.call(out, k) ? out[k] : undefined;
    let value: unknown = v;
    if (isObject(cur) && isObject(v)) value = mergeSettings(cur, v);
    else if (Array.isArray(cur) && Array.isArray(v)) value = [...new Set([...cur, ...v])];
    // defineProperty, so a "__proto__" key stays data instead of hitting the setter.
    Object.defineProperty(out, k, { value, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

export interface SettingsIO {
  /** Claude's launch directory: a relative settings path means a file there. */
  cwd?: string;
  read?: (file: string) => string;
  /** Writes merged settings somewhere only this user can read; returns the path. */
  writePrivate?: (json: string) => string;
}

const PRIVATE_SETTINGS_PREFIX = "ditto-claude-settings-";
/** A copy this old outlived the process that made it (killed by a signal). */
const STALE_SETTINGS_MS = 24 * 60 * 60 * 1000;
let privateSettingsDir: string | undefined;

/** Removes this user's settings copies that a signal-killed CLI left behind. */
export function sweepStaleSettings(tmp: string, now: number): void {
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of entries) {
    if (!name.startsWith(PRIVATE_SETTINGS_PREFIX)) continue;
    const dir = path.join(tmp, name);
    try {
      const st = statSync(dir);
      if ((uid === undefined || st.uid === uid) && now - st.mtimeMs > STALE_SETTINGS_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Another process removed it, or it is not ours to read: leave it.
    }
  }
}

/**
 * A private copy of merged settings for the life of this process. A user's
 * settings file can hold secrets, so its contents never go into Claude's
 * argv (visible in process listings); the copy is a 0600 file in a 0700
 * directory. Copies are named by content, so a long headless session that
 * re-plans every turn reuses one file per distinct value instead of piling
 * them up. The directory goes when the CLI exits; one left by a signal is
 * swept by the next launch. No signal handlers are installed: the launcher
 * owns Ctrl+C, and re-raising a signal here would cut its shutdown short.
 */
export function writePrivateSettings(json: string, tmp: string = os.tmpdir()): string {
  if (!privateSettingsDir) {
    sweepStaleSettings(tmp, Date.now());
    const dir = mkdtempSync(path.join(tmp, PRIVATE_SETTINGS_PREFIX));
    chmodSync(dir, 0o700);
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    privateSettingsDir = dir;
  }
  const file = path.join(privateSettingsDir, `${createHash("sha256").update(json).digest("hex").slice(0, 16)}.json`);
  if (!existsSync(file)) writeFileSync(file, json, { mode: 0o600 });
  return file;
}

/**
 * Adds settings to a Claude argv. Claude Code reads a single `--settings`, so
 * the one already in the argv absorbs the new keys rather than a second flag
 * silently replacing either. Inline JSON is merged in place. A settings file is
 * read from Claude's launch directory and merged into a private copy whose path
 * replaces it. A file that cannot be read stops the launch, since dropping it
 * would lose the user's settings and dropping ours their MCP permissions.
 */
export function withClaudeSettings(args: string[], settings: Json, io: SettingsIO = {}): string[] {
  const read = io.read ?? ((f: string) => readFileSync(f, "utf8"));
  const writePrivate = io.writePrivate ?? writePrivateSettings;
  if (Object.keys(settings).length === 0) return args;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    const inline = a.startsWith("--settings=");
    if (a !== "--settings" && !inline) continue;
    const value = inline ? a.slice("--settings=".length) : args[i + 1];
    if (value === undefined) continue;
    const isJSON = value.trim().startsWith("{");
    let parsed: unknown;
    try {
      parsed = JSON.parse(isJSON ? value : read(path.resolve(io.cwd ?? process.cwd(), value)));
    } catch (err) {
      throw new Error(`--settings ${value}: cannot be merged with native MCP permissions (${(err as Error).message})`);
    }
    if (!isObject(parsed)) throw new Error(`--settings ${value}: not a JSON object`);
    const json = JSON.stringify(mergeSettings(parsed, settings));
    const merged = isJSON ? json : writePrivate(json);
    const out = [...args];
    if (inline) out[i] = `--settings=${merged}`;
    else out[i + 1] = merged;
    return out;
  }
  return [...args, "--settings", JSON.stringify(settings)];
}

/** The permission settings an attachment contributes. */
export function attachmentSettings(mcp: ClaudeMcpAttachment): Json {
  const permissions: Json = {};
  if (mcp.allow.length) permissions.allow = mcp.allow;
  if (mcp.ask.length) permissions.ask = mcp.ask;
  return Object.keys(permissions).length ? { permissions } : {};
}
