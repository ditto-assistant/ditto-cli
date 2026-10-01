import { open, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalCwd } from "../teleport/harness.js";
import { cwdSlug } from "../teleport/types.js";

/**
 * Claude Code's own session store (`~/.claude/projects/<cwd slug>/<id>.jsonl`),
 * read so `heyditto claude --resume` can find a conversation the way `claude
 * --resume` does: by session id, by title, or from a picker. Sessions started
 * in Claude Desktop live in the same store, so they resume here too.
 *
 * Transcripts can be tens of megabytes; only the head and tail are read. Claude
 * re-appends its title and last-prompt lines as the session goes, so the tail
 * carries the current ones.
 */

/** Metadata of one Claude Code transcript. */
export interface ClaudeTranscript {
  /** Claude's session id (the file name). */
  id: string;
  file: string;
  /** Directory the session ran in, when the transcript records it. */
  cwd?: string;
  /** `/rename` title, else the title Claude generated. */
  title?: string;
  lastPrompt?: string;
  /** The opening prompt, when it falls in the part of the file that is read. */
  firstPrompt?: string;
  /** "cli", "claude-desktop", "sdk-ts", … */
  entrypoint?: string;
  gitBranch?: string;
  modifiedAt: Date;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

function projectsDir(): string {
  return path.join(claudeHome(), "projects");
}

/** The project directory Claude Code keys sessions started in `cwd` under. */
export function claudeProjectDir(cwd: string): string {
  return path.join(projectsDir(), cwdSlug(canonicalCwd(cwd)));
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

async function readSlice(file: string, size: number): Promise<{ head: string; tail: string }> {
  const handle = await open(file, "r");
  try {
    const headLen = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await handle.read(head, 0, headLen, 0);
    if (size <= HEAD_BYTES) return { head: head.toString("utf8"), tail: "" };
    const tailLen = Math.min(size - headLen, TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    await handle.read(tail, 0, tailLen, size - tailLen);
    return { head: head.toString("utf8"), tail: tail.toString("utf8") };
  } finally {
    await handle.close();
  }
}

function jsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* a line cut by the head/tail window */
    }
  }
  return out;
}

/** Text the user typed in a transcript `user` message; injected context (`<system-reminder>`, tool results) is skipped. */
function promptText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  const parts = typeof content === "string" ? [content] : Array.isArray(content)
    ? content.map((p) => ((p as { type?: unknown }).type === "text" ? (p as { text?: unknown }).text : undefined))
    : [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    const text = part.trim();
    if (text && !text.startsWith("<")) return text.slice(0, 500);
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Reads one transcript's metadata; undefined when it has no conversation in it. */
export async function readTranscript(file: string): Promise<ClaudeTranscript | undefined> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return undefined;
  }
  if (!info.isFile()) return undefined;
  const id = path.basename(file, ".jsonl");
  const { head, tail } = await readSlice(file, info.size);
  const lines = [...jsonLines(head), ...jsonLines(tail)];
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  let firstPrompt: string | undefined;
  let cwd: string | undefined;
  let entrypoint: string | undefined;
  let gitBranch: string | undefined;
  let spoke = false;
  for (const l of lines) {
    if (l.type === "custom-title") customTitle = str(l.customTitle) ?? customTitle;
    else if (l.type === "ai-title") aiTitle = str(l.aiTitle) ?? aiTitle;
    else if (l.type === "last-prompt") lastPrompt = str(l.lastPrompt) ?? lastPrompt;
    else if (l.type === "user" || l.type === "assistant") {
      spoke = true;
      if (l.type === "user" && !firstPrompt) firstPrompt = promptText(l.message);
    }
    cwd ??= str(l.cwd);
    entrypoint ??= str(l.entrypoint);
    gitBranch = str(l.gitBranch) ?? gitBranch;
  }
  // Newer Claude builds also keep the /rename title beside the transcript.
  try {
    const sidecar = JSON.parse(await readFile(path.join(path.dirname(file), id, "custom-title.json"), "utf8")) as { customTitle?: unknown };
    customTitle = str(sidecar.customTitle) ?? customTitle;
  } catch {
    /* no sidecar */
  }
  if (!spoke && !lastPrompt) return undefined;
  return {
    id,
    file,
    cwd,
    title: customTitle ?? aiTitle,
    lastPrompt,
    firstPrompt,
    entrypoint,
    gitBranch,
    modifiedAt: info.mtime,
  };
}

async function jsonlFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

async function projectDirs(): Promise<string[]> {
  try {
    const entries = await readdir(projectsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(projectsDir(), e.name));
  } catch {
    return [];
  }
}

/** Newest-first sort, keeping files whose metadata could not be read out. */
async function readAll(files: string[]): Promise<ClaudeTranscript[]> {
  // Most-recent files first so a caller that only shows the top of the list
  // does not wait on years of history.
  const withTimes = await Promise.all(
    files.map(async (f) => ({ f, t: await stat(f).then((s) => s.mtimeMs, () => 0) })),
  );
  withTimes.sort((a, b) => b.t - a.t);
  const out: ClaudeTranscript[] = [];
  for (const { f } of withTimes) {
    const t = await readTranscript(f);
    if (t) out.push(t);
  }
  return out;
}

/** Conversations started in `cwd`, newest first. */
export async function listTranscriptsIn(cwd: string): Promise<ClaudeTranscript[]> {
  return readAll(await jsonlFiles(claudeProjectDir(cwd)));
}

/** Every conversation Claude Code has on this machine, newest first. */
export async function listAllTranscripts(): Promise<ClaudeTranscript[]> {
  const files = (await Promise.all((await projectDirs()).map(jsonlFiles))).flat();
  return readAll(files);
}

/**
 * A transcript by Claude session id, looked up in `cwd`'s project first and
 * then in every project (a session moved between worktrees keeps its id).
 */
export async function findTranscriptById(id: string, cwd?: string): Promise<ClaudeTranscript | undefined> {
  if (!isUuid(id)) return undefined;
  if (cwd) {
    const here = await readTranscript(path.join(claudeProjectDir(cwd), `${id}.jsonl`));
    if (here) return here;
  }
  for (const dir of await projectDirs()) {
    const t = await readTranscript(path.join(dir, `${id}.jsonl`));
    if (t) return t;
  }
  return undefined;
}

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Transcripts matching a free-text query. An exact (case-insensitive) title
 * match wins outright, as `claude --resume "<title>"` does; otherwise every
 * word must appear in the title, first or last prompt, directory, branch or
 * id. Title hits come first, and within each group ones from `cwd` lead.
 */
export function searchTranscripts(all: ClaudeTranscript[], query: string, cwd?: string): ClaudeTranscript[] {
  const q = norm(query);
  if (!q) return all;
  const here = cwd ? canonicalCwd(cwd) : undefined;
  const byHere = (list: ClaudeTranscript[]) =>
    [...list].sort((a, b) => Number(b.cwd === here) - Number(a.cwd === here));
  const exact = all.filter((t) => norm(t.title) === q);
  if (exact.length) return byHere(exact);
  const words = q.split(" ");
  const has = (text: string | undefined) => {
    const hay = norm(text);
    return words.every((w) => hay.includes(w));
  };
  const inTitle = all.filter((t) => has(t.title));
  const elsewhere = all.filter((t) => !has(t.title) && has([t.title, t.lastPrompt, t.firstPrompt, t.cwd, t.gitBranch, t.id].filter(Boolean).join(" ")));
  return [...byHere(inTitle), ...byHere(elsewhere)];
}

/** "3m ago", "5h ago", "2d ago", or a date for anything older than a month. */
export function relativeTime(date: Date, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return date.toISOString().slice(0, 10);
}

export function entrypointLabel(entrypoint: string | undefined): string | undefined {
  if (entrypoint === "claude-desktop") return "Claude Desktop";
  if (entrypoint === "cli") return "CLI";
  if (entrypoint?.startsWith("sdk")) return "SDK";
  return entrypoint;
}
