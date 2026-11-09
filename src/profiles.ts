/**
 * `heyditto profile`: named endpoint profiles, and the one place the CLI asks
 * "which endpoint does the user mean when they did not say?".
 *
 * Selection order for a command that reads the default endpoint:
 *   --profile <name>  (this command only)
 *   DITTO_PROFILE      (this shell only)
 *   the active profile (`heyditto profile use <name>`)
 * With no saved profiles, the implicit `default` profile is `defaultEndpoint`,
 * so an existing install behaves exactly as before.
 */
import { type Command, Option } from "commander";
import { findEndpoint, listEndpoints } from "./api.js";
import {
  type EndpointProfile,
  type ProfileInference,
  type ProfileView,
  LEGACY_PROFILE,
  materialize,
  profileView,
  profilesPatch,
  setProfileEndpointPatch,
  unknownProfileMessage,
  validateProfileName,
} from "./profile-state.js";
import { type StoredAuth, readStoredAuth, updateStoredAuth } from "./store.js";

export type ProfileSource = "flag" | "env" | "active";

export interface SelectedProfile {
  name: string;
  profile: EndpointProfile;
  source: ProfileSource;
  /** No profiles are saved; `default` stands for the legacy `defaultEndpoint`. */
  implicit: boolean;
}

let flagOverride: string | undefined;

/** Set by `--profile` for the duration of one command. */
export function setProfileOverride(name: string | undefined): void {
  flagOverride = name?.trim() || undefined;
}

/** The profile the user named for this command (flag, then env), if any. */
export function requestedProfile(): { name: string; source: "flag" | "env" } | undefined {
  if (flagOverride) return { name: flagOverride, source: "flag" };
  const env = process.env.DITTO_PROFILE?.trim();
  return env ? { name: env, source: "env" } : undefined;
}

function select(stored: StoredAuth | undefined, view: ProfileView = profileView(stored)): SelectedProfile {
  const requested = requestedProfile();
  if (requested) {
    const profile = view.profiles[requested.name];
    if (!profile) {
      const via = requested.source === "env" ? " (from DITTO_PROFILE)" : "";
      throw new Error(unknownProfileMessage(requested.name, view) + via);
    }
    return { name: requested.name, profile, source: requested.source, implicit: view.implicit };
  }
  return { name: view.active, profile: view.profiles[view.active], source: "active", implicit: view.implicit };
}

export async function selectedProfile(): Promise<SelectedProfile> {
  return select(await readStoredAuth());
}

/** The endpoint used when --endpoint is omitted: the selected profile's. */
export async function readDefaultEndpoint(): Promise<string | undefined> {
  return (await selectedProfile()).profile.endpoint?.trim() || undefined;
}

/** Saves (or clears) the endpoint of the selected profile; other profiles are untouched. */
export async function writeDefaultEndpoint(endpoint: string | undefined): Promise<string> {
  const stored = await readStoredAuth();
  const selected = select(stored);
  await updateStoredAuth(setProfileEndpointPatch(stored, selected.name, endpoint));
  return selected.name;
}

/**
 * The endpoint of a profile the user explicitly named (--profile or
 * DITTO_PROFILE), for a launch that should treat it like --endpoint. Undefined
 * when no profile was named; an error when the named one has no endpoint.
 */
export async function explicitProfileEndpoint(): Promise<{ name: string; endpoint: string; source: "flag" | "env" } | undefined> {
  const requested = requestedProfile();
  if (!requested) return undefined;
  const selected = await selectedProfile();
  const endpoint = selected.profile.endpoint?.trim();
  if (!endpoint) {
    throw new Error(`profile "${selected.name}" has no endpoint. Set one with \`heyditto profile set ${selected.name} --endpoint <slug>\`.`);
  }
  return { name: selected.name, endpoint, source: requested.source };
}

/** After an endpoint's slug changes, follow it in every profile that named it. */
export async function renameEndpointInProfiles(oldSlug: string, newSlug: string): Promise<void> {
  const stored = await readStoredAuth();
  const view = profileView(stored);
  if (view.implicit) {
    if (stored?.defaultEndpoint === oldSlug) await updateStoredAuth({ defaultEndpoint: newSlug });
    return;
  }
  let changed = false;
  const profiles: Record<string, EndpointProfile> = {};
  for (const [name, profile] of Object.entries(view.profiles)) {
    if (profile.endpoint === oldSlug) {
      profiles[name] = { ...profile, endpoint: newSlug };
      changed = true;
    } else profiles[name] = profile;
  }
  if (changed) await updateStoredAuth(profilesPatch(profiles, view.active));
}

/** After an endpoint is archived, drop it from every profile that named it (by slug or id). */
export async function forgetEndpointInProfiles(refs: string[]): Promise<void> {
  const stored = await readStoredAuth();
  const view = profileView(stored);
  const matches = (value: string | undefined) => value !== undefined && refs.includes(value);
  if (view.implicit) {
    if (matches(stored?.defaultEndpoint)) await updateStoredAuth({ defaultEndpoint: undefined });
    return;
  }
  let changed = false;
  const profiles: Record<string, EndpointProfile> = {};
  for (const [name, profile] of Object.entries(view.profiles)) {
    if (matches(profile.endpoint)) {
      const { endpoint: _dropped, ...rest } = profile;
      profiles[name] = rest;
      changed = true;
    } else profiles[name] = profile;
  }
  if (changed) await updateStoredAuth(profilesPatch(profiles, view.active));
}

const tagged = new WeakSet<Command>();

/** `--profile <name>` for a command that reads the default endpoint. */
export function addProfileOption(cmd: Command): Command {
  tagged.add(cmd);
  return cmd.option("--profile <name>", "use this endpoint profile for this command only (default: DITTO_PROFILE, then the active profile)");
}

/**
 * Applies `--profile` before any action runs. Only commands tagged by
 * addProfileOption are read, so `repo apply --profile` and `review local
 * --profile`, which mean something else, are left alone.
 */
export function installProfileHook(program: Command): void {
  program.hook("preAction", (_root, action) => {
    setProfileOverride(tagged.has(action) ? (action.getOptionValue("profile") as string | undefined) : undefined);
  });
}

// ---------------------------------------------------------------------------
// Commands

interface OutputOptions { output?: string }
const json = (options: OutputOptions) => options.output === "json";
const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };

function inferenceOf(raw: string | undefined): ProfileInference | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "router" && raw !== "cliproxy") throw new Error("--inference must be router or cliproxy");
  return raw;
}

/** Resolves an endpoint ref through the catalog and returns its canonical slug. */
async function canonicalEndpoint(ref: string): Promise<string> {
  const catalog = await listEndpoints();
  const match = findEndpoint(catalog.endpoints, ref.trim());
  if (!match) throw new Error(`no endpoint named "${ref.trim()}". Available: ${catalog.endpoints.map((e) => e.slug).join(", ") || "(none)"}`);
  return match.slug;
}

function listJSON(view: ProfileView) {
  return {
    activeProfile: view.active,
    implicit: view.implicit,
    profiles: Object.keys(view.profiles).sort().map((name) => ({
      name,
      endpoint: view.profiles[name].endpoint ?? null,
      inference: view.profiles[name].inference ?? "cliproxy",
      active: name === view.active,
    })),
  };
}

export async function cmdProfileList(options: OutputOptions): Promise<void> {
  const stored = await readStoredAuth();
  const view = profileView(stored);
  const requested = requestedProfile();
  if (json(options)) return print({ ...listJSON(view), ...(requested ? { selected: requested.name, selectedBy: requested.source } : {}) });
  const rows = listJSON(view).profiles;
  const width = Math.max(...rows.map((r) => r.name.length), 4);
  process.stdout.write(`  ${"NAME".padEnd(width)}  ENDPOINT  (INFERENCE)\n`);
  for (const row of rows) {
    process.stdout.write(`${row.active ? "*" : " "} ${row.name.padEnd(width)}  ${row.endpoint ?? "(none)"}  (${row.inference})\n`);
  }
  if (view.implicit) process.stdout.write("\nNo profiles saved yet; `default` is your saved default endpoint. Create one with `heyditto profile create <name> --endpoint <slug>`.\n");
  if (requested) process.stdout.write(`\n${requested.source === "env" ? "DITTO_PROFILE" : "--profile"} selects "${requested.name}" for this command.\n`);
}

export async function cmdProfileCreate(rawName: string, options: OutputOptions & { endpoint: string; inference?: string; use?: boolean }): Promise<void> {
  const name = validateProfileName(rawName);
  const inference = inferenceOf(options.inference);
  const assertCreatable = (view: ProfileView): void => {
    if (!view.implicit && Object.hasOwn(view.profiles, name)) throw new Error(`profile "${name}" already exists; change it with \`heyditto profile set ${name}\``);
    if (view.implicit && name === LEGACY_PROFILE && view.profiles[LEGACY_PROFILE].endpoint) {
      throw new Error(`"${LEGACY_PROFILE}" already names your saved default endpoint; change it with \`heyditto profile set ${LEGACY_PROFILE} --endpoint <slug>\``);
    }
  };
  // Fail fast on a name clash before the network lookup...
  assertCreatable(profileView(await readStoredAuth()));
  const endpoint = await canonicalEndpoint(options.endpoint);
  // ...but build the write from state read after it: another heyditto may
  // have changed profiles while the lookup was in flight, and a patch built
  // from the earlier snapshot would silently drop that change.
  const stored = await readStoredAuth();
  const view = profileView(stored);
  assertCreatable(view);
  const { profiles, active } = materialize(stored);
  const created: EndpointProfile = { endpoint, ...(inference ? { inference } : {}), createdAt: new Date().toISOString() };
  const nextActive = options.use || active === undefined ? name : active;
  await updateStoredAuth(profilesPatch({ ...profiles, [name]: created }, nextActive));
  if (json(options)) return print({ name, endpoint, inference: inference ?? "cliproxy", active: nextActive === name, activeProfile: nextActive });
  process.stdout.write(`Created profile ${name} → ${endpoint}${nextActive === name ? " (active)" : ""}.\n`);
  if (view.implicit && profiles[LEGACY_PROFILE]) {
    process.stdout.write(`Your previous default endpoint is saved as profile "${LEGACY_PROFILE}"${nextActive === LEGACY_PROFILE ? " and stays active" : ""}.\n`);
  }
  if (nextActive !== name) process.stdout.write(`Switch with \`heyditto profile use ${name}\`, or pass --profile ${name} to one command.\n`);
}

export async function cmdProfileSet(rawName: string, options: OutputOptions & { endpoint?: string; inference?: string }): Promise<void> {
  const name = rawName.trim();
  const inference = inferenceOf(options.inference);
  if (options.endpoint === undefined && inference === undefined) throw new Error("nothing to change: pass --endpoint and/or --inference");
  const stored = await readStoredAuth();
  const view = profileView(stored);
  if (!Object.hasOwn(view.profiles, name)) throw new Error(unknownProfileMessage(name, view));
  const endpoint = options.endpoint !== undefined ? await canonicalEndpoint(options.endpoint) : undefined;
  let profiles: Record<string, EndpointProfile>;
  let active: string | undefined;
  if (view.implicit && inference === undefined) {
    await updateStoredAuth({ defaultEndpoint: endpoint });
  } else {
    ({ profiles, active } = materialize(stored));
    // An implicit default with no endpoint is not materialized; recreate it.
    const current = profiles[name] ?? {};
    const next: EndpointProfile = { ...current, ...(endpoint ? { endpoint } : {}), ...(inference ? { inference } : {}) };
    await updateStoredAuth(profilesPatch({ ...profiles, [name]: next }, active ?? name));
  }
  const after = profileView(await readStoredAuth()).profiles[name];
  if (json(options)) return print({ name, endpoint: after.endpoint ?? null, inference: after.inference ?? "cliproxy" });
  process.stdout.write(`Profile ${name} → ${after.endpoint ?? "(none)"} (${after.inference ?? "cliproxy"}).\n`);
}

export async function cmdProfileUse(rawName: string, options: OutputOptions): Promise<void> {
  const name = rawName.trim();
  const stored = await readStoredAuth();
  const view = profileView(stored);
  if (!Object.hasOwn(view.profiles, name)) throw new Error(unknownProfileMessage(name, view));
  if (!view.implicit) await updateStoredAuth(profilesPatch(view.profiles, name));
  const endpoint = view.profiles[name].endpoint ?? null;
  if (json(options)) return print({ activeProfile: name, endpoint });
  process.stdout.write(`Active profile: ${name} → ${endpoint ?? "(no endpoint yet)"}. New heyditto sessions use it; existing T3 providers keep their own endpoints.\n`);
  if (process.env.DITTO_PROFILE?.trim() && process.env.DITTO_PROFILE.trim() !== name) {
    process.stderr.write(`Note: DITTO_PROFILE=${process.env.DITTO_PROFILE.trim()} still overrides it in this shell.\n`);
  }
}

export async function cmdProfileRename(rawOld: string, rawNew: string, options: OutputOptions): Promise<void> {
  const from = rawOld.trim();
  const to = validateProfileName(rawNew);
  const stored = await readStoredAuth();
  const view = profileView(stored);
  if (!Object.hasOwn(view.profiles, from)) throw new Error(unknownProfileMessage(from, view));
  if (from === to) throw new Error("the new name is the same as the old one");
  if (Object.hasOwn(view.profiles, to)) throw new Error(`profile "${to}" already exists`);
  const { profiles, active } = materialize(stored);
  const renamed: Record<string, EndpointProfile> = {};
  for (const [name, profile] of Object.entries(profiles)) renamed[name === from ? to : name] = profile;
  if (!Object.hasOwn(renamed, to)) renamed[to] = { ...view.profiles[from] };
  await updateStoredAuth(profilesPatch(renamed, active === from || active === undefined ? to : active));
  if (json(options)) return print({ renamed: from, to });
  process.stdout.write(`Renamed profile ${from} → ${to}. T3 providers created from it keep their instance id and endpoint.\n`);
}

export async function cmdProfileDelete(rawName: string, options: OutputOptions): Promise<void> {
  const name = rawName.trim();
  const stored = await readStoredAuth();
  const view = profileView(stored);
  if (!Object.hasOwn(view.profiles, name)) throw new Error(unknownProfileMessage(name, view));
  if (name === view.active) throw new Error(`profile "${name}" is active; switch to another with \`heyditto profile use <name>\` before deleting it`);
  const { profiles, active } = materialize(stored);
  const { [name]: _removed, ...rest } = profiles;
  await updateStoredAuth(profilesPatch(rest, active));
  if (json(options)) return print({ deleted: name });
  process.stdout.write(`Deleted profile ${name}. Its endpoint and any T3 provider made from it are unchanged.\n`);
}

export function registerProfileCommands(
  program: Command,
  addExamples: (c: Command, ex: string) => Command,
  outputOption: () => Option,
): void {
  const profile = program
    .command("profile")
    .description("named endpoint profiles: switch which endpoint (and its MCP tools) new sessions use")
    .summary("manage named endpoint profiles")
    .showHelpAfterError()
    .addHelpText(
      "after",
      `
A profile names an endpoint. The active one is used when --endpoint is
omitted; --profile <name> or DITTO_PROFILE=<name> picks another for one
command or one shell. Profiles are local to this machine and hold no keys.
(\`heyditto profiles\` is an older alias of \`heyditto endpoints\`.)`,
    );
  addExamples(
    profile.command("list", { isDefault: true }).description("list profiles (* = active)").addOption(outputOption()).action(cmdProfileList),
    `  heyditto profile
  heyditto profile list --output json`,
  );
  addExamples(
    profile
      .command("create")
      .description("save a profile for an endpoint (your current default is kept as profile \"default\")")
      .argument("<name>", "profile name (lowercase letters, digits, - or _)")
      .requiredOption("--endpoint <slug>", "endpoint slug or id")
      .addOption(new Option("--inference <mode>", "inference route for `heyditto t3 setup --profile` (default cliproxy)").choices(["cliproxy", "router"]))
      .option("--use", "make it the active profile")
      .addOption(outputOption())
      .action(cmdProfileCreate),
    `  heyditto profile create subnet --endpoint my-subnet-endpoint
  heyditto profile create work --endpoint work-router --inference router --use`,
  );
  profile
    .command("set")
    .description("change a profile's endpoint or inference route")
    .argument("<name>")
    .option("--endpoint <slug>", "endpoint slug or id")
    .addOption(new Option("--inference <mode>", "inference route for T3 setup").choices(["cliproxy", "router"]))
    .addOption(outputOption())
    .action(cmdProfileSet);
  profile.command("use").alias("switch").description("make a profile active for new sessions").argument("<name>").addOption(outputOption()).action(cmdProfileUse);
  profile.command("rename").description("rename a profile").argument("<old>").argument("<new>").addOption(outputOption()).action(cmdProfileRename);
  profile.command("delete").alias("rm").description("delete a profile (not the active one)").argument("<name>").addOption(outputOption()).action(cmdProfileDelete);
}
