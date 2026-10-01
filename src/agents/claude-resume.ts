import { stat } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { canonicalCwd } from "../teleport/harness.js";
import { err as c } from "../ui.js";
import {
  type ClaudeTranscript,
  entrypointLabel,
  findTranscriptById,
  listAllTranscripts,
  listTranscriptsIn,
  relativeTime,
  searchTranscripts,
} from "./claude-transcripts.js";
import { type SessionRecord, latestSession, listSessions, readSession, sessionForHarnessId } from "./sessions.js";

/**
 * What `heyditto claude --resume [value]` reopens: the Claude conversation to
 * resume (if it has one) and the Ditto record whose thread it continues (if it
 * was launched through Ditto before).
 */
export interface ClaudeResumeTarget {
  record?: SessionRecord;
  /** Undefined when the session never recorded a conversation (nothing was sent). */
  transcript?: ClaudeTranscript;
}

export interface ResolveOptions {
  cwd: string;
  interactive: boolean;
  log: (message: string) => void;
}

const PAGE = 10;

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** The directory `claude --resume` must run in to find a transcript, when it still exists. */
export async function transcriptCwd(t: ClaudeTranscript): Promise<string | undefined> {
  return t.cwd && (await isDirectory(t.cwd)) ? t.cwd : undefined;
}

function tildify(dir: string): string {
  const home = os.homedir();
  return dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

function clip(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, Math.max(1, width - 1))}…` : flat;
}

function describe(t: ClaudeTranscript): string {
  return t.title ?? (t.lastPrompt ? clip(t.lastPrompt, 60) : "(untitled)");
}

function printChoices(list: ClaudeTranscript[], here: string, viaDitto: Set<string>): void {
  const width = Math.max(40, (process.stderr.columns ?? 100) - 8);
  list.slice(0, PAGE).forEach((t, i) => {
    const meta = [
      relativeTime(t.modifiedAt),
      entrypointLabel(t.entrypoint),
      t.gitBranch,
      viaDitto.has(t.id) ? "via Ditto" : undefined,
    ].filter(Boolean).join(" · ");
    process.stderr.write(`  ${c("cyan", `${String(i + 1).padStart(2)})`)} ${c("bold", clip(describe(t), width - meta.length - 3))}  ${c("dim", meta)}\n`);
    const where = t.cwd && t.cwd !== here ? `${tildify(t.cwd)}  ` : "";
    const prompt = t.title && t.lastPrompt ? `› ${t.lastPrompt}` : "";
    const detail = `${where}${prompt}`.trim();
    if (detail) process.stderr.write(`      ${c("dim", clip(detail, width))}\n`);
  });
  if (list.length > PAGE) process.stderr.write(c("dim", `      …and ${list.length - PAGE} more; type words to narrow\n`));
}

/**
 * Numbered picker over Claude Code sessions. A number picks, Enter picks the
 * first, and anything else is a search across every project (Claude Desktop
 * sessions included), so "I remember what it was about" is enough to find one.
 */
export async function pickTranscript(initial: ClaudeTranscript[], heading: string, cwd: string): Promise<ClaudeTranscript> {
  const here = canonicalCwd(cwd);
  const viaDitto = new Set((await listSessions()).map((s) => s.harnessSessionId).filter((id): id is string => Boolean(id)));
  let all: ClaudeTranscript[] | undefined;
  let list = initial;
  process.stderr.write(`${c("bold", heading)}\n\n`);
  if (list.length === 0) {
    all = await listAllTranscripts();
    list = all;
    process.stderr.write(`  ${c("dim", "none here yet — newest from every project:")}\n`);
  }
  printChoices(list, here, viaDitto);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const range = list.length ? `a number 1-${Math.min(list.length, PAGE)}, ` : "";
      const answer = (await rl.question(`\nResume which? [${range}words to search, Enter = 1, q = cancel] `)).trim();
      if (answer === "q" || answer === "quit") throw new Error("no session picked");
      if (answer === "" && list.length) return list[0];
      const idx = Number(answer);
      if (Number.isInteger(idx) && idx >= 1 && idx <= Math.min(list.length, PAGE)) return list[idx - 1];
      all ??= await listAllTranscripts();
      const hits = searchTranscripts(all, answer, cwd);
      if (hits.length === 0) {
        // Keep the list on screen so the numbers still mean what they did.
        process.stderr.write(`  ${c("yellow", `no session matches "${answer}"`)} ${c("dim", "— try other words, or pick from the list above")}\n`);
        continue;
      }
      list = hits;
      process.stderr.write(`\n${c("bold", `Sessions matching "${answer}":`)}\n\n`);
      printChoices(list, here, viaDitto);
    }
  } finally {
    rl.close();
  }
}

function listForError(matches: ClaudeTranscript[]): string {
  return matches
    .slice(0, 5)
    .map((t) => `  ${t.id}  ${describe(t)}${t.cwd ? `  (${tildify(t.cwd)})` : ""}`)
    .join("\n");
}

async function withRecord(transcript: ClaudeTranscript): Promise<ClaudeResumeTarget> {
  return { transcript, record: await sessionForHarnessId("claude", transcript.id) };
}

/**
 * Resolves `--resume [value]` for Claude Code. A value may be a Ditto session
 * id, a Claude session id, or a title / words from one (what `claude --resume`
 * prints for a renamed session). With no value an interactive terminal gets a
 * picker; a script gets the most recent session, as before.
 */
export async function resolveClaudeResume(value: string | true, opts: ResolveOptions): Promise<ClaudeResumeTarget> {
  if (value === true) {
    if (opts.interactive) {
      const here = await listTranscriptsIn(opts.cwd);
      return withRecord(await pickTranscript(here, `Claude Code sessions in ${tildify(canonicalCwd(opts.cwd))} (newest first):`, opts.cwd));
    }
    // The most recent conversation: the newest transcript here, or the last
    // Ditto launch's (it may have run in a worktree) if that one is newer. A
    // launch that never sent anything only wins when there is nothing else.
    const [newest] = await listTranscriptsIn(opts.cwd);
    const record = await latestSession("claude", opts.cwd);
    const recorded = record ? await findTranscriptById(record.harnessSessionId ?? record.id, record.worktree ?? record.cwd) : undefined;
    if (record && recorded && (!newest || recorded.modifiedAt >= newest.modifiedAt)) return { record, transcript: recorded };
    if (newest) return withRecord(newest);
    if (record) return { record };
    throw new Error("no previous claude session to resume here; see `heyditto sessions`");
  }

  const wanted = value.trim();
  const record = (await readSession(wanted)) ?? (await sessionForHarnessId("claude", wanted));
  if (record) {
    if (record.harness !== "claude") return { record };
    return { record, transcript: await findTranscriptById(record.harnessSessionId ?? record.id, record.cwd) };
  }
  const byId = await findTranscriptById(wanted, opts.cwd);
  if (byId) return withRecord(byId);

  const matches = searchTranscripts(await listAllTranscripts(), wanted, opts.cwd);
  if (matches.length === 1) return withRecord(matches[0]);
  if (matches.length === 0) {
    throw new Error(
      `no Claude Code session matches "${wanted}" (searched Ditto session ids, Claude session ids and titles).\n` +
        "Run `heyditto claude --resume` with no value to pick from a list.",
    );
  }
  if (opts.interactive) return withRecord(await pickTranscript(matches, `Sessions matching "${wanted}":`, opts.cwd));
  throw new Error(`"${wanted}" matches ${matches.length} sessions; pass one id:\n${listForError(matches)}`);
}
