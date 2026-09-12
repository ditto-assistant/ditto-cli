import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command, Option } from "commander";
import {
  type AppEndpoint,
  type AppPatch,
  type DeveloperApp,
  apiBase,
  attachAppEndpoint,
  createApp,
  detachAppEndpoint,
  findApp,
  getConsentProfile,
  getEndpoint,
  listAppEndpoints,
  listApps,
  listReceipts,
  rotateAppSecret,
  setAppEndpointBilling,
  updateApp,
  uploadAppIcon,
  verifyCallbackOrigin,
} from "./api.js";
import { type KeysCreateOptions, confirmTyped, isJSON, printTable, shorthandsOf } from "./commands.js";
import { STORE_IDS, VERCEL_TARGETS, deliver, selectStore } from "./secret-stores/index.js";

/**
 * Developer apps from the shell — everything the developer console does for
 * "Sign in with Ditto" and app-owned Router endpoints, so an agent can set an
 * app up end to end without a browser:
 *
 *   heyditto apps create "DittoBench"
 *   heyditto apps origins verify dittobench-3f9a https://dittobench.ai  (then --confirm)
 *   heyditto apps consent set dittobench-3f9a credits:spend "Pays for the inference your miner uses."
 *   heyditto apps secret rotate dittobench-3f9a --gh-secret DITTO_OIDC_CLIENT_SECRET --repo ditto-assistant/ditto-subnet
 *   heyditto apps oidc dittobench-3f9a --output env
 *   heyditto apps endpoints attach dittobench-3f9a screener --billing user
 *
 * The client secret follows the same rule as endpoint keys: it is forwarded
 * straight into a secret store over the store CLI's stdin and never printed.
 */

const ADVERTISED_SCOPES = [
  "openid",
  "email",
  "profile",
  "credits:spend",
  "memory:read",
  "memory:write",
  "memory:delete",
  "memory:publish",
  "offline_access",
  "mcp:read",
  "mcp:write",
] as const;

interface ScopeOptions {
  output?: string;
  company?: string;
}

function writeJSON(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function appRow(app: DeveloperApp): string[] {
  return [app.appID, app.name, app.enabled ? (app.archived ? "archived" : "enabled") : "disabled", app.createdAt.slice(0, 10)];
}

/** OIDC/OAuth values a relying app needs; none of them are secret. */
export function oidcConfig(app: DeveloperApp, base = apiBase()): Record<string, string> {
  return {
    DITTO_OIDC_ISSUER: base,
    DITTO_OIDC_CLIENT_ID: app.appID,
    DITTO_OIDC_AUTHORIZATION_ENDPOINT: `${base}/authorize`,
    DITTO_OIDC_TOKEN_ENDPOINT: `${base}/token`,
    DITTO_OIDC_USERINFO_ENDPOINT: `${base}/userinfo`,
    DITTO_OIDC_JWKS_URI: `${base}/.well-known/jwks.json`,
    DITTO_OIDC_DISCOVERY: `${base}/.well-known/openid-configuration`,
    DITTO_INFERENCE_BASE_URL: "",
  };
}

/** Renders {KEY: value} as KEY=value lines (values quoted only when needed). */
export function envLines(values: Record<string, string>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${/[\s#"'\\]/.test(v) ? JSON.stringify(v) : v}`)
    .join("\n");
}

function requireEnabledScope(scope: string): string {
  const s = scope.trim();
  if (!(ADVERTISED_SCOPES as readonly string[]).includes(s)) {
    throw new Error(`unknown scope "${scope}". Known scopes: ${ADVERTISED_SCOPES.join(", ")}`);
  }
  return s;
}

/**
 * Forwards a secret (the app secret) into the selected store exactly like an
 * endpoint key: stdin to the platform CLI, never argv, never stdout.
 */
function forwardSecret(options: KeysCreateOptions, defaultName: string, plaintext: string, what: string): { secretName: string; describe: string } {
  const { store, name: secretName } = selectStore({ ...options, secret: options.secret ?? defaultName, shorthands: shorthandsOf(options) });
  store.preflight();
  const target = store.resolveTarget(options);
  deliver(store, secretName, store.deliveries(secretName, target), plaintext);
  process.stderr.write(`Stored ${what} as ${secretName} in ${target.describe}.\n`);
  return { secretName, describe: target.describe };
}

function hasStoreFlag(options: KeysCreateOptions): boolean {
  return Boolean(options.store || options.secret || Object.values(shorthandsOf(options)).some(Boolean));
}

function addStoreOptions(command: Command, defaultSecret: string): Command {
  return command
    .addOption(new Option("--store <destination>", `where the secret goes (default secret name ${defaultSecret})`).choices([...STORE_IDS]))
    .option("--secret <NAME>", "name of the secret, variable, item or path to store (with --store)")
    .option("--gh-secret <NAME>", "shorthand for --store github --secret NAME")
    .option("--gitlab-var <NAME>", "shorthand for --store gitlab --secret NAME")
    .option("--aws-secret <NAME>", "shorthand for --store aws --secret NAME")
    .option("--gcp-secret <NAME>", "shorthand for --store gcloud --secret NAME")
    .option("--az-secret <NAME>", "shorthand for --store azure --secret NAME")
    .option("--op-item <TITLE>", "shorthand for --store 1password --secret TITLE")
    .option("--vault-secret <PATH>", "shorthand for --store vault --secret PATH")
    .option("--doppler-secret <NAME>", "shorthand for --store doppler --secret NAME")
    .option("--cf-secret <NAME>", "shorthand for --store cloudflare --secret NAME")
    .option("--vercel-env <NAME>", "shorthand for --store vercel --secret NAME")
    .option("--k8s-secret <NAME>", "shorthand for --store kubernetes --secret NAME")
    .option("--fly-secret <NAME>", "shorthand for --store fly --secret NAME")
    .option("--repo <owner/repo>", "github: repository for the secret (default: the repo of the current directory)")
    .option("--env <environment>", "github: deployment environment; gitlab: variable environment scope")
    .option("--org <org>", "github: organization secret; gitlab: group variable")
    .option("--region <region>", "aws: region")
    .option("--project <project>", "gitlab, gcloud, doppler: project")
    .option("--key-vault <name>", "azure: Key Vault the secret goes into")
    .option("--op-vault <name>", "1password: vault for the item")
    .option("--mount <mount>", "vault: kv mount")
    .option("--field <field>", "vault: field at the path")
    .option("--doppler-config <config>", "doppler: config within the project")
    .option("--worker <name>", "cloudflare: Worker name")
    .addOption(new Option("--vercel-target <target>", "vercel: environment").choices([...VERCEL_TARGETS]))
    .option("--namespace <namespace>", "kubernetes: namespace")
    .option("--k8s-key <key>", "kubernetes: key within the secret")
    .option("--app <app>", "fly: app name");
}

// ---------------------------------------------------------------------------

export async function cmdAppsList(options: ScopeOptions): Promise<void> {
  const apps = await listApps(options.company);
  if (isJSON(options)) return writeJSON({ apps });
  if (apps.length === 0) {
    process.stdout.write("No apps yet. Create one: heyditto apps create \"My App\"\n");
    return;
  }
  printTable(["APP ID", "NAME", "STATE", "CREATED"], apps.map(appRow));
}

export async function cmdAppsCreate(name: string, options: KeysCreateOptions & ScopeOptions): Promise<void> {
  const app = await createApp(name.trim(), options.company);
  const { appSecret, ...safe } = app;
  let stored: { secretName: string; describe: string } | undefined;
  if (appSecret && hasStoreFlag(options)) {
    stored = forwardSecret(options, "DITTO_OIDC_CLIENT_SECRET", appSecret, "the app secret");
  }
  if (isJSON(options)) return writeJSON({ app: safe, secretStored: stored ?? null, oidc: oidcConfig(app) });
  process.stdout.write(`Created app ${app.appID} ("${app.name}").\n`);
  process.stdout.write(`${envLines(oidcConfig(app))}\n`);
  if (appSecret && !stored) {
    process.stderr.write(
      "The app secret was minted but NOT shown. Store it somewhere your server can read it:\n" +
        `  heyditto apps secret rotate ${app.appID} --gh-secret DITTO_OIDC_CLIENT_SECRET --repo <owner/repo>\n` +
        "(rotating mints a fresh secret and forwards it straight into the store).\n",
    );
  }
}

export async function cmdAppsShow(ref: string, options: ScopeOptions): Promise<void> {
  const app = await findApp(ref, options.company);
  const [{ endpoints, baseUrl, onBehalfOfHeader }, profile] = await Promise.all([
    listAppEndpoints(app.appID),
    getConsentProfile(app.appID).catch(() => undefined),
  ]);
  if (isJSON(options)) return writeJSON({ app, endpoints, baseUrl, onBehalfOfHeader, consentProfile: profile ?? null, oidc: oidcConfig(app) });
  process.stdout.write(`${app.name} (${app.appID}) — ${app.enabled ? "enabled" : "disabled"}${app.archived ? ", archived" : ""}\n`);
  if (app.metadata?.description) process.stdout.write(`  ${app.metadata.description}\n`);
  if (profile?.iconUrl) process.stdout.write(`  icon: ${profile.iconUrl}\n`);
  const origins = profile?.callbackOrigins ?? [];
  process.stdout.write(`  verified callback origins: ${origins.length ? origins.join(", ") : "(none — run: heyditto apps origins verify)"}\n`);
  const rationale = app.consentRationale ?? profile?.rationale ?? {};
  process.stdout.write(`  consent rationale: ${Object.keys(rationale).length ? "" : "(none)"}\n`);
  for (const [scope, why] of Object.entries(rationale)) process.stdout.write(`    ${scope}: ${why}\n`);
  process.stdout.write(`  endpoints (${endpoints.length}):${endpoints.length ? "" : " (none — run: heyditto apps endpoints attach)"}\n`);
  for (const e of endpoints) process.stdout.write(`    ${e.slug}  ${e.model}  billing=${e.appBilling}  ${baseUrl}\n`);
  if (endpoints.length) process.stdout.write(`  server-to-server: send ${onBehalfOfHeader}: <ditto uid> with an owner-minted key on the endpoint\n`);
}

export async function cmdAppsUpdate(
  ref: string,
  options: ScopeOptions & { name?: string; description?: string; landingUrl?: string; appUrl?: string; enable?: boolean; disable?: boolean; archive?: boolean; restore?: boolean },
): Promise<void> {
  const app = await findApp(ref, options.company);
  const patch: AppPatch = {};
  if (options.name !== undefined) patch.name = options.name;
  if (options.description !== undefined) patch.description = options.description;
  if (options.landingUrl !== undefined) patch.landingURL = options.landingUrl;
  if (options.appUrl !== undefined) patch.appURL = options.appUrl;
  if (options.enable) patch.enabled = true;
  if (options.disable) patch.enabled = false;
  if (options.archive) patch.archived = true;
  if (options.restore) patch.archived = false;
  if (Object.keys(patch).length === 0) throw new Error("nothing to change; pass --name, --description, --landing-url, --app-url, --enable, --disable, --archive or --restore");
  const updated = await updateApp(app.appID, patch);
  if (isJSON(options)) return writeJSON({ app: updated });
  process.stdout.write(`Updated ${updated.appID}.\n`);
}

export async function cmdAppsConsentShow(ref: string, options: ScopeOptions): Promise<void> {
  const app = await findApp(ref, options.company);
  const profile = await getConsentProfile(app.appID);
  if (isJSON(options)) return writeJSON({ consentProfile: profile });
  process.stdout.write(`Consent screen for ${profile.name} (${profile.appID})\n`);
  if (profile.iconUrl) process.stdout.write(`  icon: ${profile.iconUrl}\n`);
  if (profile.ownerName) process.stdout.write(`  by: ${profile.ownerName}\n`);
  const entries = Object.entries(profile.rationale);
  process.stdout.write(`  rationale:${entries.length ? "" : " (none — the default scope wording is shown)"}\n`);
  for (const [scope, why] of entries) process.stdout.write(`    ${scope}: ${why}\n`);
}

export async function cmdAppsConsentSet(ref: string, scope: string, why: string | undefined, options: ScopeOptions & { clear?: boolean }): Promise<void> {
  const app = await findApp(ref, options.company);
  const key = requireEnabledScope(scope);
  const current = { ...(app.consentRationale ?? {}) };
  if (options.clear) delete current[key];
  else {
    const text = (why ?? "").trim();
    if (!text) throw new Error("pass the reason text, or --clear to remove it");
    current[key] = text;
  }
  const updated = await updateApp(app.appID, { consentRationale: current });
  if (isJSON(options)) return writeJSON({ consentRationale: updated.consentRationale ?? current });
  process.stdout.write(options.clear ? `Cleared the ${key} rationale on ${app.appID}.\n` : `Set the ${key} rationale on ${app.appID}.\n`);
}

const ICON_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };

export async function cmdAppsIconSet(ref: string, file: string, options: ScopeOptions): Promise<void> {
  const app = await findApp(ref, options.company);
  const contentType = ICON_TYPES[path.extname(file).toLowerCase()];
  if (!contentType) throw new Error(`unsupported icon type "${path.extname(file)}"; use png, jpg, webp or svg`);
  const data = await readFile(file);
  const out = await uploadAppIcon(app.appID, contentType, data.toString("base64"));
  const url = out.iconURL ?? out.iconUrl ?? "";
  if (isJSON(options)) return writeJSON({ appID: app.appID, iconURL: url });
  process.stdout.write(`Icon uploaded for ${app.appID}${url ? `: ${url}` : ""}\n`);
}

export async function cmdAppsOriginsVerify(ref: string, origin: string, options: ScopeOptions & { confirm?: boolean }): Promise<void> {
  const app = await findApp(ref, options.company);
  const out = await verifyCallbackOrigin(app.appID, origin, Boolean(options.confirm));
  if (isJSON(options)) return writeJSON(out);
  if (out.verified) {
    process.stdout.write(`Verified ${out.origin}. Callback origins: ${(out.callbackOrigins ?? []).join(", ")}\n`);
    return;
  }
  process.stdout.write(
    `Challenge for ${out.origin}:\n` +
      `  Serve this token as the plain-text body of ${out.wellKnown}\n` +
      `  token: ${out.token}\n` +
      `Then run: heyditto apps origins verify ${app.appID} ${out.origin} --confirm\n`,
  );
}

export async function cmdAppsSecretRotate(ref: string, options: KeysCreateOptions & ScopeOptions): Promise<void> {
  const app = await findApp(ref, options.company);
  if (!hasStoreFlag(options)) {
    throw new Error(
      "choose where the new secret goes (it is never printed): e.g. --gh-secret DITTO_OIDC_CLIENT_SECRET --repo owner/repo, --gcp-secret NAME, --op-item TITLE …",
    );
  }
  const { store, name: secretName } = selectStore({ ...options, secret: options.secret ?? "DITTO_OIDC_CLIENT_SECRET", shorthands: shorthandsOf(options) });
  store.preflight();
  const target = store.resolveTarget(options);
  await confirmTyped({
    action: `rotate the app secret of ${app.appID} (the current secret stops working) and store it in ${store.label}`,
    expected: secretName,
    label: `the ${store.nameLabel.toLowerCase()}`,
    yes: options.yes,
    preview: `Will mint a new app secret for ${app.appID} and store ${secretName} in ${target.describe}. Your server must switch to it right away.`,
  });
  const rotated = await rotateAppSecret(app.appID);
  const { appSecret, ...safe } = rotated;
  deliver(store, secretName, store.deliveries(secretName, target), appSecret ?? "");
  if (isJSON(options)) return writeJSON({ ...safe, secretStored: { secretName, describe: target.describe } });
  process.stdout.write(`Rotated the app secret of ${app.appID} and stored ${secretName} in ${target.describe}.\n`);
}

export async function cmdAppsOidc(ref: string, options: ScopeOptions & { callback?: string }): Promise<void> {
  const app = await findApp(ref, options.company);
  const [{ baseUrl }, profile] = await Promise.all([listAppEndpoints(app.appID), getConsentProfile(app.appID).catch(() => undefined)]);
  const values = oidcConfig(app);
  values.DITTO_INFERENCE_BASE_URL = baseUrl;
  if (options.callback) values.DITTO_OIDC_REDIRECT_URI = options.callback;
  const origins = profile?.callbackOrigins ?? [];
  if (options.output === "json") return writeJSON({ oidc: values, callbackOrigins: origins, scopes: ["openid", "email", "profile"], spendingScope: "credits:spend" });
  process.stdout.write(`${envLines(values)}\n`);
  process.stderr.write(
    `# redirect_uri must be on a verified callback origin (${origins.length ? origins.join(", ") : "none yet — heyditto apps origins verify"}).\n` +
      `# client_secret: heyditto apps secret rotate ${app.appID} --gh-secret DITTO_OIDC_CLIENT_SECRET …\n` +
      `# request scope "openid email profile" for sign-in, add "credits:spend" to let users pay for the app's inference.\n`,
  );
}

function endpointRow(e: AppEndpoint): string[] {
  return [e.slug, e.model, e.appBilling, e.status ?? "", e.id];
}

export async function cmdAppsEndpointsList(ref: string, options: ScopeOptions): Promise<void> {
  const app = await findApp(ref, options.company);
  const { endpoints, baseUrl, onBehalfOfHeader } = await listAppEndpoints(app.appID);
  if (isJSON(options)) return writeJSON({ appID: app.appID, endpoints, baseUrl, onBehalfOfHeader });
  if (endpoints.length === 0) {
    process.stdout.write(`No endpoints attached to ${app.appID}. Attach one: heyditto apps endpoints attach ${app.appID} <endpoint> --billing user|sponsor\n`);
    return;
  }
  printTable(["SLUG", "MODEL", "BILLING", "STATUS", "ID"], endpoints.map(endpointRow));
  process.stdout.write(`Base URL ${baseUrl}; server-to-server calls send ${onBehalfOfHeader}: <ditto uid>.\n`);
}

function parseBilling(raw: string | undefined): "user" | "sponsor" {
  const v = (raw ?? "user").trim();
  if (v === "user" || v === "sponsor") return v;
  throw new Error(`--billing must be user (the consenting user pays) or sponsor (the endpoint owner pays), got "${raw}"`);
}

export async function cmdAppsEndpointsAttach(ref: string, endpointRef: string, options: ScopeOptions & { billing?: string }): Promise<void> {
  const app = await findApp(ref, options.company);
  const { endpoint } = await getEndpoint(endpointRef);
  const attached = await attachAppEndpoint(app.appID, endpoint.id, parseBilling(options.billing));
  if (isJSON(options)) return writeJSON({ appID: app.appID, endpoint: attached });
  process.stdout.write(`Attached ${attached.slug} to ${app.appID} (billing=${attached.appBilling}).\n`);
}

export async function cmdAppsEndpointsBilling(ref: string, endpointRef: string, billing: string, options: ScopeOptions): Promise<void> {
  const app = await findApp(ref, options.company);
  const { endpoint } = await getEndpoint(endpointRef);
  const updated = await setAppEndpointBilling(app.appID, endpoint.id, parseBilling(billing));
  if (isJSON(options)) return writeJSON({ appID: app.appID, endpoint: updated });
  process.stdout.write(`${updated.slug} now bills the ${updated.appBilling === "user" ? "consenting user" : "sponsor"}.\n`);
}

export async function cmdAppsEndpointsDetach(ref: string, endpointRef: string, options: ScopeOptions): Promise<void> {
  const app = await findApp(ref, options.company);
  const { endpoint } = await getEndpoint(endpointRef);
  await detachAppEndpoint(app.appID, endpoint.id);
  if (isJSON(options)) return writeJSON({ appID: app.appID, detached: endpoint.id });
  process.stdout.write(`Detached ${endpoint.slug} from ${app.appID}.\n`);
}

export async function cmdReceipts(options: { output?: string; leg?: string; app?: string; days?: string; limit?: string }): Promise<void> {
  const days = options.days ? Number(options.days) : undefined;
  const limit = options.limit ? Number(options.limit) : undefined;
  if (days !== undefined && (!Number.isInteger(days) || days <= 0)) throw new Error("--days must be a positive integer");
  const out = await listReceipts({ leg: options.leg, app: options.app, days, limit });
  if (isJSON(options)) return writeJSON(out);
  const usd = (tokens: number) => `$${(tokens / 1e9).toFixed(4)}`;
  if (out.summary.length) {
    printTable(
      ["LEG", "APP", "CALLS", "DITTO COST"],
      out.summary.map((s) => [s.leg, s.appName || s.appID || "ditto", String(s.calls), s.leg === "ditto" ? usd(s.dittoTokens) : "—"]),
    );
    process.stdout.write("\n");
  }
  if (out.receipts.length === 0) {
    process.stdout.write("No receipts in this window.\n");
    return;
  }
  printTable(
    ["WHEN", "MODEL", "LEG", "APP", "COST"],
    out.receipts.map((r) => [r.timestamp.slice(0, 16).replace("T", " "), r.model || r.serviceName || "—", r.leg, r.appID ? `${r.appID}${r.billing === "sponsor" ? " (sponsored)" : ""}` : "", r.leg === "ditto" ? usd(r.dittoTokens) : "—"]),
  );
}

export function registerAppCommands(program: Command, addExamples: (command: Command, examples: string) => Command, outputOption: () => Option): void {
  const apps = program.command("apps").description("developer apps: Sign in with Ditto, branded consent and app-owned Router endpoints");
  const companyOption = () => new Option("--company <id>", "developer company (organization) the app belongs to; default: your developer company");

  addExamples(
    apps.command("list", { isDefault: true }).description("list your developer apps").addOption(companyOption()).addOption(outputOption()).action(cmdAppsList),
    `  heyditto apps list
  heyditto apps list --company 5f1c… --output json`,
  );
  addExamples(
    addStoreOptions(
      apps
        .command("create")
        .description("create an app; forward its client secret straight into a secret store (never printed)")
        .argument("<name>", "display name shown on the consent screen")
        .addOption(companyOption())
        .option("--yes", "skip confirmations")
        .addOption(outputOption()),
      "DITTO_OIDC_CLIENT_SECRET",
    ).action(cmdAppsCreate),
    `  heyditto apps create "DittoBench" --gh-secret DITTO_OIDC_CLIENT_SECRET --repo ditto-assistant/ditto-subnet
  heyditto apps create "DittoBench" --output json     # secret minted but not shown; rotate it into a store later`,
  );
  apps.command("show").description("one app: state, callback origins, consent rationale, attached endpoints").argument("<app>", "app id, slug or name").addOption(companyOption()).addOption(outputOption()).action(cmdAppsShow);
  apps
    .command("update")
    .description("rename, describe, enable/disable or archive an app")
    .argument("<app>", "app id, slug or name")
    .option("--name <name>")
    .option("--description <text>")
    .option("--landing-url <url>")
    .option("--app-url <url>")
    .option("--enable")
    .option("--disable")
    .option("--archive")
    .option("--restore")
    .addOption(companyOption())
    .addOption(outputOption())
    .action(cmdAppsUpdate);

  const consent = apps.command("consent").description("what the consent screen says about this app");
  consent.command("show").description("the public consent profile (name, icon, rationale per scope)").argument("<app>").addOption(companyOption()).addOption(outputOption()).action(cmdAppsConsentShow);
  addExamples(
    consent
      .command("set")
      .description("set (or --clear) the app's own reason for one requested scope")
      .argument("<app>")
      .argument("<scope>", `one of ${ADVERTISED_SCOPES.join(", ")}`)
      .argument("[why]", "the reason shown under the permission (≤ 280 chars)")
      .option("--clear", "remove the reason for this scope")
      .addOption(companyOption())
      .addOption(outputOption())
      .action(cmdAppsConsentSet),
    `  heyditto apps consent set dittobench credits:spend "Pays for the inference your miner uses during screening."
  heyditto apps consent set dittobench openid "Links your miner hotkeys to your Ditto account."
  heyditto apps consent set dittobench email --clear`,
  );

  apps.command("icon").description("app icon").command("set").description("upload the icon shown on the consent screen (png, jpg, webp, svg)").argument("<app>").argument("<file>").addOption(companyOption()).addOption(outputOption()).action(cmdAppsIconSet);

  const origins = apps.command("origins").description("verified callback origins (allowed OAuth redirect origins)");
  addExamples(
    origins
      .command("verify")
      .description("request a challenge for an https origin, then --confirm once it is served")
      .argument("<app>")
      .argument("<origin>", "https origin, e.g. https://dittobench.ai")
      .option("--confirm", "verify a previously requested challenge")
      .addOption(companyOption())
      .addOption(outputOption())
      .action(cmdAppsOriginsVerify),
    `  heyditto apps origins verify dittobench https://dittobench.ai            # prints the token to serve
  heyditto apps origins verify dittobench https://dittobench.ai --confirm  # checks /.well-known/ditto-callback-challenge`,
  );

  const secret = apps.command("secret").description("the app's client secret (signs consent callbacks; OIDC client_secret)");
  addExamples(
    addStoreOptions(secret.command("rotate").description("mint a new secret and store it straight into a secret store (never printed)").argument("<app>").addOption(companyOption()).option("--yes", "skip the confirmation prompt").addOption(outputOption()), "DITTO_OIDC_CLIENT_SECRET").action(cmdAppsSecretRotate),
    `  heyditto apps secret rotate dittobench --gh-secret DITTO_OIDC_CLIENT_SECRET --repo ditto-assistant/ditto-subnet
  heyditto apps secret rotate dittobench --gcp-secret dittobench-oidc-client-secret --project ditto-platform
  heyditto apps secret rotate dittobench --op-item "DittoBench OIDC" --op-vault Engineering`,
  );

  addExamples(
    apps
      .command("oidc")
      .description("the non-secret OIDC configuration a relying app needs (issuer, endpoints, client_id) as env lines or JSON")
      .argument("<app>")
      .option("--callback <url>", "include the redirect URI your app uses")
      .addOption(companyOption())
      .addOption(outputOption())
      .action(cmdAppsOidc),
    `  heyditto apps oidc dittobench --callback https://dittobench.ai/auth/ditto/callback >> .env
  heyditto apps oidc dittobench --output json`,
  );

  const endpoints = apps.command("endpoints").description("Router endpoints this app owns (its users get inference, never keys)");
  endpoints.command("list", { isDefault: true }).argument("<app>").addOption(companyOption()).addOption(outputOption()).action(cmdAppsEndpointsList);
  addExamples(
    endpoints
      .command("attach")
      .description("attach one of your endpoints to the app and choose who pays")
      .argument("<app>")
      .argument("<endpoint>", "endpoint slug or id")
      .addOption(new Option("--billing <who>", "user = the consenting user's credits (needs their credits:spend grant); sponsor = the endpoint owner").choices(["user", "sponsor"]).default("user"))
      .addOption(companyOption())
      .addOption(outputOption())
      .action(cmdAppsEndpointsAttach),
    `  heyditto apps endpoints attach dittobench screener --billing sponsor
  heyditto apps endpoints attach dittobench competition --billing user
  heyditto endpoints keys create competition --gh-secret DITTO_ROUTER_KEY --repo ditto-assistant/ditto-subnet   # the app's server key`,
  );
  endpoints.command("billing").description("change who pays on an attached endpoint").argument("<app>").argument("<endpoint>").argument("<who>", "user | sponsor").addOption(companyOption()).addOption(outputOption()).action(cmdAppsEndpointsBilling);
  endpoints.command("detach").argument("<app>").argument("<endpoint>").addOption(companyOption()).addOption(outputOption()).action(cmdAppsEndpointsDetach);

  addExamples(
    program
      .command("receipts")
      .description("your receipts by billing leg (ditto | byok | covered) and by the app that spent them")
      .addOption(new Option("--leg <leg>", "billing leg").choices(["ditto", "byok", "covered"]))
      .option("--app <app_id>", "only this app's spend (use - for Ditto's own surfaces)")
      .option("--days <n>", "window in days (default 30)")
      .option("--limit <n>", "max receipts (default 50)")
      .addOption(outputOption())
      .action(cmdReceipts),
    `  heyditto receipts
  heyditto receipts --leg byok --days 7
  heyditto receipts --app dittobench --output json`,
  );
}
