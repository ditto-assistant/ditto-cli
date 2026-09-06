import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import {
  ApiError,
  type InferenceEndpoint,
  type InferenceKey,
  type SelectedEndpoint,
  createEndpoint,
  createKey,
  findEndpoint,
  isEndpointPending,
  listEndpoints,
  revokeKey,
} from "../api.js";
import { openInBrowser } from "../browser.js";
import { endpointURL, resolveApiKey } from "../config.js";
import { deviceLogin } from "../device-login.js";
import { formatActivation } from "../endpoint-format.js";
import { readStoredAuth, saveLogin, updateStoredAuth } from "../store.js";
import { err as c } from "../ui.js";
import { planClaude } from "./claude.js";
import { planCodex } from "./codex.js";
import { type SessionRecord, latestSession, readSession, writeSession } from "./sessions.js";
import {
  DEFAULT_LAUNCH_EXPIRY,
  type Harness,
  type HarnessPlan,
  KEY_EXPIRIES,
  type KeyExpiry,
  type PlanInput,
  childEnv,
  maskKey,
  stripSeparator,
} from "./types.js";
import { defaultWorktreeName, ensureWorktree } from "./worktree.js";

export interface LaunchOptions {
  endpoint?: string;
  budget?: string;
  expires?: string;
  keepKey?: boolean;
  session?: string;
  resume?: string | boolean;
  continue?: boolean;
  yolo?: boolean;
  yellow?: boolean;
  plan?: boolean;
  prompt?: string;
  model?: string;
  worktree?: string | boolean;
  name?: string;
  dryRun?: boolean;
}

const DRY_RUN_KEY = "ditto_inf_<minted-at-launch>";

function log(line: string): void {
  process.stderr.write(`${c("dim", "ditto:")} ${line}\n`);
}

/**
 * Prints the command that reopens this session on a line of its own, with no
 * prefix or trailing text, so a triple-click (or a mouse drag) grabs exactly
 * the command.
 */
function logResumeHint(harness: Harness, sessionId: string): void {
  process.stderr.write(`${c("dim", "ditto:")} resume this session with:\n\n  ${c(["bold", "green"], `heyditto ${harness} --resume ${sessionId}`)}\n\n`);
}

function planFor(harness: Harness, input: PlanInput): HarnessPlan {
  return harness === "claude" ? planClaude(input) : planCodex(input);
}

function binaryAvailable(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Picks the directory a resumed session runs in. Node reports a missing spawn
 * cwd as `spawn claude ENOENT`, which reads as "claude is not installed", so a
 * worktree that was removed since the last launch (Claude Code offers to delete
 * its worktree on exit) is detected here and the launch falls back to the
 * directory the session was originally started from.
 */
async function resolveResumeCwd(record: SessionRecord): Promise<{ cwd: string; worktree?: string }> {
  if (record.worktree) {
    if (await isDirectory(record.worktree)) return { cwd: record.worktree, worktree: record.worktree };
    const fallback = (await isDirectory(record.cwd)) ? record.cwd : process.cwd();
    log(`worktree ${record.worktree} no longer exists; resuming in ${fallback} (pass --worktree <name> to recreate it)`);
    return { cwd: fallback };
  }
  if (await isDirectory(record.cwd)) return { cwd: record.cwd };
  log(`directory ${record.cwd} no longer exists; resuming in ${process.cwd()}`);
  return { cwd: process.cwd() };
}

function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--budget must be a positive integer token count, got "${raw}"`);
  return n;
}

function parseExpiry(raw: string | undefined): KeyExpiry {
  const value = (raw ?? DEFAULT_LAUNCH_EXPIRY).trim();
  if ((KEY_EXPIRIES as readonly string[]).includes(value)) return value as KeyExpiry;
  throw new Error(`--expires must be one of: ${KEY_EXPIRIES.join(", ")}`);
}

function formatSpend(e: InferenceEndpoint): string {
  const used = e.spentTokens ?? 0;
  if (e.spendLimitTokens == null || e.spendLimitTokens < 0) return `${used.toLocaleString()} tokens used, no limit`;
  return `${used.toLocaleString()} / ${e.spendLimitTokens.toLocaleString()} tokens${e.spendPeriod && e.spendPeriod !== "never" ? ` per ${e.spendPeriod.replace(/ly$/, "")}` : ""}`;
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Yes/no prompt with Enter defaulting to yes. */
async function confirmYes(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [Y/n] `)).toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/** Interactive numbered picker; also accepts a slug or id. Exported for `heyditto endpoints pick`. */
export async function pickEndpoint(endpoints: InferenceEndpoint[], defaultSlug?: string): Promise<InferenceEndpoint> {
  if (!interactive()) {
    throw new Error(
      "no endpoint selected. Pass --endpoint <slug>, or set a default with `heyditto endpoints use <slug>`.",
    );
  }
  process.stderr.write(`${c("bold", "Ditto inference endpoints:")}\n\n`);
  endpoints.forEach((e, i) => {
    const marks = [
      e.slug === defaultSlug ? c("green", "default") : "",
      isEndpointPending(e) ? c("yellow", "inactive") : "",
    ].filter(Boolean);
    process.stderr.write(
      `  ${c("cyan", `${i + 1})`)} ${c("bold", e.slug)}  ${e.name !== e.slug ? c("dim", `(${e.name})  `) : ""}${c("dim", "model=")}${e.model}${marks.length ? `  [${marks.join(", ")}]` : ""}\n`,
    );
    process.stderr.write(`${c("dim", `     ${formatSpend(e)}${e.recordTrace ? "  · traces on" : "  · traces off"}`)}\n`);
  });
  process.stderr.write("\n");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await rl.question(`Connect to which endpoint? [1-${endpoints.length}, or a slug] `)).trim();
      const idx = Number(answer);
      if (Number.isInteger(idx) && idx >= 1 && idx <= endpoints.length) return endpoints[idx - 1];
      const bySlug = findEndpoint(endpoints, answer);
      if (bySlug) return bySlug;
      process.stderr.write(`Pick a number from 1 to ${endpoints.length}, or type an endpoint slug.\n`);
    }
  } finally {
    rl.close();
  }
}

/** Refuses to launch against an endpoint the backend marked inactive (e.g. awaiting the user's plan). */
export async function assertEndpointActive(endpoint: InferenceEndpoint): Promise<void> {
  if (!isEndpointPending(endpoint)) return;
  const stored = await readStoredAuth();
  const details = formatActivation(endpoint, stored?.claimURL);
  throw new Error(
    `endpoint "${endpoint.slug}" is not active yet (${endpoint.status}).\n\n${details}`,
  );
}

async function resolveEndpoint(
  wanted: string | undefined,
  endpoints: InferenceEndpoint[],
  selected: SelectedEndpoint | undefined,
): Promise<InferenceEndpoint> {
  if (endpoints.length === 0) {
    if (interactive() && (await confirmYes("You have no inference endpoints yet. Create your first one now?"))) {
      const created = await createEndpoint({});
      log(`created endpoint ${created.slug} (model ${created.model})`);
      await updateStoredAuth({ defaultEndpoint: created.slug });
      return created;
    }
    throw new Error(
      `you have no inference endpoints yet. Create one with \`heyditto endpoints create\`, or at ${endpointURL()}.`,
    );
  }
  const stored = (await readStoredAuth())?.defaultEndpoint;
  if (wanted?.trim()) {
    const match = findEndpoint(endpoints, wanted);
    if (match) return match;
    throw new Error(`no endpoint named "${wanted.trim()}". Available: ${endpoints.map((e) => e.slug).join(", ")}`);
  }
  if (selected) {
    // Chosen in the browser moments ago during the device login.
    const match = findEndpoint(endpoints, selected.id) ?? findEndpoint(endpoints, selected.slug);
    if (match) return match;
    log(`endpoint "${selected.slug}" picked in the browser is not in your list; pick another`);
  }
  if (stored?.trim()) {
    const match = findEndpoint(endpoints, stored);
    if (match) return match;
    log(`default endpoint "${stored.trim()}" no longer exists; pick another`);
  }
  if (endpoints.length === 1) return endpoints[0];
  const picked = await pickEndpoint(endpoints, stored);
  if (await confirmYes(`Use ${picked.slug} by default next time?`)) {
    await updateStoredAuth({ defaultEndpoint: picked.slug });
    log(`default endpoint set to ${picked.slug} (change it with \`heyditto endpoints use <slug>\`)`);
  }
  return picked;
}

/**
 * First run: no key saved anywhere. On a terminal, run the browser device
 * flow with the harness as the intent so the web page can offer the endpoint
 * picker; the browser hands back the key and (optionally) the chosen endpoint.
 */
async function ensureLoggedIn(harness: Harness): Promise<SelectedEndpoint | undefined> {
  const { key } = await resolveApiKey();
  if (key) return undefined;
  if (!interactive()) {
    // Non-interactive callers (CI, agents) must log in explicitly.
    await listEndpoints(); // throws the shared "no Ditto API key configured" error
    return undefined;
  }
  log(`no Ditto login yet — opening your browser to sign in and pick an endpoint for ${harness === "claude" ? "Claude Code" : "Codex"}.`);
  return browserLogin(harness);
}

/** Runs the browser device flow for a harness and saves the result. */
async function browserLogin(harness: Harness): Promise<SelectedEndpoint | undefined> {
  const result = await deviceLogin({
    intent: harness,
    onCode: (userCode, url) => {
      process.stderr.write(`\n  ${url}\n\n  Code: ${userCode}\n\n`);
      openInBrowser(url);
      process.stderr.write("Waiting for approval in the browser (Ctrl+C to cancel)…\n");
    },
  });
  await saveLogin(result.apiKey, result.setDefault && result.endpoint ? { defaultEndpoint: result.endpoint.slug } : {});
  log(`logged in${result.endpoint ? `; endpoint ${result.endpoint.slug}${result.setDefault ? " saved as default" : ""}` : ""}`);
  return result.endpoint;
}

function forwardSignals(child: ChildProcess): () => void {
  // Ctrl+C reaches the child directly through the shared terminal; the
  // wrapper only has to survive it so it can revoke the key afterwards.
  const onInt = () => {
    /* keep running until the harness exits */
  };
  const onTerm = () => child.kill("SIGTERM");
  const onHup = () => child.kill("SIGHUP");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
  };
}

function waitForExit(child: ChildProcess, command: string, cwd: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on("error", (err) => {
      // spawn reports both a missing binary and a missing cwd as ENOENT.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`could not start ${command} in ${cwd}: ${err.message} (is "${command}" on your PATH and does the directory exist?)`));
        return;
      }
      reject(err);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : null)));
  });
}

/** Launches a coding harness against a Ditto inference endpoint with a temporary key. */
export async function launchHarness(harness: Harness, rawArgs: string[], options: LaunchOptions): Promise<void> {
  const passthrough = stripSeparator(rawArgs);
  const budget = parseBudget(options.budget);
  const expiresIn = parseExpiry(options.expires);
  if (options.plan && harness !== "claude") throw new Error("--plan is only supported for claude");
  if ([options.yolo, options.yellow, options.plan].filter(Boolean).length > 1) {
    throw new Error("choose only one of --yolo, --yellow, --plan");
  }
  if (options.resume !== undefined && options.continue) throw new Error("use either --resume or --continue");
  if (options.resume !== undefined && options.session) throw new Error("--session cannot be combined with --resume");

  if (!options.dryRun && !binaryAvailable(harness)) {
    const hint = planFor(harness, {
      baseUrl: "",
      apiKey: "",
      sessionId: "",
      passthrough: [],
      env: {},
    }).installHint;
    throw new Error(`"${harness}" is not on your PATH; ${hint}`);
  }

  // Resume: reuse the local record's Ditto session id so the traces stay in
  // the same thread; a fresh key is minted every launch.
  let record: SessionRecord | undefined;
  let resumeLast = Boolean(options.continue);
  if (options.resume !== undefined) {
    record =
      typeof options.resume === "string"
        ? await readSession(options.resume)
        : await latestSession(harness, process.cwd());
    if (!record) {
      throw new Error(
        typeof options.resume === "string"
          ? `no local session "${options.resume}"; see \`heyditto sessions\``
          : `no previous ${harness} session to resume; see \`heyditto sessions\``,
      );
    }
    if (record.harness !== harness) throw new Error(`session ${record.id} was a ${record.harness} session`);
    if (!record.harnessSessionId) resumeLast = true;
  }

  let selected = options.dryRun ? undefined : await ensureLoggedIn(harness);
  let catalog: Awaited<ReturnType<typeof listEndpoints>>;
  try {
    catalog = await listEndpoints();
  } catch (err) {
    // A saved key that lapsed (device-flow keys expire) sends the user back
    // through the browser instead of a dead 401.
    if (!(err instanceof ApiError) || err.status !== 401 || options.dryRun || !interactive()) throw err;
    const { source } = await resolveApiKey();
    if (source !== "config") throw err;
    log("your saved Ditto login is no longer valid — opening your browser to sign in again.");
    selected = await browserLogin(harness);
    catalog = await listEndpoints();
  }
  const endpoint = await resolveEndpoint(options.endpoint ?? record?.endpointSlug, catalog.endpoints, selected);
  await assertEndpointActive(endpoint);

  let cwd = process.cwd();
  let worktreePath: string | undefined;
  if (record) ({ cwd, worktree: worktreePath } = await resolveResumeCwd(record));
  if (options.worktree !== undefined && options.worktree !== false) {
    const name = typeof options.worktree === "string" ? options.worktree : defaultWorktreeName(harness);
    if (options.dryRun) {
      log(`would create worktree .worktrees/${name}`);
    } else {
      const wt = await ensureWorktree(process.cwd(), name);
      log(`${wt.created ? "created" : "reusing"} worktree ${c("bold", wt.path)} ${c("dim", `(branch ${wt.branch})`)}`);
      cwd = wt.path;
      worktreePath = wt.path;
    }
  }

  const sessionId = record?.id ?? options.session?.trim() ?? randomUUID();
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(sessionId)) {
    throw new Error("--session must match ^[A-Za-z0-9._:@-]{1,128}$");
  }
  const harnessSessionId = record?.harnessSessionId ?? (harness === "claude" && !resumeLast ? sessionId : undefined);
  // No model flag means the harness's own model choice passes through and the
  // endpoint routes it (Codex's default gpt-* id normalizes like Claude's
  // claude-* ids). Earlier releases pinned Codex sessions to the endpoint
  // slug; that pin is dropped on resume so they pass through too.
  const recordedModel = record?.model === endpoint.slug ? undefined : record?.model;
  const model = options.model ?? recordedModel;
  const now = new Date().toISOString();

  if (!(await isDirectory(cwd))) throw new Error(`launch directory ${cwd} does not exist`);

  const keyName = options.name?.trim() || `cli:${harness}:${os.hostname()}`;
  let key: InferenceKey | undefined;
  if (!options.dryRun) {
    key = await createKey(endpoint.id, {
      name: keyName,
      expiresIn,
      ...(budget !== undefined ? { spendLimitTokens: budget, spendPeriod: "never" } : {}),
    });
  }

  const plan = planFor(harness, {
    baseUrl: catalog.baseUrl,
    apiKey: key?.key ?? DRY_RUN_KEY,
    sessionId,
    model,
    resumeId: record ? record.harnessSessionId : undefined,
    resumeLast,
    prompt: options.prompt,
    yolo: options.yolo,
    yellow: options.yellow,
    plan: options.plan,
    passthrough,
    env: process.env,
  });

  const field = (name: string, value: string): string => `${c("dim", `${name}=`)}${value}`;
  const banner = [
    field("endpoint", c(["bold", "cyan"], endpoint.slug)),
    field("model", model ?? c("dim", "(harness default → endpoint routes)")),
    field("key", key ? `…${key.keyHint || maskKey(key.key ?? "")}` : "(dry run)"),
    field("expires", `${expiresIn}${options.keepKey ? "" : c("dim", " (revoked on exit)")}`),
    budget !== undefined ? field("budget", `${budget.toLocaleString()} tokens`) : undefined,
    field("session", c("bold", sessionId)),
  ]
    .filter(Boolean)
    .join("  ");
  log(banner);
  log(`traces: ${c(["underline", "cyan"], endpointURL(endpoint.id))}`);

  if (options.dryRun) {
    const env = Object.fromEntries(
      Object.entries(plan.envSet).map(([k, v]) => [k, v === DRY_RUN_KEY ? "<key>" : v]),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          harness,
          command: plan.command,
          args: plan.args,
          env,
          unsetEnv: plan.envUnset,
          cwd,
          endpoint: { id: endpoint.id, slug: endpoint.slug, model: endpoint.model },
          sessionId,
          key: { name: keyName, expiresIn, spendLimitTokens: budget ?? null },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!key) throw new Error("internal: key was not minted");

  const nextRecord: SessionRecord = {
    id: sessionId,
    harness,
    endpointId: endpoint.id,
    endpointSlug: endpoint.slug,
    keyId: key.id,
    keyHint: key.keyHint,
    harnessSessionId,
    cwd: record?.cwd ?? process.cwd(),
    worktree: worktreePath,
    model,
    createdAt: record?.createdAt ?? now,
    lastLaunchedAt: now,
    launches: (record?.launches ?? 0) + 1,
  };
  await writeSession(nextRecord);

  const child = spawn(plan.command, plan.args, {
    stdio: "inherit",
    env: childEnv(plan, process.env),
    cwd,
  });
  const restore = forwardSignals(child);
  let exitCode: number | null = null;
  try {
    exitCode = await waitForExit(child, plan.command, cwd);
  } finally {
    restore();
    process.stderr.write("\n");
    if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) {
      // The gateway answers an expired key with a 401 the harness shows, not us;
      // name the cause here so the fix (--expires) is discoverable.
      log(`${c("yellow", "the session key expired")} at ${key.expiresAt} while the agent was still running; relaunch with a longer --expires (this one was ${expiresIn})`);
    }
    if (options.keepKey) {
      log(`kept key …${key.keyHint} ${c("dim", `(expires ${expiresIn})`)}; revoke it from the Ditto app when done`);
    } else {
      try {
        await revokeKey(endpoint.id, key.id);
        log(`${c("green", "revoked")} session key …${key.keyHint}; the thread and its traces are kept`);
      } catch (err) {
        log(`${c("yellow", "could not revoke")} key …${key.keyHint} (${err instanceof Error ? err.message : String(err)}); it expires in ${expiresIn}`);
      }
    }
    // Headless runs (-p / codex exec) are scripted, and a launch whose spawn
    // failed has no conversation to reopen; neither wants the resume epilogue.
    if (options.prompt === undefined && exitCode !== null) logResumeHint(harness, sessionId);
    await writeSession({ ...nextRecord, endedAt: new Date().toISOString(), exitCode });
  }
  process.exitCode = exitCode ?? 1;
}
