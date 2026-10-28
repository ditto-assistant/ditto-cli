import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { ProviderOperatorQuote } from "./provider-key-api.js";

export function quoteRate(raw: unknown): raw is string {
  return typeof raw === "string" && /^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,9})?$/.test(raw) && Number(raw) <= 1_000_000;
}

/** Closed, nonsensitive operator price estimates. Never reflect malformed file contents. */
export function parseOperatorQuote(raw: unknown, models: string[], now = Date.now()): ProviderOperatorQuote {
  const fail = (): never => { throw new Error("invalid price quote; provide a current checkedAt and exact selected models with all four decimal-string USD rates. No file content was printed"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const quote = raw as Record<string, unknown>;
  if (Object.keys(quote).some(key => !["checkedAt", "models"].includes(key)) || typeof quote.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(quote.checkedAt)) return fail();
  const checked = Date.parse(quote.checkedAt);
  if (!Number.isFinite(checked) || checked < now - 86_400_000 || checked > now + 300_000 || !Array.isArray(quote.models) || quote.models.length !== models.length) return fail();
  const seen = new Set<string>();
  const rows = quote.models.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
    const row = raw as Record<string, unknown>;
    const fields = ["model", "inputPerMillionUsd", "outputPerMillionUsd", "perRequestUsd", "minimumRequestUsd"];
    if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key)) || typeof row.model !== "string" || !models.includes(row.model) || seen.has(row.model)) return fail();
    seen.add(row.model);
    if (!quoteRate(row.inputPerMillionUsd) || !quoteRate(row.outputPerMillionUsd) || !quoteRate(row.perRequestUsd) || !quoteRate(row.minimumRequestUsd)) return fail();
    return { model: row.model, inputPerMillionUsd: row.inputPerMillionUsd, outputPerMillionUsd: row.outputPerMillionUsd, perRequestUsd: row.perRequestUsd, minimumRequestUsd: row.minimumRequestUsd };
  });
  return { checkedAt: quote.checkedAt, models: rows };
}

export async function readOperatorQuote(file: string, models: string[]): Promise<ProviderOperatorQuote> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65_536) throw new Error("invalid quote file");
    const bytes = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65_536) throw new Error("quote file too large");
    return parseOperatorQuote(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), models);
  } catch { throw new Error("could not read a valid current --quote-file; use a bounded JSON file containing only model prices and checkedAt. No file content was printed"); }
  finally { await handle?.close().catch(() => {}); }
}
