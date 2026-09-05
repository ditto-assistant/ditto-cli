import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { readStoredKey } from "./store.js";

const requirePkg = createRequire(import.meta.url);
const pkg = requirePkg("../package.json") as { name: string; version: string };

export const packageName = pkg.name;
export const packageVersion = pkg.version;

export function apiBaseURL(): string {
  return (process.env.DITTO_API_BASE || "https://api.heyditto.ai").replace(/\/+$/, "");
}

export function mcpServerURL(): string {
  return `${apiBaseURL()}/mcp`;
}

export function configDir(): string {
  if (process.env.DITTO_CONFIG_DIR) return process.env.DITTO_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "heyditto", "cli");
}

export function authFilePath(): string {
  return path.join(configDir(), "config.json");
}

/** Directory holding one JSON record per coding-agent session launched by the CLI. */
export function sessionsDir(): string {
  return path.join(configDir(), "sessions");
}

/** Ditto web app base URL (browser pages: /device, /settings/…, /agent/claim). */
export function appBaseURL(): string {
  return (process.env.DITTO_APP_BASE || "https://app.heyditto.ai").replace(/\/+$/, "");
}

export function newKeyURL(): string {
  return `${appBaseURL()}/mcp/newkey`;
}

/** Ditto developer console base URL (inference endpoints live at /endpoints and /endpoints/<id>). */
export function developerBaseURL(): string {
  return (process.env.DITTO_DEVELOPER_BASE || "https://developer.heyditto.ai").replace(/\/+$/, "");
}

/** An endpoint's page in the developer console, or the endpoints list when no id is given. */
export function endpointURL(id?: string): string {
  const base = `${developerBaseURL()}/endpoints`;
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

export function agentSignupURL(): string {
  return `${apiBaseURL()}/api/v5/agents/signup`;
}

export type ApiKeySource = "env" | "config" | "none";

export interface ResolvedKey {
  key?: string;
  source: ApiKeySource;
}

export async function resolveApiKey(): Promise<ResolvedKey> {
  const envKey = process.env.DITTO_API_KEY?.trim();
  if (envKey) return { key: envKey, source: "env" };
  const stored = await readStoredKey();
  if (stored) return { key: stored, source: "config" };
  return { source: "none" };
}
