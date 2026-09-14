import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type SessionRecord, readSession, writeSession } from "../agents/sessions.js";
import { defaultWorktreeName, ensureWorktree, repoRoot, validWorktreeName } from "../agents/worktree.js";
import { canonicalCwd, locateClaude, locateCodex } from "../teleport/harness.js";
import { cwdSlug } from "../teleport/types.js";

/**
 * `heyditto fork <session>`: a new session that starts from a copy of an
 * existing conversation. Locally that is a copy of the harness transcript
 * under a fresh id (optionally in a new git worktree); `--cloud` then
 * teleports the fork and resumes it in Ditto Code.
 */

export interface ForkOptions {
  worktree?: string | boolean;
  cloud?: boolean;
  endpoint?: string;
  prompt?: string;
  output?: string;
}

export interface ForkResult {
  from: string;
  session: SessionRecord;
  transcript?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function claudeProjectsDir(): string {
  const home = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(home, "projects");
}

/** Copies a Claude transcript to a new session id (and, when the cwd moved, the new project slug). */
async function forkClaudeTranscript(oldId: string, newId: string, fromCwd: string, toCwd: string): Promise<string> {
  const loc = await locateClaude(oldId, fromCwd);
  if (!loc) throw new Error(`no local Claude Code transcript for session ${oldId} under ${fromCwd}`);
  const fromCanon = canonicalCwd(fromCwd);
  const toCanon = canonicalCwd(toCwd);
  const toDir = path.join(claudeProjectsDir(), cwdSlug(toCanon));
  await mkdir(toDir, { recursive: true });
  const jsonl = loc.files.find((f) => f.endsWith(`${oldId}.jsonl`));
  if (!jsonl) throw new Error(`transcript ${oldId}.jsonl not found`);
  let text = await readFile(jsonl, "utf8");
  text = text.split(oldId).join(newId);
  if (fromCanon !== toCanon) text = text.split(fromCanon).join(toCanon).split(fromCwd).join(toCwd);
  const target = path.join(toDir, `${newId}.jsonl`);
  await writeFile(target, text);
  const subdir = path.join(path.dirname(jsonl), oldId);
  if (await exists(subdir)) {
    for (const f of loc.files.filter((x) => x.startsWith(`${subdir}${path.sep}`))) {
      const dest = path.join(toDir, newId, path.relative(subdir, f));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, (await readFile(f, "utf8")).split(oldId).join(newId));
    }
  }
  return target;
}

/** Copies a Codex rollout to a new thread id: same directory, id rewritten in the file name and body. */
async function forkCodexTranscript(oldId: string, newId: string): Promise<string> {
  const loc = await locateCodex(oldId);
  if (!loc) throw new Error(`no local Codex transcript for thread ${oldId}`);
  let target = "";
  for (const f of loc.files) {
    const dest = path.join(path.dirname(f), path.basename(f).split(oldId).join(newId));
    await writeFile(dest, (await readFile(f, "utf8")).split(oldId).join(newId));
    target = target || dest;
  }
  return target;
}

export async function forkSession(ref: string, options: ForkOptions): Promise<ForkResult> {
  const record = await readSession(ref);
  if (!record) throw new Error(`no local session "${ref}"; see \`heyditto sessions\``);
  const oldHarnessId = record.harnessSessionId ?? record.id;
  const newId = randomUUID();
  const sourceCwd = record.worktree ?? record.cwd;

  let cwd = sourceCwd;
  let worktree: string | undefined;
  if (options.worktree !== undefined && options.worktree !== false) {
    const name = typeof options.worktree === "string" ? options.worktree : defaultWorktreeName(record.harness);
    if (!validWorktreeName(name)) throw new Error(`invalid worktree name "${name}"`);
    const root = repoRoot(record.cwd);
    if (!root) throw new Error(`${record.cwd} is not inside a git repository; forks into a worktree need one`);
    const wt = await ensureWorktree(root, name);
    cwd = wt.path;
    worktree = wt.path;
  }

  const transcript =
    record.harness === "claude"
      ? await forkClaudeTranscript(oldHarnessId, newId, sourceCwd, cwd)
      : await forkCodexTranscript(oldHarnessId, newId);

  const now = new Date().toISOString();
  const session: SessionRecord = {
    id: newId,
    harness: record.harness,
    endpointId: record.endpointId,
    endpointSlug: record.endpointSlug,
    harnessSessionId: newId,
    cwd: worktree ? record.cwd : cwd,
    worktree,
    model: record.model,
    createdAt: now,
    lastLaunchedAt: now,
    launches: 1,
  };
  await writeSession(session);
  return { from: record.id, session, transcript };
}

/** Lists transcripts present for a project dir; used by tests and diagnostics. */
export async function listClaudeTranscripts(cwd: string): Promise<string[]> {
  const dir = path.join(claudeProjectsDir(), cwdSlug(canonicalCwd(cwd)));
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}
