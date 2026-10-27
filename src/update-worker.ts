import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import { satisfies } from "semver";
import { effectiveUpdatePolicy, newerVersion, privateDirectory, readUpdateJSON, recordCachedActivation, selectCachedRelease, stableVersion, supportsNode, updateLeaseSlot, updateTarget, writeUpdateJSON, type UpdateHealth, type UpdateLease } from "./self-update.js";

const NAME = "@heyditto/cli";
const REGISTRY = "https://registry.npmjs.org";
const LATEST = `${REGISTRY}/%40heyditto%2Fcli/latest`;
export const UPDATE_LIMITS = { timeoutMs: 60000, metadataBytes: 1024 * 1024, archiveBytes: 24 * 1024 * 1024, downloadBytes: 128 * 1024 * 1024, unpackedBytes: 512 * 1024 * 1024, archiveUnpackedBytes: 96 * 1024 * 1024, cacheBytes: 2 * 1024 * 1024 * 1024, files: 50000, packages: 256 };

interface LockedPackage { path: string; name: string; version: string; resolved: string; integrity: string; optional?: boolean; os?: string[]; cpu?: string[]; libc?: string[] }
interface UpdateLock { version: number; bootstrap: number; name: string; packageVersion: string; packages: LockedPackage[] }
interface PackageJSON { name: string; version: string; engines?: { node?: string }; os?: string[]; cpu?: string[]; libc?: string[]; bin?: Record<string, string> | string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; bundledDependencies?: unknown; bundleDependencies?: unknown }
interface ArchiveFile { data: Buffer; mode: number }
export interface WorkerOptions {
  cache: string;
  currentVersion: string;
  /** Dependency injection is available to tests, never a CLI/env registry override. */
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
  libc?: string;
  nodeVersion?: string;
  now?: () => number;
  manual?: boolean;
  limits?: Partial<typeof UPDATE_LIMITS>;
}

export function registryURL(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid registry URL");
  const url = new URL(value);
  if (url.origin !== REGISTRY || url.username || url.password || url.hash || url.search || !url.pathname.startsWith("/")) throw new Error("updates require the public npm registry without redirects");
  return url.href;
}

function verifyIntegrity(bytes: Buffer, integrity: unknown): void {
  if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("missing SHA512 archive integrity");
  const expected = Buffer.from(integrity.slice(7), "base64"), actual = createHash("sha512").update(bytes).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("archive integrity mismatch");
}

function safeRelative(value: string): string {
  if (!value || value.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(value) || value.split("/").some(p => !p || p === "." || p === "..")) throw new Error("unsafe update archive path");
  return value;
}
function dependencyPath(value: string): string {
  safeRelative(value);
  const parts = value.split("/");
  for (let i = 0; i < parts.length;) {
    if (parts[i++] !== "node_modules") throw new Error("invalid locked dependency path");
    const name = parts[i++];
    if (!name || name === ".bin") throw new Error("invalid locked dependency name");
    if (name.startsWith("@") && !parts[i++]) throw new Error("invalid locked scope");
  }
  return value;
}

/** Parse into bounded memory BEFORE making any filesystem writes. No links or
 * special files are extracted, and mode bits are reduced to 0644/0755. */
export async function unpackArchive(bytes: Buffer, limits = UPDATE_LIMITS): Promise<Map<string, ArchiveFile>> {
  let raw: Buffer;
  try { raw = gunzipSync(bytes, { maxOutputLength: limits.archiveUnpackedBytes }); }
  catch { throw new Error("invalid or oversized compressed update archive"); }
  const files = new Map<string, ArchiveFile>(), names = new Set<string>();
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const parser = new Parser({ strict: true, maxMetaEntrySize: 65536, onReadEntry(entry) {
      try {
        const full = entry.path.replace(/\/$/, "");
        if (full === "package" && entry.type === "Directory") { entry.resume(); return; }
        if (!full.startsWith("package/")) throw new Error("archive is not an npm package");
        const relative = safeRelative(full.slice(8));
        if (entry.type === "Directory") { entry.resume(); return; }
        if (!["File", "OldFile"].includes(entry.type) || entry.linkpath) throw new Error("update archives cannot contain links or special files");
        const key = relative.normalize("NFC").toLowerCase();
        if (names.has(key)) throw new Error("duplicate update archive path");
        names.add(key);
        total += entry.size;
        if (names.size > limits.files || total > limits.archiveUnpackedBytes) throw new Error("update archive exceeds file limits");
        const chunks: Buffer[] = []; let size = 0;
        entry.on("data", (chunk: Buffer) => { size += chunk.length; chunks.push(chunk); });
        entry.on("end", () => {
          if (size !== entry.size) return parser.abort(new Error("truncated update archive entry"));
          files.set(relative, { data: Buffer.concat(chunks), mode: (entry.mode ?? 0) & 0o111 ? 0o755 : 0o644 });
        });
      } catch (error) { parser.abort(error instanceof Error ? error : new Error("invalid update archive")); }
    } });
    parser.once("error", reject); parser.once("end", resolve);
    parser.end(raw);
  });
  if (!files.has("package.json")) throw new Error("update archive has no package metadata");
  for (const name of files.keys()) {
    const parts = name.split("/");
    for (let n = 1; n < parts.length; n++) if (files.has(parts.slice(0, n).join("/"))) throw new Error("update archive file/directory collision");
  }
  return files;
}

function parseJSON<T>(files: Map<string, ArchiveFile>, name: string): T {
  const file = files.get(name);
  if (!file || file.data.length > 1024 * 1024) throw new Error("missing bounded update metadata");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.data)) as T;
}
function platformMatches(values: string[] | undefined, current: string): boolean {
  if (!values?.length) return true;
  if (values.includes(`!${current}`)) return false;
  return !values.some(v => !v.startsWith("!")) || values.includes(current) || values.includes("any");
}
async function writeArchive(directory: string, files: Map<string, ArchiveFile>, signal: AbortSignal): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [relative, file] of files) {
    if (signal.aborted) throw new Error("update timed out");
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { flag: "wx", mode: file.mode });
  }
}
async function cacheSize(directory: string, cap: number, signal: AbortSignal): Promise<number> {
  let size = 0, count = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (signal.aborted) throw new Error("update timed out");
      if (++count > 250000) throw new Error("updater cache requires manual cleanup");
      const file = path.join(folder, entry.name), stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error("updater cache contains a symlink");
      if (stat.isDirectory()) await walk(file); else if (stat.isFile()) size += stat.size; else throw new Error("updater cache contains a special file");
      if (size > cap) throw new Error("updater cache requires manual cleanup");
    }
  };
  await walk(directory); return size;
}

function validateDependencies(root: string, packages: Map<string, PackageJSON>, all: Set<string>, selected: Set<string>): void {
  for (const [relative, pkg] of packages) {
    if ([pkg.bundledDependencies, pkg.bundleDependencies].some(value => value === true || Array.isArray(value) && value.length > 0)) throw new Error("bundled dependencies need an updated manifest format");
    const optional = { ...Object.fromEntries(Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => pkg.peerDependenciesMeta?.[name]?.optional)), ...pkg.optionalDependencies };
    for (const [name, range] of Object.entries({ ...pkg.peerDependencies, ...pkg.dependencies, ...optional })) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error("invalid dependency name");
      let current = path.join(root, relative), found: string | undefined, incompatible = false;
      for (;;) {
        if (path.basename(current) !== "node_modules") {
          const candidate = path.relative(root, path.join(current, "node_modules", name)).split(path.sep).join("/");
          if (selected.has(candidate)) { found = candidate; break; }
          if (all.has(candidate)) incompatible = true;
        }
        if (current === root) break;
        const parent = path.dirname(current);
        if (!parent.startsWith(root)) break;
        current = parent;
      }
      if (!found) {
        if (name in optional && (incompatible || pkg.peerDependenciesMeta?.[name]?.optional)) continue;
        throw new Error("locked update is missing a compatible dependency");
      }
      if (!satisfies(packages.get(found)!.version, range, { includePrerelease: true })) throw new Error("locked dependency version does not satisfy its consumer");
    }
  }
}

export async function runUpdate(options: WorkerOptions): Promise<void> {
  const limits = { ...UPDATE_LIMITS, ...options.limits }, cache = path.resolve(options.cache);
  const fetcher = options.fetch ?? fetch, platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const target = updateTarget(platform, arch, options.libc), libc = target.split("-")[2];
  if (path.basename(path.dirname(cache)) === "updates" && /^[a-z0-9]+-[a-z0-9]+-(?:glibc|musl|none)$/.test(path.basename(cache)) && path.basename(cache) !== target) throw new Error("updater process target differs from its cache namespace");
  await privateDirectory(cache);
  const clock = options.now ?? Date.now, started = performance.now(), now = clock(), nonce = randomUUID();
  const window = updateLeaseSlot(now).slice(0, -5), slot = options.manual ? `${window}-manual-${nonce}.json` : `${window}.json`;
  const leases = path.join(cache, "leases"); await privateDirectory(leases);
  if ((await readdir(leases)).length >= 4096) {
    await writeUpdateJSON(path.join(cache, "health.json"), { lastAttemptAt: now, status: "paused", detail: "update lease metadata requires manual cleanup" });
    return;
  }
  const lease = path.join(leases, slot);
  const pending = path.join(leases, `.pending-${nonce}`);
  const owner: UpdateLease = { pid: process.pid, nonce, createdAt: now, deadlineAt: now + limits.timeoutMs };
  // Publish complete owner data atomically. A crash has no ownerless-lock
  // window, and a later time slot never steals or deletes an earlier lease.
  await writeFile(pending, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  try { await link(pending, lease); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  finally { await rm(pending, { force: true }); }
  const identity = await lstat(lease);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("update timed out")), limits.timeoutMs);
  let stage: string | undefined, health: UpdateHealth = { lastAttemptAt: now, status: "checking", lease: slot };
  const check = () => { if (controller.signal.aborted || clock() >= owner.deadlineAt || performance.now() - started >= limits.timeoutMs) throw new Error("update timed out"); };
  const assertLease = async () => {
    check();
    const current = await lstat(lease), data = await readUpdateJSON<UpdateLease>(lease, 4096);
    if (!current.isFile() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev || data?.nonce !== nonce) throw new Error("update worker lost its lease");
  };
  const assertPublishable = async () => {
    await assertLease();
    const policy = await effectiveUpdatePolicy(cache, target);
    if (policy.pinnedVersion || policy.enabled === false && !options.manual) throw new Error("update policy changed before publication");
  };
  try {
    await assertLease();
    if (window !== updateLeaseSlot(clock()).slice(0, -5)) { health.status = "lease window passed"; return; }
    for (const name of await readdir(leases)) {
      if (name === slot || !/^\d+(?:-manual-[0-9a-f-]{36})?\.json$/.test(name) || Math.abs(Number(name.split(/[.-]/)[0]) - Number(window)) > 1) continue;
      const other = await readUpdateJSON<UpdateLease>(path.join(leases, name), 4096);
      if (!other || !Number.isSafeInteger(other.pid) || other.pid <= 0 || other.deadlineAt <= now) continue;
      let alive = true;
      try { process.kill(other.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive) { health.status = "adjacent worker active"; return; }
    }
    const policy = await effectiveUpdatePolicy(cache, target);
    if (policy.enabled === false && !options.manual || policy.pinnedVersion) { health.status = policy.pinnedVersion ? "pinned" : "disabled"; return; }
    await writeUpdateJSON(path.join(cache, "health.json"), health);
    let downloaded = 0;
    const download = async (url: unknown, cap: number): Promise<Buffer> => {
      await assertLease();
      const response = await fetcher(registryURL(url), { redirect: "error", signal: controller.signal, headers: { accept: "application/json, application/octet-stream" } });
      if (!response.ok || !response.body) throw new Error(`public registry request failed (${response.status})`);
      if (Number(response.headers.get("content-length")) > cap) throw new Error("update download exceeds size limit");
      const chunks: Buffer[] = []; let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          check(); size += value.length; downloaded += value.length;
          if (size > cap || downloaded > limits.downloadBytes) throw new Error("update downloads exceed size limit");
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return Buffer.concat(chunks);
    };
    const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await download(LATEST, limits.metadataBytes))) as PackageJSON & { dist?: { tarball?: string; integrity?: string }; repository?: { url?: string } };
    if (metadata.name !== NAME || !stableVersion(metadata.version) || metadata.repository?.url !== "git+https://github.com/ditto-assistant/ditto-cli.git") throw new Error("unexpected public CLI package identity");
    if (!newerVersion(metadata.version, options.currentVersion)) { health.status = "current"; return; }
    if (!supportsNode(metadata.engines?.node, options.nodeVersion)) throw new Error("new CLI version does not support this Node runtime");
    const completed = await selectCachedRelease(cache, options.currentVersion, { pinnedVersion: metadata.version }, options.nodeVersion, target).catch(() => undefined);
    if (completed) {
      const receipt = await readUpdateJSON<{ rootIntegrity?: string }>(path.join(path.dirname(completed.root), "verified.json"), 4096);
      if (receipt?.rootIntegrity !== metadata.dist?.integrity) throw new Error("immutable version integrity changed at the registry");
      await writeUpdateJSON(path.join(cache, "current.json"), { version: metadata.version, installedAt: new Date().toISOString(), target }, assertPublishable);
      if (options.manual) await recordCachedActivation(cache, metadata.version, target);
      health = { ...health, status: options.manual ? "activated verified cached version" : "staged verified cached version", lastSuccessAt: Date.now() };
      return;
    }
    const rootArchive = await download(metadata.dist?.tarball, limits.archiveBytes);
    verifyIntegrity(rootArchive, metadata.dist?.integrity);
    const rootFiles = await unpackArchive(rootArchive, limits);
    const pkg = parseJSON<PackageJSON>(rootFiles, "package.json"), lock = parseJSON<UpdateLock>(rootFiles, "dist/update-lock.json");
    if (pkg.name !== NAME || pkg.version !== metadata.version || typeof pkg.bin !== "object" || pkg.bin.heyditto !== "dist/entry.js" || !supportsNode(pkg.engines?.node, options.nodeVersion) || lock.version !== 1 || lock.bootstrap !== 1 || lock.name !== NAME || lock.packageVersion !== pkg.version || !Array.isArray(lock.packages) || lock.packages.length > limits.packages) throw new Error("CLI archive and dependency manifest do not match the published candidate");
    for (const name of ["dist/entry.js", "dist/cli.js", "dist/update-worker.js"]) if (!rootFiles.has(name)) throw new Error("CLI archive is missing its safe launcher");
    const all = new Set<string>(), selected = new Set<string>();
    for (const item of lock.packages) {
      dependencyPath(item.path); registryURL(item.resolved);
      const parts = item.path.split("/");
      if (all.has(item.path) || item.name !== parts.slice(parts.lastIndexOf("node_modules") + 1).join("/")) throw new Error("invalid or duplicate locked package identity");
      all.add(item.path);
      const compatible = platformMatches(item.os, platform) && platformMatches(item.cpu, arch) && platformMatches(item.libc, libc);
      if (compatible) selected.add(item.path); else if (!item.optional) throw new Error("required dependency does not support this platform");
    }
    const existingBytes = await cacheSize(cache, limits.cacheBytes, controller.signal);
    stage = path.join(cache, `stage-${randomUUID()}`);
    await mkdir(stage, { mode: 0o700 });
    const packageRoot = path.join(stage, "package"), packages = new Map<string, PackageJSON>([["", pkg]]);
    let unpacked = [...rootFiles.values()].reduce((n, f) => n + f.data.length, 0), fileCount = rootFiles.size;
    if (unpacked > limits.unpackedBytes || existingBytes + unpacked > limits.cacheBytes || fileCount > limits.files) throw new Error("update exceeds cache capacity; manual cleanup is needed");
    await writeArchive(packageRoot, rootFiles, controller.signal);
    for (const item of lock.packages) {
      check(); if (!selected.has(item.path)) continue;
      const archive = await download(item.resolved, limits.archiveBytes); verifyIntegrity(archive, item.integrity);
      const files = await unpackArchive(archive, limits), dependency = parseJSON<PackageJSON>(files, "package.json");
      if (dependency.name !== item.name || dependency.version !== item.version) throw new Error("dependency archive identity differs from the lock");
      if (!platformMatches(dependency.os, platform) || !platformMatches(dependency.cpu, arch) || !platformMatches(dependency.libc, libc)) throw new Error("dependency archive does not support this platform");
      if (dependency.engines?.node && !supportsNode(dependency.engines.node, options.nodeVersion)) throw new Error("dependency does not support this Node runtime");
      unpacked += [...files.values()].reduce((n, f) => n + f.data.length, 0); fileCount += files.size;
      if (unpacked > limits.unpackedBytes || existingBytes + unpacked > limits.cacheBytes || fileCount > limits.files) throw new Error("update exceeds cache capacity; manual cleanup is needed");
      packages.set(item.path, dependency); await writeArchive(path.join(packageRoot, item.path), files, controller.signal);
    }
    validateDependencies(packageRoot, packages, all, selected);
    const receipt = { version: pkg.version, rootIntegrity: metadata.dist?.integrity, target, nodeRanges: [...new Set([...packages.values()].map(value => value.engines?.node).filter((range): range is string => typeof range === "string"))] };
    if (Buffer.byteLength(JSON.stringify(receipt)) > 65536) throw new Error("update compatibility receipt exceeds its bound");
    await writeUpdateJSON(path.join(stage, "verified.json"), receipt);
    // Supported PTY platform packages are required by their consumer graph;
    // binaries/helper executables keep only ordinary execute bits, no scripts.
    check();
    const latestPolicy = await effectiveUpdatePolicy(cache, target);
    if (latestPolicy.enabled === false && !options.manual || latestPolicy.pinnedVersion) { health.status = "disabled during download"; return; }
    await privateDirectory(path.join(cache, "versions"));
    const destination = path.join(cache, "versions", pkg.version);
    try { await lstat(destination); throw new Error("candidate version already exists; retaining the current version"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(stage, destination); stage = undefined;
    await writeUpdateJSON(path.join(cache, "current.json"), { version: pkg.version, installedAt: new Date().toISOString(), target }, assertPublishable);
    if (options.manual) await recordCachedActivation(cache, pkg.version, target);
    health = { ...health, status: options.manual ? "activated for next invocation" : "staged for next enabled invocation", lastSuccessAt: Date.now() };
  } catch (error) {
    health.status = "failed";
    health.detail = (error instanceof Error ? error.message : "update failed").slice(0, 180);
  } finally {
    clearTimeout(timer);
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    await writeUpdateJSON(path.join(cache, "health.json"), health).catch(() => undefined);
    // Immutable lease slots remain as bounded metadata. No active bundle or
    // other worker's lease is ever removed, including after SIGKILL recovery.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cache, currentVersion, manual] = process.argv.slice(2);
  if (cache && path.isAbsolute(cache) && stableVersion(currentVersion)) {
    // The worker is a separate process even for an explicit check. A hard stop
    // also bounds filesystem stalls; atomic publication keeps partial stages
    // from becoming the selected version. No caller command is restarted.
    const hardDeadline = setTimeout(() => process.exit(1), UPDATE_LIMITS.timeoutMs + 5000);
    hardDeadline.unref();
    void runUpdate({ cache, currentVersion, manual: manual === "--manual" }).finally(() => clearTimeout(hardDeadline)).catch(() => { process.exitCode = 1; });
  }
}
