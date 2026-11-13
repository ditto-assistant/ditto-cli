import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

export interface CliProxy {
  /** Canonical loopback OpenAI/Responses root. */
  baseUrl: string;
  /** Local credential, never a Ditto endpoint key. */
  apiKey: string;
  models: string[];
}

/** Deliberately no public/LAN destinations, embedded credentials or redirects. */
export function cliProxyBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("CLIProxy URL must be an http(s) loopback URL, such as http://127.0.0.1:8317/v1"); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("CLIProxy requires a loopback URL with no credentials, query or fragment, ending in /v1 or /");
  }
  // Pin localhost rather than resolving it through potentially modified DNS.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  url.pathname = "/v1";
  return url.toString().replace(/\/$/, "");
}

export function cliProxyConfigPaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string[] {
  if (env.CLIPROXY_CONFIG) return [env.CLIPROXY_CONFIG];
  if (platform === "darwin") return [path.join(home, "Library", "Application Support", "com.cpa.gui", "config.toml")];
  if (platform === "win32") return [path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "com.cpa.gui", "config.toml")];
  return [
    path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "com.cpa.gui", "config.toml"),
    path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "com.cpa.gui", "config.toml"),
  ];
}

/** Reads only the API access key; OAuth/provider/management credentials stay untouched. */
export async function resolveCliProxy(requested: string | true, env: NodeJS.ProcessEnv = process.env): Promise<CliProxy> {
  let config: Record<string, unknown> | undefined;
  const explicitUrl = typeof requested === "string" ? requested : env.CLIPROXY_BASE_URL;
  for (const file of explicitUrl && env.CLIPROXY_API_KEY ? [] : cliProxyConfigPaths(env)) {
    try { config = parse(await readFile(file, "utf8")) as Record<string, unknown>; break; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && !env.CLIPROXY_CONFIG) continue;
      throw new Error("Could not read CLIProxy configuration; check CLIPROXY_CONFIG or set CLIPROXY_BASE_URL and CLIPROXY_API_KEY");
    }
  }
  let detectedUrl: string | undefined;
  if (config) {
    const port = config.port;
    const host = config.host === "::1" ? "[::1]" : (config.host || "127.0.0.1");
    if (typeof host === "string" && typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
      try { detectedUrl = cliProxyBaseUrl(`http://${host}:${port}`); }
      catch { /* A LAN-configured application is not eligible for auto-discovery. */ }
    }
  }
  const baseUrl = cliProxyBaseUrl(typeof requested === "string" ? requested : env.CLIPROXY_BASE_URL || detectedUrl || "http://127.0.0.1:8317/v1");
  const keys = config?.["api-keys"];
  // EasyCLIProxyAPI also writes annotated entries as [[api-keys]] tables.
  // Only their access-key field is relevant; remarks are display metadata.
  const detectedKey = detectedUrl === baseUrl && Array.isArray(keys)
    ? keys.map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" && "key" in entry ? entry.key : undefined)
      .find((key): key is string => typeof key === "string" && Boolean(key.trim()))
    : undefined;
  const apiKey = env.CLIPROXY_API_KEY || detectedKey || "";
  if (!apiKey || /[\r\n]/.test(apiKey)) {
    throw new Error("No CLIProxy API access key found; set CLIPROXY_API_KEY or configure an API key in EasyCLIProxyAPI");
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error("CLIProxy is not reachable at the configured loopback address; start the proxy and check its port. Ditto Router inference was not used");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`CLIProxy model check failed (HTTP ${response.status}); check its API access key and provider setup. Ditto Router inference was not used`);
  }
  let data: { object?: unknown; data?: Array<{ id?: unknown }> };
  try { data = await response.json() as typeof data; }
  catch { throw new Error("CLIProxy returned an invalid model catalog; Ditto Router inference was not used"); }
  if (data?.object !== "list" || !Array.isArray(data.data)) throw new Error("CLIProxy returned an invalid model catalog; Ditto Router inference was not used");
  const models = data.data.flatMap((model) => typeof model?.id === "string" && model.id.trim() ? [model.id] : []);
  if (!models.length) throw new Error("CLIProxy has no models; connect a provider in the proxy before launching");
  return { baseUrl, apiKey, models };
}

/**
 * Environment fallback for `--auto-mode-classifier`, so a T3 launcher (or a
 * shell profile) can opt every CLIProxy Claude launch in.
 */
export const AUTO_MODE_CLASSIFIER_ENV = "DITTO_AUTO_MODE_CLASSIFIER";

/**
 * Set beside CLAUDE_CODE_AUTO_MODE_MODEL when a launch applied the classifier
 * id, so a later launch inside that session can tell the id it inherited from
 * one the user chose, and drop only the former.
 */
export const CLASSIFIER_APPLIED_ENV = "DITTO_AUTO_MODE_CLASSIFIER_APPLIED";

const CLASSIFIER_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Syntax and dedication rules for a classifier id, without a proxy at hand. */
export function assertClassifierModelId(id: string): string {
  if (!CLASSIFIER_MODEL_ID.test(id)) throw new Error("--auto-mode-classifier needs a model id of lowercase letters, digits, '.', '_' or '-' (at most 64 characters)");
  if (id.startsWith("claude-")) throw new Error("--auto-mode-classifier needs a dedicated model id, not a Claude model id; CLIProxy serves claude-* ids from your subscriptions");
  return id;
}

/**
 * The model id Claude Code's Auto Mode permission classifier should request
 * through CLIProxy, or why it keeps Claude Code's default.
 *
 * Claude Code reads CLAUDE_CODE_AUTO_MODE_MODEL only for the classifier, so a
 * dedicated id is the one structural signal that tells a proxy "this request
 * is a permission check" without looking at prompt text. The id must be
 * dedicated: a claude-* id would be served by the subscriptions under the
 * same name, and the main model's id would send the main loop to the route.
 * When CLIProxy does not list the id, nothing is set and the classifier stays
 * on its default model: an id nobody serves would fail every check, and Claude
 * Code blocks the action whenever its classifier cannot answer.
 */
export function cliProxyClassifierModel(proxy: Pick<CliProxy, "models">, requested: string | undefined, mainModel?: string): { model?: string; notice?: string } {
  const id = requested?.trim();
  if (!id) return {};
  assertClassifierModelId(id);
  if (mainModel !== undefined && id === mainModel) throw new Error("--auto-mode-classifier cannot be the session's main model");
  if (!proxy.models.includes(id)) {
    return { notice: `auto-mode classifier ${id} is not in CLIProxy's model catalog; permission checks keep Claude Code's default classifier model` };
  }
  return { model: id };
}

export function cliProxyModel(proxy: Pick<CliProxy, "models">, harness: "claude" | "codex", requested?: string): string {
  if (requested) {
    if (!proxy.models.includes(requested)) throw new Error("The requested model is not in CLIProxy's model catalog; select a model exposed by your local proxy");
    return requested;
  }
  const pattern = harness === "claude" ? /^claude-/ : /^(gpt-|o[1-9])/;
  const model = proxy.models.find((id) => pattern.test(id));
  if (!model) throw new Error(`CLIProxy has no default ${harness} model; pass --model with an ID exposed by your local proxy`);
  return model;
}
