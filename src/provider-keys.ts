import { createInterface } from "node:readline/promises";
import type { Command, Option } from "commander";
import { ApiError, NO_KEY_MESSAGE, apiFetch } from "./api.js";
import { openInBrowser } from "./browser.js";
import { confirmTyped, isJSON } from "./commands.js";
import { deviceLogin } from "./device-login.js";
import { saveLogin } from "./store.js";

/**
 * Provider keys (GM, Engy, Instant, OpenRouter, OpenAI, Anthropic, Google, …)
 * live in the user's Ditto account, where Router endpoints bill to them. The
 * CLI writes them and never reads them back: the API returns metadata only.
 * Writing needs a sign-in approved for key access (`heyditto login --keys`).
 */

export interface ProviderKey {
  id: string;
  provider: string;
  label?: string;
  modelAllow?: string[];
  modelDeny?: string[];
  configured: boolean;
  enabled: boolean;
}

export interface KeyProvider {
  id: string;
  displayName: string;
  docsUrl: string;
  keyPrefixHints?: string[];
}

export interface KeyValidation {
  ok: boolean;
  status?: number;
  error?: string;
  checkedAt: string;
}

const BASE = "/api/v5/inference/provider-keys";

/** Spellings people use for the providers Ditto stores under another id. */
const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "claude",
  google: "google-ai",
  gemini: "google-ai",
  google_gemini: "google-ai",
};

export function normalizeProvider(raw: string): string {
  const id = raw.trim().toLowerCase();
  return PROVIDER_ALIASES[id] ?? id;
}

/** A CLI-side failure with a stable code, printed as JSON under --output json. */
export class KeysError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "KeysError";
  }
}

/** Metadata only: drops anything else a server might add to a key. */
function keyMetadata({ id, provider, label, modelAllow, modelDeny, configured, enabled }: ProviderKey): ProviderKey {
  return { id, provider, label, modelAllow, modelDeny, configured, enabled };
}

/** How a key is named in messages: `gm`, or `gm "work"` for a named key. */
export function keyName(key: { provider: string; label?: string }): string {
  return key.label ? `${key.provider} "${key.label}"` : key.provider;
}

export async function listProviderKeys(): Promise<{ keys: ProviderKey[] }> {
  const response = await apiFetch<{ keys?: ProviderKey[] }>(BASE);
  if (!response || !Array.isArray(response.keys)) throw new Error("Ditto returned an invalid provider-key list");
  return { keys: response.keys.map(keyMetadata) };
}

export async function listKeyProviders(): Promise<{ providers: KeyProvider[] }> {
  const response = await apiFetch<{ providers?: KeyProvider[] }>(`${BASE}/providers`);
  if (!response || !Array.isArray(response.providers)) throw new Error("Ditto returned an invalid provider list");
  return { providers: response.providers };
}

export async function saveProviderKey(input: { provider: string; label?: string; key: string; enabled?: boolean }): Promise<{ key: ProviderKey; validation?: KeyValidation }> {
  const key = input.key.trim();
  if (!key) throw new KeysError("empty_key", "no key given: pipe it on stdin or paste it at the prompt");
  const body: Record<string, unknown> = { provider: normalizeProvider(input.provider), key };
  const label = input.label?.trim();
  if (label) body.label = label;
  if (input.enabled === false) body.enabled = false;
  const response = await apiFetch<{ key?: ProviderKey; validation?: KeyValidation }>(BASE, { method: "POST", body });
  if (!response?.key) throw new Error("Ditto returned an invalid provider-key response");
  return { key: keyMetadata(response.key), ...(response.validation ? { validation: response.validation } : {}) };
}

export async function setProviderKeyEnabled(id: string, enabled: boolean): Promise<{ key: ProviderKey }> {
  const response = await apiFetch<{ key?: ProviderKey }>(`${BASE}/${encodeURIComponent(id)}`, { method: "PATCH", body: { enabled } });
  if (!response?.key) throw new Error("Ditto returned an invalid provider-key response");
  return { key: keyMetadata(response.key) };
}

export async function removeProviderKey(id: string): Promise<Record<string, never>> {
  return apiFetch(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function validateProviderKey(id: string): Promise<{ validation: KeyValidation }> {
  return apiFetch(`${BASE}/${encodeURIComponent(id)}/validate`, { method: "POST" });
}

/** Finds the key a command names: its id, or a provider (plus --label). */
export async function resolveProviderKey(target: string, label?: string): Promise<ProviderKey> {
  const { keys } = await listProviderKeys();
  const byId = keys.find((k) => k.id === target.trim());
  if (byId) return byId;
  const provider = normalizeProvider(target);
  const wanted = label?.trim() ?? "";
  const match = keys.find((k) => k.provider === provider && (k.label ?? "") === wanted);
  if (!match) {
    throw new KeysError("key_not_found", `no ${provider}${wanted ? ` "${wanted}"` : ""} key in your Ditto account (see 'heyditto keys list')`);
  }
  return match;
}

/** The backend's error code on an API failure, when it sent one. */
export function apiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  try {
    const code = (JSON.parse(error.body) as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The server's own message for an API failure, else the error's. */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const message = (JSON.parse(error.body) as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    } catch {
      /* raw body */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** Machine-readable failure for --output json: one object on stdout, exit 1. */
export function errorJSON(error: unknown): { error: { code: string; message: string; status?: number } } {
  let code = error instanceof KeysError ? error.code : apiErrorCode(error);
  if (!code && error instanceof Error && error.message.startsWith(NO_KEY_MESSAGE.slice(0, 20))) code = "not_logged_in";
  const status = error instanceof ApiError ? error.status : undefined;
  return { error: { code: code ?? "error", message: errorMessage(error), ...(status ? { status } : {}) } };
}

/**
 * Keystrokes of a hidden prompt in raw mode. Enter or Ctrl-D ends it, Ctrl-C
 * cancels, backspace edits. Terminal escape sequences (arrow keys, Home, …)
 * and other control characters are dropped, never saved as part of the key.
 */
export class SecretInput {
  value = "";
  private escape: "start" | "csi" | "ss3" | undefined;

  /** Feeds raw input; "done" or "cancel" once the prompt is over. */
  feed(chunk: string): "done" | "cancel" | undefined {
    for (const ch of chunk) {
      if (this.escape === "start") {
        this.escape = ch === "[" ? "csi" : ch === "O" ? "ss3" : undefined;
        continue;
      }
      if (this.escape === "csi") {
        if (ch >= "@" && ch <= "~") this.escape = undefined;
        continue;
      }
      if (this.escape === "ss3") {
        this.escape = undefined;
        continue;
      }
      if (ch === "\u001b") this.escape = "start";
      else if (ch === "\r" || ch === "\n" || ch === "\u0004") return "done";
      else if (ch === "\u0003") return "cancel";
      else if (ch === "\u007f" || ch === "\b") this.value = this.value.slice(0, -1);
      else {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) this.value += ch;
      }
    }
    return undefined;
  }
}

/** Reads the key without echoing it: stdin when piped, else a hidden prompt. */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    for await (const chunk of process.stdin) buf += chunk;
    return buf.trim();
  }
  // Raw mode with no echo at all: readline would print what is typed.
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.setEncoding("utf-8");
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      const input = new SecretInput();
      const onData = (chunk: string) => {
        const end = input.feed(chunk);
        if (!end) return;
        stdin.off("data", onData);
        if (end === "done") resolve(input.value.trim());
        else reject(new Error("cancelled"));
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
}

/** Signs in through the browser with key access and saves the new key. */
export async function loginForKeys(): Promise<void> {
  const result = await deviceLogin({
    intent: "keys",
    onCode: (userCode, url) => {
      process.stderr.write(
        `\nApprove key access in your browser:\n\n  ${url}\n\n  Code: ${userCode}\n\nOpening your browser…\n`,
      );
      openInBrowser(url);
      process.stderr.write("Waiting for approval in the browser (Ctrl+C to cancel)…\n");
    },
  });
  await saveLogin(result.apiKey);
}

/**
 * Runs a write; when this sign-in can't manage keys and a person is at the
 * terminal, offers to sign in again with key access and retries once.
 */
async function withKeyAccess<T>(json: boolean, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (apiErrorCode(error) !== "provider_keys_not_granted" || json || !process.stdin.isTTY || !process.stderr.isTTY) throw error;
    if (process.env.DITTO_API_KEY) {
      throw new KeysError("provider_keys_not_granted",
        "the key in DITTO_API_KEY can't manage provider keys. Unset it and run 'heyditto login --keys', or use a key approved for key access.");
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let answer: string;
    try {
      answer = (await rl.question("This sign-in can't manage provider keys. Sign in again with key access now? [Y/n] ")).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer !== "" && answer !== "y" && answer !== "yes") throw error;
    await loginForKeys();
    return write();
  }
}

/** Wraps an action so --output json failures print one JSON object on stdout. */
function action<A extends unknown[]>(run: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const options = args.find((a): a is { output?: string } => typeof a === "object" && a !== null && "output" in (a as object)) ?? {};
    try {
      await run(...args);
    } catch (error) {
      if (!isJSON(options)) throw error;
      process.stdout.write(`${JSON.stringify(errorJSON(error), null, 2)}\n`);
      process.exitCode = 1;
    }
  };
}

function print(options: { output?: string }, value: unknown, text: string): void {
  process.stdout.write(isJSON(options) ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function describeValidation(name: string, validation: KeyValidation | undefined): string {
  if (!validation) return "";
  if (validation.ok) return `${name} accepted the key.\n`;
  const why = [validation.status ? `HTTP ${validation.status}` : "", validation.error ?? ""].filter(Boolean).join(": ");
  return `${name} refused the key${why ? ` (${why})` : ""}. It is saved anyway; replace it with 'heyditto keys set'.\n`;
}

interface KeyOptions {
  output?: string;
  label?: string;
}

export function registerKeyCommands(
  program: Command,
  addExamples: (command: Command, examples: string) => Command,
  outputOption: () => Option,
): void {
  const keys = program
    .command("keys")
    .description("manage the AI provider keys in your Ditto account (GM, OpenRouter, OpenAI, …); never shown back");

  addExamples(
    keys
      .command("list")
      .description("list your provider keys (metadata only)")
      .addOption(outputOption())
      .action(action(async (options: KeyOptions) => {
        const result = await listProviderKeys();
        const lines = result.keys.map((k) => `${keyName(k)}  ${k.configured && k.enabled ? "on" : "off"}  ${k.id}\n`);
        print(options, result, `Provider keys in Ditto (${result.keys.length}; keys are never shown)\n${lines.join("")}`);
      })),
    `  heyditto keys list
  heyditto keys list --output json`,
  );

  keys
    .command("providers")
    .description("list the providers you can save a key for")
    .addOption(outputOption())
    .action(action(async (options: KeyOptions) => {
      const result = await listKeyProviders();
      const lines = result.providers.map((p) => `${p.id}  ${p.displayName}  ${p.docsUrl}\n`);
      print(options, result, lines.join(""));
    }));

  addExamples(
    keys
      .command("set")
      .description("save or replace a provider key in Ditto (read from stdin or a hidden prompt)")
      .argument("<provider>", "provider id, e.g. gm, engy, instant, openrouter, openai, anthropic, google")
      .option("--label <label>", "name the key, to keep several for one provider (replaces the key with that name)")
      .option("--disabled", "save it turned off")
      .addOption(outputOption())
      .action(action(async (providerArg: string, options: KeyOptions & { disabled?: boolean }) => {
        const provider = normalizeProvider(providerArg);
        const label = options.label?.trim();
        const secret = await readSecret(`Paste your ${keyName({ provider, label })} key (input hidden): `);
        let result: Awaited<ReturnType<typeof saveProviderKey>>;
        try {
          result = await withKeyAccess(isJSON(options), () => saveProviderKey({ provider, label, key: secret, enabled: !options.disabled }));
        } catch (error) {
          if (apiErrorCode(error) !== "provider_key_limit") throw error;
          throw new KeysError("provider_key_limit",
            `your Ditto plan allows no more ${provider} keys. Replace one by saving it under the same --label, remove one, or upgrade your plan.`);
        }
        print(options, result,
          `Saved your ${keyName(result.key)} key to Ditto${result.key.enabled ? "" : " (turned off)"}.\n${describeValidation(keyName(result.key), result.validation)}`);
      })),
    `  heyditto keys set openrouter              (prompts, input hidden)
  printf %s "$GM_KEY" | heyditto keys set gm --output json
  heyditto keys set gm --label work         (a second, named gm key)`,
  );

  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    keys
      .command(name)
      .description(`turn a provider key ${enabled ? "on" : "off"}`)
      .argument("<key>", "provider id or key id")
      .option("--label <label>", "a named key of that provider")
      .addOption(outputOption())
      .action(action(async (target: string, options: KeyOptions) => {
        const key = await resolveProviderKey(target, options.label);
        const result = await withKeyAccess(isJSON(options), () => setProviderKeyEnabled(key.id, enabled));
        print(options, result, `Turned ${enabled ? "on" : "off"} your ${keyName(result.key)} key.\n`);
      }));
  }

  keys
    .command("remove")
    .description("remove a provider key from Ditto")
    .argument("<key>", "provider id or key id")
    .option("--label <label>", "a named key of that provider")
    .option("-y, --yes", "skip the confirmation")
    .addOption(outputOption())
    .action(action(async (target: string, options: KeyOptions & { yes?: boolean }) => {
      const key = await resolveProviderKey(target, options.label);
      await confirmTyped({ action: `remove your ${keyName(key)} key from Ditto`, expected: key.provider, label: "the provider", yes: options.yes });
      await withKeyAccess(isJSON(options), () => removeProviderKey(key.id));
      print(options, { removed: key }, `Removed your ${keyName(key)} key from Ditto.\n`);
    }));

  keys
    .command("validate")
    .description("check a provider key with its provider")
    .argument("<key>", "provider id or key id")
    .option("--label <label>", "a named key of that provider")
    .addOption(outputOption())
    .action(action(async (target: string, options: KeyOptions) => {
      const key = await resolveProviderKey(target, options.label);
      const result = await validateProviderKey(key.id);
      print(options, result, describeValidation(keyName(key), result.validation));
    }));
}
