import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import type { Attachment } from "./protocol.js";

/** Repo-relative directory attachments land in, one folder per turn. */
export const ATTACHMENTS_DIR = path.join(".tmp", "ditto", "attachments");

const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;

/** A file name that cannot escape the turn's folder or hide as a dotfile. */
export function safeAttachmentName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_");
  let cleaned = base.replace(/^\.+/, "").trim().replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned || "attachment";
}

const runFile = promisify(execFile);
async function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await runFile("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
    return { ok: true, out: r.stdout.trim() };
  } catch { return { ok: false, out: "" }; }
}

/**
 * Keeps `.tmp/` out of `git status` without touching the repository's
 * `.gitignore`: the exclude goes into `.git/info/exclude` (per-clone, never
 * committed). No-op outside a repository or when `.tmp` is already ignored.
 */
export async function ensureTmpExcluded(cwd: string): Promise<boolean> {
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok || !top.out) return false;
  const target = path.relative(top.out, path.join(cwd, ".tmp")) || ".tmp";
  if ((await git(["check-ignore", "-q", target], top.out)).ok) return false;
  const gitDir = await git(["rev-parse", "--git-common-dir"], top.out);
  const excludeFile = path.resolve(top.out, gitDir.ok && gitDir.out ? gitDir.out : ".git", "info", "exclude");
  let current = "";
  try {
    current = await readFile(excludeFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === ".tmp/" || l.trim() === ".tmp")) return false;
  await mkdir(path.dirname(excludeFile), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await appendFile(excludeFile, `${prefix}# Remote Control attachments downloaded by heyditto\n.tmp/\n`);
  return true;
}

export interface DownloadedAttachment {
  attachment: Attachment;
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the session cwd, forward slashes. */
  relPath: string;
}

async function fetchBytes(url: string, expectedSize: number): Promise<Buffer> {
  // Presigned attachment URLs must resolve with a single GET. Never follow a
  // redirect with a signed URL, or buffer an unbounded/incorrect response.
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("download failed: empty response body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > expectedSize || size > MAX_ATTACHMENT_BYTES) throw new Error("download exceeds attachment size");
      chunks.push(Buffer.from(next.value));
    }
    if (size !== expectedSize) throw new Error(`download size mismatch: expected ${expectedSize} bytes, got ${size}`);
    return Buffer.concat(chunks, size);
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

/** Downloads a turn's attachments into `<cwd>/.tmp/ditto/attachments/<turnId>/`, verifying size and sha256. */
export async function downloadAttachments(
  cwd: string,
  turnId: string,
  attachments: Attachment[] | undefined,
  fetchImpl: (url: string, size: number) => Promise<Buffer> = fetchBytes,
): Promise<DownloadedAttachment[]> {
  if (!attachments?.length) return [];
  if (!/^[A-Za-z0-9_:@-][A-Za-z0-9._:@-]{0,127}$/.test(turnId)) throw new Error("invalid turn id");
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_ATTACHMENT_BYTES) {
      throw new Error("invalid attachment size");
    }
    if (!/^[a-fA-F0-9]{64}$/.test(attachment.sha256)) throw new Error("invalid attachment sha256");
  }
  const turnDirectory = safeAttachmentName(turnId) !== turnId || /^turn-[a-f0-9]{64}$/i.test(turnId) ? `turn-${createHash("sha256").update(turnId).digest("hex")}` : turnId;
  let dir = cwd;
  for (const segment of [...ATTACHMENTS_DIR.split(path.sep), turnDirectory]) {
    dir = path.join(dir, segment);
    await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    const entry = await lstat(dir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("attachment directory is not a regular directory");
  }
  await ensureTmpExcluded(cwd);
  const used = new Set<string>();
  const result: DownloadedAttachment[] = [];
  for (const attachment of attachments) {
    let name = safeAttachmentName(attachment.name);
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    for (let suffix = 2; used.has(name.toLowerCase()); suffix++) {
      name = `${stem}-${suffix}${ext}`;
    }
    used.add(name.toLowerCase());
    const bytes = await fetchImpl(attachment.url, attachment.size);
    if (bytes.length !== attachment.size) throw new Error("download size mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== attachment.sha256.toLowerCase()) {
      throw new Error(`attachment ${attachment.name}: sha256 mismatch`);
    }
    const absPath = path.join(dir, name);
    try {
      await writeFile(absPath, bytes, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A reconnect may redeliver this turn. Reuse only the identical regular
      // file; never overwrite an existing file or follow a repository symlink.
      const entry = await lstat(absPath);
      if (!entry.isFile() || entry.isSymbolicLink()) throw err;
      const file = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== bytes.length) throw err;
        const existingHash = createHash("sha256");
        let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > bytes.length) throw err;
          existingHash.update(chunk);
        }
        if (size !== bytes.length || existingHash.digest("hex") !== digest) throw err;
      } finally { await file.close(); }
    }
    result.push({ attachment, absPath, relPath: path.relative(cwd, absPath).split(path.sep).join("/") });
  }
  return result;
}

/** The prompt handed to the harness: the user's text plus the attachment paths it can open. */
export function buildPrompt(text: string, downloaded: DownloadedAttachment[], options: { nativeFileReferences?: boolean } = {}): string {
  const body = text;
  if (downloaded.length === 0) return body;
  const list = downloaded.map((d) => `- ${options.nativeFileReferences ? `@${JSON.stringify(d.relPath)}` : d.relPath}`).join("\n");
  // Trailing newlines close Claude's @file completion before the submit key.
  // Without them the first Enter can select the path instead of submitting.
  return `${body}\n\nAttached files:\n${list}${options.nativeFileReferences ? "\n\n" : ""}`;
}
