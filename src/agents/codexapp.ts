import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { Command, Option } from "commander";
import {
  type InferenceEndpoint,
  type InferenceEndpointsResponse,
  type SelectedEndpoint,
  createKey,
  findEndpoint,
  isEndpointPending,
  listEndpoints,
  revokeKey,
  updateEndpoint,
} from "../api.js";
import { openInBrowser } from "../browser.js";
import { endpointURL, resolveApiKey } from "../config.js";
import { deviceLogin } from "../device-login.js";
import { formatActivation } from "../endpoint-format.js";
import { readStoredAuth, saveLogin, updateStoredAuth } from "../store.js";
import { err as c } from "../ui.js";
import { assertEndpointActive, pickEndpoint } from "./launch.js";
import { DEFAULT_LAUNCH_EXPIRY, KEY_EXPIRIES, type KeyExpiry } from "./types.js";

/**
 * `heyditto codex-app`: point the Codex desktop app (ChatGPT.app) at a Ditto
 * inference endpoint, so its models — GLM Flash and friends — are usable
 * through the app's own "Sign in with an API key" path.
 *
 * The app shares ~/.codex with the Codex CLI and, unlike the CLI, cannot be
 * handed environment variables (a Dock-launched app inherits none), so the
 * wiring is file-based:
 *
 * - `openai_base_url` in ~/.codex/config.toml repoints the built-in `openai`
 *   provider — the Responses wire, which the gateway speaks — at the
 *   endpoint's gateway;
 * - the endpoint key goes into ~/.codex/auth.json as OPENAI_API_KEY, the
 *   same file the app's "Sign in with an API key" screen writes. Riding the
 *   built-in provider's auth is what makes that screen the only sign-in the
 *   user needs; a custom provider's `env_key` would have nothing to read in
 *   an app launched from the Dock.
 *
 * Both files are shared with the Codex CLI: a bare `codex` run routes
 * through Ditto too. `heyditto codex` is unaffected — it injects its own
 * provider with -c overrides. `--unset` restores what was there before.
 */

export const CODEX_APP_MARKER = "# added by `heyditto codex-app`";

/** ~/.codex, or $CODEX_HOME (the same resolution Codex itself uses). */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim();
  return home && home.length > 0 ? home : path.join(os.homedir(), ".codex");
}

export type CodexAuthKind = "absent" | "api-key" | "chatgpt" | "unknown";

/**
 * What ~/.codex/auth.json holds. `chatgpt` is a ChatGPT-plan login (tokens);
 * replacing it signs the CLI and the app out of that plan, so it is backed
 * up and confirmed first.
 */
export function classifyAuthJson(raw: string | undefined): CodexAuthKind {
  if (raw === undefined || raw.trim() === "") return "absent";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0) return "api-key";
    if (parsed.tokens != null || parsed.id_token != null || parsed.refresh_token != null) return "chatgpt";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** The top-level string value of `key`, or undefined when absent/unparsable. */
export function topLevelString(raw: string | undefined, key: string): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    const parsed = parseToml(raw) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function assignmentLine(lines: string[], key: string): number {
  // Top-level keys are unindented by convention; restricting the match to
  // column 0 keeps a same-named key inside some table from being rewritten.
  // The indented fallback exists for hand-formatted configs; every write is
  // parsed back before it lands, so the fallback can only move an odd file
  // from parsable to parsable-with-our-value, never to broken.
  let idx = lines.findIndex((l) => new RegExp(`^${key}\\s*=`).test(l));
  if (idx !== -1) return idx;
  return lines.findIndex((l) => new RegExp(`^\\s+${key}\\s*=`).test(l));
}

function firstTableLine(lines: string[]): number {
  return lines.findIndex((l) => /^\s*\[.+\]\s*(#.*)?$/.test(l));
}

/**
 * Sets a top-level string key, replacing an existing assignment in place or
 * inserting one before the first table header (with `comment` above it).
 * Callers parse the result before writing it anywhere.
 */
export function upsertTopLevelString(raw: string | undefined, key: string, value: string, comment?: string): string {
  const text = raw ?? "";
  const lines = text.split("\n");
  const escaped = JSON.stringify(value);
  const idx = assignmentLine(lines, key);
  if (idx !== -1) {
    lines[idx] = `${key} = ${escaped}`;
    return lines.join("\n");
  }
  const entry = comment ? [comment, `${key} = ${escaped}`] : [`${key} = ${escaped}`];
  const table = firstTableLine(lines);
  if (table === -1) {
    const trimmed = text.replace(/\s+$/, "");
    return trimmed === "" ? `${entry.join("\n")}\n` : `${trimmed}\n${entry.join("\n")}\n`;
  }
  lines.splice(table, 0, ...entry);
  return lines.join("\n");
}

/** Removes the top-level assignment of `key` (and a codex-app marker comment above it). */
export function removeTopLevelString(raw: string | undefined, key: string): string {
  if (raw === undefined) return "";
  const lines = raw.split("\n");
  const idx = assignmentLine(lines, key);
  if (idx === -1) return raw;
  let start = idx;
  if (start > 0 && lines[start - 1].trim() === CODEX_APP_MARKER) start -= 1;
  lines.splice(start, idx + 1 - start);
  return lines.join("\n");
}

/**
 * What sat under `key` before codex-app wrote it: a value already in the
 * file that is not ours belongs to someone else and is preserved as-is; a
 * value equal to ours restores the recorded previous one (null = none).
 */
function previousValue(raw: string | undefined, key: string, ours: string | undefined, recorded: string | null | undefined): string | null {
  const existing = topLevelString(raw, key);
  if (existing === undefined) return null;
  if (ours !== undefined && existing === ours) return recorded ?? null;
  return existing;
}

async function readMaybe(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Copies `fromPath` to `toPath` once; never overwrites an earlier backup. */
async function backupOnce(fromPath: string, toPath: string): Promise<boolean> {
  if ((await readMaybe(toPath)) !== undefined) return false;
  if ((await readMaybe(fromPath)) === undefined) return false;
  await copyFile(fromPath, toPath);
  return true;
}

export interface CodexAppOptions {
  endpoint?: string;
  budget?: string;
  expires?: string;
  model?: string;
  models?: boolean;
  name?: string;
  yes?: boolean;
  dryRun?: boolean;
  unset?: boolean;
  showKey?: boolean;
}

function log(line: string): void {
  process.stderr.write(`${c("dim", "ditto:")} ${line}\n`);
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--budget must be a positive integer token count, got "${raw}"`);
  return n;
}

function parseExpiry(raw: string | undefined): KeyExpiry {
  const value = (raw ?? DEFAULT_LAUNCH_EXPIRY).trim();
  if ((KEY_EXPIRIES as readonly string[]).includes(value)) return value as KeyExpiry;
  throw new Error(`--expires must be one of: ${KEY_EXPIRIES.join(", ")}`);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Yes/no prompt with Enter defaulting to no — a destructive default is the one thing it must not have. */
async function confirmYes(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  return answer === "y" || answer === "yes";
}

async function resolveEndpointFor(options: CodexAppOptions, selected: SelectedEndpoint | undefined): Promise<{ endpoint: InferenceEndpoint; catalog: InferenceEndpointsResponse }> {
  const catalog = await listEndpoints();
  const endpoints = catalog.endpoints;
  const stored = (await readStoredAuth())?.defaultEndpoint;
  const wanted = options.endpoint?.trim();
  if (wanted) {
    const match = findEndpoint(endpoints, wanted);
    if (match) return { endpoint: match, catalog };
    throw new Error(`no endpoint named "${wanted}". Available: ${endpoints.map((e) => e.slug).join(", ")}`);
  }
  if (selected) {
    const match = findEndpoint(endpoints, selected.id) ?? findEndpoint(endpoints, selected.slug);
    if (match) return { endpoint: match, catalog };
    log(`endpoint "${selected.slug}" picked in the browser is not in your list; pick another`);
  }
  if (stored?.trim()) {
    const match = findEndpoint(endpoints, stored);
    if (match) return { endpoint: match, catalog };
    log(`default endpoint "${stored.trim()}" no longer exists; pick another`);
  }
  if (endpoints.length === 0) {
    throw new Error("you have no inference endpoints yet. Create one with `heyditto endpoints create`.");
  }
  if (endpoints.length === 1) return { endpoint: endpoints[0], catalog };
  return { endpoint: await pickEndpoint(endpoints, stored), catalog };
}

async function ensureLogin(): Promise<SelectedEndpoint | undefined> {
  const { key } = await resolveApiKey();
  if (key) return undefined;
  if (!interactive()) {
    await listEndpoints(); // throws the shared "no Ditto API key configured" error
    return undefined;
  }
  log("no Ditto login yet — opening your browser to sign in and pick an endpoint for the Codex app.");
  const result = await deviceLogin({
    intent: "codex",
    onCode: (userCode, url) => {
      process.stderr.write(`\n  ${url}\n\n  Code: ${userCode}\n\n`);
      openInBrowser(url);
      process.stderr.write("Waiting for approval in the browser (Ctrl+C to cancel)…\n");
    },
  });
  await saveLogin(result.apiKey, result.setDefault && result.endpoint ? { defaultEndpoint: result.endpoint.slug } : {});
  log(`logged in${result.endpoint ? `; endpoint ${result.endpoint.slug}${result.setDefault ? " saved as default" : ""}` : ""}`);
  return result.endpoint;
}

/** Restores a key codex-app took over: previous value back, or ours removed. */
function restoreKey(raw: string | undefined, key: string, ours: string | undefined, previous: string | null | undefined): string | undefined {
  const current = topLevelString(raw, key);
  if (current === undefined) return undefined;
  if (ours !== undefined && current !== ours) return undefined; // changed since; leave it
  return previous ? upsertTopLevelString(raw, key, previous) : removeTopLevelString(raw, key);
}

/** Removes the codex-app wiring: restores config.toml and auth.json, revokes the key. */
export async function unsetCodexApp(): Promise<void> {
  const stored = await readStoredAuth();
  const record = stored?.codexApp;
  if (!record) {
    throw new Error("no codex-app wiring found (nothing `heyditto codex-app` wrote is recorded)");
  }
  const home = codexHome();
  const configPath = path.join(home, "config.toml");
  const authPath = path.join(home, "auth.json");
  const authBackupPath = `${authPath}.pre-ditto`;

  const configRaw = await readMaybe(configPath);
  let configText = restoreKey(configRaw, "openai_base_url", record.baseUrl, record.previousBaseUrl) ?? configRaw;
  configText = restoreKey(configText, "forced_login_method", record.forcedLogin ?? "api", record.previousForcedLogin ?? null) ?? configText;
  if (record.model !== undefined) {
    configText = restoreKey(configText, "model", record.model, record.previousModel) ?? configText;
  }
  if (configText !== undefined && configText !== configRaw) {
    await writeFile(configPath, configText, { mode: 0o600 });
    log(`restored ${configPath}`);
  }

  const authRaw = await readMaybe(authPath);
  const kind = classifyAuthJson(authRaw);
  if ((await readMaybe(authBackupPath)) !== undefined) {
    await rename(authBackupPath, authPath);
    log(`restored the previous login from ${authBackupPath}`);
  } else if (kind === "absent") {
    // nothing to restore
  } else if (kind === "api-key" && record.key !== undefined && authRaw === `${JSON.stringify({ OPENAI_API_KEY: record.key }, null, 2)}\n`) {
    await rm(authPath);
    log(`removed ${authPath} (the API-key login codex-app wrote)`);
  } else {
    log(`${c("yellow", "left auth.json alone:")} it changed since codex-app wrote it (now ${kind}); remove or replace it yourself if that is not what you want.`);
  }

  try {
    await revokeKey(record.endpointId, record.keyId);
    log(`revoked endpoint key …${record.keyHint}`);
  } catch (err) {
    log(`${c("yellow", "could not revoke")} key …${record.keyHint} (${err instanceof Error ? err.message : String(err)}); revoke it from the developer console if it is still live`);
  }
  await updateStoredAuth({ codexApp: undefined });
  log("codex-app wiring removed. Restart the Codex app (and any codex CLI session) to pick up the restored login.");
}

export async function runCodexApp(options: CodexAppOptions): Promise<void> {
  if (options.unset) return unsetCodexApp();

  const home = codexHome();
  const configPath = path.join(home, "config.toml");
  const authPath = path.join(home, "auth.json");
  const authBackupPath = `${authPath}.pre-ditto`;
  const configBackupPath = `${configPath}.pre-ditto`;

  const selected = options.dryRun ? undefined : await ensureLogin();
  const { endpoint, catalog } = await resolveEndpointFor(options, selected);
  if (!options.dryRun) await assertEndpointActive(endpoint);

  const baseUrl = catalog.baseUrl;
  const budget = parseBudget(options.budget);
  const expiresIn = parseExpiry(options.expires);
  const stored = await readStoredAuth();
  const record = stored?.codexApp;
  const configRaw = await readMaybe(configPath);
  if (configRaw !== undefined) {
    try {
      parseToml(configRaw);
    } catch (err) {
      throw new Error(`${configPath} does not parse as TOML (${err instanceof Error ? err.message : String(err)}); fix it before wiring the app`);
    }
  }
  const authRaw = await readMaybe(authPath);
  const authKind = classifyAuthJson(authRaw);

  const pinningModel = options.model !== undefined;
  const previousBaseUrl = previousValue(configRaw, "openai_base_url", record?.baseUrl, record?.previousBaseUrl);
  const previousModel = pinningModel ? previousValue(configRaw, "model", record?.model, record?.previousModel) : undefined;
  const previousForcedLogin = previousValue(configRaw, "forced_login_method", record?.forcedLogin ?? "api", record?.previousForcedLogin ?? null);

  let newConfig = upsertTopLevelString(configRaw, "openai_base_url", baseUrl, CODEX_APP_MARKER);
  // Force the API-key path: without this, a ChatGPT OAuth login (which can
  // live outside auth.json, in the OS credential store) silently takes
  // precedence and the app sends its OpenAI OAuth token to the Ditto
  // gateway, which 401s it — the app breaks for its own OAuth usage.
  newConfig = upsertTopLevelString(newConfig, "forced_login_method", "api");
  if (pinningModel) newConfig = upsertTopLevelString(newConfig, "model", options.model as string);
  try {
    const parsed = parseToml(newConfig) as Record<string, unknown>;
    if (parsed.openai_base_url !== baseUrl || parsed.forced_login_method !== "api" || (pinningModel && parsed.model !== options.model)) {
      throw new Error("the edited file does not carry the new values");
    }
  } catch (err) {
    throw new Error(`refusing to write ${configPath}: the edit does not parse back cleanly (${err instanceof Error ? err.message : String(err)})`);
  }

  if (authKind !== "absent" && !options.dryRun && !options.yes) {
    if (!interactive()) {
      throw new Error(
        `refusing to replace the existing ${authKind === "chatgpt" ? "ChatGPT-plan" : authKind === "api-key" ? "API-key" : "existing"} login in ${authPath} without confirmation. Re-run with --yes.`,
      );
    }
    const what = authKind === "chatgpt" ? "your ChatGPT-plan login" : authKind === "api-key" ? "an existing API-key login" : "an unrecognized login";
    const ok = await confirmYes(`Replace ${what} in ${authPath} (a backup is kept, --unset restores it)?`);
    if (!ok) throw new Error("aborted; nothing was written. (--yes skips this prompt.)");
  }

  if (options.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          endpoint: { id: endpoint.id, slug: endpoint.slug },
          baseUrl,
          codexHome: home,
          write: {
            [configPath]: { openai_base_url: baseUrl, forced_login_method: "api", ...(pinningModel ? { model: options.model } : {}) },
            [authPath]: authKind === "absent" ? "{ OPENAI_API_KEY: <endpoint key> }" : `(replace the existing ${authKind === "chatgpt" ? "ChatGPT" : "API-key"} login; backup kept)`,
          },
          enableModelPicker: options.models !== false,
          key: { name: options.name?.trim() || `cli:codex-app:${os.hostname()}`, expiresIn, spendLimitTokens: budget ?? null },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const keyName = options.name?.trim() || `cli:codex-app:${os.hostname()}`;
  const key = await createKey(endpoint.id, {
    name: keyName,
    expiresIn,
    ...(budget !== undefined ? { spendLimitTokens: budget, spendPeriod: "never" } : {}),
  });
  if (!key.key) throw new Error("key creation succeeded but no plaintext key was returned");

  await mkdir(home, { recursive: true, mode: 0o700 });
  // Back the login up only when it is not codex-app's own: a re-run must not
  // slide our previous key into the .pre-ditto slot, or --unset would later
  // "restore" the codex-app login instead of removing it.
  const authIsOurs = record !== undefined && authKind === "api-key" && authRaw === `${JSON.stringify({ OPENAI_API_KEY: record.key }, null, 2)}\n`;
  const authBackupKept = authKind !== "absent" && !authIsOurs ? await backupOnce(authPath, authBackupPath) : false;
  const configBackupKept = configRaw !== undefined ? await backupOnce(configPath, configBackupPath) : false;
  await writeFile(configPath, newConfig, { mode: 0o600 });
  await writeFile(authPath, `${JSON.stringify({ OPENAI_API_KEY: key.key }, null, 2)}\n`, { mode: 0o600 });
  await chmod(authPath, 0o600);
  await chmod(configPath, 0o600);
  if (authBackupKept) log(`previous login backed up to ${c("bold", authBackupPath)}`);
  if (configBackupKept) log(`previous config backed up to ${c("bold", configBackupPath)}`);

  // The app's model picker lists the endpoint's models only when the
  // endpoint says so; without it the app shows the OpenAI catalog and GLM
  // Flash is nowhere in it.
  let pickerEnabled = false;
  if (options.models !== false) {
    const current = endpoint.providerOptions as Record<string, unknown> | undefined;
    if (current?.codex_models !== true) {
      try {
        await updateEndpoint(endpoint.id, { providerOptions: { ...(current ?? {}), codex_models: true } });
        pickerEnabled = true;
      } catch (err) {
        log(`${c("yellow", "could not enable the model picker on this endpoint")} (${err instanceof Error ? err.message : String(err)}); enable it with \`heyditto endpoints set ${endpoint.slug} --codex-models on\``);
      }
    }
  }

  // Rotate: the previous run's key has no reason to outlive its replacement.
  if (record?.keyId) {
    try {
      await revokeKey(record.endpointId, record.keyId);
      log(`revoked the previous codex-app key …${record.keyHint}`);
    } catch {
      log(`${c("yellow", "could not revoke the previous codex-app key")} …${record.keyHint}; it expires on its own`);
    }
  }

  await updateStoredAuth({
    codexApp: {
      endpointId: endpoint.id,
      endpointSlug: endpoint.slug,
      keyId: key.id,
      keyHint: key.keyHint,
      key: key.key,
      baseUrl,
      forcedLogin: "api",
      ...(pinningModel ? { model: options.model as string, previousModel: previousModel ?? null } : {}),
      previousBaseUrl,
      previousForcedLogin,
      wiredAt: new Date().toISOString(),
    },
  });

  log(`endpoint=${c(["bold", "cyan"], endpoint.slug)}  key=…${key.keyHint}  expires=${expiresIn}  codexHome=${home}`);
  log(`wrote ${c("bold", "openai_base_url")} into ${configPath}`);
  log(`wrote ${c("bold", 'forced_login_method = "api"')} so the app uses this key instead of a ChatGPT OAuth login (which would 401 against the gateway)`);
  log(`wrote the endpoint key to ${authPath}${authBackupKept ? ` (backup: ${authBackupPath})` : ""}`);
  if (pickerEnabled) log(`enabled the model picker on ${endpoint.slug} — the app's /model lists its models`);
  log(`traces: ${c(["underline", "cyan"], endpointURL(endpoint.id))}`);
  log(`(re)start the Codex app. On the sign-in screen pick ${c("bold", '"Sign in with an API key"')}; the key written above is the one it asks for.${options.showKey ? "" : " Print it with --show-key."}`);
  if (options.showKey) log(`endpoint key: ${c("bold", key.key)}`);
  log(`${c("yellow", "note:")} ~/.codex is shared with the codex CLI — bare \`codex\` runs now route through Ditto too. \`heyditto codex\` is unaffected.`);
  log(`undo with: ${c("bold", "heyditto codex-app --unset")}`);
}

/** Registers `codex-app` on the program (which must have enablePositionalOptions()). */
export function registerCodexAppCommand(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  addExamples(
    program
      .command("codex-app")
      .description(
        'wire the Codex desktop app (ChatGPT.app) to a Ditto inference endpoint, so its models work behind the app\'s "Sign in with an API key"',
      )
      .summary("wire the Codex desktop app to a Ditto endpoint")
      .option("-e, --endpoint <slug>", "inference endpoint slug or id (default: saved default, or a picker)")
      .option("--budget <tokens>", "spend cap for the app's key, in Ditto tokens")
      .addOption(
        new Option("--expires <duration>", "server-side expiry for the app's key (replaced on the next run, revoked by --unset)")
          .choices([...KEY_EXPIRIES])
          .default(DEFAULT_LAUNCH_EXPIRY),
      )
      .option("--model <id>", "pin the app's model (writes `model` in config.toml; otherwise pick models in the app)")
      .option("--no-models", "do not enable the endpoint's model picker (codex_models)")
      .option("--name <label>", "key name shown in the Ditto app (default: cli:codex-app:<hostname>)")
      .option("--show-key", "print the endpoint key after wiring (for pasting into the app's sign-in screen)")
      .option("--unset", "restore the previous config.toml/auth.json and revoke the key")
      .option("-y, --yes", "replace an existing Codex login without asking")
      .option("--dry-run", "print what would be written without touching anything")
      .action(async (options: CodexAppOptions) => {
        await runCodexApp(options);
      }),
    `  heyditto codex-app                          sign in, pick an endpoint, wire the app
  heyditto codex-app --endpoint my-endpoint --budget 500000
  heyditto codex-app --model glm-5.3-flash    pin the app's model
  heyditto codex-app --dry-run                show what would be written
  heyditto codex-app --unset                  restore the previous wiring and revoke the key`,
  );
}
