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
  /** Endpoint slug or id used by `heyditto claude` / `heyditto codex` when --endpoint is omitted. */
  defaultEndpoint?: string;
  /** Explicit MCP session (`heyditto session new`) sent as X-Ditto-Session-Id on every request. */
  activeSession?: { id: string; name?: string; createdAt?: string };
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

/** Merge fields into the stored auth file without dropping the saved key or agent fields. */
export async function updateStoredAuth(partial: Partial<StoredAuth>): Promise<StoredAuth> {
  const current = (await readStoredAuth()) ?? {};
  const merged: StoredAuth = { ...current, ...partial };
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k];
  }
  const path = authFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return merged;
}

export async function writeStoredKey(key: string): Promise<void> {
  const cleaned = key.trim();
  if (!cleaned) throw new Error("refusing to store empty api key");
  await writeStoredAuth({ apiKey: cleaned });
}

/**
 * Saves a human login. Merges into the existing file so the default endpoint
 * and the explicit MCP session survive a re-login, while any agent-account
 * fields from a previous `heyditto init` are cleared (the key now belongs to a
 * person, not a claimable agent).
 */
export async function saveLogin(key: string, extra: { defaultEndpoint?: string } = {}): Promise<StoredAuth> {
  const cleaned = key.trim();
  if (!cleaned) throw new Error("refusing to store empty api key");
  const partial: Partial<StoredAuth> = {
    apiKey: cleaned,
    agentMode: undefined,
    agentAccountID: undefined,
    agentUserID: undefined,
    agentCaller: undefined,
    claimURL: undefined,
    createdAt: new Date().toISOString(),
  };
  if (extra.defaultEndpoint) partial.defaultEndpoint = extra.defaultEndpoint;
  return updateStoredAuth(partial);
}

/**
 * The backend only stores a hash of an agent's claim token, so activation links
 * it returns for agent-created endpoints carry no `t=`. The CLI holds the
 * plaintext claim URL from `heyditto init`; copy its token onto the backend URL
 * so the agent hands its user one working link.
 */
export function mergeActivationURL(activationURL: string, storedClaimURL: string | undefined): string {
  if (!storedClaimURL) return activationURL;
  let target: URL;
  let claim: URL;
  try {
    target = new URL(activationURL);
    claim = new URL(storedClaimURL);
  } catch {
    return activationURL;
  }
  const token = claim.searchParams.get("t");
  if (!token || target.searchParams.has("t")) return activationURL;
  target.searchParams.set("t", token);
  return target.toString();
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
