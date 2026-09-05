import { createInterface } from "node:readline/promises";
import path from "node:path";
import { Command, Option } from "commander";
import { configDir } from "../config.js";
import { listSessions } from "../agents/sessions.js";
import { launchHarness } from "../agents/launch.js";
import * as tapi from "../teleport/api.js";
import { pushCapsule } from "../teleport/push.js";
import { pullCapsule, readCachedManifest, writeCachedManifest } from "../teleport/pull.js";
import { deleteLocalRoot, unpushedRepos, waitForOffloadReady } from "../teleport/offload.js";
import * as storage from "../teleport/storage.js";
import { discoverRepos } from "../teleport/discover.js";
import { formatBytes, type HarnessKind, type Manifest } from "../teleport/types.js";
import { resolveApiKey } from "../config.js";
import { listEndpoints } from "../api.js";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}
function json(options: { output?: string }): boolean {
  return options.output === "json";
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

/** Finds or creates the capsule for a root path, remembering the id in the local record. */
async function resolveCapsule(
  root: string,
  opts: { name?: string; create: boolean; harness?: { kind: HarnessKind; sessionId?: string } },
): Promise<{ capsule: tapi.Capsule; previous?: Manifest }> {
  const discovery = await discoverRepos(root);
  const name = opts.name?.trim() || path.basename(path.resolve(root));
  const existing = (await tapi.listCapsules()).find((c) => c.name === name);
  let capsule = existing;
  if (!capsule) {
    if (!opts.create) throw new Error(`no capsule named "${name}"; push it first with \`heyditto teleport push\``);
    capsule = await tapi.createCapsule({
      name,
      rootKind: discovery.kind,
      harnessKind: opts.harness?.kind,
      harnessSessionId: opts.harness?.sessionId,
    });
  }
  const previous = (await readCachedManifest(configDir(), capsule.id)) as Manifest | undefined;
  return { capsule, previous };
}

interface PushOptions {
  name?: string;
  mirror?: string;
  includeIgnored?: string[];
  dryRun?: boolean;
  output?: string;
  session?: string;
  harness?: string;
}

export async function cmdTeleportPush(pathArg: string | undefined, options: PushOptions): Promise<void> {
  const root = path.resolve(pathArg ?? process.cwd());
  const discovery = await discoverRepos(root);
  const harnessKind = harnessKindOf(options.harness);
  const harness = { kind: harnessKind, sessionId: options.session, cwd: harnessKind === "none" ? undefined : root };

  if (options.dryRun) {
    out(
      JSON.stringify(
        { root, rootKind: discovery.kind, repos: discovery.repos, harness, mirror: options.mirror ?? "all" },
        null,
        2,
      ),
    );
    return;
  }

  const { capsule, previous } = await resolveCapsule(root, { name: options.name, create: true, harness });
  if (options.mirror) {
    const mode = options.mirror === "all" ? "all" : "some";
    const targets = options.mirror === "all" ? undefined : options.mirror.split(",").map((s) => s.trim()).filter(Boolean);
    await tapi.setMirrorPolicy(capsule.id, { mode, targets });
  }

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
  });

  // Cache the committed manifest for the next thin push.
  const { manifest } = await tapi.resolveGeneration(capsule.id, result.generation);
  await writeCachedManifest(configDir(), capsule.id, manifest);

  if (json(options)) {
    out(JSON.stringify({ capsuleId: capsule.id, ...result }, null, 2));
    return;
  }
  out(
    `Pushed generation ${result.generation}: ${formatBytes(result.bytesTotal)} in ${result.chunkCount} chunks ` +
      `(${result.uploaded} uploaded, ${result.reused} reused).`,
  );
  out(`Pull elsewhere with: heyditto teleport pull ${capsule.name} <path>`);
}

interface PullOptions {
  capsule?: string;
  generation?: string;
  into?: string;
  restoreHarness?: boolean;
  resume?: boolean;
  output?: string;
}

export async function cmdTeleportPull(nameArg: string | undefined, pathArg: string | undefined, options: PullOptions): Promise<void> {
  const idOrName = options.capsule ?? nameArg;
  if (!idOrName) throw new Error("which capsule? pass a name/id argument or --capsule");
  const capsules = await tapi.listCapsules();
  const capsule = capsules.find((c) => c.id === idOrName || c.name === idOrName);
  if (!capsule) throw new Error(`no capsule "${idOrName}" (see \`heyditto teleport list\`)`);
  const dest = path.resolve(options.into ?? pathArg ?? path.join(process.cwd(), capsule.name));
  const generation = options.generation ? Number(options.generation) : undefined;
  err(`Pulling capsule ${capsule.name}${generation ? ` @${generation}` : ""} → ${dest}…`);
  const result = await pullCapsule(capsule.id, generation, dest, { restoreHarness: options.restoreHarness });
  const { manifest } = await tapi.resolveGeneration(capsule.id, generation ?? capsule.headGeneration);
  await writeCachedManifest(configDir(), capsule.id, manifest);

  if (json(options)) {
    out(JSON.stringify({ ...result }, null, 2));
  } else {
    out(`Restored ${result.repos.length} repo(s) into ${result.root}.`);
    if (result.harnessSessionId) out(`Harness session ${result.harnessSessionId} restored under ${result.harnessCwd}.`);
  }
  if (options.resume && result.harnessSessionId && manifest.harness.kind !== "none") {
    const harness = manifest.harness.kind === "claude-code" ? "claude" : "codex";
    err(`Resuming ${harness}…`);
    await launchHarness(harness as "claude" | "codex", [], { resume: result.harnessSessionId });
  }
}

export async function cmdTeleportList(options: { output?: string }): Promise<void> {
  const capsules = await tapi.listCapsules();
  if (json(options)) return out(JSON.stringify({ capsules }, null, 2));
  if (capsules.length === 0) return out("No capsules yet. Push one with `heyditto teleport push`.");
  const rows = capsules.map((c) => [
    c.name,
    c.rootKind,
    `gen ${c.headGeneration}`,
    formatBytes(c.bytesTotal ?? 0),
    c.status ?? "active",
  ]);
  const header = ["NAME", "KIND", "HEAD", "SIZE", "STATUS"];
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  out(header.map((h, i) => pad(h, w[i])).join("  "));
  for (const r of rows) out(r.map((c, i) => pad(c, w[i])).join("  "));
}

export async function cmdTeleportStatus(name: string, options: { output?: string }): Promise<void> {
  const capsule = (await tapi.listCapsules()).find((c) => c.id === name || c.name === name);
  if (!capsule) throw new Error(`no capsule "${name}"`);
  const status = await tapi.capsuleStatus(capsule.id);
  if (json(options)) return out(JSON.stringify(status, null, 2));
  out(`${capsule.name}: head generation ${status.headGeneration}, offload ${status.offloadReady ? "ready" : "not ready"}`);
  for (const m of status.mirrors) {
    out(`  ${pad(m.target, 16)} gen ${m.generation}  ${m.status}${m.verifiedAt ? `  verified ${m.verifiedAt.slice(0, 16)}` : ""}${m.error ? `  (${m.error})` : ""}`);
  }
}

export async function cmdTeleportVerify(name: string, options: { output?: string }): Promise<void> {
  const capsule = (await tapi.listCapsules()).find((c) => c.id === name || c.name === name);
  if (!capsule) throw new Error(`no capsule "${name}"`);
  const status = await tapi.verifyCapsule(capsule.id);
  if (json(options)) return out(JSON.stringify(status, null, 2));
  out(`${capsule.name}: ${status.offloadReady ? "all mirrors verified" : "verification incomplete"}`);
  for (const m of status.mirrors) out(`  ${pad(m.target, 16)} ${m.status}`);
}

export async function cmdTeleportRm(name: string, options: { yes?: boolean; output?: string }): Promise<void> {
  const capsule = (await tapi.listCapsules()).find((c) => c.id === name || c.name === name);
  if (!capsule) throw new Error(`no capsule "${name}"`);
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
}

/** The bare `heyditto teleport` command: push the current dir, optionally launch a cloud session. */
export async function cmdTeleport(pathArg: string | undefined, options: TeleportOptions): Promise<void> {
  const root = path.resolve(pathArg ?? process.cwd());
  // Prefer a coding session whose worktree/cwd matches this root, so the harness travels too.
  const sessions = await listSessions();
  const match = sessions.find((s) => s.cwd === root || s.worktree === root);
  const harness = match ? { kind: harnessKindOf(match.harness), sessionId: match.harnessSessionId } : undefined;
  await cmdTeleportPush(root, {
    ...options,
    session: harness?.sessionId ?? options.session,
    harness: match?.harness ?? options.harness,
  });
  if (!options.cloud) return;

  const capsule = (await tapi.listCapsules()).find((c) => c.name === (options.name?.trim() || path.basename(root)));
  if (!capsule) throw new Error("capsule not found after push");
  const harnessKind = harness?.kind ?? "claude-code";
  const session = await tapi.launchCloudSession(capsule.id, {
    harness: harnessKind === "codex" ? "codex" : "claude-code",
    endpointId: options.endpoint,
  });
  out(`Cloud session started as job ${session.jobId}.`);
  out(`Open it: ${session.appUrl ?? `https://app.heyditto.ai/chat/${session.threadId}`}`);
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
  const capsule = (await tapi.listCapsules()).find((c) => c.name === (options.name?.trim() || path.basename(root)));
  if (!capsule) throw new Error("capsule not found after push");

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
  out(`Offloaded ${root}.${del.location ? ` Moved to ${del.location}.` : ""}`);
  out(`Recover it with: heyditto teleport pull ${capsule.name} ${root}`);
}

// ===== storage =====

interface StorageAddOptions {
  name?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKey?: string;
  secretKey?: string;
  default?: boolean;
  output?: string;
}

export async function cmdStorageAdd(options: StorageAddOptions): Promise<void> {
  const bucket = options.bucket ?? (await requireTty("Bucket name: "));
  const accessKeyID = options.accessKey ?? (await requireTty("Access key id: "));
  const secretAccessKey = options.secretKey ?? (await requireTty("Secret access key: "));
  const input: storage.AddBucketInput = {
    name: options.name,
    accessKeyID,
    secretAccessKey,
    bucket,
    endpoint: options.endpoint,
    region: options.region,
    default: options.default,
  };
  const probe = await storage.testDraft(input);
  if (!probe.ok) throw new Error(`could not connect to that bucket${probe.error ? `: ${probe.error}` : ""}`);
  const saved = await storage.addBucket(input);
  if (json(options)) return out(JSON.stringify(saved, null, 2));
  out(`Added bucket ${saved.name ?? saved.bucket} (${storage.bucketEndpointLabel(saved)}).`);
}

export async function cmdStorageList(options: { output?: string }): Promise<void> {
  const status = await storage.getStorage();
  if (json(options)) return out(JSON.stringify(status, null, 2));
  if (status.buckets.length === 0) return out("No storage buckets. Add one with `heyditto storage add`.");
  for (const b of status.buckets) {
    const flags = [b.default ? "default" : "", b.enabled ? "" : "disabled"].filter(Boolean).join(", ");
    out(`${b.id}  ${pad(b.name ?? b.bucket, 20)}  ${pad(storage.bucketEndpointLabel(b), 28)}${flags ? `  (${flags})` : ""}`);
  }
}

export async function cmdStorageTest(id: string, options: { output?: string }): Promise<void> {
  const res = await storage.testBucket(id);
  if (json(options)) return out(JSON.stringify(res, null, 2));
  out(res.ok ? `Bucket ${id}: connection ok.` : `Bucket ${id}: FAILED${res.error ? ` — ${res.error}` : ""}`);
  if (!res.ok) process.exitCode = 1;
}

export async function cmdStorageRemove(id: string): Promise<void> {
  await storage.removeBucket(id);
  out(`Removed bucket ${id}.`);
}

export async function cmdStorageMirror(name: string, targetsArg: string): Promise<void> {
  const capsule = (await tapi.listCapsules()).find((c) => c.id === name || c.name === name);
  if (!capsule) throw new Error(`no capsule "${name}"`);
  const mode = targetsArg === "all" ? "all" : "some";
  const targets = targetsArg === "all" ? undefined : targetsArg.split(",").map((s) => s.trim()).filter(Boolean);
  await tapi.setMirrorPolicy(capsule.id, { mode, targets });
  out(`Mirror policy for ${capsule.name}: ${targetsArg}.`);
}

// ===== registration =====

function outputOption(): Option {
  return new Option("--output <format>", "output format").choices(["text", "json"]).default("text");
}

export function registerTeleportCommands(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  const teleport = program
    .command("teleport")
    .description("move a coding session and its repos between this machine and Ditto Cloud")
    .summary("teleport repos + session to Ditto Cloud")
    .showHelpAfterError()
    .option("--cloud", "after pushing, resume the session in a Ditto Code cloud job")
    .option("-e, --endpoint <slug>", "inference endpoint for the cloud session (with --cloud)")
    .option("--name <name>", "capsule name (default: the directory name)")
    .option("--mirror <policy>", "all | <bucketId>[,<bucketId>…]")
    .option("--include-ignored <glob>", "also capture a git-ignored path (repeatable)", collect, [])
    .option("--dry-run", "print what would be captured, upload nothing")
    .addOption(outputOption())
    .argument("[path]", "root directory (default: current)")
    .action(cmdTeleport);

  teleport
    .command("push [path]")
    .description("snapshot a repo or folder of repos to a capsule")
    .option("--name <name>", "capsule name (default: the directory name)")
    .option("--mirror <policy>", "all | <bucketId>[,…]")
    .option("--include-ignored <glob>", "also capture a git-ignored path (repeatable)", collect, [])
    .option("--session <id>", "harness session id to capture with the repos")
    .addOption(new Option("--harness <kind>", "harness whose session to capture").choices(["claude", "codex", "none"]))
    .option("--dry-run", "print what would be captured, upload nothing")
    .addOption(outputOption())
    .action(cmdTeleportPush);

  teleport
    .command("pull [name] [path]")
    .description("restore a capsule to a local directory")
    .option("--capsule <id>", "capsule id or name (alternative to the positional)")
    .option("--generation <n>", "restore a specific generation (default: head)")
    .option("--into <dir>", "destination directory")
    .option("--restore-harness", "also restore the coding-harness session state")
    .option("--resume", "resume the harness after restoring")
    .addOption(outputOption())
    .action((name, pathArg, options) => cmdTeleportPull(name, pathArg, options));

  teleport.command("list").description("list your capsules").addOption(outputOption()).action(cmdTeleportList);
  teleport.command("status <name>").description("mirror + verification status of a capsule").addOption(outputOption()).action(cmdTeleportStatus);
  teleport.command("verify <name>").description("re-verify a capsule's mirrors").addOption(outputOption()).action(cmdTeleportVerify);
  teleport.command("rm <name>").description("delete a capsule and its generations").option("--yes", "skip the confirmation").addOption(outputOption()).action(cmdTeleportRm);

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
  store
    .command("add")
    .description("add a bucket (prompts for anything not passed)")
    .option("--name <name>", "friendly label")
    .option("--endpoint <url>", "S3 endpoint (default: Hippius)")
    .option("--region <region>", "region")
    .option("--bucket <bucket>", "bucket name")
    .option("--access-key <id>", "access key id")
    .option("--secret-key <secret>", "secret access key")
    .option("--default", "make this the default bucket")
    .addOption(outputOption())
    .action(cmdStorageAdd);
  store.command("list").description("list configured buckets").addOption(outputOption()).action(cmdStorageList);
  store.command("test <id>").description("test a bucket's connection").addOption(outputOption()).action(cmdStorageTest);
  store.command("remove <id>").description("remove a bucket").action(cmdStorageRemove);
  store
    .command("mirror <capsule> <targets>")
    .description("set a capsule's mirror policy: all | <bucketId>[,…]")
    .action(cmdStorageMirror);

  // Silence unused-import lints in builds that tree-shake; these are the runner-mode helpers.
  void resolveApiKey;
  void listEndpoints;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
