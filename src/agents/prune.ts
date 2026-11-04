import { rm } from "node:fs/promises";
import os from "node:os";
import { ApiError, listKeys, revokeKey } from "../api.js";
import { configDir } from "../config.js";
import { grokHomeDir } from "./grok.js";
import { type SessionRecord, removeSession } from "./sessions.js";

/**
 * `heyditto sessions prune`: forget old coding-agent session records, the
 * launch-scoped state hanging off them (a grok session's GROK_HOME), and the
 * launch keys a launch that never reached its cleanup left live on the server.
 *
 * Planning is pure so it can be printed for --dry-run and tested without a
 * config dir; applying it is the only part that touches disk or the API.
 */

const AGE_UNITS_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

/** Parses an age such as `30d`, `12h`, `2w` or `3mo` into milliseconds. */
export function parseAge(raw: string): number {
  const m = /^(\d+)\s*(mo|m|h|d|w|y)$/.exec(raw.trim());
  if (!m) throw new Error(`--older-than must look like 30d, 12h, 2w or 3mo, got "${raw}"`);
  const ms = Number(m[1]) * AGE_UNITS_MS[m[2]];
  if (!Number.isSafeInteger(ms)) throw new Error(`--older-than is too large: "${raw}"`);
  return ms;
}

export interface PruneInput {
  /** Records whose last launch is older than this are pruned. */
  olderThanMs: number;
  /** The most recent records always stay, whatever their age. */
  keep: number;
  now?: number;
}

export interface PrunePlan {
  /** Records to forget. */
  prune: SessionRecord[];
  /** Records that stay. */
  kept: SessionRecord[];
}

/**
 * Picks the records to forget: anything last launched before the cutoff,
 * except the `keep` most recent records.
 *
 * A record with no endedAt is a launch that never reached its cleanup — the
 * wrapper was killed, or the machine went to sleep and never woke the
 * process. Once it is past the cutoff nothing will come back to stamp it, so
 * it is pruned like an ended one, and its key (which nobody revoked) goes
 * with it.
 */
export function planPrune(records: SessionRecord[], input: PruneInput): PrunePlan {
  const cutoff = (input.now ?? Date.now()) - input.olderThanMs;
  const recent = new Set(records.slice(-input.keep).map((r) => r.id));
  const prune: SessionRecord[] = [];
  const kept: SessionRecord[] = [];
  for (const record of records) {
    const launched = Date.parse(record.lastLaunchedAt);
    if (recent.has(record.id) || !Number.isFinite(launched) || launched >= cutoff) kept.push(record);
    else prune.push(record);
  }
  return { prune, kept };
}

export interface KeyToRevoke {
  endpointId: string;
  keyId: string;
  keyHint?: string;
  name?: string;
  /** Why the key is going: its record is being pruned, or nothing names it any more. */
  reason: "unfinished" | "stranded";
}

/** Keys of pruned records whose launch never revoked them (no endedAt). */
export function unfinishedKeys(plan: PrunePlan): KeyToRevoke[] {
  return plan.prune
    .filter((r) => !r.endedAt && r.keyId)
    .map((r) => ({ endpointId: r.endpointId, keyId: r.keyId as string, keyHint: r.keyHint, reason: "unfinished" }));
}

/**
 * Whether a key carries the name a launch from `host` gives it by default:
 * `cli:<harness>:<host>`. Keys named with --name are the user's to manage
 * and never match.
 */
export function isLaunchKeyName(name: string, host = os.hostname()): boolean {
  const [prefix, harness, ...rest] = name.split(":");
  return prefix === "cli" && Boolean(harness) && rest.join(":") === host;
}

/**
 * Launch keys from this machine that no remaining record accounts for: the
 * key of a record removed with `sessions rm` while it was still live, or of
 * an earlier launch of a session that was killed before it could revoke.
 *
 * Any key a remaining record still names is left alone — that session may be
 * running right now, or kept its key on purpose with --keep-key. Revoked keys
 * have nothing left to do, and expired ones are already refused by the
 * gateway, so neither is listed.
 */
export async function findStrandedKeys(
  endpointIds: Iterable<string>,
  remaining: SessionRecord[],
  now = Date.now(),
): Promise<KeyToRevoke[]> {
  const named = new Set(remaining.map((r) => r.keyId).filter((id): id is string => Boolean(id)));
  const out: KeyToRevoke[] = [];
  for (const endpointId of new Set(endpointIds)) {
    let keys;
    try {
      keys = await listKeys(endpointId);
    } catch (err) {
      // A deleted endpoint took its keys with it.
      if (err instanceof ApiError && err.status === 404) continue;
      throw err;
    }
    for (const k of keys) {
      if (k.revokedAt || named.has(k.id) || !isLaunchKeyName(k.name)) continue;
      if (k.expiresAt && Date.parse(k.expiresAt) <= now) continue;
      out.push({ endpointId, keyId: k.id, keyHint: k.keyHint, name: k.name, reason: "stranded" });
    }
  }
  return out;
}

/** Removes a session's launch-scoped files: its record and, for grok, its GROK_HOME. */
export async function removeLaunchState(id: string): Promise<boolean> {
  if (!(await removeSession(id))) return false;
  // The home holds symlinks into ~/.grok (sessions, skills, plugins); rm
  // unlinks them without following, so the user's own grok data stays put.
  await rm(grokHomeDir(configDir(), id), { recursive: true, force: true });
  return true;
}

export interface PruneResult {
  removed: string[];
  /** Records left in place because their key could not be revoked; the next prune retries them. */
  retained: string[];
  revoked: KeyToRevoke[];
  failed: Array<KeyToRevoke & { error: string }>;
}

/**
 * Applies a plan: revokes the keys first, then forgets the records, so a
 * record is never gone while the key it names is still live.
 */
export async function applyPrune(plan: PrunePlan, keys: KeyToRevoke[]): Promise<PruneResult> {
  const result: PruneResult = { removed: [], retained: [], revoked: [], failed: [] };
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key.keyId)) continue;
    seen.add(key.keyId);
    try {
      await revokeKey(key.endpointId, key.keyId);
      result.revoked.push(key);
    } catch (err) {
      result.failed.push({ ...key, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const unrevoked = new Set(result.failed.map((f) => f.keyId));
  for (const record of plan.prune) {
    if (record.keyId && unrevoked.has(record.keyId)) {
      result.retained.push(record.id);
      continue;
    }
    await removeLaunchState(record.id);
    result.removed.push(record.id);
  }
  return result;
}
