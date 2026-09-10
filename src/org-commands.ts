import type { Command, Option } from "commander";
import {
  approveToolApproval,
  type Company,
  createMCPConnection,
  deleteMCPConnection,
  type EndpointTool,
  listCompanies,
  listEndpointTools,
  listMCPConnections,
  listToolApprovals,
  type MCPConnection,
  rejectToolApproval,
  resolveCompany,
  startMCPOAuth,
  type ToolApproval,
  updateMCPConnection,
} from "./api.js";
import { openInBrowser } from "./browser.js";
import { readStoredAuth, updateStoredAuth } from "./store.js";

/**
 * Organizations, tool servers and approvals.
 *
 * The CLI had no organization concept at all: identity was "whoever the API key
 * belongs to". That is fine until the thing being managed belongs to a team.
 * An organization's MCP connections and its endpoints' held calls are the
 * organization's, and what your role lets you do with them is the server's
 * decision.
 *
 * So the CLI never re-implements that decision. It resolves the scope, sends
 * it, and renders whatever comes back — including the refusals. A member who
 * tries to remove an organization's connection gets the server's 403 and its
 * wording, not a client-side guess that might disagree with it.
 */

interface ScopeOptions {
  org?: string;
  output?: string;
}

function isJSON(options: { output?: string }): boolean {
  return options.output === "json" || options.output === "raw";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function printTable(header: string[], rows: string[][]): void {
  if (rows.length === 0) return;
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r.map((c, i) => (i === r.length - 1 ? c : pad(c ?? "", widths[i] ?? 0))).join("  ");
  process.stdout.write(`${line(header)}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
}

function writeJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Which organization a command acts on: `--org`, else the one `orgs use`
 * remembered, else none (the caller's personal scope).
 *
 * Returning undefined rather than throwing is deliberate — most of these
 * commands have a meaningful personal answer, and the ones that do not say so
 * themselves with a message naming the flag.
 */
async function resolveScope(options: ScopeOptions): Promise<Company | undefined> {
  const wanted = options.org?.trim() || (await readStoredAuth())?.defaultCompany;
  if (!wanted) return undefined;
  return resolveCompany(wanted);
}

async function requireOrg(options: ScopeOptions): Promise<Company> {
  const company = await resolveScope(options);
  if (!company) {
    throw new Error(
      "this command acts on an organization.\n\n" +
        "  Pass: --org <slug>\n" +
        "  Or:   heyditto orgs use <slug>   (remember it)\n" +
        "  See:  heyditto orgs             (the ones you belong to)\n",
    );
  }
  return company;
}

// ---------------------------------------------------------------------------
// orgs
// ---------------------------------------------------------------------------

export async function cmdOrgs(options: ScopeOptions): Promise<void> {
  const companies = await listCompanies();
  const current = (await readStoredAuth())?.defaultCompany;
  if (isJSON(options)) {
    writeJSON({ companies, defaultCompany: current ?? null });
    return;
  }
  if (companies.length === 0) {
    process.stdout.write("You are not a member of any organization.\n");
    return;
  }
  printTable(
    ["", "SLUG", "NAME", "YOUR ROLE"],
    companies.map((c) => [c.slug === current ? "*" : " ", c.slug, c.name, c.role]),
  );
  if (!current) {
    process.stderr.write("\nSet one with `heyditto orgs use <slug>` to skip --org.\n");
  }
}

export async function cmdOrgUse(slug: string, options: ScopeOptions): Promise<void> {
  const company = await resolveCompany(slug);
  await updateStoredAuth({ defaultCompany: company.slug });
  if (isJSON(options)) {
    writeJSON(company);
    return;
  }
  process.stderr.write(`Default organization set to ${company.slug} (${company.role}).\n`);
}

export async function cmdOrgClear(options: ScopeOptions): Promise<void> {
  await updateStoredAuth({ defaultCompany: undefined });
  if (isJSON(options)) {
    writeJSON({ defaultCompany: null });
    return;
  }
  process.stderr.write("Cleared the default organization.\n");
}

// ---------------------------------------------------------------------------
// mcp servers
// ---------------------------------------------------------------------------

/** The connection's live state, in the words that tell you what to do about it. */
function connectionStatus(connection: MCPConnection): string {
  if (!connection.enabled) return "paused";
  if (connection.config.authType !== "oauth") return "ready";
  switch (connection.oauthStatus) {
    case "connected":
      return "connected";
    case "expired":
      return "needs reconnect";
    default:
      return "not connected";
  }
}

function findConnection(list: MCPConnection[], wanted: string): MCPConnection {
  const needle = wanted.trim().toLowerCase();
  const match = list.find(
    (c) =>
      c.id.toLowerCase() === needle ||
      c.name.toLowerCase() === needle ||
      c.prefix.toLowerCase() === needle,
  );
  if (match) return match;
  const known = list.map((c) => c.name).join(", ");
  throw new Error(
    `no connection called "${wanted}".` + (known ? ` Available: ${known}` : " There are none yet."),
  );
}

export async function cmdMCPList(options: ScopeOptions): Promise<void> {
  const company = await requireOrg(options);
  const { servers, canManage } = await listMCPConnections(company.id);
  if (isJSON(options)) {
    writeJSON({ company: company.slug, canManage, servers });
    return;
  }
  if (servers.length === 0) {
    process.stdout.write(
      `${company.slug} has no tool servers connected.\n` +
        (canManage ? "Add one with `heyditto mcp add <name> <url>`.\n" : ""),
    );
    return;
  }
  printTable(
    ["NAME", "PREFIX", "STATUS", "TRANSPORT", "URL"],
    servers.map((s) => [
      s.name,
      `${s.prefix}__`,
      connectionStatus(s),
      s.transport,
      s.config.url,
    ]),
  );
  if (!canManage) {
    process.stderr.write("\nRead-only: an owner or admin can change these.\n");
  }
}

export async function cmdMCPAdd(
  name: string,
  url: string,
  options: ScopeOptions & {
    transport?: string;
    auth?: string;
    header?: string[];
    description?: string;
  },
): Promise<void> {
  const company = await requireOrg(options);
  const headers: Record<string, string> = {};
  for (const raw of options.header ?? []) {
    const index = raw.indexOf(":");
    if (index <= 0) throw new Error(`--header must be "Name: value", got "${raw}"`);
    headers[raw.slice(0, index).trim()] = raw.slice(index + 1).trim();
  }
  const authType = options.auth ?? (Object.keys(headers).length > 0 ? "headers" : "oauth");
  if (authType === "headers" && Object.keys(headers).length === 0) {
    throw new Error("--auth headers needs at least one --header \"Name: value\"");
  }
  const connection = await createMCPConnection(company.id, {
    name,
    description: options.description,
    transport: options.transport ?? "streamable_http",
    config: { url, authType, headers: authType === "headers" ? headers : undefined },
  });
  if (isJSON(options)) {
    writeJSON(connection);
    return;
  }
  process.stderr.write(`Connected ${connection.name} to ${company.slug}.\n`);
  process.stderr.write(`Its tools are named ${connection.prefix}__<tool>.\n`);
  if (connection.config.authType === "oauth") {
    process.stderr.write(
      `\nIt is not signed in yet. Run: heyditto mcp connect ${connection.name} --org ${company.slug}\n`,
    );
  }
}

export async function cmdMCPConnect(
  server: string,
  options: ScopeOptions & { noBrowser?: boolean },
): Promise<void> {
  const company = await requireOrg(options);
  const { servers } = await listMCPConnections(company.id);
  const connection = findConnection(servers, server);
  const url = await startMCPOAuth(connection.id);
  if (!url) throw new Error("the server did not return an authorization URL");
  if (isJSON(options)) {
    writeJSON({ authorizationUrl: url });
    return;
  }
  process.stderr.write(`Open this to sign in to ${connection.name}:\n\n  ${url}\n\n`);
  if (!options.noBrowser) openInBrowser(url);
  // Deliberately not polling. The authorization completes in a browser that may
  // not be on this machine, and a CLI that sits there spinning is worse than
  // one that tells you how to check.
  process.stderr.write(
    `When you have finished, check it with: heyditto mcp list --org ${company.slug}\n`,
  );
}

export async function cmdMCPRemove(server: string, options: ScopeOptions): Promise<void> {
  const company = await requireOrg(options);
  const { servers } = await listMCPConnections(company.id);
  const connection = findConnection(servers, server);
  await deleteMCPConnection(company.id, connection.id);
  if (isJSON(options)) {
    writeJSON({ removed: connection.id });
    return;
  }
  process.stderr.write(
    `Removed ${connection.name} from ${company.slug}. ` +
      "Endpoints that selected its tools keep the selection and stop being able to call them.\n",
  );
}

export async function cmdMCPEnable(
  server: string,
  options: ScopeOptions & { enable: boolean },
): Promise<void> {
  const company = await requireOrg(options);
  const { servers } = await listMCPConnections(company.id);
  const connection = findConnection(servers, server);
  const updated = await updateMCPConnection(company.id, connection.id, {
    enabled: options.enable,
  });
  if (isJSON(options)) {
    writeJSON(updated);
    return;
  }
  process.stderr.write(`${updated.name} is now ${updated.enabled ? "enabled" : "paused"}.\n`);
}

// ---------------------------------------------------------------------------
// mcp tools
// ---------------------------------------------------------------------------

function toolFlags(tool: EndpointTool, selected: Set<string>): string {
  const flags: string[] = [];
  if (selected.has(tool.name)) flags.push("selected");
  if (tool.requiresApproval) flags.push("needs approval");
  if (tool.enabled === false) flags.push("unavailable");
  return flags.join(", ");
}

export async function cmdMCPTools(
  endpoint: string,
  options: ScopeOptions & { all?: boolean },
): Promise<void> {
  const catalog = await listEndpointTools(endpoint);
  if (isJSON(options)) {
    writeJSON(catalog);
    return;
  }
  const selected = new Set(catalog.selected);
  const tools = options.all ? catalog.tools : catalog.tools.filter((t) => selected.has(t.name));
  if (tools.length === 0) {
    process.stdout.write(
      options.all
        ? "This endpoint can reach no tools.\n"
        : "This endpoint has no tools selected. Pass --all to see what it could reach.\n",
    );
    return;
  }
  printTable(
    ["TOOL", "FROM", "FLAGS"],
    tools.map((t) => [t.name, t.group ?? "", toolFlags(t, selected)]),
  );
  process.stderr.write(
    `\nApprovals: ${catalog.toolApprovalMode}` +
      (catalog.autoApproveTools.length > 0
        ? ` (running without asking: ${catalog.autoApproveTools.join(", ")})`
        : "") +
      "\n",
  );
}

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

function approvalLabel(approval: ToolApproval): string {
  return approval.toolTitle || approval.toolName;
}

function tierSourceNote(source: string | undefined): string {
  switch (source) {
    case "annotations":
      return "server-declared";
    case "catalog":
      return "Ditto tool";
    default:
      return "name heuristic";
  }
}

export async function cmdApprovals(
  options: ScopeOptions & { endpoint?: string },
): Promise<void> {
  const company = await resolveScope(options);
  const { approvals, canDecide } = await listToolApprovals({
    companyId: company?.id,
    endpointId: options.endpoint,
  });
  if (isJSON(options)) {
    writeJSON({ approvals, canDecide });
    return;
  }
  if (approvals.length === 0) {
    process.stdout.write("Nothing waiting.\n");
    return;
  }
  printTable(
    ["ID", "TOOL", "WHY", "REQUEST", "CALL"],
    approvals.map((a) => [
      a.id,
      approvalLabel(a),
      tierSourceNote(a.tierSource),
      a.requestId,
      a.summary || a.toolName,
    ]),
  );
  // The single most important thing to say here, because it is the reading
  // people reach for and it is wrong.
  process.stderr.write(
    "\nNone of these has run. Allowing one runs that tool on its own — it does not\n" +
      "resume the run that parked it, which has already finished.\n",
  );
  if (!canDecide) {
    // Reading this queue is wider than deciding it. Say so here rather than
    // letting the next command answer 404.
    process.stderr.write(
      "\nYou can see these but not decide them — that needs the owner or admin role\n" +
        "in the organization that owns this endpoint.\n",
    );
    return;
  }
  process.stderr.write(
    "\n  heyditto approvals allow <id>\n  heyditto approvals deny <id>\n" +
      "  heyditto approvals allow --request <request-id>   (everything one script held)\n",
  );
}

async function decide(
  ids: string[],
  allow: boolean,
  options: ScopeOptions,
): Promise<ToolApproval[]> {
  const decided: ToolApproval[] = [];
  for (const id of ids) {
    // Sequential, not parallel: each of these has a side effect on someone
    // else's system, and a half-applied batch is easier to reason about when
    // the order is the order you asked for.
    decided.push(allow ? await approveToolApproval(id) : await rejectToolApproval(id));
  }
  if (isJSON(options)) writeJSON({ approvals: decided });
  return decided;
}

async function resolveIDs(
  id: string | undefined,
  options: ScopeOptions & { request?: string; endpoint?: string },
): Promise<string[]> {
  if (id) return [id];
  if (!options.request) {
    throw new Error("pass an approval id, or --request <request-id> to decide a whole request");
  }
  const company = await resolveScope(options);
  const { approvals } = await listToolApprovals({
    companyId: company?.id,
    endpointId: options.endpoint,
  });
  const group = approvals.filter((a) => a.requestId === options.request);
  if (group.length === 0) throw new Error(`no pending approvals for request "${options.request}"`);
  return group.sort((a, b) => a.seq - b.seq).map((a) => a.id);
}

export async function cmdApprovalAllow(
  id: string | undefined,
  options: ScopeOptions & { request?: string; endpoint?: string },
): Promise<void> {
  const ids = await resolveIDs(id, options);
  const decided = await decide(ids, true, options);
  if (isJSON(options)) return;
  for (const approval of decided) {
    if (approval.status === "failed") {
      process.stderr.write(
        `${approvalLabel(approval)} failed: ${approval.error || "no reason given"}\n`,
      );
      continue;
    }
    process.stderr.write(`${approvalLabel(approval)} ran.\n`);
  }
}

export async function cmdApprovalDeny(
  id: string | undefined,
  options: ScopeOptions & { request?: string; endpoint?: string },
): Promise<void> {
  const ids = await resolveIDs(id, options);
  const decided = await decide(ids, false, options);
  if (isJSON(options)) return;
  for (const approval of decided) {
    process.stderr.write(`${approvalLabel(approval)} was not run.\n`);
  }
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerOrgCommands(
  program: Command,
  addExamples: (c: Command, ex: string) => Command,
  outputOption: () => Option,
  orgOption: () => Option,
): void {
  const orgs = program
    .command("orgs")
    .description("organizations you belong to, and which one commands act on")
    .summary("organizations");
  addExamples(
    orgs
      .command("list", { isDefault: true })
      .description("list your organizations (* = the one commands use by default)")
      .addOption(outputOption())
      .action(cmdOrgs),
    `  heyditto orgs
  heyditto orgs --output json`,
  );
  orgs
    .command("use")
    .description("act on this organization when --org is omitted")
    .argument("<org>", "organization slug or id")
    .addOption(outputOption())
    .action(cmdOrgUse);
  orgs
    .command("clear")
    .description("forget the default organization")
    .addOption(outputOption())
    .action(cmdOrgClear);

  const mcp = program
    .command("mcp")
    .description("tool servers (MCP) an organization owns")
    .summary("organization tool servers")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
A connection belongs to the organization, not to you: managers administer it
and the organization's endpoints execute its tools. Personal connections live
in the Ditto app under Settings -> Agent tools.

Anything a server marks as destructive is held for an owner or admin instead of
running. See \`heyditto approvals\`.`,
    );
  addExamples(
    mcp
      .command("list", { isDefault: true })
      .description("list the organization's tool servers")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdMCPList),
    `  heyditto mcp --org omni-aura
  heyditto orgs use omni-aura && heyditto mcp`,
  );
  addExamples(
    mcp
      .command("add")
      .description("connect a tool server to the organization")
      .argument("<name>", "what the team will call it")
      .argument("<url>", "the server's MCP endpoint (https)")
      .option("--transport <transport>", "streamable_http (default) or sse")
      .option("--auth <type>", "oauth (default) or headers")
      .option("--header <header...>", 'for --auth headers: "Name: value"')
      .option("--description <text>", "why the team has this connected")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdMCPAdd),
    `  heyditto mcp add Linear https://mcp.linear.app/mcp --org omni-aura
  heyditto mcp add Internal https://tools.internal/mcp --auth headers --header "Authorization: Bearer xxx"`,
  );
  addExamples(
    mcp
      .command("connect")
      .description("sign in to an OAuth tool server (prints and opens the URL)")
      .argument("<server>", "connection name, prefix or id")
      .option("--no-browser", "print the URL without opening it")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdMCPConnect),
    `  heyditto mcp connect Linear --org omni-aura
  heyditto mcp connect Linear --no-browser`,
  );
  mcp
    .command("remove")
    .description("remove a tool server from the organization")
    .argument("<server>", "connection name, prefix or id")
    .addOption(orgOption())
    .addOption(outputOption())
    .action(cmdMCPRemove);
  mcp
    .command("enable")
    .description("let the organization's endpoints use this connection again")
    .argument("<server>", "connection name, prefix or id")
    .addOption(orgOption())
    .addOption(outputOption())
    .action((server: string, options: ScopeOptions) =>
      cmdMCPEnable(server, { ...options, enable: true }),
    );
  mcp
    .command("disable")
    .description("stop the organization's endpoints using this connection")
    .argument("<server>", "connection name, prefix or id")
    .addOption(orgOption())
    .addOption(outputOption())
    .action((server: string, options: ScopeOptions) =>
      cmdMCPEnable(server, { ...options, enable: false }),
    );
  addExamples(
    mcp
      .command("tools")
      .description("what one endpoint can call, resolved from the endpoint")
      .argument("<endpoint>", "endpoint id")
      .option("--all", "include tools the endpoint could reach but has not selected")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdMCPTools),
    `  heyditto mcp tools 0f1e2d3c-...
  heyditto mcp tools 0f1e2d3c-... --all --output json`,
  );

  const approvals = program
    .command("approvals")
    .description("tool calls held for a human")
    .summary("tool approvals")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Nothing in this queue has run. A tool that can change or delete something was
called through an endpoint and held; the caller was told the call was queued and
carried on without it.

Allowing one runs that tool on its own. It does NOT resume the run that parked
it — that request has already finished, and on a Code Mode endpoint so has the
sandboxed script that made the call.`,
    );
  addExamples(
    approvals
      .command("list", { isDefault: true })
      .description("list held calls")
      .option("--endpoint <id>", "only this endpoint's")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdApprovals),
    `  heyditto approvals
  heyditto approvals --org omni-aura
  heyditto approvals --endpoint 0f1e2d3c-... --output json`,
  );
  addExamples(
    approvals
      .command("allow")
      .description("run one held call now")
      .argument("[id]", "approval id")
      .option("--request <id>", "allow every call one request held")
      .option("--endpoint <id>", "scope --request to one endpoint")
      .addOption(orgOption())
      .addOption(outputOption())
      .action(cmdApprovalAllow),
    `  heyditto approvals allow 6f0c...
  heyditto approvals allow --request req-1 --org omni-aura`,
  );
  approvals
    .command("deny")
    .description("refuse a held call; the tool never runs")
    .argument("[id]", "approval id")
    .option("--request <id>", "deny every call one request held")
    .option("--endpoint <id>", "scope --request to one endpoint")
    .addOption(orgOption())
    .addOption(outputOption())
    .action(cmdApprovalDeny);
}
