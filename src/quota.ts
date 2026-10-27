import { mergeActivationURL } from "./store.js";

/**
 * A plan-limit denial from the Ditto API or an MCP tool, as the backend emits
 * it: `code: "memory_quota_exceeded"` (HTTP 429) with the resource figures under
 * `params`, and optionally `upgradeUrl` / `agentInstructions` supplied by the
 * server. An autonomous agent cannot read a paywall, so the CLI turns the
 * denial into one plain instruction it can act on or relay to its owner.
 */
export interface QuotaNotice {
  code: string;
  resource?: string;
  limit?: number;
  used?: number;
  resetsAt?: string;
  upgradeUrl?: string;
  agentInstructions?: string;
}

const QUOTA_CODES = new Set(["memory_quota_exceeded", "resource_funds_exhausted", "resource_allowance_exhausted"]);

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** Reads a quota denial out of a parsed response body, or undefined if it is some other error. */
export function parseQuotaNotice(body: unknown): QuotaNotice | undefined {
  if (!body || typeof body !== "object") return undefined;
  const top = body as Record<string, unknown>;
  const root = (top.error && typeof top.error === "object" ? top.error : top) as Record<string, unknown>;
  const code = str(root.code);
  const isUpgrade = str(root.action) === "upgrade";
  if (!code || (!QUOTA_CODES.has(code) && !isUpgrade)) return undefined;
  const params = (root.params && typeof root.params === "object" ? root.params : {}) as Record<string, unknown>;
  return {
    code,
    resource: str(params.resource) ?? str(root.resource),
    limit: num(params.limit) ?? num(root.limit),
    used: num(params.used) ?? num(root.used),
    resetsAt: str(params.resetsAt) ?? str(root.resetsAt),
    upgradeUrl: str(root.upgradeUrl) ?? str(params.upgradeUrl),
    agentInstructions: str(root.agentInstructions) ?? str(params.agentInstructions),
  };
}

/** Same, from raw response text (HTTP body or an MCP text block). */
export function parseQuotaNoticeText(text: string | undefined): QuotaNotice | undefined {
  if (!text) return undefined;
  try {
    return parseQuotaNotice(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The instruction an agent should act on. `storedClaimURL` is the agent account's claim link, if it has one. */
export function formatQuotaNotice(notice: QuotaNotice, storedClaimURL?: string): string {
  const what = notice.resource ? notice.resource.replace(/_/g, " ") : "plan";
  const figures = notice.limit !== undefined && notice.used !== undefined ? ` (${notice.used} of ${notice.limit} used)` : "";
  const lines = [`Your Ditto ${what} limit is reached${figures}.`];
  if (notice.resetsAt) lines.push(`It resets ${notice.resetsAt}; retrying before then will fail, so stop retrying.`);
  else lines.push("Retrying will not help until the plan is upgraded; stop retrying.");
  if (notice.agentInstructions) lines.push(notice.agentInstructions.trim());
  const link = notice.upgradeUrl ? mergeActivationURL(notice.upgradeUrl, storedClaimURL) : storedClaimURL;
  lines.push(
    link
      ? `Ask your account owner to subscribe or upgrade here: ${link}`
      : "Ask your account owner to subscribe or upgrade in Ditto's billing settings, or run `heyditto login` if a person owns this account.",
  );
  return lines.join("\n");
}
