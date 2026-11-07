import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { apiBaseURL } from "../config.js";

const names = ["authBackup", "configBackup", "catalog", "config", "auth", "state"] as const;
export type CodexFile = typeof names[number];
export interface CodexKeyRef { endpointId: string; keyId: string }
export interface CodexTransactionHooks { checkpoint?(name: string): Promise<void> | void }
export interface CodexFileSnapshot { data?: Buffer; mode?: number }
export interface CodexFileChange {
  name: CodexFile;
  before: CodexFileSnapshot;
  contents: string | Buffer;
  mode: number;
  validate?(contents: string): void;
}
interface Entry { name: CodexFile; before?: string; beforeMode?: number; after: string; mode: number }
interface RecoveryEnvironment { apiBase: string; targets: Record<CodexFile, string> }
interface Manifest {
  version: 2;
  id: string;
  environment: RecoveryEnvironment;
  phase: "preparing" | "prepared" | "committed";
  newKey?: CodexKeyRef;
  oldKey?: CodexKeyRef;
  newKeyRevoked?: boolean;
  entries: Entry[];
}

const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const absent = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
const validKeyRef = (v: CodexKeyRef | undefined): boolean => v === undefined || v !== null && typeof v === "object" &&
  typeof v.endpointId === "string" && typeof v.keyId === "string" && /^[\w-]{1,128}$/.test(v.endpointId) &&
  /^[\w-]{1,128}$/.test(v.keyId) && !/^ditto_(?:inf|mcp|sa)_/.test(v.keyId);

function canonicalAPIBase(): string {
  try {
    const url = new URL(apiBaseURL());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch { throw new Error("Ditto API base must be an HTTP(S) server without embedded credentials, query or fragment"); }
}

/** Resolve existing ancestors without creating a different profile directory. */
async function canonicalFile(file: string): Promise<string> {
  let cursor = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(cursor), ...missing); }
    catch (err) {
      if (!absent(err) || path.dirname(cursor) === cursor) throw err;
      missing.unshift(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
}

function validEnvironment(value: RecoveryEnvironment | undefined): value is RecoveryEnvironment {
  return value !== undefined && value !== null && typeof value === "object" && typeof value.apiBase === "string" &&
    value.targets !== null && typeof value.targets === "object" && Object.keys(value.targets).length === names.length &&
    names.every((name) => typeof value.targets[name] === "string" && path.isAbsolute(value.targets[name]) && !value.targets[name].includes("\0"));
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (err) {
    // Windows does not support fsync on directory handles. File contents are
    // still synced; power-loss directory durability is not promised there.
    if (process.platform !== "win32") throw err;
  }
}

async function durableDirectories(dir: string): Promise<void> {
  const absolute = path.resolve(dir);
  const firstCreated = await mkdir(absolute, { recursive: true, mode: 0o700 });
  if (firstCreated !== undefined) {
    // Persist newly-created ancestors too, including a new CODEX_HOME.
    const stop = path.dirname(firstCreated);
    for (let current = absolute; ; current = path.dirname(current)) {
      await syncDirectory(current);
      if (current === stop) break;
    }
  }
}

async function privateDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") throw new Error("Protected Codex setup recovery currently requires macOS or Linux; existing setup files were left alone");
  await durableDirectories(dir);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new Error("Codex recovery directory must be an owner-only directory; no setup files were replaced");
  }
}

export async function codexFileSnapshot(file: string): Promise<CodexFileSnapshot> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (err) { if (absent(err)) return {}; throw err; }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Codex setup requires regular local files");
    const data = await handle.readFile();
    const after = await handle.stat();
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.mode !== after.mode) {
      throw new Error("A Codex setup file changed while being read; retry after closing other editors");
    }
    return { data, mode: after.mode & 0o777 };
  } finally { await handle.close(); }
}

function matches(snapshot: CodexFileSnapshot, hash?: string, mode?: number): boolean {
  return hash === undefined ? snapshot.data === undefined : snapshot.data !== undefined && digest(snapshot.data) === hash && snapshot.mode === mode;
}

async function durableFile(file: string, data: Buffer, mode: number): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(data); await handle.chmod(mode); await handle.sync(); }
  finally { await handle.close(); }
}

async function protectedPayload(file: string): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error("Codex recovery files must remain private regular files; existing setup files were left alone");
  }
  const snapshot = await codexFileSnapshot(file);
  if (snapshot.data === undefined) throw new Error("Codex recovery file is missing; existing setup files were left alone");
  return snapshot.data;
}

/** All transaction payloads live in a private directory; the manifest has only hashes and key IDs. */
export class CodexAppTransaction {
  private manifest?: Manifest;
  private durableCommit = false;
  readonly directory: string;
  private readonly pending: string;
  private readonly targets: Record<CodexFile, string>;

  constructor(home: string, stateFile: string, private readonly revoke: (key: CodexKeyRef) => Promise<void>, private readonly hooks: CodexTransactionHooks = {}) {
    this.directory = path.join(home, ".ditto-codex-app-recovery");
    this.pending = path.join(this.directory, "pending");
    this.targets = {
      authBackup: path.join(home, "auth.json.pre-ditto"), configBackup: path.join(home, "config.toml.pre-ditto"),
      catalog: path.join(home, "ditto-models.json"), config: path.join(home, "config.toml"),
      auth: path.join(home, "auth.json"), state: stateFile,
    };
    if (new Set(Object.values(this.targets).map((p) => path.resolve(p))).size !== names.length) {
      throw new Error("Codex and Ditto setup files must have distinct paths");
    }
  }

  async snapshot(name: CodexFile): Promise<CodexFileSnapshot> { return codexFileSnapshot(this.targets[name]); }
  private checkpoint(name: string) { return this.hooks.checkpoint?.(name); }
  private payload(entry: Entry, suffix: "before" | "after") { return path.join(this.pending, `${entry.name}.${suffix}`); }

  private async environment(): Promise<RecoveryEnvironment> {
    const targets = await Promise.all(names.map(async (name) => [name, await canonicalFile(this.targets[name])] as const));
    return { apiBase: canonicalAPIBase(), targets: Object.fromEntries(targets) as Record<CodexFile, string> };
  }

  private async assertEnvironment(manifest: Manifest): Promise<void> {
    const current = await this.environment();
    if (manifest.environment.apiBase !== current.apiBase || names.some((name) => manifest.environment.targets[name] !== current.targets[name])) {
      throw new Error("Codex recovery environment does not match its recorded files, Ditto profile or API server; files and keys were left alone. Restore the original environment before retrying");
    }
  }

  private authConflict(): Error {
    return new Error("Codex login changed; recovery stopped without further file or key changes. Earlier cleanup may already have revoked a key. Review the protected recovery directory before continuing");
  }

  private async authMatches(entry: Entry, includeNew: boolean): Promise<boolean> {
    try {
      const current = await this.snapshot("auth");
      return matches(current, entry.before, entry.beforeMode) || includeNew && matches(current, entry.after, entry.mode);
    } catch { return false; }
  }

  private async save(manifest: Manifest): Promise<void> {
    await this.checkpoint(`before-journal:${manifest.phase}`);
    await this.assertEnvironment(manifest);
    const temporary = path.join(this.pending, `manifest.${randomUUID()}.tmp`);
    await durableFile(temporary, Buffer.from(`${JSON.stringify(manifest)}\n`), 0o600);
    await rename(temporary, path.join(this.pending, "manifest.json"));
    await syncDirectory(this.pending);
  }

  async begin(): Promise<void> {
    const environment = await this.environment();
    await privateDirectory(this.pending);
    this.manifest = { version: 2, id: randomUUID(), environment, phase: "preparing", entries: [] };
    await this.save(this.manifest);
    await syncDirectory(this.directory);
    await this.checkpoint("begin");
  }

  async trackKey(key: CodexKeyRef): Promise<void> {
    if (!this.manifest) throw new Error("Codex setup transaction was not started");
    if (!validKeyRef(key)) throw new Error("The router returned an invalid key reference; inspect endpoint keys before retrying");
    // Set in memory first so an ordinary journal-write failure still revokes it.
    this.manifest.newKey = key;
    await this.save(this.manifest);
    await this.checkpoint("key-recorded");
  }

  private async replace(entry: Entry, data: Buffer, mode: number): Promise<void> {
    await this.assertEnvironment(this.manifest!);
    await this.checkpoint(`before-replace:${entry.name}`);
    const target = this.targets[entry.name];
    await durableDirectories(path.dirname(target));
    const temporary = path.join(path.dirname(target), `.ditto-${this.manifest!.id}-${entry.name}.tmp`);
    await rm(temporary, { force: true });
    await durableFile(temporary, data, mode);
    await this.checkpoint(`replace-ready:${entry.name}`);
    await rename(temporary, target);
    await this.checkpoint(`renamed:${entry.name}`);
    await syncDirectory(path.dirname(target));
  }

  async commit(changes: CodexFileChange[], oldKey?: CodexKeyRef): Promise<void> {
    if (!this.manifest?.newKey || changes.at(-1)?.name !== "state" || new Set(changes.map((c) => c.name)).size !== changes.length) {
      throw new Error("Invalid Codex setup transaction");
    }
    if (!validKeyRef(oldKey)) throw new Error("Previous Codex key reference is invalid; existing files were left alone");
    const entries: Entry[] = [];
    for (const change of changes) {
      const data = Buffer.isBuffer(change.contents) ? change.contents : Buffer.from(change.contents);
      const entry: Entry = { name: change.name, before: change.before.data === undefined ? undefined : digest(change.before.data), beforeMode: change.before.mode, after: digest(data), mode: change.mode };
      if (change.before.data !== undefined) await durableFile(this.payload(entry, "before"), change.before.data, 0o600);
      await durableFile(this.payload(entry, "after"), data, 0o600);
      const staged = await readFile(this.payload(entry, "after"));
      if (digest(staged) !== entry.after) throw new Error("Codex staged file failed validation");
      change.validate?.(staged.toString("utf8"));
      entries.push(entry);
      await this.checkpoint(`stage:${entry.name}`);
    }
    const prepared: Manifest = { ...this.manifest, phase: "prepared", entries, oldKey };
    await this.save(prepared);
    this.manifest = prepared;
    await this.checkpoint("prepared");
    // No target is touched until every payload and its rollback image is durable.
    for (const entry of entries) {
      if (!matches(await this.snapshot(entry.name), entry.before, entry.beforeMode)) {
        throw new Error(`Codex setup stopped because ${entry.name} changed; your edit was kept`);
      }
      const staged = await protectedPayload(this.payload(entry, "after"));
      if (digest(staged) !== entry.after) throw new Error("Codex staged file changed; existing setup files were left alone");
      await this.replace(entry, staged, entry.mode);
      await this.checkpoint(`replace:${entry.name}`);
    }
    const committed: Manifest = { ...prepared, phase: "committed" };
    await this.save(committed);
    this.manifest = committed;
    this.durableCommit = true;
    await this.checkpoint("committed");
    await this.finishCommitted();
  }

  private async finishCommitted(): Promise<void> {
    const manifest = this.manifest!;
    await this.assertEnvironment(manifest);
    for (const entry of manifest.entries) {
      if (!matches(await this.snapshot(entry.name), entry.after, entry.mode)) {
        // The user may have switched back to the old login after the commit.
        // Stop cleanup: a prior attempt may already have revoked a key without
        // recording it, and an edit may select either credential.
        throw new Error("Committed Codex setup files changed; recovery stopped without further file or key changes. Earlier cleanup may already have revoked a key. Review the protected recovery directory before continuing");
      }
    }
    if (manifest.oldKey && (manifest.oldKey.keyId !== manifest.newKey?.keyId || manifest.oldKey.endpointId !== manifest.newKey.endpointId)) {
      await this.assertEnvironment(manifest);
      try { await this.revoke(manifest.oldKey); }
      catch { throw new Error("Codex setup is saved; previous key cleanup is pending. Rerun codex-app to retry safely"); }
      await this.checkpoint("old-key-revoked");
    }
    await this.clean();
  }

  private async clean(): Promise<void> {
    if (this.manifest) {
      await this.assertEnvironment(this.manifest);
      for (const entry of this.manifest.entries) {
        await rm(path.join(path.dirname(this.targets[entry.name]), `.ditto-${this.manifest.id}-${entry.name}.tmp`), { force: true });
      }
    }
    await rm(this.pending, { recursive: true, force: true });
    await syncDirectory(this.directory);
    this.manifest = undefined;
  }

  async abort(): Promise<void> {
    if (!this.manifest || this.durableCommit) return;
    await this.assertEnvironment(this.manifest);
    const auth = this.manifest.entries.find((entry) => entry.name === "auth");
    // Before touching any other file, rule out an edited login selecting the
    // new key. Malformed/unreadable auth cannot prove independence either.
    if (auth && !await this.authMatches(auth, true)) throw this.authConflict();
    const conflicts: string[] = [];
    const order = [...(auth ? [auth] : []), ...[...this.manifest.entries].reverse().filter((entry) => entry.name !== "auth")];
    for (const entry of order) {
      try {
        const current = await this.snapshot(entry.name);
        if (matches(current, entry.before, entry.beforeMode)) continue;
        if (!matches(current, entry.after, entry.mode)) { conflicts.push(entry.name); continue; }
        if (entry.before !== undefined) {
          const data = await protectedPayload(this.payload(entry, "before"));
          if (digest(data) !== entry.before) throw new Error("Codex recovery copy changed; no replacement was made");
          await this.replace(entry, data, entry.beforeMode!);
        } else {
          await rm(this.targets[entry.name]);
          await syncDirectory(path.dirname(this.targets[entry.name]));
        }
      } catch { conflicts.push(entry.name); if (entry.name === "auth") break; }
    }
    // A failed auth restore must never invalidate the login it left in place.
    if (auth && !await this.authMatches(auth, false)) throw this.authConflict();
    if (this.manifest.newKey && !this.manifest.newKeyRevoked) {
      await this.assertEnvironment(this.manifest);
      try { await this.revoke(this.manifest.newKey); }
      catch { throw new Error("Previous Codex files were preserved; new setup key cleanup is pending. Rerun codex-app to retry safely"); }
      await this.checkpoint("new-key-revoked");
      this.manifest.newKeyRevoked = true;
      await this.save(this.manifest);
    }
    if (conflicts.length) throw new Error("Codex recovery could not restore every file; edits were kept and only the new key was revoked. Review the protected recovery directory before continuing");
    await this.clean();
  }

  async recover(): Promise<void> {
    try { await lstat(this.pending); } catch (err) { if (absent(err)) return; throw err; }
    await privateDirectory(this.pending);
    let data: Buffer;
    try { data = await protectedPayload(path.join(this.pending, "manifest.json")); }
    catch (err) {
      if (!absent(err)) throw err;
      try { await lstat(this.pending); } catch (missing) { if (absent(missing)) return; throw missing; }
      throw new Error("Codex recovery record is incomplete; existing files were left alone. Review the protected recovery directory before continuing");
    }
    if (data.length > 64 * 1024) throw new Error("Invalid Codex recovery record; existing files were left alone");
    let parsed: Manifest;
    try { parsed = JSON.parse(data.toString("utf8")) as Manifest; } catch { throw new Error("Invalid Codex recovery record; existing files were left alone"); }
    if (parsed === null || typeof parsed !== "object" || parsed.version !== 2 || !validEnvironment(parsed.environment) || !/^[\da-f-]{36}$/.test(parsed.id) || !["preparing", "prepared", "committed"].includes(parsed.phase) || !validKeyRef(parsed.newKey) || !validKeyRef(parsed.oldKey) || parsed.phase !== "preparing" && !parsed.newKey || parsed.newKeyRevoked !== undefined && typeof parsed.newKeyRevoked !== "boolean" || !Array.isArray(parsed.entries) || parsed.entries.length > names.length || new Set(parsed.entries.map((e) => e?.name)).size !== parsed.entries.length || parsed.entries.some((e) => !e || !names.includes(e.name) || !/^[\da-f]{64}$/.test(e.after) || e.before !== undefined && !/^[\da-f]{64}$/.test(e.before) || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777 || e.before !== undefined && (!Number.isInteger(e.beforeMode) || e.beforeMode! < 0 || e.beforeMode! > 0o777))) {
      throw new Error("Invalid Codex recovery record; existing files were left alone");
    }
    if (parsed.phase === "preparing" ? parsed.entries.length !== 0 : parsed.entries.at(-1)?.name !== "state") {
      throw new Error("Invalid Codex recovery record; existing files were left alone");
    }
    await this.assertEnvironment(parsed);
    this.manifest = parsed;
    this.durableCommit = parsed.phase === "committed";
    if (this.durableCommit) await this.finishCommitted(); else await this.abort();
  }
}

export async function assertNoCodexRecovery(home: string): Promise<void> {
  try { await lstat(path.join(home, ".ditto-codex-app-recovery", "pending")); }
  catch (err) { if (absent(err)) return; throw err; }
  throw new Error("Codex setup recovery is pending; rerun without --dry-run to recover before previewing another setup");
}

export async function withCodexAppTransaction<T>(home: string, stateFile: string, revoke: (key: CodexKeyRef) => Promise<void>, body: (transaction: CodexAppTransaction) => Promise<T>, hooks?: CodexTransactionHooks): Promise<T> {
  const transaction = new CodexAppTransaction(home, stateFile, revoke, hooks);
  await privateDirectory(transaction.directory);
  const lockFile = path.join(transaction.directory, "lock.sqlite");
  // Never follow a replacement symlink when opening the lock database.
  try { await durableFile(lockFile, Buffer.alloc(0), 0o600); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  const info = await lstat(lockFile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid Codex setup lock");
  await chmod(lockFile, 0o600);
  // Node22 warns when this experimental module is imported. Unrelated commands
  // load codex-app's command definitions, but must not load its recovery DB.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(lockFile);
  try {
    try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    catch { throw new Error("Another codex-app operation is running; retry after it finishes"); }
    await transaction.recover();
    try { return await body(transaction); }
    catch (err) { await transaction.abort(); throw err; }
  } finally { try { db.exec("ROLLBACK"); } catch { /* acquisition may have failed */ } db.close(); }
}
