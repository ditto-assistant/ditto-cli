import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  ApiError,
  apiFetch,
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
import { apiBaseURL, configDir, endpointURL, resolveApiKey } from "../config.js";
import { deviceLogin } from "../device-login.js";
import { formatActivation } from "../endpoint-format.js";
import { explicitProfileEndpoint, readDefaultEndpoint, writeDefaultEndpoint } from "../profiles.js";
import { readStoredAuth, saveLogin } from "../store.js";
import { findProfileEndpoint, repoDefaultProfile } from "../dittoconfig/profiles.js";
import { err as c } from "../ui.js";
import { holdNotesForTui, type NoteOptions, releaseNotes, writeNote } from "../terminal-note.js";
import { claudeDittoDenyRules } from "./claude-deny.js";
import { type ClaudeMcpAttachment, claudeMcpAttachment, fetchMcpCatalog, mcpApprovalNote, mcpUnavailableLines } from "./claude-mcp.js";
import { liftResumeFlags, planClaude } from "./claude.js";
import { resolveClaudeResume, transcriptCwd } from "./claude-resume.js";
import { type ClaudeTranscript, findTranscriptById, isUuid, listTranscriptsIn } from "./claude-transcripts.js";
import { watchClaudeSessionTitle } from "./claude-title-sync.js";
import { type ClaudeHookAttachment, claudeHookAttachment } from "./claude-hooks.js";
import { planCodex } from "./codex.js";
import { planCursor, writeCursorPlugin } from "./cursor.js";
import { cliProxyModel, resolveCliProxy } from "./cliproxy.js";
import { readHarnessVersion } from "./harness-headers.js";
import { ensureGrokHome, planGrok } from "./grok.js";
import { type SessionRecord, latestSession, readSession, sessionForHarnessId, writeSession } from "./sessions.js";
import { canonicalCwd } from "../teleport/harness.js";
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
import { DEFAULT_T3_INSTANCE } from "../t3/instance.js";
import { RemoteSession } from "../remote/controller.js";
import { startHeadlessTurn } from "../remote/headless.js";
import { type HookServer, claudeHookSettings, codexNotifyOverride, hookScriptPath, startHookServer, withHookArgs } from "../remote/hooks.js";
import { type PtySession, loadPty, spawnInPty } from "../remote/pty.js";
import { type SessionRegistration, remoteSessionURL, UNLINKABLE_SESSION_NOTICE } from "../remote/session-link.js";
import { checkpointPush } from "../teleport/commands.js";

export interface LaunchOptions {
  endpoint?: string;
  /**
   * The endpoint to use only when nothing else names one: no --endpoint,
   * --profile, resumed session or repository `.ditto/` default. T3 providers
   * pass theirs here so a checkout's own profile still picks its endpoint.
   */
  fallbackEndpoint?: string;
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
  /**
   * Run the harness in this directory instead of the saved session's cwd.
   * Teleport passes the restored root here so `--resume` appends to the
   * restored transcript even when the original directory still exists.
   */
  cwd?: string;
  /**
   * Remote Control: announce the session to the Ditto backend so the app can
   * send prompts (with attachments) into this terminal. On by default;
   * `--no-remote-control` turns it off.
   */
  remoteControl?: boolean;
  /**
   * Headless Remote Control: no terminal UI. Each prompt from the app runs one
   * `claude -p` / `codex exec` turn in the session's thread until Ctrl+C.
   */
  headless?: boolean;
  /**
   * Claude and Codex: attach the endpoint's tools as the agent's own MCP
   * servers (`--mcp`) or keep them on the router (`--no-mcp`). Unset follows
   * the endpoint's `<harness>_tool_surface` option, else native MCP.
   */
  mcp?: boolean;
  mcpOnly?: boolean;
  /**
   * Claude only: `--no-hooks` leaves out the Claude Code hooks the repository's
   * .ditto profile declares (`claude_hooks`) for this launch. Commander sets
   * it true by default.
   */
  hooks?: boolean;
  /** Direct inference through a loopback CLIProxy; URL is persisted, keys are not. */
  cliproxy?: string | boolean;
  remoteTransport?: "cli" | "channels";
}

/**
 * The default T3 provider's launcher from before --fallback-endpoint (no
 * DITTO_T3_ENDPOINT_MODE) passes its DITTO_T3_ENDPOINT as --endpoint. That is
 * the provider's default, so it is demoted to the fallback and a checkout's
 * `.ditto/` default applies without rerunning setup. Old launchers of any
 * other instance (profile providers) were a deliberate choice and stay
 * pinned. The launcher's variables are then dropped, so a `heyditto` run
 * inside the chat keeps its own --endpoint.
 */
export function t3FallbackEndpoint(options: LaunchOptions, env: NodeJS.ProcessEnv = process.env): LaunchOptions {
  const fromLauncher = env.DITTO_T3_ENDPOINT?.trim();
  const legacyDefault = env.DITTO_T3_ENDPOINT_MODE === undefined
    && path.basename(path.dirname(path.resolve(env.CLAUDE_CONFIG_DIR ?? "/"))) === DEFAULT_T3_INSTANCE;
  for (const k of T3_LAUNCHER_ENV) delete env[k];
  if (!fromLauncher || !legacyDefault || options.fallbackEndpoint !== undefined || options.endpoint?.trim() !== fromLauncher) return options;
  return { ...options, endpoint: undefined, fallbackEndpoint: fromLauncher };
}

const T3_LAUNCHER_ENV = ["DITTO_T3_ENDPOINT", "DITTO_T3_ENDPOINT_MODE", "DITTO_T3_INFERENCE", "DITTO_T3_HEYDITTO_BIN", "DITTO_T3_CLAUDE_BIN"];

/** Explicit flags (or resumed choices) win over repo/cloud launch defaults. */
export function resolveClaudeLaunchDefaults(options: LaunchOptions, defaults: Record<string, unknown> = {}): LaunchOptions {
  const mcpOnly = options.cliproxy ? false : options.mcpOnly ?? (defaults.claude_inference === "native");
  const channelsUsable = !options.headless && remoteMode(options) === "tui";
  const remoteTransport = options.remoteTransport ?? (mcpOnly && channelsUsable && defaults.claude_remote_transport === "channels" ? "channels" : "cli");
  return { ...options, mcpOnly, remoteTransport };
}

const DRY_RUN_KEY = "ditto_inf_<minted-at-launch>";

/** Harnesses that can attach an endpoint's tools as their own MCP servers. */
export const MCP_HARNESSES: readonly Harness[] = ["claude", "codex", "grok", "cursor"];

/**
 * Harnesses whose own service runs inference: Ditto supplies only the
 * endpoint's tools as MCP servers, so a launch without them is pointless.
 */
const MCP_ONLY_HARNESSES: readonly Harness[] = ["cursor"];

/**
 * `--mcp` / `--no-mcp`, else the endpoint's `<harness>_tool_surface`, else
 * native MCP: the agent gets an endpoint's tools as its own servers unless the
 * endpoint keeps them on the router (`claude_tool_surface = "router"`).
 */
export function wantsMcp(options: Pick<LaunchOptions, "mcp">, endpoint: Pick<InferenceEndpoint, "providerOptions">, harness: Harness = "claude"): boolean {
  if (!MCP_HARNESSES.includes(harness)) return false;
  if (options.mcp !== undefined) return options.mcp;
  return endpoint.providerOptions?.[`${harness}_tool_surface`] !== "router";
}

/**
 * Ditto's hooks for this launch, from the repository profile that names this
 * endpoint. Without --endpoint that is the profile that picked it. With one
 * (or a resumed session's), the repository's profile still applies when it
 * names the same endpoint; an unreadable .ditto then costs only the hooks,
 * since such a launch never needed the file before.
 */
async function repoHooks(
  endpoint: InferenceEndpoint,
  profile: Awaited<ReturnType<typeof repoDefaultProfile>>,
  cwd: string,
  requested: boolean,
  enabled: boolean,
): Promise<{ attachment?: ClaudeHookAttachment; banner?: string } | undefined> {
  if (requested) {
    try {
      profile = await repoDefaultProfile(cwd);
    } catch (err) {
      log(`${c("yellow", "repository hooks skipped")}: ${(err as Error).message}`);
      return undefined;
    }
    if (!profile || profile.slug !== endpoint.slug) return undefined;
    // The same slug can exist in another organization: only the profile's own
    // endpoint (its exact owner) gets the repository's hooks.
    let own = false;
    try {
      own = (await findProfileEndpoint(profile, [endpoint])) !== undefined;
    } catch (err) {
      log(`${c("yellow", "repository hooks skipped")}: ${err instanceof Error ? err.message : String(err)}`);
      own = false;
    }
    if (!own) return undefined;
  }
  if (!profile?.hooks) return undefined;
  const source = profile.file ?? ".ditto";
  const attachment = claudeHookAttachment(profile.hooks, { root: profile.repoDir, source });
  if (!attachment) return undefined;
  if (!enabled) return { banner: c("dim", "off (--no-hooks)") };
  return { attachment, banner: `${attachment.summary.join(", ")} ${c("dim", `(${source})`)}` };
}

/** Someone chose native MCP for this launch, rather than getting it by default. */
function mcpChosen(options: Pick<LaunchOptions, "mcp">, endpoint: Pick<InferenceEndpoint, "providerOptions">, harness: Harness): boolean {
  return options.mcp === true || endpoint.providerOptions?.[`${harness}_tool_surface`] === "mcp";
}

/**
 * The banner's tools field. A fallback to the router is yellow only when MCP
 * was asked for; by default it is as quiet as the log line that explains it.
 */
function mcpBanner(mcp: ClaudeMcpAttachment | undefined, opts: { dryRun?: boolean; noTools?: boolean; chosen?: boolean; agent: string }): string {
  if (opts.noTools) return c("dim", "none (the endpoint has no tools)");
  if (!mcp) return opts.dryRun ? "mcp (catalog read at launch)" : c(opts.chosen ? "yellow" : "dim", "router (MCP not attached)");
  return `mcp ${c("dim", `(${mcp.servers} servers, ${mcp.tools} tools; ${mcpApprovalNote(mcp, opts.agent)})`)}`;
}

const AGENT_LABELS: Record<Harness, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok", cursor: "Cursor CLI" };

function log(line: string, options?: NoteOptions): void {
  writeNote(`${c("dim", "ditto:")} ${line}\n`, options);
}

/**
 * Prints the command that reopens this session on a line of its own, with no
 * prefix or trailing text, so a triple-click (or a mouse drag) grabs exactly
 * the command.
 */
function logResumeHint(harness: Harness, sessionId: string): void {
  writeNote(`${c("dim", "ditto:")} resume this session with:\n\n  ${c(["bold", "green"], `heyditto ${harness} --resume ${sessionId}`)}\n\n`);
}

function planFor(harness: Harness, input: PlanInput, grokHome?: string, cursorPlugin?: string): HarnessPlan {
  if (harness === "claude") return planClaude(input);
  if (harness === "grok") return planGrok(input, grokHome ?? "");
  if (harness === "cursor") return planCursor(input, cursorPlugin);
  return planCodex(input);
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
  readOnly = false,
): Promise<InferenceEndpoint> {
  if (endpoints.length === 0) {
    if (!readOnly && interactive() && (await confirmYes("You have no inference endpoints yet. Create your first one now?"))) {
      const created = await createEndpoint({});
      log(`created endpoint ${created.slug} (model ${created.model})`);
      await writeDefaultEndpoint(created.slug);
      return created;
    }
    throw new Error(
      `you have no inference endpoints yet. Create one with \`heyditto endpoints create\`, or at ${endpointURL()}.`,
    );
  }
  if (wanted?.trim()) {
    const match = findEndpoint(endpoints, wanted);
    if (match) return match;
    throw new Error(`no endpoint named "${wanted.trim()}". Available: ${endpoints.map((e) => e.slug).join(", ")}`);
  }
  const stored = await readDefaultEndpoint();
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
  if (!readOnly && (await confirmYes(`Use ${picked.slug} by default next time?`))) {
    await writeDefaultEndpoint(picked.slug);
    log(`default endpoint set to ${picked.slug} (change it with \`heyditto endpoints use <slug>\`)`);
  }
  return picked;
}

/**
 * The endpoint `heyditto claude` would choose without --endpoint, for a caller
 * that saves the choice (T3 setup): log in if needed, then the saved default,
 * the only endpoint, or the picker, offering to create a first endpoint.
 * `readOnly` (a dry run) never creates an endpoint or saves a default.
 */
export async function chooseEndpoint(harness: Harness, readOnly = false): Promise<InferenceEndpoint> {
  const named = (await explicitProfileEndpoint())?.endpoint;
  const { selected, catalog } = await signInAndListEndpoints(harness, named, readOnly);
  return resolveEndpoint(named, catalog.endpoints, selected, readOnly);
}

/** Signs in when needed and lists endpoints; a dry run never opens the browser. */
async function signInAndListEndpoints(
  harness: Harness,
  requestedEndpoint: string | undefined,
  dryRun: boolean,
): Promise<{ selected: SelectedEndpoint | undefined; catalog: Awaited<ReturnType<typeof listEndpoints>> }> {
  let selected = dryRun ? undefined : await ensureLoggedIn(harness, requestedEndpoint);
  try {
    return { selected, catalog: await listEndpoints() };
  } catch (err) {
    // A saved key that lapsed (device-flow keys expire) sends the user back
    // through the browser instead of a dead 401.
    if (!(err instanceof ApiError) || err.status !== 401 || dryRun || !interactive()) throw err;
    const { source } = await resolveApiKey();
    if (source !== "config") throw err;
    log("your saved Ditto login is no longer valid — opening your browser to sign in again.");
    selected = await browserLogin(harness, requestedEndpoint);
    return { selected, catalog: await listEndpoints() };
  }
}

/**
 * First run: no key saved anywhere. On a terminal, run the browser device
 * flow with the harness as the intent so the web page can offer the endpoint
 * picker; the browser hands back the key and (optionally) the chosen endpoint.
 */
async function ensureLoggedIn(harness: Harness, endpoint: string | undefined): Promise<SelectedEndpoint | undefined> {
  const { key } = await resolveApiKey();
  if (key) return undefined;
  if (!interactive()) {
    // Non-interactive callers (CI, agents) must log in explicitly.
    await listEndpoints(); // throws the shared "no Ditto API key configured" error
    return undefined;
  }
  log(`no Ditto login yet — opening your browser to sign in and pick an endpoint for ${AGENT_LABELS[harness]}.`);
  return browserLogin(harness, endpoint);
}

/**
 * Runs the browser device flow for a harness and saves the result. An endpoint
 * the command already names is shown locked in the browser instead of a picker.
 */
async function browserLogin(harness: Harness, endpoint: string | undefined): Promise<SelectedEndpoint | undefined> {
  const result = await deviceLogin({
    // The sign-in page knows the agents it routes; an MCP-only one just signs in.
    intent: harness === "cursor" ? "login" : harness,
    endpoint,
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
  // An explicit empty value (often an unset shell variable) still requests
  // CLIProxy. Reject it before any launch/setup work rather than treating it
  // as a false boolean and silently using Router inference.
  if (typeof options.cliproxy === "string" && !options.cliproxy.trim()) {
    throw new Error("--cliproxy requires a loopback URL; pass --cliproxy alone to auto-detect");
  }
  let passthrough = stripSeparator(rawArgs);
  if (harness === "claude") {
    const lifted = liftResumeFlags(passthrough);
    passthrough = lifted.args;
    if (lifted.resume !== undefined) {
      if (options.resume !== undefined) throw new Error("--resume given twice (once after --)");
      options = { ...options, resume: lifted.resume };
    }
    if (lifted.continue) options = { ...options, continue: true };
  }
  const budget = parseBudget(options.budget);
  const expiresIn = parseExpiry(options.expires);
  if (options.plan && harness === "codex") throw new Error("--plan is not supported for codex");
  if (MCP_ONLY_HARNESSES.includes(harness)) {
    if (options.mcp === false) throw new Error(`${AGENT_LABELS[harness]} gets Ditto only as MCP tools; --no-mcp would attach nothing`);
    if (options.headless) throw new Error(`--headless is not supported for ${AGENT_LABELS[harness]} yet`);
    if (options.yellow) throw new Error(`--yellow is not supported for ${AGENT_LABELS[harness]}; use --yolo or its own prompts`);
  }
  if ([options.yolo, options.yellow, options.plan].filter(Boolean).length > 1) {
    throw new Error("choose only one of --yolo, --yellow, --plan");
  }
  if (options.resume !== undefined && options.continue) throw new Error("use either --resume or --continue");
  if (options.resume !== undefined && options.session) throw new Error("--session cannot be combined with --resume");

  const probe = planFor(harness, { baseUrl: "", apiKey: "", sessionId: "", passthrough: [], env: {} });
  if (!options.dryRun && !binaryAvailable(probe.command)) {
    throw new Error(`"${probe.command}" is not on your PATH; ${probe.installHint}`);
  }

  // Resume: reuse the local record's Ditto session id so the traces stay in
  // the same thread; a fresh key is minted every launch.
  let record: SessionRecord | undefined;
  // Claude: the conversation being resumed, read from Claude's own store.
  let transcript: ClaudeTranscript | undefined;
  let resumeLast = Boolean(options.continue);
  if (harness === "claude" && options.continue) {
    // Resolve "most recent here" ourselves so the Ditto thread follows it.
    const [newest] = await listTranscriptsIn(process.cwd());
    if (newest) {
      transcript = newest;
      record = await sessionForHarnessId("claude", newest.id);
      resumeLast = false;
    }
  } else if (harness === "claude" && options.resume !== undefined) {
    const target = await resolveClaudeResume(typeof options.resume === "string" ? options.resume : true, {
      cwd: process.cwd(),
      interactive: interactive(),
      log,
    });
    ({ record, transcript } = target);
    if (record && record.harness !== harness) throw new Error(`session ${record.id} was a ${record.harness} session`);
    if (!transcript && record) {
      if (record.harnessSessionId) {
        log(`session ${record.id} never recorded a conversation (nothing was sent), so it starts fresh under the same id`);
      } else resumeLast = true;
    }
  } else if (options.resume !== undefined) {
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

  options = {
    ...options,
    cliproxy: options.cliproxy ?? (options.mcpOnly !== undefined ? false : record?.cliproxy),
    mcpOnly: options.cliproxy ? options.mcpOnly : options.mcpOnly ?? record?.mcpOnly,
    remoteTransport: options.remoteTransport ?? (remoteMode(options) === "tui" ? record?.remoteTransport : undefined),
  };
  if (typeof options.cliproxy === "string" && !options.cliproxy.trim()) {
    throw new Error("The saved CLIProxy URL is empty; pass --cliproxy to auto-detect or --no-cliproxy to change inference mode");
  }
  if (options.cliproxy && options.mcpOnly) throw new Error("choose either --cliproxy or --mcp-only");
  if (options.cliproxy && harness === "grok") throw new Error("--cliproxy is supported for claude and codex");
  if (options.cliproxy && options.budget !== undefined) throw new Error("--budget cannot cap CLIProxy subscription inference; configure limits in your local proxy instead");
  // Check the local proxy before sign-in or minting any cloud key. A failure
  // must never silently switch inference back to the paid Router.
  const proxy = options.cliproxy ? await resolveCliProxy(options.cliproxy) : undefined;
  if (proxy) options = { ...options, cliproxy: proxy.baseUrl, mcpOnly: false };

  // An explicitly named profile (--profile, DITTO_PROFILE) counts as naming
  // its endpoint, so it also beats a repository's .ditto default. Only the
  // flag moves a resumed session off the endpoint it was recorded on; a
  // shell-wide DITTO_PROFILE does not.
  options = t3FallbackEndpoint(options);
  const named = options.endpoint?.trim() ? undefined : await explicitProfileEndpoint();
  const fromFlag = named?.source === "flag" ? named.endpoint : undefined;
  const requestedEndpoint = options.endpoint ?? (fromFlag ?? record?.endpointSlug ?? named?.endpoint);
  if (named) log(`using profile ${named.name} → ${named.endpoint}`);
  const fallbackEndpoint = options.fallbackEndpoint?.trim() || undefined;
  const { selected, catalog } = await signInAndListEndpoints(harness, requestedEndpoint ?? fallbackEndpoint, Boolean(options.dryRun));

  // Sent as X-Ditto-Harness-Version so the router serves this release's own
  // prompts. Started only now that sign-in has succeeded (a failed login
  // never runs the harness) and awaited where the plan is built, so the
  // probe overlaps the key and MCP setup below instead of delaying the
  // launch. It never rejects: unreadable means the header is left out,
  // never guessed. grok has no version-specific prompts.
  const harnessVersionProbe = harness === "grok" || MCP_ONLY_HARNESSES.includes(harness) ? Promise.resolve(undefined) : readHarnessVersion(harness);

  let cwd = process.cwd();
  let worktreePath: string | undefined;
  if (options.cwd) {
    // An explicit directory wins over the saved session's; rebind the record
    // so later plain `--resume` runs follow the session to its new home.
    cwd = path.resolve(options.cwd);
    if (!(await isDirectory(cwd))) throw new Error(`cwd ${cwd} does not exist`);
    if (record) {
      record.cwd = cwd;
      delete record.worktree;
    }
  } else if (transcript && (await transcriptCwd(transcript))) {
    // `claude --resume <id>` only finds a session from the directory it ran in.
    cwd = (await transcriptCwd(transcript)) as string;
    if (record?.worktree && canonicalCwd(record.worktree) === canonicalCwd(cwd)) worktreePath = record.worktree;
    if (canonicalCwd(cwd) !== canonicalCwd(process.cwd())) log(`resuming in ${c("bold", cwd)}, where this session ran`);
  } else if (record) ({ cwd, worktree: worktreePath } = await resolveResumeCwd(record));
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

  // With no --endpoint (and no resumed session's endpoint), a repository that
  // declares `repository.default_endpoint` in .ditto/config.toml picks the
  // profile; the saved personal default only applies outside such a repository.
  // It is read from the directory the harness will run in, which a transcript
  // resume or --cwd may have moved away from process.cwd().
  let endpoint: InferenceEndpoint | undefined;
  let repoLaunchDefaults: Record<string, unknown> | undefined;
  let repoProfile: Awaited<ReturnType<typeof repoDefaultProfile>>;
  if (!requestedEndpoint?.trim()) {
    const profile = await repoDefaultProfile(cwd);
    repoProfile = profile;
    if (profile) {
      endpoint = await findProfileEndpoint(profile, catalog.endpoints);
      repoLaunchDefaults = profile.launchDefaults;
      if (!endpoint) {
        throw new Error(
          `this repository's .ditto profile "${profile.name}" has no endpoint in ${profile.owner.kind === "org" ? `@${profile.owner.org}` : "your account"} yet.\n` +
            `Create it with \`heyditto repo apply --profile ${profile.name}\` (in ${profile.repoDir}), or pass --endpoint.`,
        );
      }
      log(`using ${profile.owner.kind === "org" ? `@${profile.owner.org}/` : ""}${endpoint.slug} from ${path.join(profile.repoDir, ".ditto")}`);
    }
  }
  if (!endpoint && !requestedEndpoint?.trim() && fallbackEndpoint) log(`using ${fallbackEndpoint} (no repository .ditto default here)`);
  endpoint ??= await resolveEndpoint(requestedEndpoint?.trim() ? requestedEndpoint : fallbackEndpoint, catalog.endpoints, selected);
  const hooks = harness === "claude" ? await repoHooks(endpoint, repoProfile, cwd, Boolean(requestedEndpoint?.trim()), options.hooks !== false) : undefined;
  // The repository's launch defaults (its <agent>_tool_surface among them)
  // beat the endpoint's saved options for this launch.
  endpoint = { ...endpoint, providerOptions: { ...endpoint.providerOptions, ...repoLaunchDefaults } };
  if (harness === "claude") options = resolveClaudeLaunchDefaults(options, endpoint.providerOptions);
  const mcpOnlyHarness = MCP_ONLY_HARNESSES.includes(harness);
  if (!options.mcpOnly && !proxy && !mcpOnlyHarness) await assertEndpointActive(endpoint);
  if (options.mcpOnly && (harness !== "claude" || options.mcp === false)) throw new Error("--mcp-only requires Claude Code with MCP tools enabled");
  if (options.remoteTransport === "channels" && (!options.mcpOnly || options.headless || remoteMode(options) === "off" || options.prompt !== undefined)) throw new Error("MCP Channels requires an interactive `heyditto claude --mcp-only` session with remote control enabled");

  // A Claude session first seen here keeps its own id as the Ditto session id,
  // so `--resume <that id>` finds this record next time.
  const sessionId = record?.id ?? options.session?.trim() ?? transcript?.id ?? randomUUID();
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(sessionId)) {
    throw new Error("--session must match ^[A-Za-z0-9._:@-]{1,128}$");
  }
  // Claude: the resumed conversation, or the id a fresh one is created under.
  const harnessSessionId = harness === "claude"
    ? (transcript?.id ?? (resumeLast ? undefined : sessionId))
    : record?.harnessSessionId;
  const resumeId = harness === "claude" ? transcript?.id : record?.harnessSessionId;
  // No model flag means the harness's own model choice passes through and the
  // endpoint routes it (Codex's default gpt-* id normalizes like Claude's
  // claude-* ids). Earlier releases pinned Codex sessions to the endpoint
  // slug; that pin is dropped on resume so they pass through too.
  const recordedModel = record?.model === endpoint.slug ? undefined : record?.model;
  const model = proxy ? cliProxyModel(proxy, harness as "claude" | "codex", options.model ?? recordedModel) : options.model ?? recordedModel;
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

  // Native MCP mode reads the endpoint's tool catalog with the key just
  // minted, so what Claude Code attaches is exactly what this key may reach.
  // A catalog that cannot be read falls back to the router's own tools rather
  // than launching an agent with none. Native MCP is the default, so the
  // fallback is only flagged when someone asked for MCP; an endpoint the
  // surface refuses (an app's) would otherwise warn on every launch.
  // An MCP-only harness has nothing else from Ditto, whatever the endpoint's
  // <harness>_tool_surface says (--no-mcp was refused above).
  const wantMcp = options.mcpOnly || mcpOnlyHarness || wantsMcp(options, endpoint, harness);
  const chosen = mcpChosen(options, endpoint, harness);
  let mcp: ClaudeMcpAttachment | undefined;
  let noTools = false;
  if (wantMcp && key?.key) {
    try {
      const mcpCatalog = await fetchMcpCatalog(catalog.baseUrl, key.key, sessionId);
      const attachment = claudeMcpAttachment(mcpCatalog, sessionId, { yolo: options.yolo, toolDeny: harness === "claude" ? claudeDittoDenyRules(cwd, process.env) : undefined });
      if (attachment.tools > 0) mcp = attachment;
      else noTools = true;
      for (const line of mcpUnavailableLines(mcpCatalog)) log(c("yellow", line));
      for (const name of attachment.skipped) log(c("yellow", `MCP server ${JSON.stringify(name)} left out: its name cannot be used in an agent's config`));
    } catch (err) {
      if (options.mcpOnly || proxy || mcpOnlyHarness) {
        if (!options.keepKey) {
          try { await revokeKey(endpoint.id, key.id); }
          catch { log(`could not revoke session key …${key.keyHint}; it expires in ${expiresIn}`); }
        }
        throw new Error(`${proxy ? "CLIProxy MCP" : mcpOnlyHarness ? `${AGENT_LABELS[harness]} MCP` : "MCP-only"} setup failed; no inference Router fallback: ${(err as Error).message}`);
      }
      const note = c(chosen ? "yellow" : "dim", "native MCP unavailable");
      log(`${note} (${(err as Error).message}); the router keeps this endpoint's tools`);
    }
  }

  // grok routes through a launch-scoped GROK_HOME (a real directory on disk,
  // not argv overrides like codex -c), so it is prepared before the plan, after the
  // MCP catalog it attaches, and reused by every later launch of the session.
  const grokHome = harness === "grok" && !options.dryRun
    ? await ensureGrokHome(configDir(), sessionId, {
        baseUrl: catalog.baseUrl,
        apiKey: key?.key ?? DRY_RUN_KEY,
        sessionId,
        model,
        resumeId,
        resumeLast,
        prompt: options.prompt,
        yolo: options.yolo,
        yellow: options.yellow,
        plan: options.plan,
        passthrough,
        mcp,
        unattended: options.prompt !== undefined || options.headless,
        env: process.env,
      })
    : undefined;

  // Read once per launch and reused by every turn.
  const harnessVersion = await harnessVersionProbe;

  if (mcpOnlyHarness && !mcp && key) {
    if (!options.keepKey) await revokeKey(endpoint.id, key.id).catch(() => log(`could not revoke session key …${key.keyHint}; it expires in ${expiresIn}`));
    throw new Error(`${endpoint.slug} has no tools to attach, and ${AGENT_LABELS[harness]} gets nothing else from Ditto`);
  }
  // Cursor CLI loads the attachment as a per-launch plugin (cursor.ts).
  const cursorPlugin = harness === "cursor" && mcp && !options.dryRun
    ? writeCursorPlugin(mcp, { unattended: options.prompt !== undefined })
    : undefined;

  const plan = planFor(harness, {
    baseUrl: proxy?.baseUrl ?? catalog.baseUrl,
    apiKey: proxy?.apiKey ?? key?.key ?? DRY_RUN_KEY,
    mcpApiKey: key?.key ?? DRY_RUN_KEY,
    localInference: Boolean(proxy),
    sessionId,
    harnessVersion,
    model,
    resumeId,
    resumeLast,
    prompt: options.prompt,
    yolo: options.yolo,
    yellow: options.yellow,
    plan: options.plan,
    passthrough,
    toolDeny: harness === "claude" ? claudeDittoDenyRules(cwd, process.env) : undefined,
    mcp,
    hooks: hooks?.attachment,
    mcpOnly: options.mcpOnly,
    remoteTransport: options.remoteTransport,
    cwd,
    env: process.env,
  }, grokHome, cursorPlugin);

  const field = (name: string, value: string): string => `${c("dim", `${name}=`)}${value}`;
  const banner = [
    field("endpoint", c(["bold", "cyan"], endpoint.slug)),
    field("inference", proxy ? `CLIProxy (${proxy.baseUrl})` : options.mcpOnly || mcpOnlyHarness ? `native ${AGENT_LABELS[harness]} account (MCP only)` : "Ditto Router"),
    field("model", model ?? c("dim", options.mcpOnly || mcpOnlyHarness ? `(native ${AGENT_LABELS[harness]} default)` : "(harness default → endpoint routes)")),
    field("key", key ? `…${key.keyHint || maskKey(key.key ?? "")}` : "(dry run)"),
    field("expires", `${expiresIn}${options.keepKey ? "" : c("dim", " (revoked on exit)")}`),
    budget !== undefined ? field("budget", `${budget.toLocaleString()} tokens`) : undefined,
    field("session", c("bold", sessionId)),
    wantMcp ? field("tools", mcpBanner(mcp, { dryRun: options.dryRun, noTools, chosen, agent: AGENT_LABELS[harness] })) : undefined,
    hooks?.banner ? field("hooks", hooks.banner) : undefined,
  ]
    .filter(Boolean)
    .join("  ");
  log(banner);
  if (proxy) log("inference stays on CLIProxy; Ditto provides MCP tools/remote control, without Router inference optimizations or inference traces");
  else if (mcpOnlyHarness) log(`inference stays on your ${AGENT_LABELS[harness]} account; Ditto provides the endpoint's tools, whose calls are traced at ${c(["underline", "cyan"], endpointURL(endpoint.id))}`);
  else log(`traces: ${c(["underline", "cyan"], endpointURL(endpoint.id))}`);

  if (options.dryRun) {
    const env = Object.fromEntries(
      Object.entries(plan.envSet).map(([k, v]) => [k, v === DRY_RUN_KEY || v === proxy?.apiKey ? "<key>" : v]),
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
          // A dry run reads no catalog, so the plan above is the router's; say
          // which surface a real launch would ask for, separately.
          toolSurface: mcp ? "mcp" : proxy ? "none" : "router",
          toolSurfaceRequested: wantMcp ? "mcp" : proxy ? "none" : "router",
          inference: proxy ? "cliproxy" : options.mcpOnly || mcpOnlyHarness ? "native" : "router",
          remoteTransport: options.remoteTransport ?? "cli",
          hooks: hooks?.attachment?.summary ?? [],
          key: { name: keyName, expiresIn, spendLimitTokens: budget ?? null },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!key) throw new Error("internal: key was not minted");

  const explicitLaunchTitle = options.name?.trim() || record?.explicitLaunchTitle;
  const nextRecord: SessionRecord = {
    id: sessionId,
    harness,
    endpointId: endpoint.id,
    endpointSlug: endpoint.slug,
    keyId: key.id,
    keyHint: key.keyHint,
    harnessSessionId,
    cwd: record?.cwd ?? (transcript ? cwd : process.cwd()),
    worktree: worktreePath,
    model,
    createdAt: record?.createdAt ?? now,
    lastLaunchedAt: now,
    launches: (record?.launches ?? 0) + 1,
    mcpOnly: options.mcpOnly,
    cliproxy: proxy?.baseUrl,
    remoteTransport: options.remoteTransport,
    ...(explicitLaunchTitle ? { explicitLaunchTitle } : {}),
  };
  await writeSession(nextRecord);

  // Remote Control needs the harness's turn-boundary hooks, which only the
  // agents with a hook bridge (remote/hooks.ts) report.
  const remote: RemoteMode = mcpOnlyHarness ? "off" : remoteMode(options);
  const launchRegistration = {
    sessionId, endpointId: endpoint.id, harness: harness === "claude" ? "claude-code" : harness,
    inference: proxy || options.mcpOnly || mcpOnlyHarness ? "native" : "router", transport: options.remoteTransport ?? "cli",
    title: explicitLaunchTitle || `${path.basename(cwd)} · ${sessionId.slice(0, 8)}`,
    ...(harness === "claude" && harnessSessionId && isUuid(harnessSessionId) ? { nativeSessionId: harnessSessionId } : {}),
  };
  let exitCode: number | null = null;
  let titleWatcher: { stop(): void } | undefined;
  try {
    const registration = remote !== "off" ? await apiFetch<SessionRegistration & { nativeTitleSync?: boolean }>("/api/v5/sessions/register", { method: "POST", body: launchRegistration }).catch((err) => {
      if (options.mcpOnly) throw err;
      log("session link unavailable; the CLI bridge will still announce this launch");
      return undefined;
    }) : undefined;
    if (registration) {
      const link = remoteSessionURL(registration);
      log(link ? `session: ${link}` : UNLINKABLE_SESSION_NOTICE);
    }
    if (harness === "claude" && harnessSessionId && !explicitLaunchTitle && registration?.nativeTitleSync === true && registration.threadId) {
      const threadId = registration.threadId;
      titleWatcher = watchClaudeSessionTitle({ nativeSessionId: harnessSessionId, cwd, report: async (title, signal) => {
        const result = await apiFetch<{ titleUpdated?: boolean }>("/api/v5/sessions/register", { method: "POST", signal, body: {
          ...launchRegistration, threadId, ...title,
        } });
        if (typeof result.titleUpdated !== "boolean") throw new Error("Backend did not acknowledge native title synchronization");
      } });
    }
    if (options.remoteTransport === "channels") {
      const { withChannelServer } = await import("../remote/channels-plan.js");
      const channelPlan = withChannelServer(plan, sessionId, cwd);
      exitCode = await runInTerminal(channelPlan, cwd);
    } else
    if (remote === "headless") {
      exitCode = await runHeadless(harness, {
        cwd,
        sessionId,
        harnessSessionId,
        baseUrl: proxy?.baseUrl ?? catalog.baseUrl,
        apiKey: proxy?.apiKey ?? key.key ?? "",
        mcpApiKey: key.key ?? "",
        localInference: Boolean(proxy),
        harnessVersion,
        model,
        options,
        record: nextRecord,
        grokHome,
        mcp,
        hooks: hooks?.attachment,
        claudeStarted: harness === "claude" && !resumeLast ? Boolean(transcript) : undefined,
      });
    } else if (remote === "tui") {
      exitCode = await runInTerminalWithRemote(harness, plan, { cwd, sessionId, harnessSessionId, record: nextRecord });
    } else {
      exitCode = await runInTerminal(plan, cwd);
    }
  } finally {
    titleWatcher?.stop();
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
    if (options.prompt === undefined && exitCode !== null) {
      // Claude writes no transcript until the first prompt; promising a resume
      // then only earns "No conversation found with session ID".
      // (Only when this launch pinned the id; --from-pr lets Claude choose one.)
      const empty = harness === "claude" && harnessSessionId !== undefined && plan.args.includes(harnessSessionId) &&
        !(await findTranscriptById(harnessSessionId, cwd));
      if (empty) log(`nothing was sent, so there is no conversation to resume ${c("dim", "(heyditto claude --resume lists the ones there are)")}`);
      else logResumeHint(harness, sessionId);
    }
    await writeSession({ ...nextRecord, endedAt: new Date().toISOString(), exitCode });
  }
  process.exitCode = exitCode ?? 1;
}

// ---------------------------------------------------------------------------
// Remote Control
// ---------------------------------------------------------------------------

type RemoteMode = "off" | "tui" | "headless";

/**
 * Every interactive launch is remote-controllable unless the user opts out.
 * One-shot `-p` runs are scripts, not sessions to type into, so they never
 * connect (unless `--headless` asked for a long-lived headless session).
 */
function remoteMode(options: LaunchOptions): RemoteMode {
  if (options.headless) return "headless";
  if (options.remoteControl === false) return "off";
  if (options.prompt !== undefined) return "off";
  if (process.env.HEYDITTO_REMOTE_CONTROL === "0") return "off";
  return "tui";
}

/** The hook flags that make a harness report its turn boundaries to `hooks`. */
function hookArgs(harness: Harness, hooks: HookServer): string[] {
  if (harness === "claude") return ["--settings", claudeHookSettings(hooks.socketPath)];
  // grok takes its hooks from $GROK_HOME/hooks/*.json, which ensureGrokHome
  // writes after the hook server is up — there are no argv overrides.
  if (harness === "grok") return [];
  return ["-c", codexNotifyOverride(hooks.socketPath)];
}

/** Plain launch: the harness owns the terminal directly. */
async function runInTerminal(plan: HarnessPlan, cwd: string): Promise<number | null> {
  const child = spawn(plan.command, plan.args, {
    stdio: "inherit",
    env: childEnv(plan, process.env),
    cwd,
  });
  const restore = forwardSignals(child);
  try {
    return await waitForExit(child, plan.command, cwd);
  } finally {
    restore();
  }
}

interface RemoteRunContext {
  cwd: string;
  sessionId: string;
  harnessSessionId?: string;
  record: SessionRecord;
}

/**
 * Remote-controllable TUI: the harness runs in a pseudo-terminal this process
 * owns and mirrors to the real one, so prompts from the app can be typed into
 * its input box. Anything that stops that (no PTY module, not a terminal) falls
 * back to the plain launch with a note, never a failure.
 */
async function runInTerminalWithRemote(harness: Harness, plan: HarnessPlan, ctx: RemoteRunContext): Promise<number | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log(`remote control off: not running in a terminal (use --headless to control a session without one)`);
    return runInTerminal(plan, ctx.cwd);
  }
  const loaded = loadPty();
  if (!loaded.pty) {
    log(`${c("yellow", "remote control off:")} ${loaded.reason}`);
    return runInTerminal(plan, ctx.cwd);
  }
  const { key: apiKey } = await resolveApiKey();
  const baseUrl = apiBaseURL();
  if (!apiKey) {
    log("remote control off: no Ditto login");
    return runInTerminal(plan, ctx.cwd);
  }

  const hooks = await startHookServer();
  // Only the hooks change: the launch wrote this session's model and MCP servers.
  if (harness === "grok") await ensureGrokHome(configDir(), ctx.sessionId, undefined, { socketPath: hooks.socketPath, scriptPath: hookScriptPath(), nodePath: process.execPath });
  const session = new RemoteSession(
    {
      harness,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      mode: "tui",
      baseUrl,
      apiKey,
      log,
      checkpoint: (root) => checkpointPush(root, harness, ctx.harnessSessionId),
    },
    hooks,
  );
  let pty: PtySession;
  try {
    pty = await spawnInPty(plan.command, withHookArgs(harness, plan.args, hookArgs(harness, hooks)), {
      cwd: ctx.cwd,
      env: childEnv(plan, process.env),
      harness,
    });
  } catch (err) {
    await hooks.close();
    log(`${c("yellow", "remote control off:")} ${err instanceof Error ? err.message : String(err)}`);
    return runInTerminal(plan, ctx.cwd);
  }
  session.attachTui(pty);
  const onTerm = () => pty.kill();
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onTerm);
  // The harness now owns the screen: status notes go to the notes log and are
  // replayed after it exits, instead of painting into its prompt box (issue
  // #61, DITTO-249).
  holdNotesForTui();
  // Announce in the background; the harness is already on screen.
  void session.start().then((ok) => {
    if (ok) log(`${c("green", "remote control on")} — send prompts from the Ditto app to session ${c("bold", ctx.sessionId)}`, { transient: true });
    else log("remote control: backend not reachable yet; retrying in the background");
  });
  try {
    return await pty.exit;
  } finally {
    releaseNotes();
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onTerm);
    await session.stop();
    await hooks.close();
  }
}

interface HeadlessRunContext extends RemoteRunContext {
  baseUrl: string;
  apiKey: string;
  mcpApiKey?: string;
  localInference?: boolean;
  /** Installed harness version read at launch (X-Ditto-Harness-Version). */
  harnessVersion?: string;
  model?: string;
  options: LaunchOptions;
  /** grok: the launch GROK_HOME reused by every headless turn. */
  grokHome?: string;
  /** claude, codex: the endpoint's tools as MCP servers, attached to every turn. */
  mcp?: ClaudeMcpAttachment;
  /** claude: Ditto's hooks from the repository profile, attached to every turn. */
  hooks?: ClaudeHookAttachment;
  /** claude: the session already has a conversation, so the first turn resumes it. */
  claudeStarted?: boolean;
}

/**
 * Headless Remote Control: no terminal UI, one harness invocation per turn
 * delivered from the app, all in the same thread, until Ctrl+C. Close the
 * laptop lid later; keep talking from the phone until then.
 */
async function runHeadless(harness: Harness, ctx: HeadlessRunContext): Promise<number | null> {
  const { key: dittoKey } = await resolveApiKey();
  if (!dittoKey) throw new Error("headless remote control needs a Ditto login (run `heyditto login`)");
  const hooks = await startHookServer();
  // grok's hooks come from its launch GROK_HOME; refresh the socket path —
  // it changes every process, and the home persists across launches.
  if (harness === "grok") await ensureGrokHome(configDir(), ctx.sessionId, undefined, { socketPath: hooks.socketPath, scriptPath: hookScriptPath(), nodePath: process.execPath });
  // Claude's first turn creates the session under our id; later turns resume it.
  let claudeStarted = ctx.claudeStarted ?? ctx.record.launches > 1;
  let codexStarted = ctx.record.launches > 1;
  // grok always pins its session id with -s, so every headless turn lands in
  // the same grok session without resume bookkeeping.
  let grokStarted = ctx.record.launches > 1;
  let running = false;
  const session = new RemoteSession(
    {
      harness,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      mode: "headless",
      baseUrl: apiBaseURL(),
      apiKey: dittoKey,
      log,
      checkpoint: (root) => checkpointPush(root, harness, ctx.harnessSessionId),
    },
    hooks,
  );
  const runTurn = (prompt: string) => {
    running = true;
    const resumeId = harness === "claude" && claudeStarted ? (ctx.harnessSessionId ?? ctx.sessionId) : undefined;
    const resumeLast = harness === "codex" && codexStarted;
    const turn = startHeadlessTurn({
      harness,
      base: {
        baseUrl: ctx.baseUrl,
        apiKey: ctx.apiKey,
        mcpApiKey: ctx.mcpApiKey,
        localInference: ctx.localInference,
        sessionId: ctx.sessionId,
        harnessVersion: ctx.harnessVersion,
        model: ctx.model,
        yolo: ctx.options.yolo,
        yellow: ctx.options.yellow,
        toolDeny: harness === "claude" ? claudeDittoDenyRules(ctx.cwd, process.env) : undefined,
        mcp: ctx.mcp,
        hooks: ctx.hooks,
        mcpOnly: ctx.options.mcpOnly,
        cwd: ctx.cwd,
        env: process.env,
      },
      prompt,
      resumeId,
      resumeLast,
      grokHome: ctx.grokHome,
      grokResume: harness === "grok" && grokStarted,
      cwd: ctx.cwd,
      extraArgs: harness === "codex" ? hookArgs(harness, hooks) : [],
      onProgress: (line) => process.stderr.write(`${c("dim", "  ›")} ${line}\n`),
    });
    void turn.exit.then(() => {
      running = false;
      if (harness === "claude") claudeStarted = true;
      else codexStarted = true;
      grokStarted = true;
    });
    return turn;
  };
  session.attachHeadless(runTurn);
  if (ctx.options.prompt !== undefined) {
    // `-p` together with `--headless`: the given prompt is the first turn,
    // finished before the session is announced so app turns queue behind it.
    log(`running the first turn from -p before going remote`);
    await runTurn(ctx.options.prompt).exit;
  }
  const ok = await session.start();
  log(
    ok
      ? `${c("green", "headless remote control on")} — prompts sent from the Ditto app to session ${c("bold", ctx.sessionId)} run here; Ctrl+C to stop`
      : `${c("yellow", "backend not reachable yet")}; retrying in the background (Ctrl+C to stop)`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => {
      if (running) log("stopping after the current turn (press Ctrl+C again to abort it)");
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await session.stop();
  await hooks.close();
  return 0;
}
