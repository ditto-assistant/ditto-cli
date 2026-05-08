import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { authFilePath } from "./config.js";

interface StoredAuth {
  apiKey?: string;
}

export async function readStoredKey(): Promise<string | undefined> {
  try {
    const raw = await readFile(authFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as StoredAuth;
    const key = parsed.apiKey?.trim();
    return key && key.length > 0 ? key : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeStoredKey(key: string): Promise<void> {
  const cleaned = key.trim();
  if (!cleaned) throw new Error("refusing to store empty api key");
  const path = authFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ apiKey: cleaned }, null, 2)}\n`, { mode: 0o600 });
  // chmod again so existing files inherit 0o600 even if writeFile reused mode.
  await chmod(path, 0o600);
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
