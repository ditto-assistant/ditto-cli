import { spawnSync } from "node:child_process";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { binaryAvailable } from "./git.js";
import { type Compression, type HarnessKind, cwdSlug } from "./types.js";

/** Where a harness stores the session's transcript, relative to $HOME. */
export interface HarnessLocation {
  kind: HarnessKind;
  sessionId: string;
  /** Files to capture, absolute paths. */
  files: string[];
  /** Absolute directory the session is keyed under (Claude project dir). */
  keyDir?: string;
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/** Locates Claude Code transcript files for a session recorded under `cwd`. */
export async function locateClaude(sessionId: string, cwd: string): Promise<HarnessLocation | null> {
  const projectDir = path.join(claudeHome(), "projects", cwdSlug(cwd));
  const jsonl = path.join(projectDir, `${sessionId}.jsonl`);
  if (!(await exists(jsonl))) return null;
  const files = [jsonl];
  const subdir = path.join(projectDir, sessionId);
  if (await exists(subdir)) {
    for (const f of await walkFiles(subdir)) files.push(f);
  }
  return { kind: "claude-code", sessionId, files, keyDir: projectDir };
}

/** Locates a Codex rollout transcript by thread id. */
export async function locateCodex(threadId: string): Promise<HarnessLocation | null> {
  const sessions = path.join(codexHome(), "sessions");
  if (!(await exists(sessions))) return null;
  const matches = (await walkFiles(sessions)).filter(
    (f) => f.endsWith(".jsonl") && path.basename(f).includes(threadId),
  );
  if (matches.length === 0) return null;
  return { kind: "codex", sessionId: threadId, files: matches };
}

export async function locateHarness(
  kind: HarnessKind,
  sessionId: string | undefined,
  cwd: string,
): Promise<HarnessLocation | null> {
  if (!sessionId) return null;
  if (kind === "claude-code") return locateClaude(sessionId, cwd);
  if (kind === "codex") return locateCodex(sessionId);
  return null;
}

export function pickCompression(): Compression {
  return binaryAvailable("zstd") ? "zstd" : "gzip";
}

/** Tars a harness's transcript files (as $HOME-relative paths) into `outFile`. */
export async function captureHarness(
  loc: HarnessLocation,
  outFile: string,
  compression: Compression = pickCompression(),
): Promise<{ file: string; compression: Compression } | null> {
  const home = os.homedir();
  const rel = loc.files.map((f) => path.relative(home, f)).filter((r) => !r.startsWith(".."));
  if (rel.length === 0) return null;
  await mkdir(path.dirname(outFile), { recursive: true });
  const flag = compression === "zstd" ? "--zstd" : "--gzip";
  const res = spawnSync("tar", ["-c", flag, "-f", outFile, "-C", home, "--null", "-T", "-"], {
    input: `${rel.join("\0")}\0`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`tar failed for harness state: ${res.stderr?.toString().trim()}`);
  return { file: outFile, compression };
}

/**
 * Restores a Claude transcript under a (possibly different) target cwd: extract
 * to a temp home, then rewrite the project-dir slug and any embedded absolute
 * cwd inside the jsonl so `claude --resume <id>` finds the session at the new
 * path. Returns the restored session id.
 */
export async function restoreClaudeTranscript(
  tarFile: string,
  compression: Compression,
  sessionId: string,
  originalCwd: string,
  targetCwd: string,
): Promise<void> {
  const home = os.homedir();
  const flag = compression === "zstd" ? "--zstd" : "--gzip";
  const res = spawnSync("tar", ["-x", flag, "-f", tarFile, "-C", home], { maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`tar extract failed: ${res.stderr?.toString().trim()}`);
  if (path.resolve(originalCwd) === path.resolve(targetCwd)) return;
  const fromDir = path.join(claudeHome(), "projects", cwdSlug(originalCwd));
  const toDir = path.join(claudeHome(), "projects", cwdSlug(targetCwd));
  await mkdir(toDir, { recursive: true });
  const fromJsonl = path.join(fromDir, `${sessionId}.jsonl`);
  if (await exists(fromJsonl)) {
    const rewritten = (await readFile(fromJsonl, "utf8")).split(originalCwd).join(targetCwd);
    await writeFile(path.join(toDir, `${sessionId}.jsonl`), rewritten);
  }
  const fromSub = path.join(fromDir, sessionId);
  if (await exists(fromSub)) {
    for (const f of await walkFiles(fromSub)) {
      const relFromSub = path.relative(fromSub, f);
      const dest = path.join(toDir, sessionId, relFromSub);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, await readFile(f));
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export async function fileSize(p: string): Promise<number> {
  return (await stat(p)).size;
}
