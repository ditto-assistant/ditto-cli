import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { launchHarness, pickEndpoint } from "./agents/launch.js";
import { listSessions, removeSession } from "./agents/sessions.js";
import { DEFAULT_LAUNCH_EXPIRY, HARNESSES, type Harness, KEY_EXPIRIES, type KeyExpiry, apiRootOf } from "./agents/types.js";
import {
  type ChatAgent,
  type EndpointInput,
  type InferenceEndpoint,
  createEndpoint,
  createKey,
  deleteEndpoint,
  findEndpoint,
  getEndpoint,
  isEndpointPending,
  listChatAgents,
  listEndpoints,
  listKeys,
  revokeKey,
  updateEndpoint,
} from "./api.js";
import { openInBrowser } from "./browser.js";
import { endpointURL } from "./config.js";
import { activationLink, formatActivation } from "./endpoint-format.js";
import {
  type SecretTarget,
  describeTarget,
  preflightGh,
  resolveRepoFromCwd,
  setGitHubSecret,
  validateRepo,
  validateSecretName,
} from "./gh-secret.js";
import {
  SESSION_ENV,
  SESSION_ID_HEADER,
  endSession,
  readSessionHistory,
  resolveActiveSession,
  startSession,
  useSession,
} from "./mcp-session.js";
import { readStoredAuth, updateStoredAuth } from "./store.js";

interface EndpointsOptions {
  output?: string;
  setDefault?: string;
  clearDefault?: boolean;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function spendColumn(e: InferenceEndpoint): string {
  const used = (e.spentTokens ?? 0).toLocaleString();
  if (e.spendLimitTokens == null || e.spendLimitTokens < 0) return `${used} / ∞`;
  return `${used} / ${e.spendLimitTokens.toLocaleString()}${e.spendPeriod && e.spendPeriod !== "never" ? ` ${e.spendPeriod}` : ""}`;
}

function isJSON(options: { output?: string }): boolean {
  return options.output === "json" || options.output === "raw";
}

/**
 * Endpoint controls spend the user's credits, so anything destructive asks
 * the operator to type the slug back. `--yes` skips it for scripts; without a
 * terminal and without `--yes` the command refuses.
 */
async function confirmElevated(action: string, slug: string, yes: boolean | undefined): Promise<void> {
  await confirmTyped({ action: `${action} "${slug}"`, expected: slug, label: "the endpoint slug", yes });
}

/**
 * Generic typed confirmation: the operator must type `expected` back (or pass
 * `--yes`). Refuses without a terminal so scripts cannot stumble into it.
 */
async function confirmTyped(input: { action: string; expected: string; label: string; yes: boolean | undefined; preview?: string }): Promise<void> {
  if (input.yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(`refusing to ${input.action} without confirmation. Re-run with --yes to confirm.`);
  }
  if (input.preview) process.stderr.write(`${input.preview}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const typed = (await rl.question(`Type ${input.label} (${input.expected}) to ${input.action}: `)).trim();
    if (typed !== input.expected) throw new Error(`aborted: "${typed}" did not match "${input.expected}"`);
  } finally {
    rl.close();
  }
}

/** Prints the backend's activation notice (with the claim token merged in) for inactive endpoints. */
async function noteActivation(endpoints: InferenceEndpoint[]): Promise<void> {
  const pending = endpoints.filter(isEndpointPending);
  if (pending.length === 0) return;
  const stored = await readStoredAuth();
  for (const e of pending) {
    process.stderr.write(`\n! ${e.slug} is not active yet.\n${formatActivation(e, stored?.claimURL)}\n\n`);
  }
}

/** JSON view of an endpoint with the activation link resolved for this install. */
async function endpointJSON(e: InferenceEndpoint): Promise<Record<string, unknown>> {
  const stored = await readStoredAuth();
  const link = activationLink(e, stored?.claimURL);
  return {
    ...e,
    ...(e.activation ? { activation: { ...e.activation, ...(link ? { url: link } : {}) } } : {}),
  };
}

export async function cmdEndpoints(options: EndpointsOptions): Promise<void> {
  if (options.setDefault && options.clearDefault) throw new Error("use either --set-default or --clear-default");
  const catalog = await listEndpoints();
  if (options.clearDefault) {
    await updateStoredAuth({ defaultEndpoint: undefined });
    process.stderr.write("Cleared the default endpoint.\n");
  }
  if (options.setDefault) {
    const wanted = options.setDefault.trim();
    const match = findEndpoint(catalog.endpoints, wanted);
    if (!match) {
      throw new Error(`no endpoint named "${wanted}". Available: ${catalog.endpoints.map((e) => e.slug).join(", ") || "(none)"}`);
    }
    await updateStoredAuth({ defaultEndpoint: match.slug });
    process.stderr.write(`Default endpoint set to ${match.slug}.\n`);
  }
  const defaultSlug = (await readStoredAuth())?.defaultEndpoint;
  if (isJSON(options)) {
    const endpoints = await Promise.all(catalog.endpoints.map(endpointJSON));
    process.stdout.write(`${JSON.stringify({ ...catalog, endpoints, defaultEndpoint: defaultSlug ?? null }, null, 2)}\n`);
    return;
  }
  if (catalog.endpoints.length === 0) {
    process.stdout.write(
      `No inference endpoints yet. Create one with \`heyditto endpoints create\`, or at ${endpointURL()}.\n`,
    );
    return;
  }
  const rows = catalog.endpoints.map((e) => [
    e.slug === defaultSlug ? "*" : " ",
    e.slug,
    e.model,
    spendColumn(e),
    [isEndpointPending(e) ? "inactive" : "", e.recordTrace ? "traces" : ""].filter(Boolean).join(" "),
  ]);
  const widths = [1, 0, 0, 0];
  for (const r of rows) for (let i = 1; i < 4; i++) widths[i] = Math.max(widths[i], r[i].length);
  process.stdout.write(`  ${pad("SLUG", widths[1])}  ${pad("MODEL", widths[2])}  ${pad("SPEND (tokens)", widths[3])}\n`);
  for (const r of rows) {
    process.stdout.write(`${r[0]} ${pad(r[1], widths[1])}  ${pad(r[2], widths[2])}  ${pad(r[3], widths[3])}  ${r[4]}\n`);
  }
  process.stdout.write(`\nGateway: ${catalog.baseUrl}${defaultSlug ? `  (* = default)` : ""}\n`);
  await noteActivation(catalog.endpoints);
}

interface EndpointCreateOptions {
  output?: string;
  name?: string;
  slug?: string;
  model?: string;
  default?: boolean;
}

export async function cmdEndpointCreate(options: EndpointCreateOptions): Promise<void> {
  const input: EndpointInput = {};
  if (options.name?.trim()) input.name = options.name.trim();
  if (options.slug?.trim()) input.slug = options.slug.trim().toLowerCase();
  if (options.model?.trim()) input.model = options.model.trim();
  const created = await createEndpoint(input);
  const stored = await readStoredAuth();
  const makeDefault = options.default || !stored?.defaultEndpoint;
  if (makeDefault) await updateStoredAuth({ defaultEndpoint: created.slug });
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ ...(await endpointJSON(created)), defaultEndpoint: makeDefault ? created.slug : (stored?.defaultEndpoint ?? null) }, null, 2)}\n`);
  } else {
    process.stdout.write(`Created endpoint ${created.slug} (model ${created.model})${makeDefault ? " — now the default" : ""}.\n`);
    if (!isEndpointPending(created)) {
      process.stdout.write(`Launch with: heyditto claude --endpoint ${created.slug}\n`);
    }
  }
  await noteActivation([created]);
}

export async function cmdEndpointShow(ref: string, options: { output?: string }): Promise<void> {
  const { endpoint, catalog } = await getEndpoint(ref);
  const defaultSlug = (await readStoredAuth())?.defaultEndpoint;
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ ...(await endpointJSON(endpoint)), baseUrl: catalog.baseUrl, isDefault: endpoint.slug === defaultSlug }, null, 2)}\n`);
    return;
  }
  const lines = [
    `slug:          ${endpoint.slug}${endpoint.slug === defaultSlug ? "  (default)" : ""}`,
    `name:          ${endpoint.name}`,
    `id:            ${endpoint.id}`,
    `model:         ${endpoint.model}${endpoint.modelMode ? `  (${endpoint.modelMode})` : ""}`,
    `status:        ${endpoint.status ?? "active"}`,
    `spend:         ${spendColumn(endpoint)}`,
    `memory:        recall ${endpoint.recallEnabled === false ? "off" : "on"}, record ${endpoint.recordEnabled === false ? "off" : "on"}${endpoint.memoryDepth !== undefined ? `, depth ${endpoint.memoryDepth}` : ""}`,
    `traces:        ${endpoint.recordTrace ? "on" : "off"}`,
    `tools:         ${(endpoint.tools ?? []).join(", ") || "(none)"}`,
    `gateway:       ${catalog.baseUrl}`,
    `web:           ${endpointURL(endpoint.id)}`,
  ];
  if (endpoint.systemPrompt) lines.push(`system prompt: ${endpoint.systemPrompt.length > 120 ? `${endpoint.systemPrompt.slice(0, 117)}…` : endpoint.systemPrompt}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  await noteActivation([endpoint]);
}

export async function cmdEndpointUse(ref: string, options: { output?: string }): Promise<void> {
  const { endpoint } = await getEndpoint(ref);
  await updateStoredAuth({ defaultEndpoint: endpoint.slug });
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ defaultEndpoint: endpoint.slug }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Default endpoint set to ${endpoint.slug}.\n`);
  await noteActivation([endpoint]);
}

export async function cmdEndpointPick(options: { output?: string }): Promise<void> {
  const catalog = await listEndpoints();
  if (catalog.endpoints.length === 0) {
    throw new Error("you have no inference endpoints yet. Create one with `heyditto endpoints create`.");
  }
  const stored = (await readStoredAuth())?.defaultEndpoint;
  const picked = await pickEndpoint(catalog.endpoints, stored);
  await updateStoredAuth({ defaultEndpoint: picked.slug });
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ defaultEndpoint: picked.slug }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Default endpoint set to ${picked.slug}.\n`);
  await noteActivation([picked]);
}

export async function cmdEndpointOpen(ref: string | undefined, options: { print?: boolean }): Promise<void> {
  // The developer console addresses endpoints by id; resolve the slug (or the
  // stored default) through the catalog. No target → the endpoints list.
  const target = ref ?? (await readStoredAuth())?.defaultEndpoint;
  const id = target ? (await getEndpoint(target)).endpoint.id : undefined;
  const url = endpointURL(id);
  process.stdout.write(`${url}\n`);
  if (!options.print) {
    process.stderr.write("Opening in your browser…\n");
    openInBrowser(url);
  }
}

interface EndpointSetOptions {
  output?: string;
  name?: string;
  model?: string;
  systemPrompt?: string;
  spendLimit?: string;
  spendPeriod?: string;
  recordTrace?: string;
  recall?: string;
  record?: string;
  memoryDepth?: string;
  yes?: boolean;
}

function onOff(flag: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "false" || v === "no") return false;
  throw new Error(`${flag} must be on or off`);
}

export async function cmdEndpointSet(ref: string, options: EndpointSetOptions): Promise<void> {
  const patch: EndpointInput = {};
  if (options.name !== undefined) patch.name = options.name.trim();
  if (options.model !== undefined) patch.model = options.model.trim();
  if (options.systemPrompt !== undefined) patch.systemPrompt = options.systemPrompt;
  if (options.spendLimit !== undefined) {
    const raw = options.spendLimit.trim().toLowerCase();
    if (raw === "none" || raw === "unlimited" || raw === "off") {
      patch.spendLimitTokens = null;
    } else {
      const n = Number(raw.replace(/[_,]/g, ""));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--spend-limit must be a positive integer token count or "none", got "${options.spendLimit}"`);
      patch.spendLimitTokens = n;
    }
  }
  if (options.spendPeriod !== undefined) patch.spendPeriod = options.spendPeriod;
  const recordTrace = onOff("--record-trace", options.recordTrace);
  if (recordTrace !== undefined) patch.recordTrace = recordTrace;
  const recall = onOff("--recall", options.recall);
  if (recall !== undefined) patch.recallEnabled = recall;
  const record = onOff("--record", options.record);
  if (record !== undefined) patch.recordEnabled = record;
  if (options.memoryDepth !== undefined) {
    const n = Number(options.memoryDepth);
    if (!Number.isInteger(n) || n < 0 || n > 25) throw new Error("--memory-depth must be an integer from 0 to 25");
    patch.memoryDepth = n;
  }
  if (Object.keys(patch).length === 0) throw new Error("nothing to change; pass at least one --flag (see `heyditto endpoints set --help`)");

  const { endpoint } = await getEndpoint(ref);
  // Raising or removing a spend cap lets the endpoint spend more credits.
  const raisesSpend =
    patch.spendLimitTokens === null ||
    (typeof patch.spendLimitTokens === "number" &&
      endpoint.spendLimitTokens != null &&
      endpoint.spendLimitTokens >= 0 &&
      patch.spendLimitTokens > endpoint.spendLimitTokens) ||
    (patch.spendPeriod !== undefined && patch.spendPeriod !== endpoint.spendPeriod && patch.spendPeriod === "never");
  if (raisesSpend) await confirmElevated("raise the spend limit of", endpoint.slug, options.yes);

  const updated = await updateEndpoint(endpoint.id, patch);
  if (updated.slug !== endpoint.slug && (await readStoredAuth())?.defaultEndpoint === endpoint.slug) {
    await updateStoredAuth({ defaultEndpoint: updated.slug });
  }
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify(await endpointJSON(updated), null, 2)}\n`);
    return;
  }
  process.stdout.write(`Updated ${updated.slug}: ${Object.keys(patch).join(", ")}.\n`);
  await noteActivation([updated]);
}

export async function cmdEndpointDelete(ref: string, options: { yes?: boolean; output?: string }): Promise<void> {
  const { endpoint } = await getEndpoint(ref);
  await confirmElevated("delete", endpoint.slug, options.yes);
  await deleteEndpoint(endpoint.id);
  const stored = await readStoredAuth();
  if (stored?.defaultEndpoint === endpoint.slug || stored?.defaultEndpoint === endpoint.id) {
    await updateStoredAuth({ defaultEndpoint: undefined });
  }
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ deleted: endpoint.id, slug: endpoint.slug }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Deleted endpoint ${endpoint.slug}. Its keys stop working immediately; threads and traces are kept.\n`);
}

export async function cmdEndpointKeys(ref: string, options: { output?: string }): Promise<void> {
  const { endpoint } = await getEndpoint(ref);
  const keys = await listKeys(endpoint.id);
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ endpoint: { id: endpoint.id, slug: endpoint.slug }, keys }, null, 2)}\n`);
    return;
  }
  if (keys.length === 0) {
    process.stdout.write(`No keys on ${endpoint.slug}. \`heyditto claude\` mints a temporary one per session.\n`);
    return;
  }
  const rows = keys.map((k) => [
    k.id,
    `…${k.keyHint}`,
    k.name,
    k.revokedAt ? "revoked" : k.expiresAt ? `expires ${k.expiresAt.slice(0, 10)}` : "no expiry",
    k.lastUsedAt ? `used ${k.lastUsedAt.slice(0, 16).replace("T", " ")}` : "",
  ]);
  const header = ["ID", "KEY", "NAME", "STATE", "LAST USED"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]))).join("  ");
  process.stdout.write(`${line(header)}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
}

export async function cmdEndpointKeysRevoke(ref: string, keyId: string, options: { yes?: boolean; output?: string }): Promise<void> {
  const { endpoint } = await getEndpoint(ref);
  await confirmElevated(`revoke key ${keyId} on`, endpoint.slug, options.yes);
  await revokeKey(endpoint.id, keyId);
  if (isJSON(options)) {
    process.stdout.write(`${JSON.stringify({ revoked: keyId, endpoint: endpoint.slug }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Revoked key ${keyId} on ${endpoint.slug}.\n`);
}

interface KeysCreateOptions {
  output?: string;
  ghSecret?: string;
  repo?: string;
  env?: string;
  org?: string;
  name?: string;
  expires?: string;
  budget?: string;
  spendPeriod?: string;
  yes?: boolean;
}

function parseKeyBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--budget must be a positive integer token count, got "${raw}"`);
  return n;
}

function parseKeyExpiry(raw: string | undefined): KeyExpiry {
  const value = (raw ?? "1y").trim();
  if ((KEY_EXPIRIES as readonly string[]).includes(value)) return value as KeyExpiry;
  throw new Error(`--expires must be one of: ${KEY_EXPIRIES.join(", ")}`);
}

/** Resolves where the secret goes from --repo / --env / --org (repo falls back to the cwd, like gh). */
function resolveSecretTarget(options: KeysCreateOptions): SecretTarget {
  const org = options.org?.trim();
  const env = options.env?.trim();
  if (org) {
    if (options.repo || env) throw new Error("--org cannot be combined with --repo or --env (organization secrets are not scoped to one repository)");
    if (!/^[A-Za-z0-9_.-]+$/.test(org)) throw new Error(`--org must be an organization login, got "${options.org}"`);
    return { kind: "org", org };
  }
  const repo = options.repo ? validateRepo(options.repo) : resolveRepoFromCwd();
  if (env) return { kind: "env", repo, env };
  return { kind: "repo", repo };
}

/**
 * Mints a key on an endpoint and hands the plaintext straight to `gh secret
 * set` over stdin. The key is never printed, logged or stored locally; on a
 * failed `gh` call it is revoked again so nothing usable is left behind.
 */
export async function cmdEndpointKeysCreate(ref: string, options: KeysCreateOptions): Promise<void> {
  if (!options.ghSecret) throw new Error("--gh-secret <NAME> is required: this command only mints keys straight into a GitHub Actions secret");
  const secretName = validateSecretName(options.ghSecret);
  const budget = parseKeyBudget(options.budget);
  const expiresIn = parseKeyExpiry(options.expires);
  if (options.spendPeriod !== undefined && budget === undefined) throw new Error("--spend-period only applies together with --budget");
  const spendPeriod = budget !== undefined ? (options.spendPeriod ?? "monthly") : undefined;

  // Everything that can fail cheaply happens before any write: gh present and
  // signed in, target repo known, endpoint exists, operator confirmed.
  preflightGh();
  const target = resolveSecretTarget(options);
  const { endpoint, catalog } = await getEndpoint(ref);
  const keyName =
    options.name?.trim() || (target.kind === "org" ? `gh-secret:${secretName}` : `gh:${target.repo}:${secretName}`);
  const plan = `Will mint key "${keyName}" on ${endpoint.slug} (expires ${expiresIn}${budget !== undefined ? `, budget ${budget.toLocaleString()} tokens ${spendPeriod}` : ""}) and set secret ${secretName} on ${describeTarget(target)}.`;
  await confirmTyped({ action: `mint a key on ${endpoint.slug} and set secret ${secretName}`, expected: secretName, label: "the secret name", yes: options.yes, preview: plan });

  const minted = await createKey(endpoint.id, {
    name: keyName,
    expiresIn,
    ...(budget !== undefined ? { spendLimitTokens: budget, spendPeriod } : {}),
  });
  // Split the plaintext off immediately; only `plaintext` may reach gh's stdin.
  const { key: plaintext, ...key } = minted;
  try {
    setGitHubSecret(secretName, target, plaintext ?? "");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      await revokeKey(endpoint.id, key.id);
    } catch (revokeErr) {
      const detail = revokeErr instanceof Error ? revokeErr.message : String(revokeErr);
      throw new Error(
        `${reason}\nMinted key ${key.id} (…${key.keyHint}) on ${endpoint.slug} could NOT be revoked (${detail}). Revoke it now: heyditto endpoints keys revoke ${endpoint.slug} ${key.id} --yes, or at ${endpointURL(endpoint.id)}`,
      );
    }
    throw new Error(`${reason}\nThe key minted for it (…${key.keyHint}) was revoked again; nothing was stored.`);
  }

  const anthropicBaseUrl = apiRootOf(catalog.baseUrl);
  const openaiBaseUrl = catalog.baseUrl;
  const snippet = `\${{ secrets.${secretName} }}`;
  if (isJSON(options)) {
    process.stdout.write(
      `${JSON.stringify(
        {
          endpoint: { id: endpoint.id, slug: endpoint.slug },
          key: {
            id: key.id,
            name: key.name ?? keyName,
            keyHint: key.keyHint,
            expiresIn,
            expiresAt: key.expiresAt ?? null,
            spendLimitTokens: key.spendLimitTokens ?? budget ?? null,
            spendPeriod: key.spendPeriod ?? spendPeriod ?? null,
          },
          secret: { name: secretName, ...target, snippet },
          gateway: { baseUrl: catalog.baseUrl, anthropicBaseUrl, openaiBaseUrl },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  process.stdout.write(
    [
      `Minted key …${key.keyHint} (${key.name ?? keyName}) on ${endpoint.slug}: expires ${expiresIn}${budget !== undefined ? `, budget ${budget.toLocaleString()} tokens ${spendPeriod}` : ", no spend cap"}.`,
      `Stored it as GitHub Actions secret ${secretName} on ${describeTarget(target)}. The key was not printed and is not kept locally.`,
      "",
      "Use it in a workflow step:",
      "  env:",
      `    ANTHROPIC_AUTH_TOKEN: ${snippet}`,
      `    ANTHROPIC_BASE_URL: ${anthropicBaseUrl}`,
      `  # OpenAI-compatible clients: OPENAI_API_KEY: ${snippet} with OPENAI_BASE_URL: ${openaiBaseUrl}`,
      "",
      `Revoke later with: heyditto endpoints keys revoke ${endpoint.slug} ${key.id}`,
    ].join("\n") + "\n",
  );
}

/** Registers the `endpoints` group; bare `heyditto endpoints [flags]` still lists. */
export function registerEndpointCommands(
  program: Command,
  addExamples: (c: Command, ex: string) => Command,
  outputOption: () => Option,
): void {
  const endpoints = program
    .command("endpoints")
    .description("manage the inference endpoints used by heyditto claude / codex")
    .summary("manage inference endpoints")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Endpoint controls spend your Ditto credits, so delete, key revocation and
spend-limit increases ask you to type the slug back (or pass --yes).
'keys create --gh-secret' mints a key straight into a GitHub Actions secret
through the gh CLI; the plaintext never reaches your terminal.`,
    );
  addExamples(
    endpoints
      .command("list", { isDefault: true })
      .description("list your inference endpoints (* = default)")
      .option("--set-default <slug>", "endpoint to use when --endpoint is omitted")
      .option("--clear-default", "forget the default endpoint")
      .addOption(outputOption())
      .action(cmdEndpoints),
    `  heyditto endpoints
  heyditto endpoints --set-default my-endpoint
  heyditto endpoints list --output json`,
  );
  addExamples(
    endpoints
      .command("create")
      .description("create an endpoint (one click: name, slug and model are generated when omitted)")
      .option("--name <name>", "display name")
      .option("--slug <slug>", "url-safe slug (lowercase letters, digits, dashes)")
      .option("--model <id>", "default model id (default: the gateway's default model)")
      .option("--default", "make it the default for heyditto claude / codex (automatic when you have no default yet)")
      .addOption(outputOption())
      .action(cmdEndpointCreate),
    `  heyditto endpoints create
  heyditto endpoints create --name "Work laptop" --model anthropic/claude-sonnet-5 --default`,
  );
  endpoints
    .command("show")
    .description("show one endpoint's settings")
    .argument("<endpoint>", "endpoint slug or id")
    .addOption(outputOption())
    .action(cmdEndpointShow);
  endpoints
    .command("use")
    .description("make an endpoint the default for heyditto claude / codex")
    .argument("<endpoint>", "endpoint slug or id")
    .addOption(outputOption())
    .action(cmdEndpointUse);
  endpoints
    .command("pick")
    .description("choose the default endpoint interactively")
    .addOption(outputOption())
    .action(cmdEndpointPick);
  endpoints
    .command("open")
    .description("open the endpoint editor in the Ditto app (default endpoint when omitted)")
    .argument("[endpoint]", "endpoint slug or id")
    .option("--print", "print the URL without opening a browser")
    .action(cmdEndpointOpen);
  addExamples(
    endpoints
      .command("set")
      .description("change an endpoint's settings (mirror of the web editor)")
      .argument("<endpoint>", "endpoint slug or id")
      .option("--name <name>", "display name")
      .option("--model <id>", "default model id")
      .option("--system-prompt <text>", "system prompt prepended to every request")
      .option("--spend-limit <tokens|none>", "spend cap in Ditto tokens, or none")
      .addOption(new Option("--spend-period <period>", "window the spend cap resets on").choices(["daily", "weekly", "monthly", "yearly", "never"]))
      .option("--record-trace <on|off>", "store raw request/response traces")
      .option("--recall <on|off>", "recall memories into requests")
      .option("--record <on|off>", "record new memories from requests")
      .option("--memory-depth <n>", "memories recalled per request (0-25)")
      .option("--yes", "skip the confirmation when raising a spend limit")
      .addOption(outputOption())
      .action(cmdEndpointSet),
    `  heyditto endpoints set my-endpoint --model openai/gpt-5.6-luna --record-trace on
  heyditto endpoints set my-endpoint --spend-limit 5000000 --spend-period monthly`,
  );
  endpoints
    .command("delete")
    .description("delete an endpoint (keys stop working; threads and traces are kept)")
    .argument("<endpoint>", "endpoint slug or id")
    .option("--yes", "skip the confirmation prompt")
    .addOption(outputOption())
    .action(cmdEndpointDelete);
  const keys = endpoints
    .command("keys")
    .description("list an endpoint's API keys")
    .argument("<endpoint>", "endpoint slug or id")
    .addOption(outputOption())
    .action(cmdEndpointKeys);
  addExamples(
    keys
      .command("create")
      .description("mint a key and store it straight into a GitHub Actions secret via gh (the key is never printed)")
      .argument("<endpoint>", "endpoint slug or id")
      .requiredOption("--gh-secret <NAME>", "Actions secret name to set with the gh CLI")
      .option("--repo <owner/repo>", "repository for the secret (default: the repo of the current directory, as gh resolves it)")
      .option("--env <environment>", "set a deployment-environment secret on the repo instead of a repository secret")
      .option("--org <org>", "set an organization secret instead (cannot be combined with --repo/--env)")
      .option("--name <label>", "key name shown in the Ditto app (default: gh:<owner>/<repo>:<NAME>)")
      .addOption(new Option("--expires <duration>", "server-side key expiry").choices([...KEY_EXPIRIES]).default("1y"))
      .option("--budget <tokens>", "spend cap for the key, in Ditto tokens")
      .addOption(new Option("--spend-period <period>", "window the key's spend cap resets on (with --budget; default monthly)").choices(["daily", "weekly", "monthly", "yearly", "never"]))
      .option("--yes", "skip the confirmation prompt (required without a terminal)")
      .addOption(outputOption())
      .action(cmdEndpointKeysCreate),
    `  heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY                  # repo of the current directory
  heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY --repo acme/app --budget 5000000
  heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY --repo acme/app --env production --yes
  heyditto endpoints keys create my-endpoint --gh-secret DITTO_KEY --org acme --expires 6mo --output json`,
  );
  keys
    .command("revoke")
    .description("revoke one key")
    .argument("<endpoint>", "endpoint slug or id")
    .argument("<keyId>", "key id (see `heyditto endpoints keys <endpoint>`)")
    .option("--yes", "skip the confirmation prompt")
    .addOption(outputOption())
    .action(cmdEndpointKeysRevoke);
}

interface SessionsOptions {
  json?: boolean;
  all?: boolean;
}

export async function cmdSessions(options: SessionsOptions): Promise<void> {
  const records = await listSessions();
  const shown = options.all ? records : records.slice(0, 20);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
    return;
  }
  if (shown.length === 0) {
    process.stdout.write("No coding-agent sessions yet. Start one with `heyditto claude` or `heyditto codex`.\n");
    return;
  }
  for (const s of shown) {
    const state = s.endedAt ? `exited ${s.exitCode ?? "?"}` : "running/unknown";
    process.stdout.write(
      `${s.id}  ${pad(s.harness, 6)}  ${pad(s.endpointSlug, 16)}  ${s.lastLaunchedAt.slice(0, 16).replace("T", " ")}  ${state}\n`,
    );
    process.stdout.write(`  ${s.worktree ?? s.cwd}${s.launches > 1 ? `  (${s.launches} launches)` : ""}\n`);
  }
  if (!options.all && records.length > shown.length) {
    process.stdout.write(`\n…and ${records.length - shown.length} more (use --all)\n`);
  }
  process.stdout.write(`\nResume: heyditto <claude|codex> --resume <id>\n`);
}

export async function cmdSessionsRm(id: string): Promise<void> {
  const removed = await removeSession(id);
  if (!removed) throw new Error(`no local session "${id}"`);
  process.stdout.write(`Removed local session record ${id} (the Ditto thread and traces are kept).\n`);
}

/** Registers `claude` and `codex` on the program (which must have enablePositionalOptions()). */
export function registerHarnessCommands(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  for (const harness of HARNESSES) {
    const other: Harness = harness === "claude" ? "codex" : "claude";
    const cmd = program
      .command(`${harness} [args...]`)
      .description(
        `launch ${harness === "claude" ? "Claude Code" : "Codex"} through a Ditto inference endpoint with a temporary key`,
      )
      .summary(`launch ${harness === "claude" ? "Claude Code" : "Codex"} through a Ditto endpoint`)
      .option("-e, --endpoint <slug>", "inference endpoint slug or id (default: saved default, or a picker)")
      .option("--budget <tokens>", "spend cap for this session's key, in Ditto tokens")
      .addOption(
        new Option("--expires <duration>", "server-side safety expiry for the key (it is still revoked on exit)")
          .choices([...KEY_EXPIRIES])
          .default(DEFAULT_LAUNCH_EXPIRY),
      )
      .option("--keep-key", "do not revoke the key when the agent exits")
      .option("--session <id>", "reuse a Ditto session id (X-Ditto-Session-Id) for the traces thread")
      .option("--resume [id]", "resume a local session (default: the most recent one); mints a fresh key")
      .option("-c, --continue", `continue the most recent ${harness} conversation in this directory`)
      .option("--yolo", `bypass all permission prompts (${harness === "claude" ? "--dangerously-skip-permissions" : "--dangerously-bypass-approvals-and-sandbox"})`)
      .option("--yellow", `auto-accept edits (${harness === "claude" ? "--permission-mode acceptEdits" : "-a on-request -s workspace-write"})`)
      .option("-p, --prompt <text>", `headless run (${harness === "claude" ? "claude -p" : "codex exec"}); pair with --output-format etc.`)
      .option("-m, --model <id>", harness === "codex" ? "model id (default: the endpoint slug)" : "model id (default: let the endpoint route Claude's ids)")
      .option("-w, --worktree [name]", "run inside <repo>/.worktrees/<name> (created on a branch of the same name)")
      .option("--name <label>", "key name shown in the Ditto app (default: cli:<harness>:<hostname>)")
      .option("--dry-run", "print the command, args and env (key masked) without minting a key")
      .allowUnknownOption()
      .passThroughOptions();
    if (harness === "claude") cmd.option("--plan", "start in plan mode (--permission-mode plan)");
    cmd.action(async (args: string[], options) => {
      await launchHarness(harness, args, options);
    });
    addExamples(
      cmd,
      `  heyditto ${harness}                       first run: sign in + pick an endpoint in the browser, then launch
  heyditto ${harness} --endpoint my-endpoint --budget 500000
  heyditto ${harness} --yellow --worktree feature-x
  heyditto ${harness} -p "summarize this repo" --output-format json
  heyditto ${harness} --resume                 reopen the last session in its thread
  heyditto ${harness} -- --verbose             forward flags to ${harness}
  (see also: heyditto ${other})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Explicit MCP sessions: `heyditto session …`
// ---------------------------------------------------------------------------

interface SessionOutputOptions {
  output?: string;
}

function jsonOut(options: SessionOutputOptions): boolean {
  return options.output === "json" || options.output === "raw";
}

function sessionOutputOption(): Option {
  return new Option("--output <format>", "output format").choices(["text", "json"]).default("text");
}

function relativeAge(iso: string | undefined | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export async function cmdSessionNew(nameParts: string[], options: SessionOutputOptions & { id?: string }): Promise<void> {
  const name = nameParts.join(" ").trim() || undefined;
  const record = await startSession(name, options.id);
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify({ active: true, ...record }, null, 2)}\n`);
    return;
  }
  process.stderr.write(
    `Started session ${record.id}${record.name ? ` (${record.name})` : ""}.\n` +
      `Memory commands now send ${SESSION_ID_HEADER}; end it with \`heyditto session end\`.\n`,
  );
  process.stdout.write(`${record.id}\n`);
}

export async function cmdSessionList(options: SessionOutputOptions & { all?: boolean }): Promise<void> {
  const [history, active] = await Promise.all([readSessionHistory(), resolveActiveSession()]);
  const rows = options.all ? history : history.slice(0, 20);
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify({ active: active ?? null, sessions: rows }, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No MCP sessions yet. Start one with `heyditto session new [name]`.\n");
    return;
  }
  for (const r of rows) {
    const mark = active?.id === r.id ? "*" : " ";
    const state = r.endedAt ? "ended" : active?.id === r.id ? "active" : "idle";
    process.stdout.write(
      `${mark} ${r.id}  ${pad(state, 6)}  ${pad(relativeAge(r.lastUsedAt ?? r.createdAt), 9)}  ${r.name ?? ""}\n`,
    );
  }
  if (active?.source === "env") process.stdout.write(`\n${SESSION_ENV} pins session ${active.id} for this shell.\n`);
}

export async function cmdSessionUse(id: string, options: SessionOutputOptions): Promise<void> {
  const record = await useSession(id);
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify({ active: true, ...record }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`Using session ${record.id}${record.name ? ` (${record.name})` : ""}.\n`);
  process.stdout.write(`${record.id}\n`);
}

export async function cmdSessionCurrent(options: SessionOutputOptions): Promise<void> {
  const active = await resolveActiveSession();
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify(active ?? null, null, 2)}\n`);
    if (!active) process.exitCode = 1;
    return;
  }
  if (!active) {
    process.stderr.write("No active session. Start one with `heyditto session new [name]`.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${active.id}\n`);
  if (active.name) process.stderr.write(`name: ${active.name}\n`);
  if (active.source === "env") process.stderr.write(`(pinned by ${SESSION_ENV})\n`);
}

export async function cmdSessionEnd(options: SessionOutputOptions): Promise<void> {
  const ended = await endSession();
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify(ended ?? null, null, 2)}\n`);
    return;
  }
  if (!ended) {
    process.stderr.write("No active session.\n");
    return;
  }
  process.stderr.write(`Ended session ${ended.id}. Memory commands go back to the implicit session.\n`);
}

export function registerSessionCommands(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  const session = program
    .command("session")
    .description("explicit MCP sessions: group saves and searches into one thread")
    .summary("manage the explicit MCP session")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
Without a session, MCP saves fall into a time-based implicit session on the
server. 'session new' pins an explicit one: every request carries
${SESSION_ID_HEADER} (and the name once, as X-Ditto-Session-Name). Set
${SESSION_ENV} to pin a session for one shell or script.`,
    );
  addExamples(
    session
      .command("new")
      .description("start a new session and make it active")
      .argument("[name...]", "optional name; becomes the thread title")
      .option("--id <id>", "use this session id instead of a random uuid")
      .addOption(sessionOutputOption())
      .action(cmdSessionNew),
    `  heyditto session new "refactor auth module"
  heyditto session new --output json | jq -r .id`,
  );
  session
    .command("list")
    .description("list local sessions (newest first; * = active)")
    .option("--all", "show every record, not just the latest 20")
    .addOption(sessionOutputOption())
    .action(cmdSessionList);
  session
    .command("use")
    .description("make an existing session active")
    .argument("<id>", "session id (a unique prefix of at least 6 chars works)")
    .addOption(sessionOutputOption())
    .action(cmdSessionUse);
  session
    .command("current")
    .description("print the active session id (exit 1 when none)")
    .addOption(sessionOutputOption())
    .action(cmdSessionCurrent);
  session
    .command("end")
    .description("end the active session (history is kept)")
    .addOption(sessionOutputOption())
    .action(cmdSessionEnd);
}

// ---------------------------------------------------------------------------
// Chat agents: `heyditto agents`
// ---------------------------------------------------------------------------

function connectionsColumn(a: ChatAgent): string {
  const live = (a.connections ?? []).filter((c) => !c.revokedAt);
  return live.map((c) => `${c.kind}${c.name ? `:${c.name}` : ""}`).join(", ");
}

export async function cmdAgents(options: SessionOutputOptions): Promise<void> {
  const agents = await listChatAgents();
  if (jsonOut(options)) {
    process.stdout.write(`${JSON.stringify({ agents }, null, 2)}\n`);
    return;
  }
  if (agents.length === 0) {
    process.stdout.write("No agents yet.\n");
    return;
  }
  const rows = agents.map((a) => [
    a.id,
    a.kind,
    a.name,
    String(a.threadCount ?? ""),
    relativeAge(a.lastActivityAt ?? a.updatedAt),
    connectionsColumn(a),
  ]);
  const header = ["ID", "KIND", "NAME", "THREADS", "LAST ACTIVITY", "CONNECTIONS"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]))).join("  ");
  process.stdout.write(`${line(header)}\n`);
  for (const r of rows) process.stdout.write(`${line(r)}\n`);
}
