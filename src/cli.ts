#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type ApiKeySource,
  apiBaseURL,
  authFilePath,
  mcpServerURL,
  newKeyURL,
  packageName,
  packageVersion,
  resolveApiKey,
} from "./config.js";
import { clearStoredKey, writeStoredKey } from "./store.js";

type OutputFormat = "json" | "text" | "markdown" | "raw";
const OUTPUT_FORMATS: readonly OutputFormat[] = ["json", "text", "markdown", "raw"];
const outputOption = { type: "string" } as const;

function parseOutputFormat(value: string | undefined): OutputFormat {
  if (!value) return "text";
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new Error(`--output must be one of: ${OUTPUT_FORMATS.join(", ")}`);
}

function extractTextBlock(result: unknown): string | undefined {
  const r = result as { content?: unknown };
  if (!Array.isArray(r.content)) return undefined;
  const block = r.content[0];
  if (block && typeof block === "object" && "type" in block && (block as { type: unknown }).type === "text" && "text" in block) {
    return String((block as { text: unknown }).text);
  }
  return undefined;
}

function formatToolResult(result: unknown, format: OutputFormat): string {
  if (format === "raw") return JSON.stringify(result, null, 2);
  const text = extractTextBlock(result);
  if (format === "json") {
    if (text === undefined) return JSON.stringify(result, null, 2);
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return JSON.stringify({ text }, null, 2);
    }
  }
  // text / markdown — pass the text block through; fall back to raw envelope.
  return text ?? JSON.stringify(result, null, 2);
}

function usage(): string {
  return `${packageName} ${packageVersion}

Usage:
  ditto save <content> [--source <s>] [--source-context <c>]
  ditto search <query>...
  ditto fetch <pair-id>...
  ditto subjects <query> [--top-k <n>]
  ditto memories <subject-id>...
  ditto network <pair-id> [--limit <n>]

All data commands (and 'status') accept --output <format>, where <format>
is one of: json, text, markdown, raw. Default is 'text' (passthrough of
the server's text block, which is JSON for data commands). Use --output json
to guarantee structured JSON output suitable for piping into 'jq'.

Auth:
  ditto login [<key>] [--paste] [--stdin]   Save an API key to ${authFilePath()}
  ditto logout                              Delete the saved key
  ditto status [--output <format>]          Show endpoint, key source, live tools
  ditto config                              Print MCP client config snippet

Other:
  ditto help                                Show this message

Note: on macOS, Apple ships /usr/bin/ditto (a file-copy utility). If 'ditto'
runs the wrong tool, install with 'npm i -g @heyditto/cli' and invoke as
'heyditto' (alias bin), or check 'type -a ditto' to disambiguate.

Environment:
  DITTO_API_KEY    Optional override (takes precedence over the saved key).
                   Get one at ${newKeyURL()}.
  DITTO_API_BASE   Optional. Defaults to https://api.heyditto.ai.
  DITTO_CONFIG_DIR Optional. Defaults to $XDG_CONFIG_HOME/heyditto/cli or
                   ~/.config/heyditto/cli.
`;
}

async function getClient(): Promise<Client> {
  const { key, source } = await resolveApiKey();
  if (!key) {
    process.stderr.write(
      `error: no Ditto API key configured.\n\n` +
        `  1. Get a key at ${newKeyURL()}\n` +
        `  2. Save it with: ditto login <key>\n` +
        `     (or export DITTO_API_KEY=ditto_mcp_…)\n`,
    );
    process.exit(1);
  }
  const client = new Client({ name: packageName, version: packageVersion });
  const transport = new StreamableHTTPClientTransport(new URL(mcpServerURL()), {
    requestInit: {
      headers: { Authorization: `Bearer ${key}` },
    },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    process.stderr.write(
      `error: failed to connect to ${mcpServerURL()} (key source: ${source}).\n` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
  return client;
}

async function callAndPrint(
  name: string,
  args: Record<string, unknown>,
  format: OutputFormat,
): Promise<void> {
  const client = await getClient();
  try {
    const result = await client.callTool({ name, arguments: args });
    process.stdout.write(`${formatToolResult(result, format)}\n`);
  } finally {
    await client.close();
  }
}

function requirePositionals(positionals: string[], minimum: number, label: string): void {
  if (positionals.length < minimum) {
    throw new Error(`${label}: expected at least ${minimum} argument(s), got ${positionals.length}`);
  }
}

async function readKeyFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

async function promptForKey(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    /* swallow — best-effort */
  });
  child.unref();
}

async function cmdLogin(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      paste: { type: "boolean", default: false },
      stdin: { type: "boolean", default: false },
      output: outputOption,
    },
    allowPositionals: true,
  });
  parseOutputFormat(values.output); // validate but ignored — login is interactive

  let key = positionals[0]?.trim();

  if (!key && values.stdin) {
    key = (await readKeyFromStdin()).trim();
  } else if (!key) {
    if (values.paste) {
      process.stderr.write(`Opening ${newKeyURL()} in your browser…\n`);
      openInBrowser(newKeyURL());
    }
    if (!process.stdin.isTTY) {
      throw new Error(
        `no key provided and stdin is not a TTY. Pass the key as an argument or pipe it via --stdin.`,
      );
    }
    key = (await promptForKey(`Paste your Ditto API key (from ${newKeyURL()}): `)).trim();
  }

  if (!key) throw new Error("no key provided");
  if (!key.startsWith("ditto_mcp_")) {
    process.stderr.write(`warning: key does not start with "ditto_mcp_" — proceeding anyway\n`);
  }

  await writeStoredKey(key);
  process.stdout.write(`Saved key to ${authFilePath()}\n`);
  if (process.env.DITTO_API_KEY) {
    process.stderr.write(
      `note: DITTO_API_KEY is set in your environment and will override the saved key for this session.\n`,
    );
  }
  process.stdout.write(`Run 'ditto status' to verify.\n`);
}

async function cmdLogout(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { output: outputOption },
    allowPositionals: true,
  });
  parseOutputFormat(values.output);
  const removed = await clearStoredKey();
  if (removed) {
    process.stdout.write(`Removed ${authFilePath()}\n`);
  } else {
    process.stdout.write(`No saved key found at ${authFilePath()}\n`);
  }
  if (process.env.DITTO_API_KEY) {
    process.stderr.write(`note: DITTO_API_KEY is still set in your environment and will continue to be used.\n`);
  }
}

async function cmdSave(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      source: { type: "string", default: "cli" },
      "source-context": { type: "string" },
      output: outputOption,
    },
    allowPositionals: true,
  });
  const format = parseOutputFormat(values.output);
  requirePositionals(positionals, 1, "save");
  await callAndPrint(
    "save_memory",
    {
      content: positionals.join(" "),
      source: values.source,
      sourceContext: values["source-context"],
    },
    format,
  );
}

async function cmdSearch(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { output: outputOption },
    allowPositionals: true,
  });
  const format = parseOutputFormat(values.output);
  requirePositionals(positionals, 1, "search");
  await callAndPrint("search_memories", { queries: positionals }, format);
}

async function cmdFetch(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { output: outputOption },
    allowPositionals: true,
  });
  const format = parseOutputFormat(values.output);
  requirePositionals(positionals, 1, "fetch");
  await callAndPrint("fetch_memories", { pairIds: positionals }, format);
}

async function cmdSubjects(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { "top-k": { type: "string" }, output: outputOption },
    allowPositionals: true,
  });
  const format = parseOutputFormat(values.output);
  requirePositionals(positionals, 1, "subjects");
  const args: Record<string, unknown> = { query: positionals.join(" ") };
  if (values["top-k"]) {
    const n = Number.parseInt(values["top-k"], 10);
    if (!Number.isFinite(n)) throw new Error("--top-k must be an integer");
    args.topK = n;
  }
  await callAndPrint("search_subjects", args, format);
}

async function cmdMemories(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { output: outputOption },
    allowPositionals: true,
  });
  const format = parseOutputFormat(values.output);
  requirePositionals(positionals, 1, "memories");
  await callAndPrint("search_memories_in_subjects", { subjectIds: positionals }, format);
}

async function cmdNetwork(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { limit: { type: "string" }, output: outputOption },
    allowPositionals: true,
  });
  const format = parseOutputFormat(values.output);
  requirePositionals(positionals, 1, "network");
  const args: Record<string, unknown> = { pairId: positionals[0] };
  if (values.limit) {
    const n = Number.parseInt(values.limit, 10);
    if (!Number.isFinite(n)) throw new Error("--limit must be an integer");
    args.limit = n;
  }
  await callAndPrint("get_memory_network", args, format);
}

interface StatusReport {
  package: string;
  version: string;
  endpoint: string;
  apiKey: { present: boolean; source: ApiKeySource };
  tools?: string[];
  connect?: { ok: boolean; error?: string };
}

async function cmdStatus(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { output: outputOption },
    allowPositionals: true,
  });
  const format = parseOutputFormat(values.output);

  const { key, source } = await resolveApiKey();
  const report: StatusReport = {
    package: packageName,
    version: packageVersion,
    endpoint: mcpServerURL(),
    apiKey: { present: !!key, source },
  };

  if (key) {
    try {
      const client = await getClient();
      try {
        const tools = await client.listTools();
        report.tools = tools.tools.map((t) => t.name);
        report.connect = { ok: true };
      } finally {
        await client.close();
      }
    } catch (err) {
      report.connect = { ok: false, error: err instanceof Error ? err.message : String(err) };
      process.exitCode = 1;
    }
  } else {
    process.exitCode = 1;
  }

  if (format === "json" || format === "raw") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [
    `${report.package} ${report.version}`,
    `endpoint:  ${report.endpoint}`,
    `api key:   ${report.apiKey.present ? "set" : "MISSING"}  (source: ${report.apiKey.source})`,
  ];
  if (!report.apiKey.present) {
    lines.push(``, `Get a key at ${newKeyURL()} and run 'ditto login <key>'.`);
  } else if (report.tools) {
    lines.push(`tools:     ${report.tools.join(", ")}`);
  } else if (report.connect && !report.connect.ok) {
    lines.push(`connect:   FAILED — ${report.connect.error}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdConfig(rest: string[]): void {
  const { values } = parseArgs({
    args: rest,
    options: { output: outputOption },
    allowPositionals: true,
  });
  parseOutputFormat(values.output); // accepted; output is always JSON
  const config = {
    mcpServers: {
      ditto: {
        url: mcpServerURL(),
        headers: { Authorization: "Bearer ${DITTO_API_KEY}" },
      },
    },
    notes: { apiBase: apiBaseURL(), newKey: newKeyURL() },
  };
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  switch (command) {
    case "save":
      await cmdSave(rest);
      return;
    case "search":
      await cmdSearch(rest);
      return;
    case "fetch":
      await cmdFetch(rest);
      return;
    case "subjects":
      await cmdSubjects(rest);
      return;
    case "memories":
      await cmdMemories(rest);
      return;
    case "network":
      await cmdNetwork(rest);
      return;
    case "login":
      await cmdLogin(rest);
      return;
    case "logout":
      await cmdLogout(rest);
      return;
    case "status":
      await cmdStatus(rest);
      return;
    case "config":
      cmdConfig(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(usage());
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${packageVersion}\n`);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
