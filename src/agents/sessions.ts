import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../config.js";
import type { Harness } from "./types.js";

/** One coding-agent session launched by the CLI; the Ditto session id is the file name. */
export interface SessionRecord {
  id: string;
  harness: Harness;
  endpointId: string;
  endpointSlug: string;
  /** Last key minted for this session; revoked on exit unless --keep-key. */
  keyId?: string;
  keyHint?: string;
  /** Harness-native id used to resume (Claude's --session-id; Codex thread id when known). */
  harnessSessionId?: string;
  cwd: string;
  worktree?: string;
  model?: string;
  createdAt: string;
  lastLaunchedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  launches: number;
}

function fileFor(id: string): string {
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(id)) throw new Error(`invalid session id: ${id}`);
  return path.join(sessionsDir(), `${id}.json`);
}

export async function writeSession(record: SessionRecord): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true, mode: 0o700 });
  await writeFile(fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function readSession(id: string): Promise<SessionRecord | undefined> {
  try {
    return JSON.parse(await readFile(fileFor(id), "utf8")) as SessionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function removeSession(id: string): Promise<boolean> {
  try {
    await rm(fileFor(id));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** All local records, most recently launched first. */
export async function listSessions(): Promise<SessionRecord[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(await readFile(path.join(sessionsDir(), name), "utf8")) as SessionRecord);
    } catch {
      /* skip unreadable record */
    }
  }
  return records.sort((a, b) => (b.lastLaunchedAt ?? "").localeCompare(a.lastLaunchedAt ?? ""));
}

/** Most recent record for a harness, preferring one launched from the same directory. */
export async function latestSession(harness: Harness, cwd: string): Promise<SessionRecord | undefined> {
  const all = (await listSessions()).filter((s) => s.harness === harness);
  return all.find((s) => s.cwd === cwd || s.worktree === cwd) ?? all[0];
}
