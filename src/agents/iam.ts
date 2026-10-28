import type { InferenceEndpoint } from "../api.js";
import type { KeyExpiry } from "./types.js";

/** The server's current rights choose only an omitted/default launch lifetime.
 * Explicit --expires remains explicit and is still checked by the server. */
export function iamLaunchExpiry(endpoint: InferenceEndpoint, requested: KeyExpiry, explicit: boolean): KeyExpiry {
  const access = endpoint.access;
  if (explicit || !access?.iamEnforced || !access.createSession || access.createKey) return requested;
  const max = access.maxSessionSeconds;
  if (!Number.isSafeInteger(max) || max === undefined || max <= 0) throw new Error("the endpoint did not provide a valid temporary session lifetime");
  for (const [expiry, seconds] of [["12h",43200],["8h",28800],["4h",14400],["1h",3600]] as const) {
    if (seconds <= Math.min(max,43200)) return expiry;
  }
  throw new Error("the endpoint's temporary session lifetime is shorter than this client supports");
}
