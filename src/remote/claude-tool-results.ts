import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_READ = 256 * 1024;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface ClaudeToolResultAnchor {
  file: string;
  projectsRoot: string;
  nativeSessionId: string;
  device: number;
  inode: number;
  offset: number;
  prefixHash: string;
  prefixBytes: number;
  lineBoundary: boolean;
}

/** Only a main-session UUID file immediately below the owned projects root. */
async function openTranscript(file: string, nativeSessionId: string, projectsRoot: string) {
  if (!path.isAbsolute(file) || !UUID.test(nativeSessionId) || path.basename(file) !== `${nativeSessionId}.jsonl`) return;
  const parent = path.dirname(path.resolve(file));
  const entry = await lstat(parent);
  if (!entry.isDirectory() || entry.isSymbolicLink()) return;
  const canonicalParent = await realpath(parent);
  if (path.dirname(canonicalParent) !== projectsRoot) return;
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) return;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    const after = await lstat(file);
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino || await realpath(parent) !== canonicalParent) {
      await handle.close(); return;
    }
    return { handle, info };
  } catch (error) { await handle.close(); throw error; }
}

/** Capture before permission execution; old results before this offset cannot resolve it. */
export async function captureClaudeToolResultAnchor(file: string, nativeSessionId: string, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")): Promise<ClaudeToolResultAnchor | undefined> {
  try {
    const projectsRoot = await realpath(path.join(configDir, "projects"));
    const opened = await openTranscript(file, nativeSessionId, projectsRoot);
    if (!opened) return;
    const { handle, info } = opened;
    try {
      const prefixBytes = Math.min(info.size, 64);
      const prefix = Buffer.alloc(prefixBytes);
      const read = await handle.read(prefix, 0, prefixBytes, info.size - prefixBytes);
      if (read.bytesRead !== prefixBytes) return;
      return { file, projectsRoot, nativeSessionId, device: info.dev, inode: info.ino, offset: info.size, prefixBytes, prefixHash: hash(prefix), lineBoundary: info.size === 0 || prefix.at(-1) === 10 };
    } finally { await handle.close(); }
  } catch { return; }
}

/** Bounded metadata only. No directory discovery or raw tool content is returned. */
export async function readClaudeToolResults(anchor: ClaudeToolResultAnchor, expectedIds: readonly string[]): Promise<Array<{ toolUseId: string; isError: boolean }>> {
  if (expectedIds.length > 16 || expectedIds.some(id => typeof id !== "string" || id.length === 0 || id.length > 256)) return [];
  try {
    const opened = await openTranscript(anchor.file, anchor.nativeSessionId, anchor.projectsRoot);
    if (!opened) return [];
    const { handle, info } = opened;
    try {
      if (info.dev !== anchor.device || info.ino !== anchor.inode || info.size < anchor.offset) return [];
      const prefix = Buffer.alloc(anchor.prefixBytes);
      if ((await handle.read(prefix, 0, prefix.length, anchor.offset - prefix.length)).bytesRead !== prefix.length || hash(prefix) !== anchor.prefixHash) return [];
      const start = Math.max(anchor.offset, info.size - MAX_READ);
      const bytes = Buffer.alloc(Math.min(MAX_READ, info.size - start));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      let text = bytes.subarray(0, bytesRead).toString("utf8");
      if (start > anchor.offset || !anchor.lineBoundary) {
        const boundary = text.indexOf("\n");
        if (boundary < 0) return [];
        text = text.slice(boundary + 1);
      }
      // Never accept an unfinished append; complete rows end in a newline.
      text = text.slice(0, text.lastIndexOf("\n") + 1);
      const ids = new Set(expectedIds);
      const found = new Map<string, boolean>();
      for (const line of text.split("\n")) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.type !== "user" || row.isSidechain === true || row.sessionId !== anchor.nativeSessionId || row.message?.role !== "user" || !Array.isArray(row.message.content)) continue;
        for (const block of row.message.content) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && ids.has(block.tool_use_id)) found.set(block.tool_use_id, block.is_error === true);
        }
      }
      return [...found].map(([toolUseId, isError]) => ({ toolUseId, isError }));
    } finally { await handle.close(); }
  } catch { return []; }
}
