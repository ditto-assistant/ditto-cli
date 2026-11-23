import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Command, Option } from "commander";
import {
  type InferenceEndpoint,
  createKey,
  findEndpoint,
  listEndpoints,
  revokeKey,
} from "./api.js";
import {
  type McpCatalog,
  type McpCatalogServer,
  type McpCatalogTool,
  claudeServerName,
  fetchMcpCatalog,
  mcpUnavailableLines,
} from "./agents/claude-mcp.js";
import { clientHeaders, packageName, packageVersion } from "./config.js";
import { findProfileEndpoint, repoDefaultProfile } from "./dittoconfig/profiles.js";
import { SESSION_ID_PATTERN, resolveActiveSession } from "./mcp-session.js";
import { addProfileOption, explicitProfileEndpoint, readDefaultEndpoint } from "./profiles.js";

const DEFAULT_CALL_TIMEOUT_SECONDS = 120;
const MAX_TOOL_LIST_PAGES = 50;

export interface ResolvedMcpEndpoint {
  endpoint: InferenceEndpoint;
  baseUrl: string;
}

/**
 * Resolves the active inference endpoint for MCP catalog commands (`mcp-config`
 * and `tools`). Precedence matches `heyditto claude` / `mcp-config`:
 *   1. explicit `--endpoint <slug|name|id>`
 *   2. explicit `--profile <name>` / `DITTO_PROFILE`
 *   3. repository `.ditto` default endpoint profile
 *   4. active profile / saved default endpoint
 *   5. sole endpoint when the account has exactly one
 */
export async function resolveMcpEndpoint(
  options: { endpoint?: string; cwd?: string } = {},
): Promise<ResolvedMcpEndpoint> {
  const { endpoints, baseUrl } = await listEndpoints();
  const explicit = options.endpoint?.trim() || (await explicitProfileEndpoint())?.endpoint;
  let endpoint: InferenceEndpoint | undefined;
  if (explicit) {
    endpoint = findEndpoint(endpoints, explicit);
    if (!endpoint) {
      const available = endpoints.map((e) => e.slug).join(", ");
      throw new Error(
        `No endpoint named "${explicit}"${available ? `. Available: ${available}` : " (no endpoints configured; create one with `heyditto endpoints create`)"}`,
      );
    }
  } else {
    const profile = await repoDefaultProfile(options.cwd ?? process.cwd());
    if (profile) {
      endpoint = await findProfileEndpoint(profile, endpoints);
      if (!endpoint) throw new Error("Repository .ditto profile has no applied endpoint; run heyditto repo apply");
    } else {
      const saved = await readDefaultEndpoint();
      endpoint = saved ? findEndpoint(endpoints, saved) : endpoints.length === 1 ? endpoints[0] : undefined;
    }
  }
  if (!endpoint) {
    const available = endpoints.map((e) => e.slug).join(", ");
    throw new Error(
      `No unambiguous MCP endpoint; select one with --endpoint or heyditto endpoints use${available ? `. Available: ${available}` : ""}`,
    );
  }
  return { endpoint, baseUrl };
}

/**
 * Resolves the MCP session id: explicit `--session`, `T3CODE_THREAD_ID`, active
 * CLI session (`DITTO_SESSION_ID` or `heyditto session new`), or a fresh id.
 */
export async function resolveToolsSessionId(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    const trimmed = explicit.trim();
    if (!trimmed || !SESSION_ID_PATTERN.test(trimmed)) {
      throw new Error(`--session must match ${SESSION_ID_PATTERN}`);
    }
    return trimmed;
  }
  const t3 = process.env.T3CODE_THREAD_ID?.trim();
  if (t3 && SESSION_ID_PATTERN.test(t3)) return t3;
  const active = await resolveActiveSession();
  if (active?.id) return active.id;
  return `cli-tools-${randomUUID()}`;
}

/** Replaces any occurrence of a secret token before text reaches stdout or stderr. */
export function sanitizeSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

function sanitizeError(error: unknown, secret: string): Error {
  if (!secret) return error instanceof Error ? error : new Error(String(error));
  if (error instanceof Error) {
    const cleaned = new Error(sanitizeSecret(error.message, secret));
    cleaned.name = error.name;
    if (error.stack) cleaned.stack = sanitizeSecret(error.stack, secret);
    return cleaned;
  }
  return new Error(sanitizeSecret(String(error), secret));
}

/** Strips query string and fragment from a URL so presigned signatures are never printed. */
export function redactUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    const idx = rawUrl.indexOf("?");
    return idx >= 0 ? rawUrl.slice(0, idx) : rawUrl;
  }
}

/**
 * Mints a one-hour ephemeral key on `endpoint`, passes it to `fn`, and always
 * revokes the key in `finally` (and on SIGINT/SIGTERM). Never prints the key.
 */
export async function withEphemeralMcpKey<T>(
  endpoint: InferenceEndpoint,
  sessionId: string,
  fn: (apiKey: string) => Promise<T>,
): Promise<T> {
  const keyName = `cli-tools:${sessionId}`.slice(0, 128);
  const created = await createKey(endpoint.id, { name: keyName, expiresIn: "1h" });
  const secret = created.key;
  if (!secret) throw new Error("MCP key response did not contain a key");

  let revoked = false;
  const revokeOnce = async (): Promise<void> => {
    if (revoked) return;
    revoked = true;
    await revokeKey(endpoint.id, created.id).catch(() => {
      process.stderr.write(
        `warning: could not revoke ephemeral MCP key ${created.id}; it may remain valid until its one-hour expiry\n`,
      );
    });
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    void revokeOnce().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await fn(secret);
  } catch (error) {
    throw sanitizeError(error, secret);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await revokeOnce();
  }
}

function normalizeServerToken(value: string): string {
  return value.trim().toLowerCase().replace(/^ditto[-_]/, "").replace(/[-_\s]+/g, "");
}

export interface ResolvedCatalogServer {
  server: McpCatalogServer;
  /** Harness-facing server name: "ditto" or "ditto-<source>". */
  displayName: string;
  /** Raw catalog alias: "ditto", "googledrive", "gmail", etc. */
  alias: string;
}

/**
 * Resolves a user-supplied server name against the endpoint's MCP catalog.
 * Accepts canonical names (`ditto-googledrive`), short aliases (`googledrive`),
 * and separator variants (`google-drive`, `google_drive`).
 */
export function resolveCatalogServer(catalog: McpCatalog, wanted: string): ResolvedCatalogServer {
  const raw = wanted.trim();
  if (!raw) throw new Error("provide a server name (run `heyditto tools` to list available servers)");
  const active = catalog.servers.filter((s) => s.tools.length > 0);
  const wrap = (server: McpCatalogServer): ResolvedCatalogServer => ({
    server,
    displayName: claudeServerName(server.name),
    alias: server.name,
  });

  // 1. Exact canonical or raw name.
  const exact = active.find((s) => claudeServerName(s.name) === raw || s.name === raw);
  if (exact) return wrap(exact);

  // 2. Case-insensitive canonical or raw name.
  const lower = raw.toLowerCase();
  const ci = active.filter(
    (s) => claudeServerName(s.name).toLowerCase() === lower || s.name.toLowerCase() === lower,
  );
  if (ci.length === 1) return wrap(ci[0]);

  // 3. Normalized separator / optional ditto- prefix match.
  const norm = normalizeServerToken(raw);
  if (norm) {
    const fuzzy = active.filter((s) => normalizeServerToken(s.name) === norm);
    if (fuzzy.length === 1) return wrap(fuzzy[0]);
    if (fuzzy.length > 1) {
      throw new Error(
        `server "${raw}" is ambiguous. Matches: ${fuzzy.map((s) => claudeServerName(s.name)).join(", ")}`,
      );
    }
  }

  // 4. Helpful message if the server is currently disconnected.
  const unavailable = Array.isArray(catalog.unavailable) ? catalog.unavailable : [];
  const dropped = unavailable.find((u) => {
    const candidates = [u.prefix, claudeServerName(u.prefix), u.name].filter(Boolean);
    return candidates.some(
      (c) => c.toLowerCase() === lower || (norm.length > 0 && normalizeServerToken(c) === norm),
    );
  });
  if (dropped) {
    const [line] = mcpUnavailableLines({ unavailable: [dropped] });
    throw new Error(line ?? `server "${raw}" is disconnected`);
  }

  const available = active
    .map((s) => {
      const display = claudeServerName(s.name);
      return display === s.name ? display : `${display} (${s.name})`;
    })
    .join(", ");
  throw new Error(
    `no connected MCP server named "${raw}".${available ? ` Available: ${available}` : " This endpoint has no connected MCP servers."}`,
  );
}

/** Opens a Streamable HTTP MCP client session against one catalog server. */
export async function connectCatalogServer(
  server: McpCatalogServer,
  baseUrl: string,
  apiKey: string,
  sessionId: string,
): Promise<Client> {
  const resolvedUrl = new URL(server.url, `${baseUrl.replace(/\/+$/, "")}/`);
  const client = new Client({ name: packageName, version: packageVersion });
  const transport = new StreamableHTTPClientTransport(resolvedUrl, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Ditto-Session-Id": sessionId,
        ...clientHeaders(),
      },
    },
  });
  await client.connect(transport);
  return client;
}

export interface McpListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Fetches all tools from an MCP server, following `nextCursor` pagination. */
export async function listAllServerTools(client: Client): Promise<McpListedTool[]> {
  const all: McpListedTool[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    for (const tool of res.tools ?? []) {
      all.push(tool as McpListedTool);
    }
    if (!res.nextCursor || seenCursors.has(res.nextCursor)) break;
    seenCursors.add(res.nextCursor);
    cursor = res.nextCursor;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Argument parsing for `tools call`
// ---------------------------------------------------------------------------

/**
 * Parses a single `--arg key=value` value: JSON booleans, null, strict finite
 * numbers, quoted strings, arrays and objects parse as JSON; everything else
 * stays a plain string.
 */
export function parseArgValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  if (
    (raw.startsWith("{") && raw.endsWith("}")) ||
    (raw.startsWith("[") && raw.endsWith("]")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function splitKeyValue(pair: string, flagName: string): [string, string] {
  const idx = pair.indexOf("=");
  if (idx <= 0) {
    throw new Error(`${flagName} must be "key=value", got "${pair}"`);
  }
  const key = pair.slice(0, idx).trim();
  if (!key) throw new Error(`${flagName} key cannot be empty`);
  return [key, pair.slice(idx + 1)];
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("reading tool arguments from stdin requires piped input (stdin is a TTY)");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${source} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object (e.g. '{"key":"value"}')`);
  }
  return parsed as Record<string, unknown>;
}

async function loadJsonSource(spec: string, label: string): Promise<Record<string, unknown>> {
  if (spec === "-") {
    const raw = await readAllStdin();
    if (!raw.trim()) return {};
    return parseJsonObject(raw, "stdin");
  }
  if (spec.startsWith("@")) {
    const filePath = spec.slice(1);
    if (!filePath) throw new Error(`${label} "@" must be followed by a file path`);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      throw new Error(`failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parseJsonObject(raw, filePath);
  }
  return parseJsonObject(spec, label);
}

export interface ToolCallInputOptions {
  json?: string;
  stdin?: boolean;
  arg?: string[];
  rawArg?: string[];
}

export async function parseToolCallArgs(
  positionalInput: string | undefined,
  options: ToolCallInputOptions,
): Promise<Record<string, unknown>> {
  const baseSources = [
    positionalInput !== undefined ? "positional input" : undefined,
    options.json !== undefined ? "--json" : undefined,
    options.stdin ? "--stdin" : undefined,
  ].filter(Boolean);
  if (baseSources.length > 1) {
    throw new Error(`use only one JSON payload source (got ${baseSources.join(" and ")})`);
  }

  let args: Record<string, unknown> = {};
  if (options.stdin) {
    const raw = await readAllStdin();
    if (raw.trim()) args = parseJsonObject(raw, "--stdin");
  } else if (options.json !== undefined) {
    args = await loadJsonSource(options.json, "--json");
  } else if (positionalInput !== undefined) {
    args = await loadJsonSource(positionalInput, "input");
  }

  for (const pair of options.arg ?? []) {
    const [key, value] = splitKeyValue(pair, "--arg");
    args[key] = parseArgValue(value);
  }
  for (const pair of options.rawArg ?? []) {
    const [key, value] = splitKeyValue(pair, "--raw-arg");
    args[key] = value;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Download extraction & streaming for `--download <path-or-dir>`
// ---------------------------------------------------------------------------

export type DownloadTarget =
  | { kind: "url"; url: string; filename?: string; mimeType?: string }
  | { kind: "base64"; data: string; filename?: string; mimeType?: string };

const PRESIGNED_URL_KEYS = [
  "s3url",
  "s3_url",
  "download_url",
  "downloadUrl",
  "presigned_url",
  "presignedUrl",
] as const;

const FILENAME_KEYS = ["name", "filename", "fileName", "file_name"] as const;
const MIMETYPE_KEYS = ["mimetype", "mime_type", "mimeType", "contentType", "content_type"] as const;

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function findUrlInObject(
  value: unknown,
  depth = 0,
  parentFilename?: string,
  parentMime?: string,
): DownloadTarget | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findUrlInObject(item, depth + 1, parentFilename, parentMime);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;

  const ownFilename = firstString(value, FILENAME_KEYS) ?? parentFilename;
  const ownMime = firstString(value, MIMETYPE_KEYS) ?? parentMime;

  // Priority 1: `downloaded_file_content` object (e.g. Google Drive download_file).
  const dfc = value.downloaded_file_content;
  if (isPlainObject(dfc)) {
    const url = firstString(dfc, [...PRESIGNED_URL_KEYS, "url"]);
    if (url && isHttpUrl(url)) {
      return {
        kind: "url",
        url,
        filename: firstString(dfc, FILENAME_KEYS) ?? ownFilename,
        mimeType: firstString(dfc, MIMETYPE_KEYS) ?? ownMime,
      };
    }
  }

  // Priority 2: explicit presigned/download URL key on this object.
  const direct = firstString(value, PRESIGNED_URL_KEYS);
  if (direct && isHttpUrl(direct)) {
    return { kind: "url", url: direct, filename: ownFilename, mimeType: ownMime };
  }

  // Recurse into nested objects.
  for (const child of Object.values(value)) {
    if (isPlainObject(child) || Array.isArray(child)) {
      const hit = findUrlInObject(child, depth + 1, ownFilename, ownMime);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Extracts a downloadable file payload (presigned URL or embedded binary blob)
 * from an MCP `CallToolResult`.
 */
export function extractDownloadTarget(result: unknown): DownloadTarget | undefined {
  if (!isPlainObject(result)) return undefined;

  // Check structuredContent first if present.
  if (result.structuredContent !== undefined) {
    const hit = findUrlInObject(result.structuredContent);
    if (hit) return hit;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  // Check JSON inside text blocks for presigned download payloads.
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      try {
        const parsed = JSON.parse(block.text) as unknown;
        const hit = findUrlInObject(parsed);
        if (hit) return hit;
      } catch {
        // Non-JSON text block; ignore.
      }
    }
  }

  // Fall back to embedded binary resource / image / audio blocks.
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === "resource" && isPlainObject(block.resource)) {
      const res = block.resource;
      if (typeof res.blob === "string" && res.blob.length > 0) {
        const uriName = typeof res.uri === "string" ? path.posix.basename(res.uri) : undefined;
        return {
          kind: "base64",
          data: res.blob,
          filename: firstString(res, FILENAME_KEYS) ?? uriName,
          mimeType: firstString(res, MIMETYPE_KEYS),
        };
      }
    }
    if ((block.type === "image" || block.type === "audio") && typeof block.data === "string" && block.data.length > 0) {
      return {
        kind: "base64",
        data: block.data,
        mimeType: firstString(block, MIMETYPE_KEYS),
      };
    }
  }

  return undefined;
}

/** Sanitizes a remote filename so it can never escape a destination directory. */
export function sanitizeFilename(raw: string | undefined): string {
  if (!raw) return "download.bin";
  // Split on both POSIX and Windows separators and take the final segment.
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  const last = (segments.at(-1) ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!last || last === "." || last === "..") return "download.bin";
  return last;
}

function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return star[1].trim().replace(/^"|"$/g, "");
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\r\n]+)/i.exec(header);
  return (plain?.[1] ?? plain?.[2])?.trim();
}

function filenameFromUrl(rawUrl: string): string | undefined {
  try {
    const base = path.posix.basename(new URL(rawUrl).pathname);
    return base && base !== "/" ? decodeURIComponent(base) : undefined;
  } catch {
    return undefined;
  }
}

export interface DownloadResult {
  downloaded: true;
  path: string;
  filename: string;
  bytes: number;
  contentType?: string;
  sha256: string;
}

async function resolveDownloadPath(destArg: string, suggestedFilename: string): Promise<string> {
  const trimmed = destArg.trim();
  if (!trimmed) throw new Error("--download requires a file or directory path");
  const endsWithSep = trimmed.endsWith("/") || trimmed.endsWith(path.sep);
  let isDir = endsWithSep;
  if (!isDir) {
    try {
      isDir = (await stat(trimmed)).isDirectory();
    } catch {
      isDir = false;
    }
  }
  if (isDir) {
    await mkdir(trimmed, { recursive: true });
    return path.join(trimmed, sanitizeFilename(suggestedFilename));
  }
  await mkdir(path.dirname(path.resolve(trimmed)), { recursive: true });
  return trimmed;
}

/**
 * Streams a `DownloadTarget` to disk without sending Ditto auth headers to
 * presigned URLs and without returning or logging any presigned URL.
 */
export async function downloadToolPayload(
  target: DownloadTarget,
  destArg: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_SECONDS * 1000;

  if (target.kind === "base64") {
    const buf = Buffer.from(target.data, "base64");
    const destPath = await resolveDownloadPath(destArg, target.filename ?? "download.bin");
    const tmpPath = `${destPath}.ditto-dl-${randomUUID()}.tmp`;
    try {
      const hash = createHash("sha256").update(buf).digest("hex");
      const out = createWriteStream(tmpPath, { mode: 0o600 });
      out.end(buf);
      await once(out, "finish");
      await rename(tmpPath, destPath);
      return {
        downloaded: true,
        path: destPath,
        filename: path.basename(destPath),
        bytes: buf.length,
        ...(target.mimeType ? { contentType: target.mimeType } : {}),
        sha256: hash,
      };
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  if (!isHttpUrl(target.url)) {
    throw new Error("download payload URL must use http or https");
  }

  // Deliberately send NO Authorization header to presigned storage URLs.
  const response = await fetchImpl(target.url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} from ${redactUrl(target.url)}`);
  }

  const suggested =
    target.filename ??
    filenameFromContentDisposition(response.headers.get("content-disposition")) ??
    filenameFromUrl(target.url) ??
    "download.bin";
  const contentType = target.mimeType ?? response.headers.get("content-type")?.split(";")[0]?.trim() ?? undefined;
  const destPath = await resolveDownloadPath(destArg, suggested);
  const tmpPath = `${destPath}.ditto-dl-${randomUUID()}.tmp`;

  const hash = createHash("sha256");
  let bytes = 0;
  const out = createWriteStream(tmpPath);
  const streamError = new Promise<never>((_resolve, reject) => {
    out.once("error", reject);
  });

  try {
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          hash.update(chunk);
          bytes += chunk.byteLength;
          if (!out.write(chunk)) {
            await Promise.race([once(out, "drain"), streamError]);
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    out.end();
    await Promise.race([once(out, "finish"), streamError]);
    await rename(tmpPath, destPath);
  } catch (err) {
    out.destroy();
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  return {
    downloaded: true,
    path: destPath,
    filename: path.basename(destPath),
    bytes,
    ...(contentType ? { contentType } : {}),
    sha256: hash.digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printTable(header: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r.map((c, i) => (i === r.length - 1 ? c : pad(c ?? "", widths[i] ?? 0))).join("  ");
  process.stdout.write(`${line(header)}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
}

function writeJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function wantsJSON(options: { output?: string; json?: boolean }): boolean {
  return options.json === true || options.output === "json" || options.output === "raw";
}

function oneLine(text: string | undefined, max = 96): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function extractTextBlocks(result: unknown): string[] {
  if (!isPlainObject(result) || !Array.isArray(result.content)) return [];
  const texts: string[] = [];
  for (const block of result.content) {
    if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts;
}

function formatCallOutput(result: unknown, outputFormat: string): string {
  if (outputFormat === "raw") return JSON.stringify(result, null, 2);
  const texts = extractTextBlocks(result);
  if (outputFormat === "json") {
    if (isPlainObject(result) && result.structuredContent !== undefined) {
      return JSON.stringify(result.structuredContent, null, 2);
    }
    if (texts.length === 1) {
      try {
        return JSON.stringify(JSON.parse(texts[0]), null, 2);
      } catch {
        return JSON.stringify({ text: texts[0] }, null, 2);
      }
    }
    if (texts.length > 1) {
      const parsed = texts.map((t) => {
        try {
          return JSON.parse(t) as unknown;
        } catch {
          return t;
        }
      });
      return JSON.stringify({ content: parsed }, null, 2);
    }
    return JSON.stringify(result, null, 2);
  }
  if (texts.length > 0) return texts.join("\n");
  if (isPlainObject(result) && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

function formatSchemaType(prop: unknown): string {
  if (!isPlainObject(prop)) return "any";
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (typeof prop.type === "string") {
    if (prop.type === "array" && isPlainObject(prop.items) && typeof prop.items.type === "string") {
      return `${prop.items.type}[]`;
    }
    return prop.type;
  }
  if (Array.isArray(prop.type)) return prop.type.join(" | ");
  if (Array.isArray(prop.anyOf)) return prop.anyOf.map(formatSchemaType).join(" | ");
  if (Array.isArray(prop.oneOf)) return prop.oneOf.map(formatSchemaType).join(" | ");
  return "any";
}

function parseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CALL_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 3600) {
    throw new Error("--timeout must be a positive number of seconds (up to 3600)");
  }
  return n;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface ToolsBaseOptions {
  endpoint?: string;
  session?: string;
  output?: string;
  json?: boolean;
}

export async function cmdToolsServers(options: ToolsBaseOptions): Promise<void> {
  const { endpoint, baseUrl } = await resolveMcpEndpoint({ endpoint: options.endpoint });
  const sessionId = await resolveToolsSessionId(options.session);
  const catalog = await withEphemeralMcpKey(endpoint, sessionId, (apiKey) =>
    fetchMcpCatalog(baseUrl, apiKey, sessionId),
  );
  const active = catalog.servers.filter((s) => s.tools.length > 0);
  const unavailable = Array.isArray(catalog.unavailable) ? catalog.unavailable : [];

  if (wantsJSON(options)) {
    writeJSON({
      endpoint: { id: endpoint.id, slug: endpoint.slug, name: endpoint.name },
      sessionId,
      approvalMode: catalog.approvalMode,
      clientApprovals: catalog.clientApprovals,
      servers: active.map((s) => ({
        name: claudeServerName(s.name),
        alias: s.name,
        url: s.url,
        toolCount: s.tools.length,
        gatedCount: s.tools.filter((t) => t.approval).length,
        tools: s.tools,
      })),
      unavailable,
    });
    return;
  }

  for (const line of mcpUnavailableLines(catalog)) {
    process.stderr.write(`warning: ${line}\n`);
  }
  if (active.length === 0) {
    process.stdout.write(`No connected MCP servers on endpoint "${endpoint.slug}".\n`);
    return;
  }
  printTable(
    ["SERVER", "ALIAS", "TOOLS", "GATED"],
    active.map((s) => [
      claudeServerName(s.name),
      s.name,
      String(s.tools.length),
      String(s.tools.filter((t) => t.approval).length),
    ]),
  );
  process.stderr.write(
    `\nEndpoint: ${endpoint.slug}  (inspect tools with \`heyditto tools list <server>\`)\n`,
  );
}

export async function cmdToolsList(
  serverArg: string | undefined,
  options: ToolsBaseOptions & { search?: string },
): Promise<void> {
  const { endpoint, baseUrl } = await resolveMcpEndpoint({ endpoint: options.endpoint });
  const sessionId = await resolveToolsSessionId(options.session);
  const search = options.search?.trim().toLowerCase() ?? "";

  if (!serverArg) {
    const catalog = await withEphemeralMcpKey(endpoint, sessionId, (apiKey) =>
      fetchMcpCatalog(baseUrl, apiKey, sessionId),
    );
    const entries: Array<{
      server: string;
      alias: string;
      name: string;
      tier: string;
      approval: boolean;
    }> = [];
    for (const s of catalog.servers) {
      if (s.tools.length === 0) continue;
      const display = claudeServerName(s.name);
      for (const t of s.tools) {
        if (
          search &&
          !t.name.toLowerCase().includes(search) &&
          !s.name.toLowerCase().includes(search) &&
          !display.toLowerCase().includes(search)
        ) {
          continue;
        }
        entries.push({ server: display, alias: s.name, name: t.name, tier: t.tier, approval: t.approval });
      }
    }
    if (wantsJSON(options)) {
      writeJSON({
        endpoint: { id: endpoint.id, slug: endpoint.slug },
        sessionId,
        ...(search ? { search } : {}),
        tools: entries,
      });
      return;
    }
    for (const line of mcpUnavailableLines(catalog)) {
      process.stderr.write(`warning: ${line}\n`);
    }
    if (entries.length === 0) {
      process.stdout.write(
        search ? `No tools matching "${options.search}" on endpoint "${endpoint.slug}".\n` : `No tools available on endpoint "${endpoint.slug}".\n`,
      );
      return;
    }
    printTable(
      ["SERVER", "TOOL", "TIER", "APPROVAL"],
      entries.map((e) => [e.server, e.name, e.tier, e.approval ? "gated" : "auto"]),
    );
    return;
  }

  const { resolved, tools } = await withEphemeralMcpKey(endpoint, sessionId, async (apiKey) => {
    const catalog = await fetchMcpCatalog(baseUrl, apiKey, sessionId);
    const resolvedServer = resolveCatalogServer(catalog, serverArg);
    const client = await connectCatalogServer(resolvedServer.server, baseUrl, apiKey, sessionId);
    try {
      const listed = await listAllServerTools(client);
      return { resolved: resolvedServer, tools: listed };
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  const catalogByName = new Map<string, McpCatalogTool>(
    resolved.server.tools.map((t) => [t.name, t]),
  );

  const merged = tools
    .map((t) => {
      const meta = catalogByName.get(t.name);
      return {
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        ...(t.description ? { description: t.description } : {}),
        ...(meta ? { tier: meta.tier, approval: meta.approval } : {}),
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      };
    })
    .filter((t) => {
      if (!search) return true;
      return (
        t.name.toLowerCase().includes(search) ||
        (t.title ?? "").toLowerCase().includes(search) ||
        (t.description ?? "").toLowerCase().includes(search)
      );
    });

  if (wantsJSON(options)) {
    writeJSON({
      endpoint: { id: endpoint.id, slug: endpoint.slug },
      sessionId,
      server: resolved.displayName,
      alias: resolved.alias,
      ...(search ? { search } : {}),
      tools: merged,
    });
    return;
  }

  if (merged.length === 0) {
    process.stdout.write(
      search
        ? `No tools matching "${options.search}" on ${resolved.displayName}.\n`
        : `No tools advertised by ${resolved.displayName}.\n`,
    );
    return;
  }
  printTable(
    ["TOOL", "APPROVAL", "DESCRIPTION"],
    merged.map((t) => [
      t.name,
      t.approval === undefined ? "" : t.approval ? "gated" : "auto",
      oneLine(t.description ?? t.title),
    ]),
  );
  process.stderr.write(
    `\nInspect one tool: \`heyditto tools describe ${resolved.alias} <tool>\`\n`,
  );
}

export async function cmdToolsDescribe(
  serverArg: string,
  toolArg: string,
  options: ToolsBaseOptions,
): Promise<void> {
  const { endpoint, baseUrl } = await resolveMcpEndpoint({ endpoint: options.endpoint });
  const sessionId = await resolveToolsSessionId(options.session);
  const wantedTool = toolArg.trim();
  if (!wantedTool) throw new Error("provide a tool name");

  const { resolved, listed } = await withEphemeralMcpKey(endpoint, sessionId, async (apiKey) => {
    const catalog = await fetchMcpCatalog(baseUrl, apiKey, sessionId);
    const resolvedServer = resolveCatalogServer(catalog, serverArg);
    const client = await connectCatalogServer(resolvedServer.server, baseUrl, apiKey, sessionId);
    try {
      const tools = await listAllServerTools(client);
      return { resolved: resolvedServer, listed: tools };
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  const match =
    listed.find((t) => t.name === wantedTool) ??
    listed.find((t) => t.name.toLowerCase() === wantedTool.toLowerCase());
  if (!match) {
    const needle = wantedTool.toLowerCase();
    const similar = listed
      .map((t) => t.name)
      .filter((n) => n.toLowerCase().includes(needle))
      .slice(0, 8);
    const hint = similar.length
      ? ` Matching tools: ${similar.join(", ")}`
      : listed.length > 0
        ? ` Available: ${listed.slice(0, 12).map((t) => t.name).join(", ")}${listed.length > 12 ? ` (+${listed.length - 12} more)` : ""}`
        : "";
    throw new Error(`tool "${wantedTool}" not found on ${resolved.displayName}.${hint}`);
  }

  const meta = resolved.server.tools.find((t) => t.name === match.name);
  if (options.output === "raw") {
    writeJSON(match);
    return;
  }
  if (wantsJSON(options)) {
    writeJSON({
      endpoint: { id: endpoint.id, slug: endpoint.slug },
      sessionId,
      server: resolved.displayName,
      alias: resolved.alias,
      tool: {
        name: match.name,
        ...(match.title ? { title: match.title } : {}),
        ...(match.description ? { description: match.description } : {}),
        ...(meta ? { tier: meta.tier, approval: meta.approval } : {}),
        inputSchema: match.inputSchema ?? { type: "object", properties: {} },
        ...(match.annotations ? { annotations: match.annotations } : {}),
      },
    });
    return;
  }

  process.stdout.write(`${resolved.displayName} / ${match.name}\n`);
  if (meta) {
    process.stdout.write(`tier: ${meta.tier}  approval: ${meta.approval ? "gated" : "auto"}\n`);
  }
  if (match.description) {
    process.stdout.write(`\n${match.description.trim()}\n`);
  }
  const schema = isPlainObject(match.inputSchema) ? match.inputSchema : undefined;
  const props = schema && isPlainObject(schema.properties) ? schema.properties : undefined;
  const required = new Set(
    schema && Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  if (props && Object.keys(props).length > 0) {
    process.stdout.write("\nParameters:\n");
    printTable(
      ["NAME", "TYPE", "REQUIRED", "DESCRIPTION"],
      Object.entries(props).map(([key, def]) => [
        key,
        formatSchemaType(def),
        required.has(key) ? "yes" : "no",
        isPlainObject(def) && typeof def.description === "string" ? oneLine(def.description, 120) : "",
      ]),
    );
  }
  if (schema) {
    process.stdout.write(`\nInput schema:\n${JSON.stringify(schema, null, 2)}\n`);
  }
}

export interface ToolsCallOptions extends ToolCallInputOptions {
  endpoint?: string;
  session?: string;
  output?: string;
  timeout?: string;
  download?: string;
}

export async function cmdToolsCall(
  serverArg: string,
  toolArg: string,
  positionalInput: string | undefined,
  options: ToolsCallOptions,
): Promise<void> {
  const outputFormat = options.output ?? "text";
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  const timeoutMs = timeoutSeconds * 1000;
  const toolName = toolArg.trim();
  if (!toolName) throw new Error("provide a tool name");

  // Parse and validate local arguments BEFORE minting an ephemeral key.
  const args = await parseToolCallArgs(positionalInput, options);

  const { endpoint, baseUrl } = await resolveMcpEndpoint({ endpoint: options.endpoint });
  const sessionId = await resolveToolsSessionId(options.session);

  const { result, renderedOutput } = await withEphemeralMcpKey(endpoint, sessionId, async (apiKey) => {
    const catalog = await fetchMcpCatalog(baseUrl, apiKey, sessionId);
    const resolved = resolveCatalogServer(catalog, serverArg);
    const client = await connectCatalogServer(resolved.server, baseUrl, apiKey, sessionId);
    let callResult: Awaited<ReturnType<Client["callTool"]>>;
    try {
      callResult = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: timeoutMs },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
    if (callResult.isError) {
      const message = formatCallOutput(callResult, "text");
      throw new Error(message || `tool "${toolName}" returned an error`);
    }
    return {
      result: callResult,
      renderedOutput: sanitizeSecret(formatCallOutput(callResult, outputFormat), apiKey),
    };
  });

  if (options.download !== undefined) {
    const target = extractDownloadTarget(result);
    if (!target) {
      throw new Error(
        `tool "${toolName}" did not return a downloadable file payload (expected downloaded_file_content.s3url, download_url, or binary resource)`,
      );
    }
    const downloaded = await downloadToolPayload(target, options.download, { timeoutMs });
    if (outputFormat === "json" || outputFormat === "raw") {
      writeJSON(downloaded);
    } else {
      const mimeNote = downloaded.contentType ? ` (${downloaded.contentType})` : "";
      process.stdout.write(`Downloaded ${downloaded.bytes} bytes to ${downloaded.path}${mimeNote}\n`);
    }
    return;
  }

  process.stdout.write(`${renderedOutput}\n`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function collectOption(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export function registerToolsCommands(
  program: Command,
  addExamples: (c: Command, ex: string) => Command,
  outputOption: () => Option,
): void {
  const tools = program
    .command("tools")
    .description("discover, inspect, and invoke connected-app MCP tools from the shell")
    .summary("connected-app MCP tools")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Connected-app MCP servers (Google Drive, Gmail, Google Docs, Jira, Backroom,
etc.) are resolved from your active endpoint's MCP catalog. Each invocation
mints a short-lived ephemeral key, never prints it, and revokes it on exit.

Server names accept both canonical names (\`ditto-googledrive\`) and short
aliases (\`googledrive\`, \`google-drive\`, \`gmail\`, \`ditto\`).`,
    );

  const serversCmd = addProfileOption(
    tools
      .command("servers", { isDefault: true })
      .description("list connected MCP servers on the active endpoint")
      .option("-e, --endpoint <endpoint>", "endpoint slug, name, or id")
      .option("--session <id>", "MCP session id (default: T3CODE_THREAD_ID, active session, or auto-generated)")
      .option("--json", "print machine-readable JSON output")
      .addOption(outputOption())
      .action(cmdToolsServers),
  );
  addExamples(
    serversCmd,
    `  heyditto tools
  heyditto tools --endpoint my-endpoint --json`,
  );

  const listCmd = addProfileOption(
    tools
      .command("list")
      .alias("ls")
      .description("list tools on one connected MCP server (or across all servers when omitted)")
      .argument("[server]", "MCP server name or alias (e.g. googledrive, ditto-googledrive, ditto)")
      .option("-s, --search <query>", "filter tools by substring match on name or description")
      .option("-e, --endpoint <endpoint>", "endpoint slug, name, or id")
      .option("--session <id>", "MCP session id (default: T3CODE_THREAD_ID, active session, or auto-generated)")
      .option("--json", "print machine-readable JSON output")
      .addOption(outputOption())
      .action(cmdToolsList),
  );
  addExamples(
    listCmd,
    `  heyditto tools list googledrive
  heyditto tools list googledrive --search download
  heyditto tools list --search gmail --json`,
  );

  const describeCmd = addProfileOption(
    tools
      .command("describe")
      .alias("schema")
      .alias("inspect")
      .alias("show")
      .description("inspect one tool's description, required parameters, and JSON input schema")
      .argument("<server>", "MCP server name or alias (e.g. googledrive, gmail, ditto)")
      .argument("<tool>", "tool name")
      .option("-e, --endpoint <endpoint>", "endpoint slug, name, or id")
      .option("--session <id>", "MCP session id (default: T3CODE_THREAD_ID, active session, or auto-generated)")
      .option("--json", "print machine-readable JSON output")
      .addOption(outputOption())
      .action(cmdToolsDescribe),
  );
  addExamples(
    describeCmd,
    `  heyditto tools describe googledrive download_file
  heyditto tools schema gmail search_messages --json`,
  );

  const callCmd = addProfileOption(
    tools
      .command("call")
      .alias("run")
      .alias("invoke")
      .description("call a tool on a connected MCP server over Streamable HTTP")
      .argument("<server>", "MCP server name or alias (e.g. googledrive, gmail, ditto)")
      .argument("<tool>", "tool name")
      .argument("[input]", "optional JSON object, @file.json, or - for stdin")
      .option("--json <payload>", "tool arguments as a JSON object string, @file.json, or - for stdin")
      .option("--stdin", "read tool arguments JSON object from stdin")
      .option(
        "-a, --arg <key=value>",
        "set one tool argument (repeatable; parses JSON numbers, booleans, arrays, and objects)",
        collectOption,
      )
      .option(
        "--raw-arg <key=value>",
        "set one string tool argument without JSON parsing (repeatable)",
        collectOption,
      )
      .option(
        "--download <path-or-dir>",
        "stream a returned presigned file (e.g. downloaded_file_content.s3url) or binary resource to disk without printing presigned URLs",
      )
      .option("--timeout <seconds>", `tool call timeout in seconds (default ${DEFAULT_CALL_TIMEOUT_SECONDS})`)
      .option("-e, --endpoint <endpoint>", "endpoint slug, name, or id")
      .option("--session <id>", "MCP session id (default: T3CODE_THREAD_ID, active session, or auto-generated)")
      .addOption(outputOption())
      .action(cmdToolsCall),
  );
  addExamples(
    callCmd,
    `  heyditto tools call googledrive list_files --arg page_size=10 --output json
  heyditto tools call googledrive download_file --arg file_id=1abc --download ./downloads/
  heyditto tools call gmail search_messages --json '{"query":"from:alice"}' --output json
  echo '{"query":"roadmap"}' | heyditto tools call googledrive search_files --stdin --output json
  heyditto tools call jira create_issue @issue.json --output json`,
  );
}
