import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageVersion } from "../config.js";
import { TOOL_DENY_HEADER } from "./claude-deny.js";

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

/**
 * A connection Ditto could not open for this session (DITTO-1639): its tools
 * are missing, and the server it would have been served under offers only
 * `connection_status`, which tells the agent why.
 */
export interface McpUnavailableSource {
  serverId: string;
  name: string;
  /** The catalog server name its tools would have had. */
  prefix: string;
  /** oauth_not_connected (sign-in expired or revoked), oauth_error, … */
  reason: string;
  /** Where its owner reconnects it; absent for someone else's connection. */
  reconnectUrl?: string;
  personal: boolean;
}

/** GET /v1/mcp. */
export interface McpCatalog {
  endpoint: string;
  approvalMode: string;
  clientApprovals: boolean;
  servers: McpCatalogServer[];
  /** Absent from a backend that predates DITTO-1639. */
  unavailable?: McpUnavailableSource[];
}

const UNAVAILABLE_REASONS: Record<string, string> = {
  oauth_not_connected: "sign-in expired or revoked",
  oauth_error: "sign-in could not be refreshed",
};

/**
 * One line per connection whose tools are missing from this session, with
 * where to reconnect it, so the person sees it before the agent stumbles on
 * it mid-task.
 */
export function mcpUnavailableLines(catalog: Pick<McpCatalog, "unavailable">): string[] {
  const sources = Array.isArray(catalog.unavailable) ? catalog.unavailable : [];
  return sources.map((s) => {
    const name = s.name?.trim() || s.prefix || "an MCP connection";
    const why = UNAVAILABLE_REASONS[s.reason] ?? "could not be opened";
    const fix = s.personal && s.reconnectUrl ? `reconnect: ${s.reconnectUrl}` : "ask whoever connected it to reconnect it";
    return `${name} is disconnected (${why}); its tools are missing — ${fix}`;
  });
}

/**
 * One attached server in harness-neutral form, for harnesses that take MCP
 * configuration in their own shape (codex-mcp.ts). The key is never here:
 * each harness reads it from MCP_KEY_ENV.
 */
export interface McpAttachedServer {
  /** The harness-side server name (claudeServerName). */
  name: string;
  url: string;
  /** Session and deny headers; not Authorization. */
  headers: Record<string, string>;
  /** Tools that run without the agent asking. */
  allowTools: string[];
  /** Tools the agent asks a person about first. */
  askTools: string[];
}

/** What a launch needs to attach the catalog. */
export interface ClaudeMcpAttachment {
  /** The `--mcp-config` JSON. */
  config: string;
  /** permissions.allow / permissions.ask for `--settings`. */
  allow: string[];
  ask: string[];
  /** The same servers and policy, for every other harness. */
  attached: McpAttachedServer[];
  /** Catalog servers left out because their name is unsafe in an agent's config. */
  skipped: string[];
  /**
   * The agent, not Ditto, stops gated calls (client approvals without
   * --yolo). A server can advertise a tool after launch, so agent rules must
   * then name every tool they allow: a server-wide allow would run a gated
   * tool nobody listed, and Ditto holds nothing on this surface.
   */
  clientAsks: boolean;
  servers: number;
  tools: number;
  /** Tools Ditto's policy would hold for a person. */
  gated: number;
  clientApprovals: boolean;
}

/** The catalog attached to a launch, whichever harness renders it. */
export type McpAttachment = ClaudeMcpAttachment;

/**
 * A server name every agent's config can carry as a bare key: Codex splits
 * `-c` paths on dots, and tool rules join the name with "__". The backend only
 * serves names like this (mcpServerName); anything else is left out, the same
 * way for every harness, rather than spliced into a config path.
 */
const SAFE_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

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
export function claudeMcpAttachment(catalog: McpCatalog, sessionId: string, opts: { yolo?: boolean; toolDeny?: string[] } = {}): ClaudeMcpAttachment {
  const mcpServers: Record<string, unknown> = {};
  const attached: McpAttachedServer[] = [];
  const allow: string[] = [];
  const ask: string[] = [];
  const skipped: string[] = [];
  let tools = 0;
  let gated = 0;
  for (const server of catalog.servers) {
    if (server.tools.length === 0) continue;
    if (!SAFE_SERVER_NAME.test(server.name)) {
      skipped.push(server.name);
      continue;
    }
    const name = claudeServerName(server.name);
    const headers: Record<string, string> = { "X-Ditto-Session-Id": sessionId, "X-Heyditto-Client": `heyditto-cli/${packageVersion}`, ...(opts.toolDeny?.length ? { [TOOL_DENY_HEADER]: opts.toolDeny.join(",") } : {}) };
    mcpServers[name] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer \${${MCP_KEY_ENV}}`, ...headers },
    };
    tools += server.tools.length;
    gated += server.tools.filter((t) => t.approval).length;
    // Ditto's gate is the authority without client approvals; an agent prompt
    // on top would ask twice. With them, the agent asks about exactly the
    // calls Ditto would have held, unless bypass said not to ask.
    const asks = (t: McpCatalogTool) => catalog.clientApprovals && t.approval && !opts.yolo;
    attached.push({
      name,
      url: server.url,
      headers,
      allowTools: server.tools.filter((t) => !asks(t)).map((t) => t.name),
      askTools: server.tools.filter(asks).map((t) => t.name),
    });
    if (!catalog.clientApprovals) {
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
    attached,
    skipped,
    clientAsks: catalog.clientApprovals && !opts.yolo,
    servers: Object.keys(mcpServers).length,
    tools,
    gated,
    clientApprovals: catalog.clientApprovals,
  };
}

/** Who stops a gated call, for the launch banner: only what is actually true. */
export function mcpApprovalNote(mcp: ClaudeMcpAttachment, agent = "Claude Code", unattended = false): string {
  if (mcp.gated === 0) return "no gated tools";
  if (!mcp.clientApprovals) return `Ditto holds ${mcp.gated} gated`;
  // A -p or headless run has nobody to answer a prompt: Grok and Codex have
  // Ditto refuse gated tools then, and Claude Code denies its own ask rules.
  if (unattended && mcp.ask.length) return `${mcp.ask.length} gated refused: nobody to approve them`;
  return mcp.ask.length ? `${agent} asks before ${mcp.ask.length} gated` : `${mcp.gated} gated run unasked (--yolo)`;
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
/** One private directory per temp root for the life of this process. */
const privateSettingsDirs = new Map<string, string>();

/** The pid a private directory belongs to: <prefix><pid>-<random>. */
function ownerPid(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const m = /^(\d+)-/.exec(name.slice(prefix.length));
  return m ? Number(m[1]) : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A dead owner's directory survives this long, since a launcher killed right after
 * spawning Claude can leave a Claude that has not yet read its `--settings`.
 */
const STALE_SETTINGS_GRACE_MS = 5 * 60 * 1000;

/**
 * Removes settings copies whose CLI is gone (killed by a signal before its exit
 * cleanup ran). Liveness, not age: a session can run for days, and its Claude
 * keeps reading its settings for as long as it runs. A dead owner's directory
 * is kept for a short grace period after its last write.
 */
export function sweepStaleSettings(tmp: string, isAlive: (pid: number) => boolean = alive, now: number = Date.now(), prefix: string = PRIVATE_SETTINGS_PREFIX): void {
  let entries: string[];
  try {
    entries = readdirSync(tmp);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of entries) {
    const pid = ownerPid(name, prefix);
    if (pid === undefined || pid === process.pid || isAlive(pid)) continue;
    const dir = path.join(tmp, name);
    try {
      const st = statSync(dir);
      if (now - st.mtimeMs < STALE_SETTINGS_GRACE_MS) continue;
      if (uid === undefined || st.uid === uid) rmSync(dir, { recursive: true, force: true });
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
 * swept by a later launch once its process is gone. No signal handlers are
 * installed: the launcher owns Ctrl+C, and re-raising a signal here would cut
 * its shutdown short.
 */
export function writePrivateSettings(json: string, tmp: string = os.tmpdir()): string {
  let dir = privateSettingsDirs.get(tmp);
  if (!dir) {
    sweepStaleSettings(tmp);
    const created = mkdtempSync(path.join(tmp, `${PRIVATE_SETTINGS_PREFIX}${process.pid}-`));
    chmodSync(created, 0o700);
    process.once("exit", () => rmSync(created, { recursive: true, force: true }));
    privateSettingsDirs.set(tmp, created);
    dir = created;
  }
  const file = path.join(dir, `${createHash("sha256").update(json).digest("hex").slice(0, 16)}.json`);
  if (!existsSync(file)) writeFileSync(file, json, { mode: 0o600 });
  return file;
}

/**
 * Adds settings to a Claude argv. Claude Code reads a single `--settings`, so
 * the one already in the argv absorbs the new keys rather than a second flag
 * silently replacing either. Inline JSON is merged in place. A settings file is
 * read from Claude's launch directory and merged into a private copy whose path
 * replaces it. A file that cannot be read stops the launch, since dropping it
 * would lose the user's settings and dropping ours their MCP permissions or hooks.
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
      throw new Error(`--settings ${value}: cannot be merged with Ditto's session settings (${(err as Error).message})`);
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
