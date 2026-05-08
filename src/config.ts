export const packageName = "@heyditto/cli";
export const packageVersion = "0.1.0";

export function apiBaseURL(): string {
  return (process.env.DITTO_API_BASE || "https://api.heyditto.ai").replace(/\/+$/, "");
}

export function mcpServerURL(): string {
  return `${apiBaseURL()}/mcp`;
}

export function apiKey(): string | undefined {
  return process.env.DITTO_API_KEY;
}

export function newKeyURL(): string {
  return "https://app.heyditto.ai/mcp/newkey";
}
