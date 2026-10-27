import { spawn } from "node:child_process";
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { satisfies } from "semver";
import type { Command, Option } from "commander";
import { configDir, packageName, packageVersion } from "./config.js";

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export interface UpdatePolicy { enabled?: boolean; pinnedVersion?: string; pins?: Record<string, string> }
export interface UpdateHealth { lastAttemptAt?: number; lastSuccessAt?: number; status?: string; detail?: string; lease?: string }
export interface UpdatePointer { version: string; installedAt: string; target?: string }
export interface UpdateLease { pid: number; nonce: string; createdAt: number; deadlineAt: number }
export const updateLeaseSlot = (now = Date.now()): string => `${Math.floor(now / UPDATE_INTERVAL_MS)}.json`;
export function updateTarget(platform: string = process.platform, arch: string = process.arch, libc?: string): string {
  const family = platform === "linux" ? libc ?? ((process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? "glibc" : "musl") : "none";
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch) || !["none", "glibc", "musl"].includes(family)) throw new Error("unsupported update target");
  return `${platform}-${arch}-${family}`;
}
export const updateRoot = (target = updateTarget()): string => {
  if (!/^[a-z0-9]+-[a-z0-9]+-(none|glibc|musl)$/.test(target)) throw new Error("invalid update target");
  return path.resolve(configDir(), "updates", target);
};
export function updatePreferenceFiles(cache: string, target = updateTarget()): { enabled: string; pin: string; legacy: string } {
  const base = path.basename(cache) === target && path.basename(path.dirname(cache)) === "updates" ? path.dirname(cache) : cache;
  return { enabled: path.join(base, "enabled.json"), pin: path.join(base, "pins", `${target}.json`), legacy: path.join(base, "settings.json") };
}
export async function effectiveUpdatePolicy(cache: string, target = updateTarget()): Promise<UpdatePolicy> {
  const files = updatePreferenceFiles(cache, target);
  let enabled = await readUpdateJSON<{ enabled: boolean }>(files.enabled, 4096);
  let pin = await readUpdateJSON<{ version: string | null }>(files.pin, 4096);
  const legacy = enabled === undefined || pin === undefined ? await readUpdateJSON<UpdatePolicy>(files.legacy, 4096) ?? {} : {};
  // A current control may appear while the legacy fallback is being read.
  enabled ??= await readUpdateJSON<{ enabled: boolean }>(files.enabled, 4096);
  pin ??= await readUpdateJSON<{ version: string | null }>(files.pin, 4096);
  if (enabled !== undefined && typeof enabled?.enabled !== "boolean") throw new Error("invalid updater enable preference");
  if (pin !== undefined && pin?.version !== null && !stableVersion(pin?.version)) throw new Error("invalid updater pin preference");
  return { enabled: enabled?.enabled ?? legacy.enabled, pinnedVersion: pin !== undefined ? pin.version ?? undefined : legacy.pins?.[target] ?? legacy.pinnedVersion };
}
export const stableVersion = (value: unknown): value is string => typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value);
export function newerVersion(a: string, b: string): boolean {
  if (!stableVersion(a) || !stableVersion(b)) return false;
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}
export function supportsNode(range: unknown, version = process.versions.node): boolean {
  return typeof range === "string" && range.length <= 256 && stableVersion(version) && satisfies(version, range);
}

/** No auth file, npmrc, repository, shell, or credential environment is read. */
export function cleanUpdateEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) if (env[key]) clean[key] = env[key];
  return clean;
}

export async function privateDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("updater paths cannot traverse symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== absolute || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) throw new Error("updater directory is not privately owned");
}
export async function readUpdateJSON<T>(file: string, max = 65536): Promise<T | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("invalid updater metadata");
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function writeUpdateJSON(file: string, data: unknown, beforePublish?: () => Promise<void>): Promise<void> {
  await privateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data) + "\n", { flag: "wx", mode: 0o600 });
    await beforePublish?.();
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export function updateEligibility(root: string, env: NodeJS.ProcessEnv = process.env, args: string[] = process.argv.slice(2)): string | undefined {
  const normalized = root.replaceAll("\\", "/");
  if (env.DITTO_CLI_PINNED === "1") return "explicit installed-version pin";
  if (env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILD_NUMBER) return "CI execution";
  if (env.npm_lifecycle_event || env.npm_command === "exec" || env.npm_config_package || /\/(?:_npx|\.pnpm|\.yarn)\//.test(normalized)) return "ephemeral or package-script execution";
  if (/\/(?:Cellar|Caskroom|nix\/store|snap)\//i.test(normalized) || /^\/(?:usr\/(?:share|lib)|nix|snap)\//.test(normalized)) return "package-manager-owned installation";
  const windowsGlobal = process.platform === "win32" && env.APPDATA && normalized === path.join(env.APPDATA, "npm/node_modules/@heyditto/cli").replaceAll("\\", "/");
  if (!normalized.endsWith("/lib/node_modules/@heyditto/cli") && !windowsGlobal) return "project or unmanaged installation";
  // Disabling checks does not grant ownership or permission to delegate. Only
  // an otherwise eligible installation may retain its selected cached version.
  if (env.DITTO_CLI_AUTO_UPDATE === "0" || env.DISABLE_AUTOUPDATER === "1" || args.includes("--no-auto-update")) return "disabled for this invocation";
  return undefined;
}

export async function selectCachedRelease(cache: string, bundledVersion: string, policy: UpdatePolicy, nodeVersion = process.versions.node, target = updateTarget()): Promise<{ root: string; version: string } | undefined> {
  cache = path.resolve(cache);
  const pointer = policy.pinnedVersion ? { version: policy.pinnedVersion } : await readUpdateJSON<UpdatePointer>(path.join(cache, "current.json"), 4096);
  if (!pointer || !stableVersion(pointer.version) || (!newerVersion(pointer.version, bundledVersion) && pointer.version !== policy.pinnedVersion) || (policy.pinnedVersion && pointer.version !== policy.pinnedVersion)) return undefined;
  if ("target" in pointer && pointer.target !== target) return undefined;
  try { await lstat(path.join(cache, "quarantine", `${pointer.version}.json`)); return undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
  const root = path.join(cache, "versions", pointer.version, "package");
  for (const directory of [cache, path.join(cache, "versions"), path.dirname(root), root]) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o022))) return undefined;
  }
  if (await realpath(root) !== root) return undefined;
  const pkg = await readUpdateJSON<{ name?: string; version?: string; engines?: { node?: string }; bin?: Record<string, string> }>(path.join(root, "package.json"));
  const lock = await readUpdateJSON<{ bootstrap?: number; packageVersion?: string }>(path.join(root, "dist/update-lock.json"), 1024 * 1024);
  const receipt = await readUpdateJSON<{ version?: string; rootIntegrity?: string; target?: string; nodeRanges?: string[] }>(path.join(path.dirname(root), "verified.json"), 65536);
  if (pkg?.name !== packageName || pkg.version !== pointer.version || pkg.bin?.heyditto !== "dist/entry.js" || !supportsNode(pkg.engines?.node, nodeVersion) || lock?.bootstrap !== 1 || lock.packageVersion !== pointer.version || receipt?.version !== pointer.version || receipt.target !== target || !Array.isArray(receipt.nodeRanges) || receipt.nodeRanges.length > 257 || !receipt.nodeRanges.every(range => supportsNode(range, nodeVersion)) || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(receipt?.rootIntegrity ?? "")) return undefined;
  for (const file of ["dist/cli.js", "dist/entry.js", "dist/update-worker.js"]) {
    const absolute = path.join(root, file), stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(absolute) !== absolute) return undefined;
  }
  return { root, version: pointer.version };
}

/** Only a validated startup selection or an explicit manual check activates a
 * version. Background workers publish candidates, never these markers. */
export async function recordCachedActivation(cache: string, version: string, target = updateTarget()): Promise<void> {
  if (!stableVersion(version)) throw new Error("invalid activation version");
  const directory = path.join(path.resolve(cache), "activated"), file = path.join(directory, `${version}.json`);
  await privateDirectory(directory);
  const existing = await readUpdateJSON<{ version?: string; target?: string }>(file, 4096);
  if (existing) {
    if (existing.version !== version || existing.target !== target) throw new Error("invalid cached activation");
    return;
  }
  if ((await readdir(directory)).length >= 4096) throw new Error("activation metadata requires manual cleanup");
  const pending = path.join(directory, `.pending-${randomUUID()}`);
  await writeFile(pending, JSON.stringify({ version, target }) + "\n", { flag: "wx", mode: 0o600 });
  try { await link(pending, file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = await readUpdateJSON<{ version?: string; target?: string }>(file, 4096);
    if (winner?.version !== version || winner.target !== target) throw new Error("invalid concurrent cached activation");
  } finally { await rm(pending, { force: true }).catch(() => undefined); }
}

export async function selectActivatedRelease(cache: string, bundledVersion: string, nodeVersion = process.versions.node, target = updateTarget()): Promise<{ root: string; version: string } | undefined> {
  cache = path.resolve(cache);
  const directory = path.join(cache, "activated");
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o022))) return undefined;
    const files = await readdir(directory);
    if (files.length > 4096) return undefined;
    const versions = files.filter(name => name.endsWith(".json") && stableVersion(name.slice(0, -5))).map(name => name.slice(0, -5)).filter(version => newerVersion(version, bundledVersion)).sort((a, b) => newerVersion(a, b) ? -1 : newerVersion(b, a) ? 1 : 0);
    for (const version of versions.slice(0, 16)) {
      try {
        const marker = await readUpdateJSON<{ version?: string; target?: string }>(path.join(directory, `${version}.json`), 4096);
        if (marker?.version !== version || marker.target !== target) continue;
        const selected = await selectCachedRelease(cache, bundledVersion, { pinnedVersion: version }, nodeVersion, target);
        if (selected) return selected;
      } catch { /* invalid activation cannot grant execution permission */ }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return undefined;
}

export async function quarantineCachedRelease(root: string, cache = updateRoot()): Promise<void> {
  const relative = path.relative(cache, root).split(path.sep);
  if (relative.length !== 3 || relative[0] !== "versions" || !stableVersion(relative[1]) || relative[2] !== "package") return;
  await writeUpdateJSON(path.join(cache, "quarantine", `${relative[1]}.json`), { failedAt: Date.now(), reason: "CLI execution failed; this invocation was not retried" });
}

export async function startupUpdate(bundledRoot: string): Promise<string> {
  const root = await realpath(bundledRoot);
  // Explicit pins, manager ownership and ephemeral launches also suppress cache
  // delegation, so an npx/package-manager version remains the version invoked.
  const eligibility = updateEligibility(root);
  if (eligibility && eligibility !== "disabled for this invocation") return root;
  const cache = updateRoot();
  const [candidate, activated, health] = await Promise.all([
    selectCachedRelease(cache, packageVersion, {}).catch(() => undefined),
    selectActivatedRelease(cache, packageVersion).catch(() => undefined),
    readUpdateJSON<UpdateHealth>(path.join(cache, "health.json"), 4096).catch(() => undefined),
  ]);
  let policy: UpdatePolicy;
  try {
    // Validate the staged candidate BEFORE the final policy read. A candidate
    // published after an acknowledged disable cannot become this selection.
    policy = await effectiveUpdatePolicy(cache);
  } catch { return root; }
  let selected: { root: string; version: string } | undefined;
  if (policy.pinnedVersion) {
    try { selected = await selectCachedRelease(cache, packageVersion, policy); } catch { /* invalid pin falls back */ }
  } else if (eligibility || policy.enabled === false) selected = activated;
  else {
    selected = candidate && (!activated || newerVersion(candidate.version, activated.version)) ? candidate : activated;
    if (selected) {
      try { await recordCachedActivation(cache, selected.version); }
      catch { selected = activated; } // Never select a new version we cannot retain.
    }
  }
  const active = selected ?? { root, version: packageVersion };
  const args = process.argv.slice(2);
  if (eligibility || policy.enabled === false || policy.pinnedVersion || !stableVersion(active.version) || !args.length || ["self-update", "help"].includes(args[0]) || args.some(a => ["--preview", "--offline", "--help", "-h", "--version", "-v"].includes(a))) return active.root;
  const last = health?.lastAttemptAt;
  if (typeof last === "number" && Number.isFinite(last) && Date.now() - last < UPDATE_INTERVAL_MS) return active.root;
  try {
    await privateDirectory(cache);
    // Each time window has one immutable lease. Crashes cannot permanently
    // block later windows, and active leases are never deleted or stolen.
    try { await lstat(path.join(cache, "leases", updateLeaseSlot())); return active.root; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return active.root; }
    const child = spawn(process.execPath, [path.join(active.root, "dist/update-worker.js"), cache, active.version], { cwd: cache, detached: true, stdio: "ignore", env: cleanUpdateEnvironment() });
    child.on("error", () => undefined);
    child.unref();
  } catch { /* optional background update cannot affect command output */ }
  return active.root;
}

async function manualUpdate(cache: string): Promise<number> {
  await privateDirectory(cache);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./update-worker.js", import.meta.url)), cache, packageVersion, "--manual"], { cwd: cache, stdio: "ignore", env: cleanUpdateEnvironment() });
    const stop = () => { process.exitCode = 130; child.kill("SIGTERM"); };
    const terminate = () => { process.exitCode = 143; child.kill("SIGTERM"); };
    process.on("SIGINT", stop); process.on("SIGTERM", terminate);
    const timer = setTimeout(() => child.kill("SIGKILL"), 70000);
    const cleanup = () => { clearTimeout(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", terminate); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => { cleanup(); resolve(code ?? 1); });
  });
}

export function registerSelfUpdateCommands(program: Command, outputOption: () => Option): void {
  const group = program.command("self-update").description("inspect, disable or pin occasional background CLI updates");
  const action = (kind: "status" | "enable" | "disable" | "pin" | "unpin" | "check") => async (options: { output?: string }) => {
    const cache = updateRoot();
    const target = updateTarget(), preferences = updatePreferenceFiles(cache, target);
    const invalidMetadata: string[] = [];
    const safeRead = async <T>(file: string, limit = 4096): Promise<T | undefined> => {
      try { return await readUpdateJSON<T>(path.join(cache, file), limit); }
      catch { invalidMetadata.push(file); return undefined; }
    };
    // Each command writes only its own intent. A stale reader cannot clobber
    // another target's pin or an acknowledged global enable/disable.
    if (kind === "enable" || kind === "disable") await writeUpdateJSON(preferences.enabled, { enabled: kind === "enable" });
    if (kind === "pin" || kind === "unpin") await writeUpdateJSON(preferences.pin, { version: kind === "pin" ? packageVersion : null });
    let invokedRoot = fileURLToPath(new URL("../", import.meta.url));
    if (process.argv[1]) invokedRoot = await realpath(process.argv[1]).then(file => path.dirname(path.dirname(file))).catch(() => invokedRoot);
    const eligibilityReason = updateEligibility(invokedRoot, process.env, []);
    let manualExitCode: number | undefined;
    if (kind === "check" && (!eligibilityReason || eligibilityReason === "disabled for this invocation")) {
      manualExitCode = await manualUpdate(cache);
    }
    let settings: UpdatePolicy;
    try { settings = await effectiveUpdatePolicy(cache, target); }
    catch { invalidMetadata.push("preferences"); settings = { enabled: false }; }
    const health = await safeRead<UpdateHealth>("health.json") ?? {};
    if (manualExitCode) { health.status = "failed"; health.detail ||= "manual updater exited before completion"; }
    const leaseName = typeof health.lease === "string" && /^\d+(?:-manual-[0-9a-f-]{36})?\.json$/.test(health.lease) ? health.lease : updateLeaseSlot();
    const lease = await safeRead<UpdateLease>(path.join("leases", leaseName));
    let worker: "active" | "interrupted" | "finished" | "unknown" | undefined;
    if (lease) {
      worker = health.lease === leaseName && health.status && health.status !== "checking" ? "finished" : "unknown";
      if (worker !== "finished" && Number.isSafeInteger(lease.pid) && lease.pid! > 0) {
        try { process.kill(lease.pid!, 0); worker = "active"; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") worker = "interrupted"; }
      }
    }
    const bundled = await readUpdateJSON<{ version?: string }>(path.join(invokedRoot, "package.json"), 65536).catch(() => undefined);
    const pointer = await safeRead<UpdatePointer>("current.json");
    const activated = await selectActivatedRelease(cache, bundled?.version ?? packageVersion).catch(() => undefined);
    const checkAllowed = !eligibilityReason || eligibilityReason === "disabled for this invocation";
    const state = { version: packageVersion, bundledVersion: bundled?.version ?? packageVersion, selectedVersion: packageVersion, cachedVersion: stableVersion(pointer?.version) ? pointer.version : null, stagedVersion: stableVersion(pointer?.version) ? pointer.version : null, activatedVersion: activated?.version ?? null, target, policyFile: preferences.enabled, pinFile: preferences.pin, policyScope: "user", pinScope: "runtime_target", eligible: !eligibilityReason, eligibilityReason: eligibilityReason ?? null, checkRequested: kind === "check", checkAllowed: kind === "check" ? checkAllowed : null, manualExitCode: manualExitCode ?? null, enabled: settings.enabled !== false, pinnedVersion: settings.pinnedVersion ?? null, checkIntervalHours: 6, health, worker: worker ?? null, cache, historicalNpmPinDetectable: false, invalidMetadata };
    if (options.output === "json") process.stdout.write(JSON.stringify(state) + "\n");
    else process.stdout.write(`CLI ${state.selectedVersion} (bundled ${state.bundledVersion}, staged ${state.stagedVersion ?? "none"}, activated ${state.activatedVersion ?? "none"}): background updates ${state.enabled ? "enabled" : "disabled"}${state.pinnedVersion ? `, pinned to ${state.pinnedVersion}` : ""}${eligibilityReason ? `\nLaunch: ${eligibilityReason}` : ""}\nLast attempt: ${health.status ?? "none"}${health.detail ? ` (${health.detail})` : ""}${worker ? `\nWorker lease: ${worker} (leases are never stolen)` : ""}\n`);
    if (kind === "check" && (!checkAllowed || health.status === "failed")) process.exitCode ||= 1;
  };
  for (const [kind, description] of [["status", "show update policy, installation eligibility and last attempt"], ["check", "check now and activate a verified update for the next invocation"], ["enable", "enable occasional updates for eligible global installations"], ["disable", "disable background downloads and new automatic activations"], ["pin", "keep the currently selected CLI version"], ["unpin", "resume updates after a version pin"]] as const) group.command(kind).description(description).addOption(outputOption()).action(action(kind));
}
