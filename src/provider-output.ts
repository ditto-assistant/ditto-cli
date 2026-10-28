import { inspect } from "node:util";

/** Format only the already allowlisted metadata supplied by the command. */
export function printProviderMetadata(value: unknown, format = "json"): void {
  const text = format === "json" || format === "raw" ? JSON.stringify(value, null, 2) : inspect(value, { depth: null, colors: false, compact: false });
  process.stdout.write(`${format === "markdown" ? `\`\`\`text\n${text}\n\`\`\`` : text}\n`);
}
