import type { Command, Option } from "commander";
import { resolveCompany } from "./api.js";
import { readStoredAuth } from "./store.js";
import { addProviderKey, BALANCE_PROVIDERS, inspectProviderKey, listProviderKeys, probeMetadata, probeProviderKey, providerCatalog, providerManagementBase, removeProviderKey, requireProviderKeyId, setProviderKey, type BalanceProvider, type ProviderKeyInput } from "./provider-key-api.js";
import { boundedInteger, parseProviderProtocol, providerKeyHints, providerURLInput, publicProviderParams } from "./provider-key-input.js";
import { readOperatorQuote } from "./provider-probe-quote.js";
import { importGCloudProviderSecret, readProviderSecret } from "./provider-secrets.js";

interface ScopeOptions { org?: string; personal?: boolean; output?: string }
interface AddOptions extends ScopeOptions {
  provider?: string; protocol?: string; baseUrl?: string; balanceProvider?: string; label?: string;
  enable?: boolean; priority?: string; modelAllow?: string[]; modelDeny?: string[]; stdin?: boolean; inspect?: boolean;
  param?: string[]; keyEnv?: string;
  from?: string; secret?: string; project?: string; account?: string; version?: string;
}

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function collect(value: string, previous: string[] = []): string[] { return [...previous, value]; }

export async function providerKeyScope(options: ScopeOptions): Promise<{ companyId?: string; scope: Record<string, unknown> }> {
  providerManagementBase(); // before resolving an organization with the shared REST client
  if (options.org && options.personal) throw new Error("choose --org or --personal, not both");
  const wanted = options.org?.trim() || (options.personal ? undefined : (await readStoredAuth())?.defaultCompany);
  if (!wanted) return { scope: { kind: "personal" } };
  const company = await resolveCompany(wanted);
  return { companyId: company.id, scope: { kind: "company", companyId: company.id, slug: company.slug } };
}

async function cmdAdd(options: AddOptions, importing: boolean): Promise<void> {
  const { companyId, scope } = await providerKeyScope(options);
  if (importing && options.from !== "gcloud") throw new Error("--from currently supports gcloud");
  if (importing && !options.secret) throw new Error("import requires --secret NAME or a Secret Manager resource");
  if (options.balanceProvider !== undefined && !BALANCE_PROVIDERS.includes(options.balanceProvider as BalanceProvider)) throw new Error("--balance-provider must be impala, openrouter, gm or vercel_ai_gateway");
  const url = options.baseUrl === undefined ? undefined : providerURLInput(options.baseUrl);
  const protocol = parseProviderProtocol(options.protocol) ?? url?.protocolHint;
  if (options.protocol && url?.protocolHint && protocol !== url.protocolHint) throw new Error("--protocol conflicts with the method in --base-url");
  const priority = options.priority === undefined ? undefined : boundedInteger(options.priority, "--priority", 1, 10_000);
  const catalog = await providerCatalog();
  let key = "";
  let source: unknown;
  try {
    if (importing) {
      const imported = await importGCloudProviderSecret({ secret: options.secret!, project: options.project, account: options.account, version: options.version });
      key = imported.key;
      source = { store: "gcloud", ...imported.source };
    } else key = await readProviderSecret(options);
    const hints = providerKeyHints(key, catalog);
    const provider = options.provider ?? (url && protocol ? "custom" : hints.length === 1 ? hints[0] : undefined);
    if (!provider) {
      throw new Error(hints.length > 1 ? `ambiguous key type; choose one --provider (${hints.join(", ")}). No key was submitted` : "unknown key type; choose --provider, or use --provider custom --base-url URL --protocol openai|anthropic. No key was submitted");
    }
    if (provider !== "custom" && !catalog.some(row => row.id === provider && row.routable)) throw new Error("choose a routable --provider from provider-keys providers");
    if (provider === "custom" && (!url || !protocol)) throw new Error("custom API keys require --base-url and --protocol openai|anthropic (a full chat/messages URL can supply the protocol)");
    const entry = catalog.find(row => row.id === provider);
    if (entry?.requiresBaseUrl && !url) throw new Error("this provider requires --base-url URL");
    const templateParams = publicProviderParams(options.param ?? [], entry, url?.baseUrl, key);
    if (options.balanceProvider === "impala" && !["custom", "custom_openai", "custom_anthropic"].includes(provider)) throw new Error("the Impala balance adapter requires a custom API key");
    if (options.balanceProvider && options.balanceProvider !== "impala" && options.balanceProvider !== provider) throw new Error("the balance adapter must match the selected named provider");
    if (options.label && options.label.includes(key)) throw new Error("the key label must not contain the API key");
    const input: ProviderKeyInput = { companyId, provider, key, enabled: options.enable === true, label: options.label, baseUrl: url?.baseUrl, protocol, priority, modelAllow: options.modelAllow, modelDeny: options.modelDeny, templateParams, balanceProvider: options.balanceProvider as BalanceProvider | undefined };
    const saved = await addProviderKey(input);
    key = "";
    print({ scope, key: saved, ...(source ? { source } : {}), secretPrinted: false });
    if (options.inspect !== false) {
      try { print({ inspection: await inspectProviderKey(saved.id, companyId), note: "Advertised models are not proof of inference or paid access. No generation probe ran." }); }
      catch { process.stderr.write(`Key ${saved.id} was saved. Its no-generation inspection failed; use provider-keys inspect to retry. No credential diagnostics were printed.\n`); }
    }
  } finally { key = ""; }
}

function addScope(command: Command, outputOption: () => Option): Command {
  return command.option("--org <org>", "organization slug or UUID (default: saved organization, otherwise personal)").option("--personal", "use personal keys, ignoring the saved organization").addOption(outputOption());
}

export function registerProviderKeyCommands(program: Command, outputOption: () => Option): void {
  const keys = program.command("provider-keys").description("manage provider credentials without exposing their values; designed for agents").showHelpAfterError().addHelpText("after", "\nSecrets enter through a local --key-env reference, hidden paste, --stdin, or Secret Manager import. Never pass raw keys as arguments or MCP tool inputs. Prefixes are hints; validation uses one confirmed destination. JSON output contains metadata only.\n");
  addScope(keys.command("list").description("list saved key metadata; never retrieve credentials"), outputOption).action(async (options: ScopeOptions) => {
    const { companyId, scope } = await providerKeyScope(options);
    print({ scope, ...await listProviderKeys(companyId) });
  });
  keys.command("providers").description("list provider hints and supported protocols without contacting providers").addOption(outputOption()).action(async () => print({ providers: await providerCatalog() }));
  for (const importing of [false, true]) {
    const command = addScope(keys.command(importing ? "import" : "add").description(importing ? "copy a key from Secret Manager into Ditto without printing it" : "save a provider key from a local env reference, hidden paste or stdin"), outputOption)
      .option("--provider <id>", "provider id, or custom; omit for unique local prefix detection")
      .option("--base-url <url>", "public HTTPS base or full chat/messages URL; credentials and query parameters are rejected")
      .option("--protocol <protocol>", "custom API protocol: openai or anthropic")
      .option("--balance-provider <provider>", "explicitly send the saved key to this provider's fixed balance API: impala, openrouter, gm or vercel_ai_gateway")
      .option("--label <label>", "key label, never its value")
      .option("--priority <number>", "provider priority, an integer from 1 to 10000")
      .option("--param <name=value>", "declared public provider setting, such as account_id or gateway_id (repeatable; never credentials)", collect)
      .option("--model-allow <pattern>", "model allow pattern (repeatable)", collect)
      .option("--model-deny <pattern>", "model deny pattern (repeatable)", collect)
      .option("--enable", "activate immediately for existing normal BYOK endpoints using automatic/all-key selection; not limited to a private pool")
      .option("--no-inspect", "skip the default no-generation validation, model listing and balance check")
      .addHelpText("after", "\nNew keys are stored disabled by default. Use --enable only to make the key eligible for existing normal BYOK automatic/all-key selection. Inspection and explicitly confirmed bounded probes can use dormant keys.\n\nBalance inspection sends the saved key to a fixed provider API. Impala uses https://api.platform.getimpala.ai/v1/account, which is a different origin from its inference endpoint. OpenRouter uses https://openrouter.ai/api/v1/key; GM uses https://api.saygm.com/v1/credits; Vercel uses https://ai-gateway.vercel.sh/v1/credits. Native OpenRouter, GM and Vercel keys use their adapter automatically unless a base URL override is configured. A custom key uses Impala billing only after explicit --balance-provider impala association.\n");
    if (importing) command.requiredOption("--from <store>", "source store (currently gcloud)").requiredOption("--secret <name-or-resource>", "secret name or projects/PROJECT/secrets/SECRET[/versions/VERSION]").option("--project <id>", "explicit Google Cloud project (required for a short secret name)").option("--account <email>", "signed-in gcloud account; otherwise verify the single active account").option("--version <version>", "secret version (default: latest)");
    else command.option("--stdin", "read a piped key without echo; omit for hidden TTY paste").option("--key-env <name>", "read an existing local environment variable internally; never print its value");
    command.action((options: AddOptions) => cmdAdd(options, importing));
  }
  addScope(keys.command("set").description("enable, disable or reprioritize a saved key; optionally rotate from a local secret reference").argument("<key-id>", "saved key UUID, never the credential"), outputOption)
    .option("--enable", "make this key eligible for existing normal BYOK endpoints using automatic/all-key selection; not limited to private pools").option("--disable", "disable this saved key").option("--priority <number>", "priority, an integer from 1 to 10000").option("--rotate-stdin", "replace the key from piped stdin; never printed").option("--rotate-key-env <name>", "replace the key from an existing local env reference; never print its value")
    .action(async (id: string, options: ScopeOptions & { enable?: boolean; disable?: boolean; priority?: string; rotateStdin?: boolean; rotateKeyEnv?: string }) => {
      requireProviderKeyId(id);
      if (options.enable && options.disable) throw new Error("choose --enable or --disable");
      if (!options.enable && !options.disable && options.priority === undefined && !options.rotateStdin && options.rotateKeyEnv === undefined) throw new Error("set needs --enable, --disable, --priority, --rotate-stdin or --rotate-key-env");
      const { companyId, scope } = await providerKeyScope(options);
      const priority = options.priority === undefined ? undefined : boundedInteger(options.priority, "--priority", 1, 10_000);
      let key = options.rotateStdin || options.rotateKeyEnv !== undefined ? await readProviderSecret({ stdin: options.rotateStdin, keyEnv: options.rotateKeyEnv }) : undefined;
      try { print({ scope, key: await setProviderKey(id, { companyId, priority, key, ...(options.enable || options.disable ? { enabled: options.enable === true } : {}) }), secretPrinted: false }); }
      finally { key = undefined; }
    });
  addScope(keys.command("remove").description("delete a saved provider key; existing routes may stop working").argument("<key-id>", "saved key UUID"), outputOption).option("--yes", "confirm removal without a terminal prompt")
    .action(async (id: string, options: ScopeOptions & { yes?: boolean }) => {
      requireProviderKeyId(id);
      const { companyId, scope } = await providerKeyScope(options);
      if (!options.yes) throw new Error("removing a saved provider key requires --yes; existing routes using it may stop working");
      await removeProviderKey(id, companyId);
      print({ scope, removed: id });
    });
  for (const name of ["inspect", "models", "balance"]) {
    addScope(keys.command(name).description(name === "inspect" ? "check one saved key, model listing and balance without generation" : name === "models" ? "list models advertised for one saved key, without generation" : "check a supported balance API; unsupported is not a zero balance").argument("<key-id>", "saved key UUID"), outputOption)
      .action(async (id: string, options: ScopeOptions) => {
        requireProviderKeyId(id);
        const { companyId, scope } = await providerKeyScope(options);
        const result = await inspectProviderKey(id, companyId);
        print({ scope, ...(name === "inspect" ? result : { keyId: id, [name]: result[name] }) });
      });
  }
  addScope(keys.command("probe").description("run a bounded synthetic probe against an explicit shortlist; supplier charges may apply").argument("<key-id>", "saved key UUID"), outputOption)
    .requiredOption("--model <id>", "exact model id to test (repeatable, no automatic catalog sweep)", collect)
    .option("--requests <count>", "total generation calls, 1–20 across all selected models (default: 20)", "20")
    .option("--concurrency <count>", "parallel calls, 1–4 (default: 1)", "1")
    .option("--requests-per-minute <count>", "probe admission rate, 1–6000 (default: 60); does not configure live pool limits", "60")
    .requiredOption("--max-output-tokens <count>", "maximum output per call, 1–32")
    .option("--max-cost-usd <amount>", "local quoted estimate limit in USD (default: 0.10); not a guaranteed supplier bill ceiling", "0.10")
    .option("--quote-file <file>", "current operator price estimate as closed JSON; exact models and four decimal-string USD rates")
    .option("--accept-estimate", "accept the quote and its estimated input framing; supplier billing can differ")
    .option("--confirm-spend", "confirm this exact quoted run can incur supplier charges")
    .option("--dry-run", "ask the server to prepare a quote plan; make no generation calls")
    .action(async (id: string, options: ScopeOptions & { model: string[]; requests: string; concurrency: string; requestsPerMinute: string; maxOutputTokens: string; maxCostUsd: string; quoteFile?: string; acceptEstimate?: boolean; confirmSpend?: boolean; dryRun?: boolean }) => {
      requireProviderKeyId(id);
      const requests = boundedInteger(options.requests, "--requests", 1, 20), concurrency = boundedInteger(options.concurrency, "--concurrency", 1, 4), maxOutputTokens = boundedInteger(options.maxOutputTokens, "--max-output-tokens", 1, 32);
      const requestsPerMinute = boundedInteger(options.requestsPerMinute, "--requests-per-minute", 1, 6000);
      const models = [...new Set(options.model.map(id => id.trim()))];
      if (models.length < 1 || models.length > 20 || models.some(id => !id || id.length > 200 || /[\s\x00-\x1f\x7f]/.test(id))) throw new Error("provide 1–20 exact --model identifiers without whitespace");
      if (requests < models.length || concurrency > requests) throw new Error("--requests must cover every model and be at least --concurrency");
      const maxCostUsd = Number(options.maxCostUsd);
      if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error("--max-cost-usd must be a positive number");
      const operatorQuote = options.quoteFile ? await readOperatorQuote(options.quoteFile, models) : undefined;
      if (!options.dryRun && (!operatorQuote || !options.acceptEstimate || !options.confirmSpend)) throw new Error("paid probes require --quote-file, --accept-estimate and --confirm-spend; review the same command with --dry-run first");
      const { companyId, scope } = await providerKeyScope(options);
      const plan = { companyId, models, requests, concurrency, requestsPerMinute, maxOutputTokens, maxCostUsd, operatorQuote, acceptEstimate: options.acceptEstimate === true, confirmSpend: options.confirmSpend === true, dryRun: options.dryRun === true };
      print({ scope, ...probeMetadata(await probeProviderKey(id, plan)), ...(options.dryRun ? { generationCallsMade: 0 } : {}), note: "Operator quotes are estimates, not supplier billing guarantees. Unknown prices stop generation. Observed throughput is not capacity; omitted costs and cache counts remain unknown." });
    });
}
