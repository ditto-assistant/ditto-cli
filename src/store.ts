import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { authFilePath } from "./config.js";

export interface StoredAuth {
  apiKey?: string;
  agentMode?: boolean;
  agentAccountID?: string;
  agentUserID?: string;
  agentCaller?: string;
  claimURL?: string;
  createdAt?: string;
}

export async function readStoredAuth(): Promise<StoredAuth | undefined> {
  try {
    const raw = await readFile(authFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as StoredAuth;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function readStoredKey(): Promise<string | undefined> {
  const parsed = await readStoredAuth();
  const key = parsed?.apiKey?.trim();
  return key && key.length > 0 ? key : undefined;
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  const cleaned = auth.apiKey?.trim();
  if (!cleaned) throw new Error("refusing to store empty api key");
  const path = authFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ ...auth, apiKey: cleaned }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeStoredKey(key: string): Promise<void> {
  const cleaned = key.trim();
  if (!cleaned) throw new Error("refusing to store empty api key");
  await writeStoredAuth({ apiKey: cleaned });
}

export async function clearStoredKey(): Promise<boolean> {
  try {
    await rm(authFilePath());
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
