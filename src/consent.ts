import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * `heyditto consent`: get the Ditto Terms of Service and AI processing
 * accepted for the account this CLI signs in as.
 *
 * Accepting is a person's decision, so the CLI never accepts anything itself.
 * It asks Ditto for a short approval link (device-code style), shows it, and
 * waits while the person who owns the account opens it, signs in and accepts.
 * For an agent account a person has claimed, that is the person who claimed
 * it, and the acceptance is recorded on their account. An agent account nobody
 * has claimed yet has no owner to ask: the person claims it first with the
 * claim link from `heyditto init`, and accepts as part of claiming.
 *
 * Both steps are Ditto MCP tools, so this works for every kind of key: a
 * person's own, a claimed agent's and an unclaimed agent's.
 */

export const CONSENT_STATUS_TOOL = "consent_status";
export const REQUEST_CONSENT_TOOL = "request_consent";

/** What `consent_status` reports. Unknown fields are kept for JSON output. */
export interface ConsentStatus {
  complete: boolean;
  terms?: boolean;
  ai?: boolean;
  account?: string;
  message?: string;
  request?: ConsentRequest | null;
  [key: string]: unknown;
}

/** What `request_consent` returns. */
export interface ConsentRequest {
  /** "pending" while waiting; "complete" when already accepted; "needs_claim" for an unclaimed agent. */
  status: string;
  url?: string;
  code?: string;
  expiresAt?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ConsentOptions {
  wait: boolean;
  open: boolean;
  json: boolean;
  /** Claim link saved by `heyditto init`, shown when the agent is unclaimed. */
  claimURL?: string;
  pollMs?: number;
  /** Used when the request carries no expiry. */
  timeoutMs?: number;
}

export interface ConsentIO {
  out: (text: string) => void;
  err: (text: string) => void;
  openURL: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Outcome of a run; the caller turns it into the exit code. */
export type ConsentOutcome = "complete" | "pending" | "needs_claim";

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const UNSUPPORTED =
  "this Ditto server cannot ask for consent from the CLI yet. Open https://app.heyditto.ai/mcp, " +
  "sign in to the account and accept there.";

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Calls a consent tool and parses the JSON object in its first text block. */
async function callJSON<T>(client: Pick<Client, "callTool">, name: string): Promise<T> {
  let result: unknown;
  try {
    result = await client.callTool({ name, arguments: {} });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found|unknown tool|-32602/i.test(message)) throw new Error(UNSUPPORTED);
    throw err;
  }
  const text = textOf(result);
  if ((result as { isError?: unknown }).isError) {
    if (/not found|unknown tool/i.test(text)) throw new Error(UNSUPPORTED);
    throw new Error(text || `${name} failed`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
  } catch {
    /* fall through */
  }
  throw new Error(`${name} returned an unexpected response`);
}

function deadlineOf(request: ConsentRequest, now: number, fallbackMs: number): number {
  const at = request.expiresAt ? Date.parse(request.expiresAt) : Number.NaN;
  return Number.isFinite(at) && at > now ? at : now + fallbackMs;
}

export async function runConsent(client: Pick<Client, "callTool">, options: ConsentOptions, io: ConsentIO): Promise<ConsentOutcome> {
  const emit = (value: unknown, text: string) => io.out(options.json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);

  const status = await callJSON<ConsentStatus>(client, CONSENT_STATUS_TOOL);
  if (status.complete) {
    emit(status, "The Terms of Service and AI processing are already accepted for this account.");
    return "complete";
  }

  const request = await callJSON<ConsentRequest>(client, REQUEST_CONSENT_TOOL);
  if (request.status === "complete") {
    emit(request, "The Terms of Service and AI processing are already accepted for this account.");
    return "complete";
  }
  if (request.status === "needs_claim") {
    const lines = [request.message || "This agent account has no owner yet. A person has to claim it, and accepts the Terms while claiming."];
    if (options.claimURL) lines.push(`Claim link: ${options.claimURL}`);
    emit({ ...request, ...(options.claimURL ? { claimURL: options.claimURL } : {}) }, lines.join("\n"));
    return "needs_claim";
  }
  if (!request.url) throw new Error(`${REQUEST_CONSENT_TOOL} returned no link`);

  io.err(`${request.message || "Ask the person who owns this Ditto account to open this link, sign in and accept the Terms of Service and AI processing:"}\n`);
  io.err(`  ${request.url}\n`);
  if (request.code) io.err(`  Code: ${request.code}\n`);
  if (options.open) io.openURL(request.url);

  if (!options.wait) {
    emit(request, request.url);
    return "pending";
  }

  io.err("Waiting for the account owner to accept (Ctrl-C to stop; run `heyditto consent` again any time)...\n");
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = deadlineOf(request, io.now(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (io.now() < deadline) {
    await io.sleep(pollMs);
    const next = await callJSON<ConsentStatus>(client, CONSENT_STATUS_TOOL);
    if (next.complete) {
      emit(next, "Accepted. Ditto can run for this account now.");
      return "complete";
    }
  }
  throw new Error("the link expired before it was accepted; run `heyditto consent` for a new one");
}
