import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configDir } from "./config.js";
import { readStoredAuth, updateStoredAuth } from "./store.js";

/**
 * Explicit MCP sessions: `heyditto session new` picks an id that every later
 * MCP request carries as X-Ditto-Session-Id, so saves and searches land in one
 * thread inside the agent the key is attached to. The name rides once on
 * X-Ditto-Session-Name (the backend titles the thread with it).
 */

export const SESSION_ID_HEADER = "X-Ditto-Session-Id";
export const SESSION_NAME_HEADER = "X-Ditto-Session-Name";
/** Overrides the stored active session so scripts and spawned shells can pin one. */
export const SESSION_ENV = "DITTO_SESSION_ID";
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

export interface McpSessionRecord {
  id: string;
  name?: string;
  createdAt: string;
  lastUsedAt?: string;
  endedAt?: string;
  /** True once X-Ditto-Session-Name went out on a successful request. */
  nameSent?: boolean;
}

export interface ActiveSession {
  id: string;
  name?: string;
  createdAt?: string;
  source: "env" | "config";
  /** Send the name header on the next request. */
  sendName: boolean;
}

interface HistoryFile {
  sessions: McpSessionRecord[];
}

const HISTORY_LIMIT = 200;

export function sessionsHistoryPath(): string {
  return path.join(configDir(), "mcp-sessions.json");
}

export async function readSessionHistory(): Promise<McpSessionRecord[]> {
  try {
    const raw = await readFile(sessionsHistoryPath(), "utf-8");
    const parsed = JSON.parse(raw) as HistoryFile;
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeSessionHistory(sessions: McpSessionRecord[]): Promise<void> {
  const file = sessionsHistoryPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const trimmed = [...sessions]
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0))
    .slice(0, HISTORY_LIMIT);
  await writeFile(file, `${JSON.stringify({ sessions: trimmed }, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function upsertSessionRecord(record: McpSessionRecord): Promise<void> {
  const history = await readSessionHistory();
  const idx = history.findIndex((s) => s.id === record.id);
  if (idx >= 0) history[idx] = { ...history[idx], ...record };
  else history.push(record);
  await writeSessionHistory(history);
}

/** The session every MCP request should be tagged with, or undefined. */
export async function resolveActiveSession(): Promise<ActiveSession | undefined> {
  const envID = process.env[SESSION_ENV]?.trim();
  if (envID) {
    if (!SESSION_ID_PATTERN.test(envID)) throw new Error(`${SESSION_ENV} must match ${SESSION_ID_PATTERN}`);
    return { id: envID, source: "env", sendName: false };
  }
  const stored = (await readStoredAuth())?.activeSession;
  if (!stored?.id) return undefined;
  const history = await readSessionHistory();
  const record = history.find((s) => s.id === stored.id);
  const name = record?.name ?? stored.name;
  return {
    id: stored.id,
    name,
    createdAt: record?.createdAt ?? stored.createdAt,
    source: "config",
    sendName: Boolean(name) && !record?.nameSent,
  };
}

/** Pure: the extra headers for one MCP request. */
export function sessionHeaders(active: ActiveSession | undefined): Record<string, string> {
  if (!active) return {};
  const headers: Record<string, string> = { [SESSION_ID_HEADER]: active.id };
  if (active.sendName && active.name) headers[SESSION_NAME_HEADER] = active.name;
  return headers;
}

/** Record a successful request: the name is sent once, lastUsedAt moves. */
export async function markSessionUsed(active: ActiveSession | undefined): Promise<void> {
  if (!active || active.source !== "config") return;
  const history = await readSessionHistory();
  const record = history.find((s) => s.id === active.id);
  if (!record) return;
  await upsertSessionRecord({ ...record, lastUsedAt: new Date().toISOString(), nameSent: record.nameSent || active.sendName });
}

export async function startSession(name: string | undefined, id?: string): Promise<McpSessionRecord> {
  const sessionID = id?.trim() || randomUUID();
  if (!SESSION_ID_PATTERN.test(sessionID)) throw new Error(`session id must match ${SESSION_ID_PATTERN}`);
  const record: McpSessionRecord = { id: sessionID, createdAt: new Date().toISOString() };
  const cleaned = name?.trim();
  if (cleaned) record.name = cleaned;
  await upsertSessionRecord(record);
  await updateStoredAuth({ activeSession: { id: record.id, name: record.name, createdAt: record.createdAt } });
  return record;
}

export async function useSession(id: string): Promise<McpSessionRecord> {
  const wanted = id.trim();
  const history = await readSessionHistory();
  const record = history.find((s) => s.id === wanted || (wanted.length >= 6 && s.id.startsWith(wanted)));
  if (!record) {
    if (!SESSION_ID_PATTERN.test(wanted)) throw new Error(`no local session "${wanted}"; see \`heyditto session list\``);
    // An id minted elsewhere (another machine, the app) can still be pinned.
    const fresh: McpSessionRecord = { id: wanted, createdAt: new Date().toISOString(), nameSent: true };
    await upsertSessionRecord(fresh);
    await updateStoredAuth({ activeSession: { id: fresh.id, createdAt: fresh.createdAt } });
    return fresh;
  }
  const revived = { ...record, endedAt: undefined };
  await upsertSessionRecord(revived);
  await updateStoredAuth({ activeSession: { id: revived.id, name: revived.name, createdAt: revived.createdAt } });
  return revived;
}

export async function endSession(): Promise<McpSessionRecord | undefined> {
  const stored = (await readStoredAuth())?.activeSession;
  if (!stored?.id) return undefined;
  const history = await readSessionHistory();
  const record = history.find((s) => s.id === stored.id);
  const ended: McpSessionRecord = { ...(record ?? { id: stored.id, createdAt: stored.createdAt ?? new Date().toISOString() }), endedAt: new Date().toISOString() };
  await upsertSessionRecord(ended);
  await updateStoredAuth({ activeSession: undefined });
  return ended;
}
