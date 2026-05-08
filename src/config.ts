import os from "node:os";
import path from "node:path";
import { readStoredKey } from "./store.js";

export const packageName = "@heyditto/cli";
export const packageVersion = "1.0.0";

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

export function newKeyURL(): string {
  return "https://app.heyditto.ai/mcp/newkey";
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
