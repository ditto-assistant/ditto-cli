import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import { assertClassifierModelId } from "../agents/cliproxy.js";
import { chooseEndpoint } from "../agents/launch.js";
import { LEGACY_PROFILE, profileLabel } from "../profile-state.js";
import { type SelectedProfile, addProfileOption, selectedProfile, setProfileOverride } from "../profiles.js";

type JsonObject = Record<string, unknown>;
import { DEFAULT_T3_INSTANCE } from "./instance.js";

export { DEFAULT_T3_INSTANCE };
export interface T3SetupOptions {
  endpoint?: string;
  inference?: string;
  instance?: string;
  name?: string;
  baseDir?: string;
  claudeBin?: string;
  heydittoBin?: string;
  dryRun?: boolean;
  json?: boolean;
  /**
   * Pin the endpoint for every chat (`--endpoint`) instead of using it only
   * where the checkout has no `.ditto/` default (`--fallback-endpoint`).
   * Default: the default provider follows the repository; a profile's or a
   * custom `--instance` provider is a deliberate choice and pins.
   */
  pin?: boolean;
  /**
   * CLIProxy providers only: export DITTO_AUTO_MODE_CLASSIFIER in the
   * launcher, so every chat requests this dedicated id for Auto Mode
   * permission checks once the proxy lists it.
   */
  autoModeClassifier?: string;
  /** Set by commander; read through the shared --profile hook. */
  profile?: string;
}
export interface T3SetupPlan {
  settingsPath: string;
  original: string;
  updated: string;
  instance: string;
  endpoint: string;
  inference: "router" | "cliproxy";
  pin: boolean;
  autoModeClassifier?: string;
  displayName: string;
  managedRoot: string;
  homePath: string;
  launcherPath: string;
  files: Array<{ path: string; content: string }>;
  action: "add" | "update" | "unchanged";
  runningPid?: number;
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userPath(value: string): string {
  return path.resolve(value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}

function ownedPath(target: string, kind: "file" | "directory"): void {
  const st = lstatSync(target);
  if (st.isSymbolicLink() || (kind === "file" ? !st.isFile() || st.nlink !== 1 : !st.isDirectory()) || st.uid !== process.getuid?.()) {
    throw new Error(`Refusing an unowned, linked or unexpected T3 ${kind}: ${target}`);
  }
  if (kind === "directory" && (st.mode & 0o022) !== 0) throw new Error(`Refusing a writable shared T3 directory: ${target}`);
}

function privateDirectory(target: string): void {
  if (existsSync(target)) {
    ownedPath(target, "directory");
    if ((statSync(target).mode & 0o077) !== 0) throw new Error(`T3 setup needs an owner-only directory: ${target}`);
    return;
  }
  privateDirectory(path.dirname(target));
  mkdirSync(target, { mode: 0o700 });
}

function executable(value: string | undefined, name: string): string {
  const found = value ?? spawnSync("which", [name], { encoding: "utf8" }).stdout?.trim();
  if (!found || /[\r\n\0]/.test(found)) throw new Error(`Cannot locate ${name}; set --${name === "claude" ? "claude" : "heyditto"}-bin to its executable path`);
  const resolved = userPath(found);
  accessSync(resolved, constants.X_OK);
  if (!statSync(resolved).isFile()) throw new Error(`${name} must be an executable file`);
  return resolved;
}

function parseObject(raw: string, label: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (object(parsed)) return parsed;
  } catch { /* Do not include potentially secret JSON excerpts in diagnostics. */ }
  throw new Error(`Cannot parse ${label} as a JSON object; nothing changed`);
}

function runningServer(userdata: string): number | undefined {
  const runtime = path.join(userdata, "server-runtime.json");
  if (!existsSync(runtime)) return undefined;
  ownedPath(runtime, "file");
  const record = parseObject(readFileSync(runtime, "utf8"), "T3 server runtime");
  const pid = record.pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error("Cannot establish whether T3 is stopped: invalid server runtime pid");
  try { process.kill(pid as number, 0); return pid as number; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw new Error("Cannot establish whether T3 is stopped; close T3 before setup");
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Plan only: no credentials, endpoint changes, filesystem writes or service stops. */
export function planT3Setup(options: T3SetupOptions): T3SetupPlan {
  if (process.platform === "win32") throw new Error("T3 launcher setup currently supports macOS and Linux; use the manual T3 guide on Windows");
  const endpoint = options.endpoint ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(endpoint)) throw new Error("Use an endpoint CLI slug or UUID with --endpoint");
  const inference = options.inference ?? "cliproxy";
  if (inference !== "router" && inference !== "cliproxy") throw new Error("--inference must be router or cliproxy");
  const autoModeClassifier = options.autoModeClassifier === undefined ? undefined : assertClassifierModelId(options.autoModeClassifier.trim());
  if (autoModeClassifier !== undefined && inference !== "cliproxy") throw new Error("--auto-mode-classifier applies only to --inference cliproxy");
  const instance = options.instance ?? DEFAULT_T3_INSTANCE;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(instance)) throw new Error("--instance must contain letters, digits, '-' or '_' and be at most 80 characters");
  const base = userPath(options.baseDir ?? process.env.T3CODE_HOME ?? path.join(os.homedir(), ".t3"));
  const userdata = path.join(base, "userdata");
  const settingsPath = path.join(userdata, "settings.json");
  ownedPath(base, "directory");
  ownedPath(userdata, "directory");
  ownedPath(settingsPath, "file");
  const original = readFileSync(settingsPath, "utf8");
  const settings = parseObject(original, "T3 settings");
  if (settings.providerInstances !== undefined && !object(settings.providerInstances)) throw new Error("Unsupported T3 provider settings shape; nothing changed");
  const instances = (settings.providerInstances ?? {}) as JsonObject;
  const existing = Object.hasOwn(instances, instance) ? instances[instance] : undefined;
  const managedRoot = path.join(base, "ditto-providers");
  // Check existing ancestors before planning any generated paths. The root may
  // be new; it must not redirect the install through a symlink.
  for (const dir of [managedRoot, path.join(managedRoot, instance)]) {
    if (existsSync(dir)) ownedPath(dir, "directory");
  }
  const homePath = path.join(managedRoot, instance, "claude");
  if (existing !== undefined && (!object(existing) || existing.driver !== "claudeAgent" || !object(existing.config) || existing.config.homePath !== homePath || typeof existing.config.binaryPath !== "string" || !existing.config.binaryPath.startsWith(path.join(managedRoot, instance) + path.sep))) {
    throw new Error(`T3 provider '${instance}' already exists outside this setup; choose another --instance (no overwrite)`);
  }
  const pin = options.pin ?? instance !== DEFAULT_T3_INSTANCE;
  const heydittoBin = executable(options.heydittoBin, "heyditto");
  const claudeBin = executable(options.claudeBin, "claude");
  if (path.basename(claudeBin) !== "claude") throw new Error("--claude-bin must point to an executable named claude (a symlink is supported)");
  const help = spawnSync(heydittoBin, ["claude", "--help"], { encoding: "utf8", timeout: 15_000 });
  const required = inference === "cliproxy" ? ["--cliproxy", "--mcp", "--no-mcp-only", "--no-remote-control"] : ["--no-mcp", "--no-mcp-only", "--no-remote-control"];
  if (help.status !== 0 || required.some((flag) => !new RegExp(`(^|[\\s,])${flag}([\\s,]|$)`, "m").test(help.stdout ?? ""))) {
    throw new Error(`The selected heyditto does not support ${inference} T3 launches; update it before setup`);
  }
  // An older heyditto would ignore the exported variable without a word.
  if (autoModeClassifier !== undefined && !/(^|[\s,])--auto-mode-classifier([\s,]|$)/m.test(help.stdout ?? "")) {
    throw new Error("The selected heyditto does not support --auto-mode-classifier; update it (3.18.0 or newer) before setup");
  }
  const launcher = readFileSync(fileURLToPath(new URL("../../scripts/claude-router-launcher.sh", import.meta.url)), "utf8");
  // The classifier joins the digest only when set, so existing installs keep
  // their launcher directory.
  const digest = createHash("sha256").update(JSON.stringify({ inference, endpoint, pin, heydittoBin, claudeBin, launcher, ...(autoModeClassifier ? { autoModeClassifier } : {}) })).digest("hex").slice(0, 20);
  const versionDir = path.join(managedRoot, instance, digest);
  const supportPath = path.join(versionDir, "claude-router-launcher.sh");
  const launcherPath = path.join(versionDir, "launch");
  const wrapper = `#!/bin/sh\n# Managed by heyditto t3 setup. No credentials are stored here.\nexport DITTO_T3_INFERENCE=${shellQuote(inference)}\nexport DITTO_T3_ENDPOINT=${shellQuote(endpoint)}\nexport DITTO_T3_ENDPOINT_MODE=${pin ? "pin" : "fallback"}\nexport DITTO_T3_HEYDITTO_BIN=${shellQuote(heydittoBin)}\nexport DITTO_T3_CLAUDE_BIN=${shellQuote(claudeBin)}\n${autoModeClassifier ? `export DITTO_AUTO_MODE_CLASSIFIER=${shellQuote(autoModeClassifier)}\n` : ""}exec ${shellQuote(supportPath)} "$@"\n`;
  const displayName = options.name?.trim() || (inference === "cliproxy" ? "Claude CLIProxy + Ditto" : "Ditto Router");
  const previous = object(existing) ? existing : {};
  const provider = { ...previous, driver: "claudeAgent", displayName, enabled: true, config: { ...(object(previous.config) ? previous.config : {}), binaryPath: launcherPath, homePath } };
  const updatedObject = { ...settings, providerInstances: { ...instances, [instance]: provider } };
  const same = JSON.stringify(settings) === JSON.stringify(updatedObject);
  return {
    settingsPath, original, updated: same ? original : JSON.stringify(updatedObject, null, 2) + "\n",
    instance, endpoint, inference, pin, ...(autoModeClassifier ? { autoModeClassifier } : {}), displayName, managedRoot, homePath, launcherPath,
    files: [{ path: supportPath, content: launcher }, { path: launcherPath, content: wrapper }],
    action: existing === undefined ? "add" : same ? "unchanged" : "update",
    runningPid: runningServer(userdata),
  };
}

function ensureStopped(plan: T3SetupPlan): void {
  const pid = runningServer(path.dirname(plan.settingsPath));
  if (pid !== undefined) throw new Error(`T3 is running (pid ${pid}). Quit T3 or stop its service yourself, then rerun setup; no active chats were stopped`);
}

/** Apply only the selected provider; immutable launchers cannot change an old instance on failure. */
export function applyT3Setup(plan: T3SetupPlan): { changed: boolean; backup?: string } {
  ensureStopped(plan);
  const userdata = path.dirname(plan.settingsPath);
  const lock = path.join(userdata, ".heyditto-t3-setup.lock");
  const lockFd = openSync(lock, "wx", 0o600);
  let stage: string | undefined;
  let backup: string | undefined;
  let installed = false;
  try {
    ownedPath(plan.settingsPath, "file");
    if (readFileSync(plan.settingsPath, "utf8") !== plan.original) throw new Error("T3 settings changed since planning; rerun setup (no overwrite)");
    // The base directory is already validated, so start recursion at our new,
    // private child instead of trying to privatize T3's existing directories.
    if (!existsSync(plan.managedRoot)) mkdirSync(plan.managedRoot, { mode: 0o700 });
    privateDirectory(plan.managedRoot);
    privateDirectory(plan.homePath);
    for (const file of plan.files) {
      privateDirectory(path.dirname(file.path));
      if (existsSync(file.path)) {
        ownedPath(file.path, "file");
        if (readFileSync(file.path, "utf8") !== file.content || (statSync(file.path).mode & 0o777) !== 0o700) throw new Error("An installed T3 launcher was modified; refusing to overwrite it");
      } else {
        writeFileSync(file.path, file.content, { flag: "wx", mode: 0o700 });
        installed = true;
      }
    }
    if (plan.original === plan.updated) return { changed: installed };
    const backups = path.join(plan.managedRoot, "backups");
    privateDirectory(backups);
    backup = path.join(backups, `settings-${Date.now()}-${randomUUID()}.json`);
    writeFileSync(backup, plan.original, { flag: "wx", mode: 0o600 });
    stage = path.join(userdata, `.heyditto-settings-${randomUUID()}.json`);
    const fd = openSync(stage, "wx", 0o600);
    try { writeFileSync(fd, plan.updated, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    ensureStopped(plan);
    ownedPath(plan.settingsPath, "file");
    if (readFileSync(plan.settingsPath, "utf8") !== plan.original) throw new Error("T3 settings changed during setup; backup kept, original launcher retained, settings not overwritten");
    renameSync(stage, plan.settingsPath);
    stage = undefined;
    return { changed: true, backup };
  } finally {
    closeSync(lockFd);
    if (stage !== undefined) unlinkSync(stage);
    unlinkSync(lock);
  }
}

/**
 * T3 settings a profile implies. The `default` profile keeps the original
 * instance id and label, so an install that predates profiles reruns setup
 * onto the same provider; any other profile gets its own instance
 * (`subnet` → `claude_ditto_subnet_cliproxy`, "Claude Subnet"), so a second
 * provider is created next to the first instead of replacing it.
 */
export function profileT3Defaults(name: string, inference: "router" | "cliproxy"): { instance: string; name?: string } {
  if (name === LEGACY_PROFILE && inference === "cliproxy") return { instance: DEFAULT_T3_INSTANCE };
  const id = name.replace(/-/g, "_");
  return { instance: `claude_ditto_${id}_${inference}`, name: `Claude ${profileLabel(name)}${inference === "router" ? " (Router)" : ""}` };
}

export interface T3SetupDeps {
  /** Chooses an endpoint when --endpoint is omitted; `readOnly` for --dry-run. */
  chooseEndpoint?: (readOnly: boolean) => Promise<{ slug: string }>;
  /** Reads the profile selected by --profile, DITTO_PROFILE or the active one. */
  selectedProfile?: () => Promise<SelectedProfile>;
}

/**
 * Fills endpoint, inference, instance and name from the selected profile.
 * Profiles apply when one was named (--profile / DITTO_PROFILE) or when
 * profiles are saved and --endpoint was omitted. Explicit flags always win.
 * With no saved profiles and no profile named, nothing changes.
 */
export async function resolveT3Profile(options: T3SetupOptions, read: () => Promise<SelectedProfile> = selectedProfile): Promise<{ options: T3SetupOptions; profileName?: string }> {
  const selected = await read();
  const named = selected.source !== "active";
  if (!named && (selected.implicit || options.endpoint !== undefined)) return { options };
  if (named && options.endpoint !== undefined) throw new Error("pass either --profile or --endpoint, not both");
  const endpoint = selected.profile.endpoint?.trim();
  // The active profile may not have an endpoint yet: let the picker choose
  // one (it saves the choice into that profile) but keep its own instance.
  if (!endpoint && named) throw new Error(`profile "${selected.name}" has no endpoint. Set one with \`heyditto profile set ${selected.name} --endpoint <slug>\`.`);
  const inference = (options.inference ?? selected.profile.inference ?? "cliproxy") as "router" | "cliproxy";
  const derived = profileT3Defaults(selected.name, inference);
  return {
    options: { ...options, ...(endpoint ? { endpoint } : {}), inference, instance: options.instance ?? derived.instance, name: options.name ?? derived.name },
    profileName: selected.name,
  };
}

export function registerT3Commands(program: Command, deps: T3SetupDeps = {}): void {
  const choose = deps.chooseEndpoint ?? ((readOnly: boolean) => chooseEndpoint("claude", readOnly));
  const readProfile = deps.selectedProfile ?? selectedProfile;
  const setup = program.command("t3").description("configure a local T3 Code provider for Ditto").command("setup")
    .description("install a Claude launcher and configure a T3 provider while T3 is stopped")
    .option("--endpoint <slug>", "Ditto endpoint supplying tools (and inference in Router mode); default: the selected profile's, or pick or create one")
    .addOption(new Option("--inference <mode>", "inference route (default: the profile's, else cliproxy)").choices(["cliproxy", "router"]))
    .option("--instance <id>", `T3 provider instance id (default: ${DEFAULT_T3_INSTANCE}, or claude_ditto_<profile>_<inference> for a named profile)`)
    .option("--name <name>", "provider display name (default from the profile, e.g. \"Claude Subnet\")")
    .option("--pin", "use this provider's endpoint in every chat, even in a checkout whose .ditto/ names another (default for --profile / --instance providers)")
    .option("--no-pin", "use this provider's endpoint only where the checkout has no .ditto/ default (default for the default provider)")
    .option("--auto-mode-classifier <model>", "CLIProxy providers: dedicated CLIProxy model id for Auto Mode permission checks (exported as DITTO_AUTO_MODE_CLASSIFIER; used only when the proxy lists it)")
    .option("--base-dir <dir>", "T3 base directory (default: T3CODE_HOME or ~/.t3; userdata is appended)")
    .option("--claude-bin <path>", "installed Claude executable named claude")
    .option("--heyditto-bin <path>", "installed heyditto executable")
    .option("--dry-run", "show the setup plan; write nothing and allow T3 to remain open")
    .option("--json", "print a credential-free setup summary")
    .action(async (raw: T3SetupOptions) => {
      // Also honour --profile when this command is registered without the
      // program-wide hook (tests, embedders).
      if (raw.profile !== undefined) setProfileOverride(raw.profile);
      const { profile: flagProfile, ...rest } = raw;
      if (flagProfile !== undefined && rest.endpoint !== undefined) throw new Error("pass either --profile or --endpoint, not both");
      // An explicit --endpoint keeps the original behaviour (and stays
      // synchronous): no profile is read, even with DITTO_PROFILE set.
      const resolved = rest.endpoint !== undefined ? { options: rest } : await resolveT3Profile(rest, readProfile);
      let options = resolved.options;
      const profileName = (resolved as { profileName?: string }).profileName;
      if (profileName !== undefined) process.stderr.write(`Using profile ${profileName} → ${options.endpoint} as T3 provider ${options.instance ?? DEFAULT_T3_INSTANCE}\n`);
      if (options.endpoint === undefined) {
        // Fail on local problems (T3 settings, binaries) before a browser
        // login, picker or endpoint creation. The throwaway plan needs any
        // valid slug; the chosen one replaces it below.
        const probe = planT3Setup({ ...options, endpoint: "endpoint-not-chosen-yet" });
        if (!options.dryRun) ensureStopped(probe);
        const chosen = await choose(Boolean(options.dryRun));
        process.stderr.write(`Using endpoint ${chosen.slug} (pass --endpoint <slug> to choose another)\n`);
        options = { ...options, endpoint: chosen.slug };
      }
      const plan = planT3Setup(options);
      const applied = options.dryRun ? undefined : applyT3Setup(plan);
      const summary = { action: plan.action, dryRun: Boolean(options.dryRun), profile: profileName ?? null, instance: plan.instance, displayName: plan.displayName, endpoint: plan.endpoint, endpointMode: plan.pin ? "pin" : "fallback", inference: plan.inference, autoModeClassifier: plan.autoModeClassifier ?? null, settingsPath: plan.settingsPath, binaryPath: plan.launcherPath, homePath: plan.homePath, runningPid: plan.runningPid ?? null, ...applied };
      if (options.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      else {
        process.stdout.write(`${options.dryRun ? "Plan" : "Configured"}: ${plan.displayName} → ${plan.endpoint} (${plan.inference}, ${plan.pin ? "pinned" : "unless the checkout's .ditto/ names another"})\nSettings: ${plan.settingsPath}\nBinary: ${plan.launcherPath}\nClaude config: ${plan.homePath}\n`);
        if (applied?.backup) process.stdout.write(`Private settings backup: ${applied.backup}\n`);
        if (options.dryRun && plan.runningPid !== undefined) process.stdout.write("T3 is running. Quit it before applying; this command will not stop chats.\n");
        else if (!options.dryRun) process.stdout.write("Open T3 and select this provider in a new chat. Setup did not mint any keys or send inference requests.\n");
      }
    });
  addProfileOption(setup);
}
