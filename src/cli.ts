#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Command, Option } from "commander";
import {
  type ApiKeySource,
  agentSignupURL,
  apiBaseURL,
  authFilePath,
  mcpServerURL,
  newKeyURL,
  packageName,
  packageVersion,
  resolveApiKey,
} from "./config.js";
import { clearStoredKey, readStoredAuth, saveLogin, writeStoredAuth } from "./store.js";
import {
  cmdAgents,
  cmdSessions,
  cmdSessionsRm,
  registerEndpointCommands,
  registerHarnessCommands,
  registerSessionCommands,
} from "./commands.js";
import { type ActiveSession, markSessionUsed, resolveActiveSession, sessionHeaders } from "./mcp-session.js";
import { NO_KEY_MESSAGE } from "./api.js";
import { openInBrowser } from "./browser.js";
import { deviceLogin } from "./device-login.js";

type OutputFormat = "json" | "text" | "markdown" | "raw";
const OUTPUT_FORMATS: readonly OutputFormat[] = ["json", "text", "markdown", "raw"];

type MemoryFormat = "full" | "outline" | "blocks";
const MEMORY_FORMATS: readonly MemoryFormat[] = ["full", "outline", "blocks"];

interface CommonOptions {
  output?: string;
}

interface SaveOptions extends CommonOptions {
  source?: string;
  sourceContext?: string;
}

interface SearchOptions extends CommonOptions {
  includePublic?: boolean;
  filterUsername?: string;
}

interface FetchOptions extends CommonOptions {
  memoryFormat?: string;
}

interface ListOptions extends CommonOptions {
  username?: string;
  limit?: string;
  offset?: string;
  source?: string;
}

interface UpdateOptions extends CommonOptions {
  content?: string;
  contentFile?: string;
  title?: string;
  sourceContext?: string;
  editsJson?: string;
  editsFile?: string;
  baseRevision?: string;
}

interface PublishOptions extends CommonOptions {
  title?: string;
  privacyMode?: string;
}

interface UnpublishOptions extends CommonOptions {
  memoryId?: string;
  shareId?: string;
}

interface SubjectsOptions extends CommonOptions {
  topK?: string;
}

interface MemoriesOptions extends CommonOptions {
  query?: string;
}

interface NetworkOptions extends CommonOptions {
  limit?: string;
}

interface MyMemoriesOptions extends CommonOptions {
  limit?: string;
  offset?: string;
  source?: string;
}

interface SubjectEdgesOptions extends CommonOptions {
  kg?: string;
  limit?: string;
  minWeight?: string;
}

interface GraphSharingOptions extends CommonOptions {
  enable?: boolean;
  disable?: boolean;
  title?: string;
  description?: string;
}

interface DeleteOptions extends CommonOptions {
  confirm?: boolean;
  kg?: string;
}

interface InitOptions extends CommonOptions {
  agent?: boolean;
  agentCaller?: string;
  name?: string;
  subscribe?: string[];
  json?: boolean;
}

interface LoginOptions extends CommonOptions {
  paste?: boolean;
  stdin?: boolean;
}

function outputOption(): Option {
  return new Option("--output <format>", "output format")
    .choices([...OUTPUT_FORMATS])
    .default("text");
}

function hiddenOutputOption(): Option {
  return outputOption().hideHelp();
}

function memoryFormatOption(): Option {
  return new Option("--memory-format <format>", "memory body format")
    .choices([...MEMORY_FORMATS])
    .default("full");
}

function parseOutputFormat(value: string | undefined): OutputFormat {
  if (!value) return "text";
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new Error(`--output must be one of: ${OUTPUT_FORMATS.join(", ")}`);
}

function parseMemoryFormat(value: string | undefined): MemoryFormat {
  if (!value) return "full";
  if ((MEMORY_FORMATS as readonly string[]).includes(value)) return value as MemoryFormat;
  throw new Error(`--memory-format must be one of: ${MEMORY_FORMATS.join(", ")}`);
}

function parseIntegerOption(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function parseNumberOption(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function parseJSONOption(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${name} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readTextFile(path: string, name: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(`failed to read ${name} at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  // text / markdown: pass the text block through; fall back to raw envelope.
  return text ?? JSON.stringify(result, null, 2);
}

async function getClient(): Promise<Client> {
  const { key, source } = await resolveApiKey();
  if (!key) {
    process.stderr.write(`error: ${NO_KEY_MESSAGE}  Human-owned keys are also available at ${newKeyURL()}.\n`);
    process.exit(1);
  }
  // An explicit session (heyditto session new / DITTO_SESSION_ID) tags every
  // request so the server groups this run's saves and searches into one thread.
  let session: ActiveSession | undefined;
  try {
    session = await resolveActiveSession();
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const client = new Client({ name: packageName, version: packageVersion });
  const transport = new StreamableHTTPClientTransport(new URL(mcpServerURL()), {
    requestInit: {
      headers: { Authorization: `Bearer ${key}`, ...sessionHeaders(session) },
    },
  });
  try {
    await client.connect(transport);
    await markSessionUsed(session);
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

async function cmdLogin(keyArg: string | undefined, options: LoginOptions): Promise<void> {
  parseOutputFormat(options.output); // validate but ignored: login is interactive

  let key = keyArg?.trim();
  let viaDevice = false;
  let defaultEndpoint: string | undefined;
  let pickedEndpoint: string | undefined;

  if (!key && options.stdin) {
    key = (await readKeyFromStdin()).trim();
  } else if (!key && !options.paste && process.stdin.isTTY) {
    // Browser device flow: no key to copy around. The page signs the user in
    // (or creates the account) and hands the key back to this process.
    const result = await deviceLogin({
      intent: "login",
      onCode: (userCode, url) => {
        process.stderr.write(
          `\nSign in to Ditto in your browser:\n\n` +
            `  ${url}\n\n` +
            `  Code: ${userCode}\n\n` +
            `Opening your browser…\n`,
        );
        openInBrowser(url);
        process.stderr.write("Waiting for approval in the browser (Ctrl+C to cancel)…\n");
      },
    });
    key = result.apiKey;
    viaDevice = true;
    pickedEndpoint = result.endpoint?.slug;
    if (result.setDefault && result.endpoint) defaultEndpoint = result.endpoint.slug;
  } else if (!key) {
    if (options.paste) {
      process.stderr.write(`Opening ${newKeyURL()} in your browser...\n`);
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
    process.stderr.write(`warning: key does not start with "ditto_mcp_" - proceeding anyway\n`);
  }

  const stored = await saveLogin(key, defaultEndpoint ? { defaultEndpoint } : {});
  process.stdout.write(`${viaDevice ? "Logged in. " : ""}Saved key to ${authFilePath()}\n`);
  if (defaultEndpoint) {
    process.stdout.write(`Default endpoint: ${defaultEndpoint}\n`);
  } else if (pickedEndpoint) {
    process.stdout.write(`Endpoint picked in the browser: ${pickedEndpoint} (make it the default with 'heyditto endpoints use ${pickedEndpoint}')\n`);
  } else if (stored.defaultEndpoint) {
    process.stdout.write(`Default endpoint: ${stored.defaultEndpoint} (kept)\n`);
  }
  if (process.env.DITTO_API_KEY) {
    process.stderr.write(
      `note: DITTO_API_KEY is set in your environment and will override the saved key for this session.\n`,
    );
  }
  process.stdout.write(`Run 'heyditto status' to verify, or 'heyditto claude' to start coding.\n`);
}

interface AgentSignupResponse {
  accountID: string;
  userID: string;
  apiKeyID: number;
  apiKey: string;
  agentCaller?: string;
  claimURL: string;
  status: "unclaimed";
  createdAt: string;
  subscribedGraphs?: string[];
  failedGraphs?: string[];
}

function defaultAgentCaller(): string {
  return process.env.DITTO_AGENT_CALLER?.trim() || process.env.CURSOR_AGENT?.trim() || "agent";
}

async function cmdInit(graphs: string[], options: InitOptions): Promise<void> {
  const output = options.json ? "json" : parseOutputFormat(options.output);
  // --agent is accepted for backward compatibility. Agent init is the default.
  if (options.agentCaller && options.name && options.agentCaller !== options.name) {
    throw new Error("init: use either --name or --agent-caller, not both");
  }
  // --subscribe pre-subscribes the new agent to public foundation knowledge
  // graphs (e.g. the @minos mentor KG). Accepts repeats and comma-separated
  // lists, plus bare positional graph names: --subscribe @minos @a,@b.
  // De-duped; '@' optional.
  const subscribeGraphs = Array.from(
    new Set(
      [...(options.subscribe ?? []), ...graphs]
        .flatMap((v) => v.split(","))
        .map((g) => g.trim().replace(/^@/, ""))
        .filter((g) => g.length > 0),
    ),
  );

  const stored = await readStoredAuth();
  if (stored?.apiKey && stored.agentMode) {
    const existing = {
      created: false,
      accountID: stored.agentAccountID,
      userID: stored.agentUserID,
      apiKeyStored: true,
      agentCaller: stored.agentCaller,
      claimURL: stored.claimURL,
      status: "configured",
      configPath: authFilePath(),
    };
    if (output === "json" || output === "raw") {
      process.stdout.write(`${JSON.stringify(existing, null, 2)}\n`);
    } else {
      process.stdout.write(`Agent account already configured at ${authFilePath()}\n`);
      if (stored.claimURL) process.stdout.write(`Claim later: ${stored.claimURL}\n`);
    }
    return;
  }
  if (stored?.apiKey) {
    throw new Error(`a Ditto API key is already saved at ${authFilePath()}; run 'heyditto logout' before creating an agent account`);
  }

  const agentCaller = options.name?.trim() || options.agentCaller?.trim() || defaultAgentCaller();
  const response = await fetch(agentSignupURL(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `${packageName}/${packageVersion}`,
    },
    body: JSON.stringify({
      agentCaller,
      ...(subscribeGraphs.length > 0 ? { subscribeGraphs } : {}),
      metadata: {
        package: packageName,
        version: packageVersion,
        platform: process.platform,
        arch: process.arch,
      },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`agent signup failed: HTTP ${response.status}${body ? ` - ${body}` : ""}`);
  }
  const signupRaw = (await response.json()) as Partial<AgentSignupResponse>;
  if (
    typeof signupRaw.accountID !== "string" ||
    typeof signupRaw.userID !== "string" ||
    typeof signupRaw.apiKeyID !== "number" ||
    typeof signupRaw.apiKey !== "string" ||
    typeof signupRaw.claimURL !== "string" ||
    signupRaw.status !== "unclaimed" ||
    typeof signupRaw.createdAt !== "string"
  ) {
    throw new Error("agent signup failed: invalid response payload");
  }
  const signup: AgentSignupResponse = signupRaw as AgentSignupResponse;
  await writeStoredAuth({
    apiKey: signup.apiKey,
    agentMode: true,
    agentAccountID: signup.accountID,
    agentUserID: signup.userID,
    agentCaller: signup.agentCaller || agentCaller,
    claimURL: signup.claimURL,
    createdAt: signup.createdAt,
  });

  const result = {
    created: true,
    accountID: signup.accountID,
    userID: signup.userID,
    apiKeyID: signup.apiKeyID,
    apiKeyStored: true,
    agentCaller: signup.agentCaller || agentCaller,
    claimURL: signup.claimURL,
    status: signup.status,
    configPath: authFilePath(),
    ...(subscribeGraphs.length > 0
      ? {
          subscribedGraphs: signup.subscribedGraphs ?? [],
          failedGraphs: signup.failedGraphs ?? [],
        }
      : {}),
  };
  if (output === "json" || output === "raw") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Created agent account ${signup.userID}\n`);
  process.stdout.write(`Saved key to ${authFilePath()}\n`);
  if (subscribeGraphs.length > 0) {
    const subscribed = signup.subscribedGraphs ?? [];
    const failed = signup.failedGraphs ?? [];
    if (subscribed.length > 0) {
      process.stdout.write(
        `Subscribed to ${subscribed.map((g) => `@${g}`).join(", ")}\n`,
      );
    }
    if (failed.length > 0) {
      process.stdout.write(
        `Could not subscribe (not found or not public): ${failed
          .map((g) => `@${g}`)
          .join(", ")}\n`,
      );
    }
  }
  process.stdout.write(`Claim later: ${signup.claimURL}\n`);
}

async function cmdLogout(options: CommonOptions): Promise<void> {
  parseOutputFormat(options.output);
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

async function cmdSave(content: string[], options: SaveOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  await callAndPrint(
    "save_memory",
    {
      content: content.join(" "),
      source: options.source ?? "cli",
      sourceContext: options.sourceContext,
    },
    format,
  );
}

async function cmdSearch(queries: string[], options: SearchOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  const args: Record<string, unknown> = { queries };
  if (options.includePublic) args.includePublic = true;
  if (options.filterUsername) args.filterUsername = options.filterUsername;
  await callAndPrint("search_memories", args, format);
}

async function cmdFetch(ids: string[], options: FetchOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  const memoryFormat = parseMemoryFormat(options.memoryFormat);
  await callAndPrint("fetch_memories", { ids, format: memoryFormat }, format);
}

async function cmdList(options: ListOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  const args: Record<string, unknown> = {};
  if (options.username) args.username = options.username;
  const limit = parseIntegerOption(options.limit, "--limit");
  if (limit !== undefined) args.limit = limit;
  const offset = parseIntegerOption(options.offset, "--offset");
  if (offset !== undefined) args.offset = offset;
  if (options.source) args.source = options.source;
  await callAndPrint("list_memories", args, format);
}

async function cmdUpdate(id: string, options: UpdateOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  if (options.content && options.contentFile) {
    throw new Error("update: use either --content or --content-file, not both");
  }
  if (options.editsJson && options.editsFile) {
    throw new Error("update: use either --edits-json or --edits-file, not both");
  }
  if ((options.content || options.contentFile) && (options.editsJson || options.editsFile)) {
    throw new Error("update: content replacement and block edits are mutually exclusive");
  }

  const args: Record<string, unknown> = { memoryId: id };
  if (options.content) args.content = options.content;
  if (options.contentFile) args.content = await readTextFile(options.contentFile, "--content-file");
  if (options.title !== undefined) args.title = options.title;
  if (options.sourceContext !== undefined) args.sourceContext = options.sourceContext;

  if (options.editsJson || options.editsFile) {
    const raw = options.editsJson ?? (await readTextFile(options.editsFile!, "--edits-file"));
    args.edits = parseJSONOption(raw, options.editsJson ? "--edits-json" : "--edits-file");
    const baseRevision = parseIntegerOption(options.baseRevision, "--base-revision");
    if (baseRevision === undefined) {
      throw new Error("update: --base-revision is required with block edits");
    }
    args.baseRevision = baseRevision;
  } else {
    const baseRevision = parseIntegerOption(options.baseRevision, "--base-revision");
    if (baseRevision !== undefined) args.baseRevision = baseRevision;
  }

  await callAndPrint("update_memory", args, format);
}

async function cmdPublish(id: string, options: PublishOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  const args: Record<string, unknown> = { memoryId: id };
  if (options.title !== undefined) args.title = options.title;
  if (options.privacyMode !== undefined) args.privacyMode = options.privacyMode;
  await callAndPrint("publish_memory", args, format);
}

async function cmdUnpublish(id: string | undefined, options: UnpublishOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  const provided = [options.memoryId, options.shareId, id].filter(Boolean);
  if (provided.length !== 1) {
    throw new Error("unpublish: provide exactly one of --memory-id, --share-id, or positional id");
  }
  const args: Record<string, unknown> = {};
  if (options.memoryId) {
    args.memoryId = options.memoryId;
  } else if (options.shareId) {
    args.shareId = options.shareId;
  } else {
    args.memoryId = id;
  }
  await callAndPrint("unpublish_memory", args, format);
}

async function cmdSubjects(query: string[], options: SubjectsOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  const args: Record<string, unknown> = { query: query.join(" ") };
  const topK = parseIntegerOption(options.topK, "--top-k");
  if (topK !== undefined) args.topK = topK;
  await callAndPrint("search_subjects", args, format);
}

async function cmdMemories(subjectIds: string[], options: MemoriesOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  const args: Record<string, unknown> = { subjectIds };
  if (options.query) args.query = options.query;
  await callAndPrint("search_memories_in_subjects", args, format);
}

async function cmdNetwork(pairId: string, options: NetworkOptions): Promise<void> {
  const format = parseOutputFormat(options.output);
  const args: Record<string, unknown> = { pairId };
  const limit = parseIntegerOption(options.limit, "--limit");
  if (limit !== undefined) args.limit = limit;
  await callAndPrint("get_memory_network", args, format);
}

async function cmdFriends(options: CommonOptions): Promise<void> {
  await callAndPrint("list_friends", {}, parseOutputFormat(options.output));
}

async function cmdKnowledgeGraphs(options: CommonOptions): Promise<void> {
  await callAndPrint("list_knowledge_graphs", {}, parseOutputFormat(options.output));
}

async function cmdMyMemories(options: MyMemoriesOptions): Promise<void> {
  const args: Record<string, unknown> = {};
  const limit = parseIntegerOption(options.limit, "--limit");
  if (limit !== undefined) args.limit = limit;
  const offset = parseIntegerOption(options.offset, "--offset");
  if (offset !== undefined) args.offset = offset;
  if (options.source) args.source = options.source;
  await callAndPrint("list_my_memories", args, parseOutputFormat(options.output));
}

async function cmdSubjectEdges(subjectId: string, options: SubjectEdgesOptions): Promise<void> {
  const args: Record<string, unknown> = { subjectId };
  if (options.kg) args.kg = options.kg;
  const limit = parseIntegerOption(options.limit, "--limit");
  if (limit !== undefined) args.limit = limit;
  const minWeight = parseNumberOption(options.minWeight, "--min-weight");
  if (minWeight !== undefined) args.minWeight = minWeight;
  await callAndPrint("get_subject_edges", args, parseOutputFormat(options.output));
}

async function cmdGraphSharing(options: GraphSharingOptions): Promise<void> {
  if (!!options.enable === !!options.disable) {
    throw new Error("sharing: provide exactly one of --enable or --disable");
  }
  const args: Record<string, unknown> = {
    publicSubscriptionsEnabled: !!options.enable,
  };
  if (options.title !== undefined) args.title = options.title;
  if (options.description !== undefined) args.description = options.description;
  await callAndPrint("set_knowledge_graph_sharing", args, parseOutputFormat(options.output));
}

async function cmdDelete(memoryId: string, options: DeleteOptions): Promise<void> {
  if (!options.confirm) {
    throw new Error("delete: pass --confirm to permanently delete this memory");
  }
  const args: Record<string, unknown> = { memoryId, confirm: true };
  if (options.kg) args.kg = options.kg;
  await callAndPrint("delete_memory", args, parseOutputFormat(options.output));
}

interface StatusReport {
  session?: { id: string; name?: string; source: "env" | "config" };
  defaultEndpoint?: string;
  package: string;
  version: string;
  endpoint: string;
  apiKey: { present: boolean; source: ApiKeySource };
  agent?: {
    enabled: boolean;
    accountID?: string;
    userID?: string;
    caller?: string;
    claimURL?: string;
  };
  tools?: string[];
  toolsError?: string;
  connect?: { ok: boolean; error?: string };
}

async function cmdStatus(options: CommonOptions): Promise<void> {
  const format = parseOutputFormat(options.output);

  const [{ key, source }, stored, session] = await Promise.all([
    resolveApiKey(),
    readStoredAuth(),
    resolveActiveSession(),
  ]);
  const report: StatusReport = {
    package: packageName,
    version: packageVersion,
    endpoint: mcpServerURL(),
    apiKey: { present: !!key, source },
  };
  if (session) report.session = { id: session.id, name: session.name, source: session.source };
  if (stored?.defaultEndpoint) report.defaultEndpoint = stored.defaultEndpoint;
  if (source === "config" && stored?.agentMode) {
    report.agent = {
      enabled: true,
      accountID: stored.agentAccountID,
      userID: stored.agentUserID,
      caller: stored.agentCaller,
      claimURL: stored.claimURL,
    };
  }

  if (key) {
    try {
      const client = await getClient();
      try {
        // The initialize handshake inside getClient() succeeded, so the
        // connection is healthy. tools/list is a separate probe that may fail
        // (e.g. the server returns an empty body) without the account being unusable.
        report.connect = { ok: true };
        try {
          const tools = await client.listTools();
          report.tools = tools.tools.map((t) => t.name);
        } catch (err) {
          report.toolsError = err instanceof Error ? err.message : String(err);
        }
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
    lines.push(``, `Run 'heyditto login' to sign in through your browser, 'heyditto init --json' for no-human agent setup, or get a key at ${newKeyURL()} and run 'heyditto login <key>'.`);
  } else if (report.tools) {
    lines.push(`tools:     ${report.tools.join(", ")}`);
  } else if (report.toolsError) {
    lines.push(`connect:   ok`, `tools:     unavailable (tools/list failed: ${report.toolsError})`);
  } else if (report.connect && !report.connect.ok) {
    lines.push(`connect:   FAILED - ${report.connect.error}`);
  }
  if (report.defaultEndpoint) lines.push(`endpoint:  ${report.defaultEndpoint}  (default for heyditto claude / codex)`);
  if (report.agent?.claimURL) {
    lines.push(`agent:     unclaimed (${report.agent.caller || "agent"})`, `claim:     ${report.agent.claimURL}`);
  }
  if (report.session) {
    const pinned = report.session.source === "env" ? "  [DITTO_SESSION_ID]" : "";
    lines.push(`session:   ${report.session.id}${report.session.name ? ` (${report.session.name})` : ""}${pinned}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdConfig(options: CommonOptions): void {
  parseOutputFormat(options.output); // accepted; output is always JSON
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

// These commands mirror the MCP subscription tools. Subscriptions only ever
// cover other users' public graphs by @username; this cannot touch the account's
// own graph or app graph, since those are not subscriptions.
async function cmdGraphsCreate(
  nameParts: string[],
  options: CommonOptions & { app?: string },
): Promise<void> {
  const args: Record<string, unknown> = { name: nameParts.join(" ") };
  const app = options.app?.trim();
  if (app) args.app = app;
  await callAndPrint(
    "create_dedicated_graph",
    args,
    parseOutputFormat(options.output),
  );
}

async function cmdGraphsList(options: CommonOptions): Promise<void> {
  await callAndPrint(
    "list_knowledge_graph_subscriptions",
    {},
    parseOutputFormat(options.output),
  );
}

async function cmdGraphsSubscribers(options: CommonOptions): Promise<void> {
  await callAndPrint(
    "list_knowledge_graph_subscribers",
    {},
    parseOutputFormat(options.output),
  );
}

async function cmdGraphsAdd(username: string, options: CommonOptions): Promise<void> {
  await callAndPrint(
    "subscribe_knowledge_graph",
    { username },
    parseOutputFormat(options.output),
  );
}

async function cmdGraphsRemove(username: string, options: CommonOptions): Promise<void> {
  await callAndPrint(
    "unsubscribe_knowledge_graph",
    { username },
    parseOutputFormat(options.output),
  );
}

function addExamples(command: Command, examples: string): Command {
  return command.addHelpText("after", `\nExamples:\n${examples}`);
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name("heyditto")
    .description("Save, search, fetch, and traverse Ditto memories from the shell.")
    .version(packageVersion, "-v, --version", "print the CLI version")
    .helpCommand("help [command]", "show help for a command")
    .enablePositionalOptions()
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Notes:
  On macOS, Apple ships /usr/bin/ditto (a file-copy utility). If 'ditto'
  runs the wrong tool, install with 'npm i -g @heyditto/cli' and invoke as
  'heyditto' (alias bin), or check 'type -a ditto' to disambiguate.

Environment:
  DITTO_API_KEY     Optional override, taking precedence over the saved key.
  DITTO_API_BASE    Optional API base URL. Defaults to https://api.heyditto.ai.
  DITTO_APP_BASE    Optional web app URL for browser pages. Defaults to https://app.heyditto.ai.
  DITTO_SESSION_ID  Optional explicit MCP session id sent as X-Ditto-Session-Id (see 'session').
  DITTO_CONFIG_DIR  Optional config directory. Defaults to $XDG_CONFIG_HOME/heyditto/cli
                    or ~/.config/heyditto/cli.

Coding agents:
  heyditto claude / heyditto codex launch the agent through one of your Ditto
  inference endpoints with a temporary key that is revoked when it exits, so
  every session becomes its own thread with full traces in the Ditto app.
  First run with no login? They open your browser to sign in (or create an
  account) and pick an endpoint — no setup needed:
    npx @heyditto/cli@latest claude
`,
    );

  addExamples(
    program
      .command("save")
      .description("save a memory")
      .summary("save a memory")
      .argument("<content...>", "memory content")
      .option("--source <source>", "memory source", "cli")
      .option("--source-context <context>", "source context, such as a filename")
      .addOption(outputOption())
      .action(cmdSave),
    `  heyditto save "Project X uses Bun + SolidJS"
  heyditto save "$(cat note.md)" --source document --source-context note.md`,
  );

  addExamples(
    program
      .command("search")
      .description("search private memories, optionally public graphs")
      .summary("search private memories, optionally public graphs")
      .argument("<query...>", "one or more search queries")
      .option("--include-public", "include public DittoHub memories")
      .option("--filter-username <username>", "scope public results to a username")
      .addOption(outputOption())
      .action(cmdSearch),
    `  heyditto search "typescript preferences"
  heyditto search "launch notes" --include-public --filter-username peyton`,
  );

  program
    .command("fetch")
    .description("fetch memories by id")
    .summary("fetch memories by id")
    .argument("<id...>", "memory ids or public share ids")
    .addOption(memoryFormatOption())
    .addOption(outputOption())
    .action(cmdFetch);

  program
    .command("list")
    .description("list memories or public publishes")
    .summary("list memories or public publishes")
    .option("--username <username>", "list public DittoHub publishes for a username")
    .option("--limit <number>", "maximum number of results")
    .option("--offset <number>", "result offset")
    .option("--source <source>", "filter by memory source")
    .addOption(outputOption())
    .action(cmdList);

  program
    .command("my-memories")
    .alias("list_my_memories")
    .description("list only your saved memories")
    .summary("list only your saved memories")
    .option("--limit <number>", "maximum number of results")
    .option("--offset <number>", "result offset")
    .option("--source <source>", "filter by memory source")
    .addOption(outputOption())
    .action(cmdMyMemories);

  program
    .command("update")
    .description("update a saved memory")
    .summary("update a saved memory")
    .argument("<id>", "memory id")
    .option("--content <text>", "replacement memory content")
    .option("--content-file <path>", "path to replacement memory content")
    .option("--title <title>", "memory title")
    .option("--source-context <context>", "source context")
    .option("--edits-json <json>", "structured block edits as JSON")
    .option("--edits-file <path>", "path to structured block edits JSON")
    .option("--base-revision <number>", "base memory revision")
    .addOption(outputOption())
    .addHelpText(
      "after",
      `
Examples:
  heyditto update <memory-id> --content-file revised.md --output json
  heyditto update <memory-id> --edits-file edits.json --base-revision 3 --output json`,
    )
    .action(cmdUpdate);

  program
    .command("publish")
    .description("publish a memory to DittoHub")
    .summary("publish a memory to DittoHub")
    .argument("<id>", "memory id")
    .option("--title <title>", "public title")
    .option(
      "--privacy-mode <mode>",
      "privacy mode: scan_and_block, scan_and_warn, or scan_and_redact",
    )
    .addOption(outputOption())
    .action(cmdPublish);

  program
    .command("unpublish")
    .description("remove an existing public share")
    .summary("remove an existing public share")
    .argument("[id]", "memory id")
    .option("--memory-id <id>", "memory id")
    .option("--share-id <id>", "share id")
    .addOption(outputOption())
    .action(cmdUnpublish);

  program
    .command("delete")
    .alias("delete_memory")
    .description("permanently delete a saved memory")
    .summary("permanently delete a saved memory")
    .argument("<memory-id>", "memory id")
    .requiredOption("--confirm", "confirm permanent deletion")
    .option("--kg <alias>", "knowledge graph alias")
    .addOption(outputOption())
    .action(cmdDelete);

  program
    .command("subjects")
    .description("search the subject graph")
    .summary("search the subject graph")
    .argument("<query...>", "subject search query")
    .option("--top-k <number>", "maximum number of subjects")
    .addOption(outputOption())
    .action(cmdSubjects);

  program
    .command("subject-edges")
    .alias("get_subject_edges")
    .description("list related subjects for a subject")
    .summary("list related subjects for a subject")
    .argument("<subject-id>", "subject id")
    .option("--kg <alias>", "knowledge graph alias")
    .option("--limit <number>", "maximum number of related subjects")
    .option("--min-weight <number>", "minimum edge weight from 0 to 1")
    .addOption(outputOption())
    .action(cmdSubjectEdges);

  program
    .command("memories")
    .description("fetch memory previews for subjects")
    .summary("fetch memory previews for subjects")
    .argument("<subject-id...>", "subject ids")
    .option("--query <query>", "optional search query")
    .addOption(outputOption())
    .action(cmdMemories);

  program
    .command("network")
    .description("traverse related memories")
    .summary("traverse related memories")
    .argument("<pair-id>", "memory pair id")
    .option("--limit <number>", "maximum number of related memories")
    .addOption(outputOption())
    .action(cmdNetwork);

  program
    .command("friends")
    .alias("list_friends")
    .description("list Ditto friends")
    .summary("list Ditto friends")
    .addOption(outputOption())
    .action(cmdFriends);

  program
    .command("knowledge-graphs")
    .alias("list_knowledge_graphs")
    .description("list readable knowledge graphs")
    .summary("list readable knowledge graphs")
    .addOption(outputOption())
    .action(cmdKnowledgeGraphs);

  program
    .command("graph-sharing")
    .alias("set_knowledge_graph_sharing")
    .description("configure whether others can subscribe to your graph")
    .summary("configure graph sharing")
    .option("--enable", "allow public subscriptions to your graph")
    .option("--disable", "disable public subscriptions to your graph")
    .option("--title <title>", "subscribable graph title")
    .option("--description <description>", "subscribable graph description")
    .addOption(outputOption())
    .action(cmdGraphSharing);

  const graphs = program
    .command("graphs")
    .description("manage knowledge graph subscriptions")
    .summary("manage knowledge graph subscriptions")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Subscriptions cover other users' public graphs by @username. They do not modify
your own graph or an app graph.`,
    );

  graphs
    .command("create")
    .description("create a dedicated graph you own (optionally owned by an app)")
    .argument("<name...>", "graph name")
    .option(
      "--app <appId>",
      "create the graph OWNED BY one of your apps (an app can own many graphs)",
    )
    .addOption(outputOption())
    .action(cmdGraphsCreate);

  graphs
    .command("list")
    .description("list public graphs you're subscribed to")
    .addOption(outputOption())
    .action(cmdGraphsList);

  graphs
    .command("available")
    .alias("list_knowledge_graphs")
    .description("list readable knowledge graphs")
    .addOption(outputOption())
    .action(cmdKnowledgeGraphs);

  graphs
    .command("add")
    .description("subscribe to a public graph")
    .argument("<username>", "public graph username, with or without @")
    .addOption(outputOption())
    .action(cmdGraphsAdd);

  graphs
    .command("remove")
    .description("unsubscribe from a public graph")
    .argument("<username>", "public graph username, with or without @")
    .addOption(outputOption())
    .action(cmdGraphsRemove);

  graphs
    .command("subscribers")
    .description("list who is subscribed to your graph")
    .addOption(outputOption())
    .action(cmdGraphsSubscribers);

  graphs
    .command("sharing")
    .alias("set_knowledge_graph_sharing")
    .description("configure whether others can subscribe to your graph")
    .option("--enable", "allow public subscriptions to your graph")
    .option("--disable", "disable public subscriptions to your graph")
    .option("--title <title>", "subscribable graph title")
    .option("--description <description>", "subscribable graph description")
    .addOption(outputOption())
    .action(cmdGraphSharing);

  program
    .command("init")
    .description("initialize a claimable agent account")
    .argument("[graph...]", "public graphs to subscribe to")
    .addOption(new Option("--agent", "create a free, claimable agent account").hideHelp())
    .option("--name <name>", "agent name")
    .addOption(new Option("--agent-caller <name>", "agent name").hideHelp())
    .addOption(
      new Option("--subscribe <graph>", "public graphs to subscribe to")
        .argParser((value, previous: string[] | undefined) => [...(previous ?? []), value]),
    )
    .option("--json", "print machine-readable output")
    .addOption(hiddenOutputOption())
    .action(cmdInit);

  program
    .command("login")
    .description("sign in through your browser (device flow) or save an API key")
    .argument("[key]", "Ditto API key (omit to sign in through the browser)")
    .option("--paste", "open the key creation page and paste a key instead of the device flow")
    .option("--stdin", "read the API key from stdin")
    .addOption(hiddenOutputOption())
    .action(cmdLogin);

  registerEndpointCommands(program, addExamples, outputOption);
  registerHarnessCommands(program, addExamples);
  registerSessionCommands(program, addExamples);

  addExamples(
    program
      .command("agents")
      .description("list your Ditto agents (threads, activity, connections)")
      .summary("list Ditto agents")
      .addOption(outputOption())
      .action(cmdAgents),
    `  heyditto agents
  heyditto agents --output json`,
  );

  const sessions = program
    .command("sessions")
    .description("list coding-agent sessions launched by this CLI")
    .summary("list coding-agent sessions")
    .option("--json", "print machine-readable output")
    .option("--all", "show every record, not just the latest 20")
    .action(cmdSessions);
  sessions
    .command("rm")
    .description("forget a local session record (threads and traces are kept)")
    .argument("<id>", "Ditto session id")
    .action(cmdSessionsRm);

  program
    .command("logout")
    .description("delete the saved API key")
    .addOption(hiddenOutputOption())
    .action(cmdLogout);

  program
    .command("status")
    .description("show CLI auth and endpoint status")
    .addOption(outputOption())
    .action(cmdStatus);

  program
    .command("config")
    .description("print MCP client configuration")
    .addOption(hiddenOutputOption())
    .action(cmdConfig);

  return program;
}

async function main(): Promise<void> {
  const argv = [...process.argv];
  const args = argv.slice(2);
  if (
    args[0] === "graphs" &&
    (args.length === 1 || (args[1].startsWith("-") && args[1] !== "-h" && args[1] !== "--help"))
  ) {
    argv.splice(3, 0, "list");
  }
  await buildProgram().parseAsync(argv);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
