import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export const LOCAL_REVIEW_MAX_BYTES = 16 * 1024 * 1024;
export const LOCAL_REVIEW_MAX_FILES = 4096;
export const LOCAL_REVIEW_MAX_JSON_BYTES = 24 * 1024 * 1024;

export interface SnapshotFile { path: string; contentBase64: string; mode: "100644" | "100755" }
export interface ReviewSnapshot {
  version: 1;
  mode: "workspace" | "staged" | "base";
  baseRef?: string;
  baseSha?: string;
  digest: string;
  baseFiles: SnapshotFile[];
  headFiles: SnapshotFile[];
  changedPaths: string[];
  contextComplete: boolean;
  omittedContext: string[];
  skipped: { path: string; reason: string }[];
}
interface GitEntry { oid: string; mode: string }
export interface SnapshotOptions { staged?: boolean; base?: string; cwd?: string; signal?: AbortSignal }
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const order = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Git is only ever queried. In particular capture does not write the index,
 * create commits, stash changes, invoke hooks, or use external diff drivers. */
export async function reviewGit(cwd: string, args: string[], input?: string, signal?: AbortSignal): Promise<Buffer> {
  const filterConfig: string[] = [];
  if (args[0] === "diff") {
    // --no-ext-diff/--no-textconv do not disable clean/process filters. Read
    // names only (never credential/config values) and override each configured
    // driver for this invocation, so preview cannot run Git LFS or custom code.
    const keys = await reviewGit(cwd, ["config", "--null", "--name-only", "--list"], undefined, signal);
    const drivers = new Set<string>();
    // Config subsections are arbitrary bytes, unlike snapshot paths. Match
    // the ASCII filter framing before UTF-8 decoding, ignoring unrelated keys.
    // A matching driver's bytes must round-trip exactly for safe -c overrides.
    for (const key of keys.toString("latin1").split("\0")) {
      const driver = /^filter\.([\s\S]+)\.(?:clean|smudge|process|required)$/i.exec(key)?.[1];
      if (driver === undefined) continue;
      try { drivers.add(utf8.decode(Buffer.from(driver, "latin1"))); }
      catch { throw new Error("local review cannot safely disable a non-UTF-8 Git filter driver; fix that filter configuration before retrying"); }
    }
    for (const driver of drivers) for (const [setting, value] of [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]]) filterConfig.push("-c", `filter.${driver}.${setting}=${value}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.fsmonitor=false", ...filterConfig, ...args], {
      cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "pipe"], signal,
    });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    let size = 0, overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 40 * 1024 * 1024) { overflow = true; child.kill(); } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (errors.reduce((n, c) => n + c.length, 0) < 4000) errors.push(chunk); });
    child.on("error", reject);
    child.stdin.on("error", () => { /* process failure is reported by close */ });
    child.on("close", (code) => {
      if (overflow) return reject(new Error("git output exceeds the local review capture limit"));
      if (code !== 0) return reject(new Error(`git ${args[0]} failed: ${Buffer.concat(errors).toString("utf8").trim().slice(0, 500)}`));
      resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

function names(data: Buffer): string[] {
  try { return utf8.decode(data).split("\0").filter(Boolean); }
  catch { throw new Error("local review requires UTF-8 Git paths; unsupported names abort capture before upload rather than changing or omitting path identity"); }
}

function safePath(file: string): void {
  if (!file || Buffer.byteLength(file) > 1024 || /[\0\r\n\\:]/.test(file) || file.startsWith("/")) throw new Error("unsupported path in local review snapshot");
  if (file.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("unsafe path in local review snapshot");
}

async function entries(cwd: string, ref: string | undefined, index: boolean, signal?: AbortSignal): Promise<Map<string, GitEntry>> {
  if (!index && !ref) return new Map();
  const rows = names(await reviewGit(cwd, index ? ["ls-files", "--stage", "-z"] : ["ls-tree", "-rz", "--full-tree", ref!], undefined, signal));
  const out = new Map<string, GitEntry>();
  for (const row of rows) {
    const tab = row.indexOf("\t");
    if (tab < 0) throw new Error("invalid git tree entry");
    const fields = row.slice(0, tab).split(" "), file = row.slice(tab + 1);
    safePath(file);
    if (index && fields[2] !== "0") throw new Error("resolve unmerged index entries before reviewing a working diff");
    out.set(file, { mode: fields[0], oid: fields[index ? 1 : 2] });
  }
  return out;
}

async function objectSizes(cwd: string, ids: string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = (await reviewGit(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], ids.join("\n") + "\n", signal)).toString("ascii").trim().split("\n");
  for (const row of rows) {
    const [id, type, size] = row.split(" ");
    if (type !== "blob" || !/^\d+$/.test(size)) throw new Error("local review requires available Git blob objects; materialize missing objects manually before retrying (capture never fetches)");
    out.set(id, Number(size));
  }
  return out;
}

async function blobs(cwd: string, ids: string[], signal?: AbortSignal): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  if (!ids.length) return out;
  const data = await reviewGit(cwd, ["cat-file", "--batch"], ids.join("\n") + "\n", signal);
  let offset = 0;
  for (const expected of ids) {
    const end = data.indexOf(10, offset);
    if (end < 0) throw new Error("truncated Git object response");
    const [id, type, rawSize] = data.subarray(offset, end).toString("ascii").split(" ");
    const size = Number(rawSize), start = end + 1;
    if (id !== expected || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || start + size >= data.length || data[start + size] !== 10) throw new Error("invalid Git object response");
    out.set(id, data.subarray(start, start + size));
    offset = start + size + 1;
  }
  if (offset !== data.length) throw new Error("unexpected trailing Git object response");
  return out;
}

class SkipFile extends Error {}

/** Reject symlinks (including parent directories); do not follow them outside
 * the checkout. Verify the opened inode and stat again after reading. */
async function workingFile(root: string, file: string, read: boolean): Promise<{ size: number; mode: "100644" | "100755"; data?: Buffer } | undefined> {
  const absolute = path.join(root, file);
  let before;
  try {
    let parent = root;
    for (const part of file.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      const stat = await lstat(parent);
      if (stat.isFile()) return undefined; // A tracked directory was replaced by a file.
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SkipFile("symlink or non-directory parent");
    }
    before = await lstat(absolute);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  if (before.isDirectory()) return undefined; // A tracked file was replaced by a directory.
  if (!before.isFile() || before.isSymbolicLink()) throw new SkipFile("symlink or non-regular file");
  const mode = (before.mode & 0o111) ? "100755" : "100644";
  if (!read) return { size: before.size, mode };
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error(`file changed while capturing ${file}; retry the review`);
    if (opened.size > LOCAL_REVIEW_MAX_BYTES) throw new Error(`file is too large for local review: ${file}`);
    const data = await handle.readFile();
    const after = await handle.stat(), named = await lstat(absolute);
    const resolved = await realpath(absolute);
    if (!resolved.startsWith(root + path.sep) || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || data.length !== opened.size) throw new Error(`file changed while capturing ${file}; retry the review`);
    return { size: data.length, mode, data };
  } finally { await handle.close(); }
}

function textFile(data: Buffer): boolean {
  if (data.includes(0)) return false;
  try { utf8.decode(data); return true; } catch { return false; }
}

export function snapshotDigest(snapshot: Omit<ReviewSnapshot, "digest"> | ReviewSnapshot): string {
  const hash = createHash("sha256");
  hash.update(`ditto-review-local-v1\0${snapshot.mode}\0${snapshot.baseSha ?? ""}\0`);
  for (const [tree, files] of [["base", snapshot.baseFiles], ["head", snapshot.headFiles]] as const) {
    for (const file of [...files].sort((a, b) => order(a.path, b.path))) hash.update(`${tree}\0${file.path}\0${file.mode || "100644"}\0${file.contentBase64}\0`);
  }
  for (const file of [...snapshot.changedPaths].sort(order)) hash.update(`changed\0${file}\0`);
  for (const file of [...snapshot.omittedContext].sort(order)) hash.update(`omitted\0${file}\0`);
  hash.update(`context\0${snapshot.contextComplete}\0`);
  for (const skip of [...snapshot.skipped].sort((a, b) => order(a.path, b.path) || order(a.reason, b.reason))) hash.update(`skip\0${skip.path}\0${skip.reason}\0`);
  return hash.digest("hex");
}

export async function captureReviewSnapshot(options: SnapshotOptions = {}): Promise<{ root: string; snapshot: ReviewSnapshot; bytes: number }> {
  if (options.staged && options.base) throw new Error("--staged and --base cannot be used together");
  const root = await realpath(utf8.decode(await reviewGit(options.cwd ?? process.cwd(), ["rev-parse", "--show-toplevel"], undefined, options.signal)).replace(/\r?\n$/, ""));
  let head: string | undefined;
  try { head = (await reviewGit(root, ["rev-parse", "--verify", "HEAD"], undefined, options.signal)).toString("ascii").trim(); }
  catch {
    const branch = (await reviewGit(root, ["symbolic-ref", "-q", "HEAD"], undefined, options.signal)).toString("utf8").trim();
    if ((await reviewGit(root, ["for-each-ref", "--format=%(objectname)", branch], undefined, options.signal)).length) throw new Error("cannot resolve repository HEAD");
  }
  let baseSha = head;
  if (options.base) {
    if (!head) throw new Error("--base requires a committed HEAD");
    const ref = (await reviewGit(root, ["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`], undefined, options.signal)).toString("ascii").trim();
    baseSha = (await reviewGit(root, ["merge-base", head, ref], undefined, options.signal)).toString("ascii").trim();
  }
  const mode = options.staged ? "staged" : options.base ? "base" : "workspace";
  let honorFileMode = true;
  try { honorFileMode = (await reviewGit(root, ["config", "--bool", "core.fileMode"], undefined, options.signal)).toString("ascii").trim() !== "false"; } catch { /* Git's default is true. */ }
  const base = await entries(root, baseSha, false, options.signal), index = await entries(root, undefined, true, options.signal);
  const untracked = options.staged ? [] : names(await reviewGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], undefined, options.signal));
  const headPaths = new Set([...index.keys(), ...untracked]);
  const changes = baseSha ? names(await reviewGit(root, ["diff", ...(options.staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", baseSha, "--"], undefined, options.signal)) : [...headPaths];
  const changedPaths = [...new Set([...changes, ...untracked])].sort(order);
  if (changedPaths.length > LOCAL_REVIEW_MAX_FILES) throw new Error("changed paths exceed the local review limit of 4096; narrow the diff");
  const changed = new Set(changedPaths);
  const all = [...new Set([...base.keys(), ...headPaths])];
  all.forEach(safePath);
  const regular = (entry: GitEntry | undefined) => !!entry && (entry.mode === "100644" || entry.mode === "100755");
  const ids = [...new Set([...base.values(), ...(options.staged ? index.values() : [])].filter(regular).map(e => e.oid))];
  const sizes = await objectSizes(root, ids, options.signal);
  const metadata = new Map<string, { baseSize: number; headSize: number }>();
  const skipped: ReviewSnapshot["skipped"] = [];
  for (const file of all) {
    if (options.signal?.aborted) throw options.signal.reason;
    const b = base.get(file), h = index.get(file);
    if ((b && !regular(b)) || (headPaths.has(file) && h && !regular(h))) { skipped.push({ path: file, reason: "symlink or submodule" }); continue; }
    try {
      const working = !options.staged && changed.has(file) && headPaths.has(file) ? await workingFile(root, file, false) : undefined;
      // Unchanged surrounding context intentionally comes from the pinned
      // comparison tree. Avoid thousands of live reads (and attribute/filter
      // execution) for bytes Git did not select as changes.
      metadata.set(file, { baseSize: b ? sizes.get(b.oid)! : 0, headSize: options.staged ? (h ? sizes.get(h.oid)! : 0) : changed.has(file) ? (working?.size ?? 0) : b ? sizes.get(b.oid)! : 0 });
    } catch (error) { if (error instanceof SkipFile) skipped.push({ path: file, reason: error.message }); else throw error; }
  }
  const distance = (file: string): number => {
    const parts = file.split("/");
    return Math.min(...changedPaths.map(p => { const target = p.split("/"); let n = 0; while (n < parts.length - 1 && n < target.length - 1 && parts[n] === target[n]) n++; return parts.length + target.length - 2 * n; }), 10000);
  };
  const prioritized = all.filter(f => metadata.has(f)).sort((a, b) => Number(changed.has(b)) - Number(changed.has(a)) || distance(a) - distance(b) || order(a, b));
  let total = 0, baseCount = 0, headCount = 0;
  const selected: string[] = [], omittedContext: string[] = [];
  for (const file of prioritized) {
    const size = metadata.get(file)!;
    const nextBase = baseCount + Number(base.has(file)), nextHead = headCount + Number(headPaths.has(file));
    if (total + size.baseSize + size.headSize > LOCAL_REVIEW_MAX_BYTES || nextBase > LOCAL_REVIEW_MAX_FILES || nextHead > LOCAL_REVIEW_MAX_FILES) {
      if (changed.has(file)) throw new Error(`changed files exceed local review limits (16 MiB, 4096 files/tree); narrow the diff before reviewing: ${file}`);
      omittedContext.push(file); continue;
    }
    selected.push(file); total += size.baseSize + size.headSize; baseCount = nextBase; headCount = nextHead;
  }
  const selectedIds = [...new Set(selected.flatMap(file => [base.get(file), ...(options.staged ? [index.get(file)] : [])].filter((e): e is GitEntry => regular(e)).map(e => e.oid)))];
  const content = await blobs(root, selectedIds, options.signal);
  const baseFiles: SnapshotFile[] = [], headFiles: SnapshotFile[] = [];
  for (const file of selected) {
    const b = base.get(file), h = index.get(file);
    const before = b ? content.get(b.oid)! : undefined;
    let after: Buffer | undefined, headMode: SnapshotFile["mode"] = "100644";
    try {
      if (options.staged) { after = h ? content.get(h.oid) : undefined; headMode = h?.mode as SnapshotFile["mode"] ?? "100644"; }
      else if (!changed.has(file)) { after = before; headMode = b?.mode as SnapshotFile["mode"] ?? "100644"; }
      else if (headPaths.has(file)) { const value = await workingFile(root, file, true); after = value?.data; headMode = honorFileMode ? value?.mode ?? "100644" : h?.mode as SnapshotFile["mode"] ?? "100644"; }
    } catch (error) { if (error instanceof SkipFile) { skipped.push({ path: file, reason: error.message }); continue; } throw error; }
    if ((before && !textFile(before)) || (after && !textFile(after))) { skipped.push({ path: file, reason: "binary or non-UTF-8 file" }); continue; }
    if (before) baseFiles.push({ path: file, contentBase64: before.toString("base64"), mode: b!.mode as SnapshotFile["mode"] });
    if (after) headFiles.push({ path: file, contentBase64: after.toString("base64"), mode: headMode });
  }
  baseFiles.sort((a, b) => order(a.path, b.path)); headFiles.sort((a, b) => order(a.path, b.path)); omittedContext.sort(order);
  skipped.sort((a, b) => order(a.path, b.path) || order(a.reason, b.reason));
  // Git attributes can normalize worktree bytes (for example CRLF) or ignore
  // file mode. Scope identifies the actual sealed trees, not a lossy name list.
  const baseline = new Map(baseFiles.map(f => [f.path, f]));
  const current = new Map(headFiles.map(f => [f.path, f]));
  const capturedChanges = [...new Set([...baseline.keys(), ...current.keys()])].filter(file => {
    const b = baseline.get(file), h = current.get(file);
    return !b || !h || b.contentBase64 !== h.contentBase64 || b.mode !== h.mode;
  });
  const sealedChanges = [...new Set([...capturedChanges, ...skipped.filter(f => changed.has(f.path)).map(f => f.path)])].sort(order);
  if (sealedChanges.length > LOCAL_REVIEW_MAX_FILES || omittedContext.length > 20000 || skipped.length > 20000) throw new Error("local review manifest exceeds path limits; narrow the diff");
  const bytes = [...baseFiles, ...headFiles].reduce((n, f) => n + Buffer.byteLength(f.contentBase64, "base64"), 0);
  if (bytes > LOCAL_REVIEW_MAX_BYTES) throw new Error("files grew beyond the local review content limit during capture; retry with a smaller diff");
  const snapshot: ReviewSnapshot = { version: 1, mode, ...(options.base ? { baseRef: options.base } : {}), ...(baseSha ? { baseSha } : {}), digest: "", baseFiles, headFiles, changedPaths: sealedChanges, contextComplete: omittedContext.length === 0 && skipped.length === 0, omittedContext, skipped };
  snapshot.digest = snapshotDigest(snapshot);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > LOCAL_REVIEW_MAX_JSON_BYTES) throw new Error("local review snapshot exceeds the 24 MiB transport limit; narrow the diff");
  return { root, snapshot, bytes };
}
