import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { claudeHome, claudeProjectDir, isUuid, readClaudeSessionTitle, type ClaudeSessionTitle } from "./claude-transcripts.js";

export interface ClaudeTitleWatcherOptions {
  /** The exact UUID passed to/resumed by this wrapper, never a cwd guess. */
  nativeSessionId: string;
  cwd: string;
  report: (title: ClaudeSessionTitle, signal: AbortSignal) => Promise<void>;
  intervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
}

async function fileStamp(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    return info.isFile() ? `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The current launch directory plus exact UUID is preferred. A moved native
 * transcript can be recovered by UUID only when there is exactly one match.
 */
async function locateTitleFile(nativeSessionId: string, cwd: string): Promise<string | undefined> {
  const expected = path.join(claudeProjectDir(cwd), `${nativeSessionId}.jsonl`);
  if (await fileStamp(expected)) return expected;
  const projects = path.join(claudeHome(), "projects");
  let dirs;
  try { dirs = await readdir(projects, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let found: string | undefined;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const file = path.join(projects, dir.name, `${nativeSessionId}.jsonl`);
    if (!(await fileStamp(file))) continue;
    if (found) return undefined; // Ambiguous mirror: do not choose by directory order.
    found = file;
  }
  return found;
}

/** Poll native metadata independently of hooks and inference. Reads and report
 * failures are isolated from Claude. Reports are serialized, coalesced and
 * deduplicated; stopping aborts a pending HTTP report and never waits on it.
 */
export function watchClaudeSessionTitle(options: ClaudeTitleWatcherOptions): { stop(): void } {
  if (!isUuid(options.nativeSessionId)) return { stop() {} };
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let file: string | undefined;
  let version: string | undefined;
  let candidate: ClaudeSessionTitle | undefined;
  let reported: string | undefined;
  let failures = 0;
  const abort = new AbortController();
  const interval = options.intervalMs ?? 2000;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => void poll(), delay);
    timer.unref?.();
  };
  const poll = async () => {
    try {
      if (stopped) return;
      file ??= await locateTitleFile(options.nativeSessionId, options.cwd);
      if (!file) { schedule(interval); return; }
      const transcript = await fileStamp(file);
      if (!transcript) { file = undefined; version = undefined; candidate = undefined; schedule(interval); return; }
      const sidecar = await fileStamp(path.join(path.dirname(file), options.nativeSessionId, "custom-title.json"));
      const nextVersion = `${file}:${transcript}:${sidecar ?? "none"}`;
      if (nextVersion !== version) {
        candidate = await readClaudeSessionTitle(file, options.nativeSessionId);
        version = nextVersion;
      }
      const key = candidate ? `${candidate.titleSource}\0${candidate.title}` : undefined;
      if (candidate && key !== reported && !stopped) {
        await options.report(candidate, AbortSignal.any([abort.signal, AbortSignal.timeout(options.requestTimeoutMs ?? 4000)]));
        if (!stopped) reported = key;
      }
      failures = 0;
      schedule(interval);
    } catch {
      // Files may be incomplete, the host announcement may not have arrived,
      // or the network may be down. Never let title sync interrupt the harness.
      failures += 1;
      schedule(Math.min(options.retryMaxMs ?? 60_000, (options.retryBaseMs ?? 2000) * 2 ** Math.min(failures - 1, 5)));
    }
  };
  void poll();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); abort.abort(); } };
}
