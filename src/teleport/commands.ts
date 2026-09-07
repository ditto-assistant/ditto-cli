import { createInterface } from "node:readline/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { configDir } from "../config.js";
import { type InferenceEndpoint, listEndpoints } from "../api.js";
import { listSessions } from "../agents/sessions.js";
import { launchHarness } from "../agents/launch.js";
import * as tapi from "../teleport/api.js";
import { detectCommitter, pushCapsule } from "../teleport/push.js";
import { pullCapsule, readCachedManifest, writeCachedManifest } from "../teleport/pull.js";
import { deleteLocalRoot, unpushedRepos, waitForOffloadReady } from "../teleport/offload.js";
import * as storage from "../teleport/storage.js";
import { discoverRepos } from "../teleport/discover.js";
import { formatBytes, type HarnessKind, type Manifest } from "../teleport/types.js";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}
interface OutputOptions {
  output?: string;
  json?: boolean;
}
function json(options: OutputOptions): boolean {
  return options.json === true || options.output === "json";
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function harnessKindOf(h: string | undefined): HarnessKind {
  if (h === "claude") return "claude-code";
  if (h === "codex") return "codex";
  if (h === "claude-code" || h === "codex") return h;
  return "none";
}

async function requireTty(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("this command needs an interactive terminal; pass the value as an argument instead");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/** Finds or creates the capsule for a root path; `{capsule}` routes accept the name directly. */
async function resolveCapsule(
  root: string,
  opts: { name?: string; create: boolean; harness?: { kind: HarnessKind; sessionId?: string } },
): Promise<{ capsule: tapi.Capsule; previous?: Manifest }> {
  const discovery = await discoverRepos(root);
  const name = opts.name?.trim() || path.basename(path.resolve(root));
  let capsule: tapi.Capsule | undefined;
  try {
    capsule = await tapi.getCapsule(name);
  } catch (e) {
    if (!(e instanceof Error) || !/HTTP 404/.test(e.message)) throw e;
  }
  if (!capsule) {
    if (!opts.create) throw new Error(`no capsule named "${name}"; push it first with \`heyditto teleport push\``);
    capsule = await tapi.createCapsule({
      name,
      rootKind: discovery.kind,
      harnessKind: opts.harness?.kind === "none" ? undefined : opts.harness?.kind,
      harnessSessionId: opts.harness?.sessionId,
    });
  }
  const previous = (await readCachedManifest(configDir(), capsule.id)) as Manifest | undefined;
  return { capsule, previous };
}

/** Pull and cloud sessions need at least one committed generation. */
function requireGenerations(capsule: tapi.Capsule): void {
  if (capsule.headGeneration > 0) return;
  throw new Error(
    `capsule ${capsule.name} has no generations yet — push it first with \`heyditto teleport push\``,
  );
}

interface PushOptions extends OutputOptions {
  name?: string;
  mirror?: string;
  includeIgnored?: string[];
  dryRun?: boolean;
  session?: string;
  harness?: string;
}

export async function cmdTeleportPush(pathArg: string | undefined, options: PushOptions): Promise<void> {
  const root = path.resolve(pathArg ?? process.cwd());
  const discovery = await discoverRepos(root);
  const harnessKind = harnessKindOf(options.harness);
  const harness = { kind: harnessKind, sessionId: options.session, cwd: harnessKind === "none" ? undefined : root };

  if (options.dryRun) {
    out(JSON.stringify({ root, rootKind: discovery.kind, repos: discovery.repos, harness, mirror: options.mirror ?? "all" }, null, 2));
    return;
  }

  const { capsule, previous } = await resolveCapsule(root, { name: options.name, create: true, harness });
  if (options.mirror) await tapi.setMirrorPolicy(capsule.id, parsePolicy(options.mirror));

  err(`Teleporting ${discovery.repos.length} repo(s) from ${root} → capsule ${capsule.name}…`);
  const result = await pushCapsule({
    root,
    capsuleId: capsule.id,
    parentGeneration: capsule.headGeneration || null,
    previousManifest: previous,
    harness,
    ignoredIncludes: options.includeIgnored ?? [],
    rootName: capsule.name,
    rootKind: discovery.kind,
    committedBy: detectCommitter(),
  });

  // Cache the committed manifest for the next thin push.
  const resolved = await tapi.resolveGeneration(capsule.id, result.generation);
  await writeCachedManifest(configDir(), capsule.id, resolved.manifest);

  if (json(options)) {
    out(JSON.stringify({ capsuleId: capsule.id, name: capsule.name, ...result }, null, 2));
    return;
  }
  out(
    `Pushed generation ${result.generation}: ${formatBytes(result.bytesTotal)} in ${result.chunkCount} chunks ` +
      `(${result.uploaded} uploaded, ${result.reused} reused).`,
  );
  out(`Pull elsewhere with: heyditto teleport pull ${capsule.name} <path>`);
}

function parsePolicy(raw: string): { mode: "all" | "some"; targets?: string[] } {
  if (raw === "all") return { mode: "all" };
  return { mode: "some", targets: raw.split(",").map((s) => s.trim()).filter(Boolean) };
}

interface PullOptions extends OutputOptions {
  capsule?: string;
  generation?: string;
  into?: string;
  restoreHarness?: boolean;
  resume?: boolean;
}

export async function cmdTeleportPull(nameArg: string | undefined, pathArg: string | undefined, options: PullOptions): Promise<void> {
  const ref = options.capsule ?? nameArg;
  if (!ref) throw new Error("which capsule? pass a name/id argument or --capsule");
  const capsule = await tapi.getCapsule(ref);
  requireGenerations(capsule);
  const dest = path.resolve(options.into ?? pathArg ?? path.join(process.cwd(), capsule.name));
  const generation = options.generation ? Number(options.generation) : undefined;
  err(`Pulling capsule ${capsule.name}${generation ? ` @${generation}` : ""} → ${dest}…`);
  const result = await pullCapsule(capsule.id, generation, dest, { restoreHarness: options.restoreHarness });
  const resolved = await tapi.resolveGeneration(capsule.id, generation);
  await writeCachedManifest(configDir(), capsule.id, resolved.manifest);
  const harnessKind = resolved.manifest.harness.kind;

  if (json(options)) {
    // Runner contract: the entrypoint reads cwd + harness ids from this line.
    out(JSON.stringify({ cwd: result.harnessCwd ?? result.root, harnessSessionId: result.harnessSessionId, harnessKind, root: result.root, repos: result.repos, generation: resolved.generation }));
  } else {
    out(`Restored ${result.repos.length} repo(s) into ${result.root} (generation ${resolved.generation}).`);
    if (result.harnessSessionId) out(`Harness session ${result.harnessSessionId} restored under ${result.harnessCwd}.`);
  }
  if (options.resume && result.harnessSessionId && harnessKind !== "none") {
    const harness = harnessKind === "claude-code" ? "claude" : "codex";
    err(`Resuming ${harness}…`);
    await launchHarness(harness as "claude" | "codex", [], { resume: result.harnessSessionId });
  }
}

export async function cmdTeleportList(options: OutputOptions): Promise<void> {
  const capsules = await tapi.listCapsules();
  if (json(options)) return out(JSON.stringify({ capsules }, null, 2));
  if (capsules.length === 0) return out("No capsules yet. Push one with `heyditto teleport push`.");
  const rows = capsules.map((c) => [c.name, c.rootKind, `gen ${c.headGeneration}`, formatBytes(c.bytesTotal ?? 0), c.status ?? "active"]);
  const header = ["NAME", "KIND", "HEAD", "SIZE", "STATUS"];
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  out(header.map((h, i) => pad(h, w[i])).join("  "));
  for (const r of rows) out(r.map((c, i) => pad(c, w[i])).join("  "));
}

function printMirrors(status: tapi.CapsuleStatus): void {
  for (const m of status.mirrors) {
    out(
      `  ${pad(m.target, 16)} gen ${m.generation}  ${pad(m.status, 9)}${m.required ? " required" : ""}` +
        `${m.verifiedAt ? `  verified ${m.verifiedAt.slice(0, 16)}` : ""}${m.error ? `  (${m.error})` : ""}`,
    );
  }
}

export async function cmdTeleportStatus(ref: string, options: OutputOptions): Promise<void> {
  const status = await tapi.capsuleStatus(ref);
  if (json(options)) return out(JSON.stringify(status, null, 2));
  out(`${status.capsule.name}: head generation ${status.headGeneration}, ${formatBytes(status.bytesTotal ?? 0)}, offload ${status.offloadReady ? "ready" : "not ready"}`);
  printMirrors(status);
}

export async function cmdTeleportVerify(ref: string, options: OutputOptions): Promise<void> {
  const status = await tapi.verifyCapsule(ref);
  if (json(options)) return out(JSON.stringify(status, null, 2));
  out(`${status.capsule.name}: verification ${status.offloadReady ? "complete" : "in progress"}`);
  printMirrors(status);
}

export async function cmdTeleportGenerations(ref: string, options: OutputOptions): Promise<void> {
  const gens = await tapi.listGenerations(ref);
  if (json(options)) return out(JSON.stringify({ generations: gens }, null, 2));
  if (gens.length === 0) return out("No generations yet.");
  for (const g of gens) out(`gen ${pad(String(g.generation), 4)} ${pad(formatBytes(g.bytes), 10)} ${pad(String(g.chunkCount), 6)} chunks  ${g.committedAt.slice(0, 16)}  ${g.committedBy}`);
}

export async function cmdTeleportTargets(options: OutputOptions): Promise<void> {
  const res = await tapi.listTargets();
  if (json(options)) return out(JSON.stringify(res, null, 2));
  out(`Quota: ${res.quotaGb} GB, capsule limit: ${res.capsuleLimit < 0 ? "unlimited" : res.capsuleLimit}`);
  for (const t of res.targets) {
    out(`  ${pad(t.target, 20)} ${pad(t.label, 24)} ${t.required ? "required" : "optional"}${t.available ? "" : "  (unavailable)"}`);
  }
}

export async function cmdTeleportRm(ref: string, options: OutputOptions & { yes?: boolean }): Promise<void> {
  const capsule = await tapi.getCapsule(ref);
  if (!options.yes) {
    const answer = await requireTty(`Delete capsule ${capsule.name} and all its generations? [y/N] `);
    if (answer.toLowerCase() !== "y") return err("Aborted.");
  }
  await tapi.deleteCapsule(capsule.id);
  out(`Deleted capsule ${capsule.name}.`);
}

interface TeleportOptions extends PushOptions {
  cloud?: boolean;
  endpoint?: string;
  prompt?: string;
}

/** The bare `heyditto teleport` command: push the current dir, optionally launch a cloud session. */
export async function cmdTeleport(pathArg: string | undefined, options: TeleportOptions): Promise<void> {
  const root = path.resolve(pathArg ?? process.cwd());
  // Prefer a coding session whose worktree/cwd matches this root, so the harness travels too.
  const sessions = await listSessions();
  const match = sessions.find((s) => s.cwd === root || s.worktree === root);
  await cmdTeleportPush(root, {
    ...options,
    session: match?.harnessSessionId ?? options.session,
    harness: match?.harness ?? options.harness,
  });
  if (!options.cloud) return;

  const name = options.name?.trim() || path.basename(root);
  requireGenerations(await tapi.getCapsule(name));
  const harnessKind = harnessKindOf(match?.harness ?? options.harness);
  const endpoint = await resolveEndpoint(options.endpoint);
  if (endpoint) err(`Using inference endpoint ${endpoint.slug} (${endpoint.name}).`);
  const session = await tapi.launchCloudSession(name, {
    prompt: options.prompt?.trim() || "Resume the teleported session and continue where it left off.",
    harness: harnessKind === "codex" ? "codex" : "claude-code",
    endpointId: endpoint?.id,
  });
  if (json(options)) return out(JSON.stringify(session, null, 2));
  out(`Cloud session started: job ${session.jobId} (${session.harness}, generation ${session.generation}).`);
  out(`Open it: ${tapi.appThreadUrl(session.threadId)}`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turns `--endpoint <id|slug|name>` into the endpoint the backend expects by
 * UUID. Omitted: the user's only endpoint when exactly one exists, otherwise
 * the backend's default. Unknown values list what is available.
 */
export async function resolveEndpoint(option: string | undefined): Promise<InferenceEndpoint | undefined> {
  const { endpoints } = await listEndpoints();
  const wanted = option?.trim();
  if (!wanted) {
    return endpoints.length === 1 ? endpoints[0] : undefined;
  }
  const found =
    endpoints.find((e) => e.id === wanted) ??
    endpoints.find((e) => e.slug === wanted) ??
    endpoints.find((e) => e.name.toLowerCase() === wanted.toLowerCase());
  if (found) return found;
  if (UUID_RE.test(wanted)) {
    // Let the backend judge an id we cannot see (e.g. a shared endpoint).
    return { id: wanted, slug: wanted, name: wanted, model: "" };
  }
  const slugs = endpoints.map((e) => e.slug).join(", ") || "none";
  throw new Error(`no inference endpoint matches "${wanted}"; available: ${slugs}. Create one in Settings → Developer → Inference endpoints.`);
}

export async function cmdOffload(pathArg: string | undefined, options: { yes?: boolean; allowUnpushed?: boolean; name?: string }): Promise<void> {
  const root = path.resolve(pathArg ?? process.cwd());
  const risky = await unpushedRepos(root);
  if (risky.length > 0 && !options.allowUnpushed) {
    err("Refusing to offload: these repos hold work no remote has:");
    for (const r of risky) err(`  ${r.relPath} (${r.reason})`);
    err("Push them to a remote, or re-run with --allow-unpushed to keep them only in the capsule.");
    process.exitCode = 1;
    return;
  }

  err("Pushing before offload…");
  await cmdTeleportPush(root, { name: options.name });
  const name = options.name?.trim() || path.basename(root);
  const capsule = await tapi.getCapsule(name);

  err("Waiting for redundant mirrors to verify…");
  const readiness = await waitForOffloadReady(capsule.id, {
    onPoll: (s) => err(`  mirrors: ${s.mirrors.map((m) => `${m.target}=${m.status}`).join(", ") || "(none)"}`),
  });
  if (!readiness.ready) {
    err("Mirrors are not all verified yet; not deleting anything. Check `heyditto teleport status`.");
    process.exitCode = 1;
    return;
  }
  if (!options.yes) {
    const answer = await requireTty(`Verified on ${readiness.mirrors.filter((m) => m.verifiedAt).length} mirror(s). Delete ${root}? [y/N] `);
    if (answer.toLowerCase() !== "y") return err("Aborted; capsule kept, local files untouched.");
  }
  const del = await deleteLocalRoot(root);
  await tapi.updateCapsule(capsule.id, { status: "offloaded" });
  out(`Offloaded ${root}.${del.location ? ` Moved to ${del.location}.` : ""}`);
  out(`Recover it with: heyditto teleport pull ${capsule.name} ${root}`);
}

// ===== storage =====

interface StorageAddOptions extends OutputOptions {
  name?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  default?: boolean;
  /** commander maps --no-mirror to mirror=false */
  mirror?: boolean;
}

export async function cmdStorageAdd(options: StorageAddOptions): Promise<void> {
  const endpoint = options.endpoint ?? (await requireTty("S3 endpoint URL: "));
  const bucket = options.bucket ?? (await requireTty("Bucket name: "));
  const accessKeyID = options.accessKey ?? (await requireTty("Access key id: "));
  const secretAccessKey = options.secretKey ?? (await requireTty("Secret access key: "));
  const input: storage.AddBucketInput = {
    name: options.name,
    accessKeyID,
    secretAccessKey,
    bucket,
    endpoint,
    region: options.region,
    default: options.default,
    teleportMirror: options.mirror !== false,
  };
  const probe = await storage.testDraft(input);
  if (!probe.ok) throw new Error(`could not connect to that bucket${probe.error ? `: ${probe.error}` : ""}`);
  const saved = await storage.addBucket(input);
  if (json(options)) return out(JSON.stringify(saved, null, 2));
  out(`Added bucket ${saved.name ?? saved.bucket} (${storage.bucketEndpointLabel(saved)}, ${saved.providerKind ?? "s3"}).`);
}

export async function cmdStorageList(options: OutputOptions): Promise<void> {
  const [buckets, targets] = await Promise.all([storage.listBuckets(), tapi.listTargets().catch(() => undefined)]);
  if (json(options)) return out(JSON.stringify({ buckets, targets: targets?.targets ?? [] }, null, 2));
  if (targets) {
    out("Mirror targets:");
    for (const t of targets.targets) out(`  ${pad(t.target, 20)} ${pad(t.label, 24)} ${t.required ? "required" : "optional"}${t.available ? "" : "  (unavailable)"}`);
  }
  if (buckets.length === 0) return out("No buckets of your own. Add one with `heyditto storage add`.");
  out("Your buckets:");
  for (const b of buckets) {
    const flags = [
      b.default ? "default" : "",
      b.enabled ? "" : "disabled",
      b.teleportMirror ? "mirror" : "",
      b.credentialState && b.credentialState !== "ready" ? b.credentialState : "",
    ]
      .filter(Boolean)
      .join(", ");
    out(`  ${b.id}  ${pad(b.name ?? b.bucket, 20)}  ${pad(storage.bucketEndpointLabel(b), 28)}${flags ? `  (${flags})` : ""}`);
  }
}

/** `<bucket>` is a friendly name or an id. */
export async function cmdStorageTest(ref: string, options: OutputOptions): Promise<void> {
  const bucket = await storage.resolveBucket(ref);
  const res = await storage.testBucket(bucket.id);
  const label = bucket.name ?? bucket.bucket;
  if (json(options)) return out(JSON.stringify({ id: bucket.id, ...res }, null, 2));
  out(res.ok ? `Bucket ${label}: connection ok.` : `Bucket ${label}: FAILED${res.error ? ` — ${res.error}` : ""}`);
  if (!res.ok) process.exitCode = 1;
}

export async function cmdStorageRemove(ref: string): Promise<void> {
  const bucket = await storage.resolveBucket(ref);
  await storage.removeBucket(bucket.id);
  out(`Removed bucket ${bucket.name ?? bucket.bucket}.`);
}

export async function cmdStorageMirror(ref: string, targetsArg: string): Promise<void> {
  const capsule = await tapi.setMirrorPolicy(ref, parsePolicy(targetsArg));
  out(`Mirror policy for ${capsule.name}: ${targetsArg}.`);
}

// ===== registration =====

function outputOption(): Option {
  return new Option("--output <format>", "output format").choices(["text", "json"]).default("text");
}
function jsonAlias(): Option {
  return new Option("--json", "shorthand for --output json");
}
function withOutput(c: Command): Command {
  return c.addOption(outputOption()).addOption(jsonAlias());
}

export function registerTeleportCommands(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  const teleport = withOutput(
    program
      .command("teleport")
      .description("move a coding session and its repos between this machine and Ditto Cloud")
      .summary("teleport repos + session to Ditto Cloud")
      .showHelpAfterError()
      .option("--cloud", "after pushing, resume the session in a Ditto Code cloud job")
      .option("-e, --endpoint <slug>", "inference endpoint for the cloud session (with --cloud)")
      .option("--prompt <text>", "first instruction for the cloud session (with --cloud)")
      .option("--name <name>", "capsule name (default: the directory name)")
      .option("--mirror <policy>", "all | <target>[,<target>…]")
      .option("--include-ignored <glob>", "also capture a git-ignored path (repeatable)", collect, [])
      .option("--dry-run", "print what would be captured, upload nothing")
      .argument("[path]", "root directory (default: current)")
      .action(cmdTeleport),
  );

  withOutput(
    teleport
      .command("push [path]")
      .description("snapshot a repo or folder of repos to a capsule")
      .option("--name <name>", "capsule name (default: the directory name)")
      .option("--mirror <policy>", "all | <target>[,…]")
      .option("--include-ignored <glob>", "also capture a git-ignored path (repeatable)", collect, [])
      .option("--session <id>", "harness session id to capture with the repos")
      .addOption(new Option("--harness <kind>", "harness whose session to capture").choices(["claude", "codex", "none"]))
      .option("--dry-run", "print what would be captured, upload nothing")
      .action(cmdTeleportPush),
  );

  withOutput(
    teleport
      .command("pull [name] [path]")
      .description("restore a capsule to a local directory")
      .option("--capsule <ref>", "capsule id or name (alternative to the positional)")
      .option("--generation <n>", "restore a specific generation (default: head)")
      .option("--into <dir>", "destination directory")
      .option("--restore-harness", "also restore the coding-harness session state")
      .option("--resume", "resume the harness after restoring")
      .action((name, pathArg, options) => cmdTeleportPull(name, pathArg, options)),
  );

  withOutput(teleport.command("list").description("list your capsules").action(cmdTeleportList));
  withOutput(teleport.command("status <capsule>").description("mirror + verification status").action(cmdTeleportStatus));
  withOutput(teleport.command("verify <capsule>").description("re-verify a capsule's mirrors").action(cmdTeleportVerify));
  withOutput(teleport.command("generations <capsule>").description("list a capsule's generations").action(cmdTeleportGenerations));
  withOutput(teleport.command("targets").description("mirror targets, quota and capsule limit for your plan").action(cmdTeleportTargets));
  withOutput(teleport.command("rm <capsule>").description("delete a capsule and its generations").option("--yes", "skip the confirmation").action(cmdTeleportRm));

  addExamples(
    teleport,
    `  heyditto teleport                       push the current directory
  heyditto teleport --cloud --endpoint work   push, then resume in Ditto Code
  heyditto teleport push ~/code/project --mirror all
  heyditto teleport pull project ~/code/project --restore-harness --resume
  heyditto teleport list`,
  );

  addExamples(
    program
      .command("offload [path]")
      .description("push a project, verify its mirrors, then delete the local copy")
      .summary("free disk: back up then remove a local project")
      .option("--yes", "skip the delete confirmation")
      .option("--allow-unpushed", "offload even when a repo has commits no remote has")
      .option("--name <name>", "capsule name (default: the directory name)")
      .action(cmdOffload),
    `  heyditto offload ~/code/old-project
  heyditto offload --yes`,
  );

  const store = program
    .command("storage")
    .description("manage S3-compatible buckets capsules can mirror to")
    .summary("storage mirrors (bring your own bucket)")
    .showHelpAfterError();
  withOutput(
    store
      .command("add")
      .description("add a bucket (prompts for anything not passed)")
      .option("--name <name>", "friendly label")
      .option("--endpoint <url>", "S3 endpoint URL (AWS, R2, B2, MinIO, Hippius)")
      .option("--no-mirror", "add the bucket without using it as a teleport mirror")
      .option("--region <region>", "region")
      .option("--bucket <bucket>", "bucket name")
      .option("--access-key <id>", "access key id")
      .option("--secret-key <secret>", "secret access key")
      .option("--default", "make this the default bucket")
      .action(cmdStorageAdd),
  );
  withOutput(store.command("list").description("list mirror targets and your buckets").action(cmdStorageList));
  withOutput(store.command("test <bucket>").description("test a bucket's connection (name or id)").action(cmdStorageTest));
  store.command("remove <bucket>").description("remove a bucket (name or id)").action(cmdStorageRemove);
  store.command("mirror <capsule> <targets>").description("set a capsule's mirror policy: all | <target>[,…]").action(cmdStorageMirror);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
