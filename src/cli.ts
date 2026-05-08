#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  apiBaseURL,
  apiKey,
  mcpServerURL,
  newKeyURL,
  packageName,
  packageVersion,
} from "./config.js";

function usage(): string {
  return `${packageName} ${packageVersion}

Usage:
  ditto save <content> [--source <s>] [--source-context <c>]
  ditto search <query>...
  ditto fetch <pair-id>...
  ditto subjects <query> [--top-k <n>]
  ditto memories <subject-id>...
  ditto network <pair-id> [--limit <n>]
  ditto status
  ditto config
  ditto help

Environment:
  DITTO_API_KEY    Required. Get one at ${newKeyURL()}.
  DITTO_API_BASE   Optional. Defaults to https://api.heyditto.ai.
`;
}

async function getClient(): Promise<Client> {
  const key = apiKey();
  if (!key) {
    process.stderr.write(
      `error: DITTO_API_KEY is not set.\nGet a key at ${newKeyURL()}, then export DITTO_API_KEY=ditto_mcp_…\n`,
    );
    process.exit(1);
  }
  const client = new Client({ name: packageName, version: packageVersion });
  const transport = new StreamableHTTPClientTransport(new URL(mcpServerURL()), {
    requestInit: {
      headers: { Authorization: `Bearer ${key}` },
    },
  });
  await client.connect(transport);
  return client;
}

async function callAndPrint(name: string, args: Record<string, unknown>): Promise<void> {
  const client = await getClient();
  try {
    const result = await client.callTool({ name, arguments: args });
    const block = Array.isArray(result.content) ? result.content[0] : undefined;
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
      process.stdout.write(`${block.text}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } finally {
    await client.close();
  }
}

function requirePositionals(positionals: string[], minimum: number, label: string): void {
  if (positionals.length < minimum) {
    throw new Error(`${label}: expected at least ${minimum} argument(s), got ${positionals.length}`);
  }
}

async function cmdSave(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      source: { type: "string", default: "cli" },
      "source-context": { type: "string" },
    },
    allowPositionals: true,
  });
  requirePositionals(positionals, 1, "save");
  await callAndPrint("save_memory", {
    content: positionals.join(" "),
    source: values.source,
    sourceContext: values["source-context"],
  });
}

async function cmdSearch(rest: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args: rest,
    options: {},
    allowPositionals: true,
  });
  requirePositionals(positionals, 1, "search");
  await callAndPrint("search_memories", { queries: positionals });
}

async function cmdFetch(rest: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args: rest,
    options: {},
    allowPositionals: true,
  });
  requirePositionals(positionals, 1, "fetch");
  await callAndPrint("fetch_memories", { pairIds: positionals });
}

async function cmdSubjects(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "top-k": { type: "string" },
    },
    allowPositionals: true,
  });
  requirePositionals(positionals, 1, "subjects");
  const args: Record<string, unknown> = { query: positionals.join(" ") };
  if (values["top-k"]) {
    const n = Number.parseInt(values["top-k"], 10);
    if (!Number.isFinite(n)) throw new Error("--top-k must be an integer");
    args.topK = n;
  }
  await callAndPrint("search_subjects", args);
}

async function cmdMemories(rest: string[]): Promise<void> {
  const { positionals } = parseArgs({
    args: rest,
    options: {},
    allowPositionals: true,
  });
  requirePositionals(positionals, 1, "memories");
  await callAndPrint("search_memories_in_subjects", { subjectIds: positionals });
}

async function cmdNetwork(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      limit: { type: "string" },
    },
    allowPositionals: true,
  });
  requirePositionals(positionals, 1, "network");
  const args: Record<string, unknown> = { pairId: positionals[0] };
  if (values.limit) {
    const n = Number.parseInt(values.limit, 10);
    if (!Number.isFinite(n)) throw new Error("--limit must be an integer");
    args.limit = n;
  }
  await callAndPrint("get_memory_network", args);
}

async function cmdStatus(): Promise<void> {
  const key = apiKey();
  const lines = [
    `${packageName} ${packageVersion}`,
    `endpoint:  ${mcpServerURL()}`,
    `api key:   ${key ? "set" : "MISSING (export DITTO_API_KEY)"}`,
  ];
  if (!key) {
    lines.push(`new key:   ${newKeyURL()}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const client = await getClient();
    try {
      const tools = await client.listTools();
      lines.push(`tools:     ${tools.tools.map((t) => t.name).join(", ")}`);
    } finally {
      await client.close();
    }
  } catch (err) {
    lines.push(`connect:   FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdConfig(): void {
  const config = {
    mcpServers: {
      ditto: {
        url: mcpServerURL(),
        headers: {
          Authorization: "Bearer ${DITTO_API_KEY}",
        },
      },
    },
    notes: {
      apiBase: apiBaseURL(),
      newKey: newKeyURL(),
    },
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
    case "status":
      await cmdStatus();
      return;
    case "config":
      cmdConfig();
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
