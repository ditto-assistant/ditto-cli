import { Command, Option } from "commander";
import { launchHarness } from "./agents/launch.js";
import { listSessions, removeSession } from "./agents/sessions.js";
import { HARNESSES, type Harness, KEY_EXPIRIES } from "./agents/types.js";
import { type InferenceEndpoint, listEndpoints } from "./api.js";
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

export async function cmdEndpoints(options: EndpointsOptions): Promise<void> {
  if (options.setDefault && options.clearDefault) throw new Error("use either --set-default or --clear-default");
  const catalog = await listEndpoints();
  if (options.clearDefault) {
    await updateStoredAuth({ defaultEndpoint: undefined });
    process.stderr.write("Cleared the default endpoint.\n");
  }
  if (options.setDefault) {
    const wanted = options.setDefault.trim();
    const match = catalog.endpoints.find((e) => e.slug === wanted || e.id === wanted);
    if (!match) {
      throw new Error(`no endpoint named "${wanted}". Available: ${catalog.endpoints.map((e) => e.slug).join(", ") || "(none)"}`);
    }
    await updateStoredAuth({ defaultEndpoint: match.slug });
    process.stderr.write(`Default endpoint set to ${match.slug}.\n`);
  }
  const defaultSlug = (await readStoredAuth())?.defaultEndpoint;
  if (options.output === "json") {
    process.stdout.write(`${JSON.stringify({ ...catalog, defaultEndpoint: defaultSlug ?? null }, null, 2)}\n`);
    return;
  }
  if (catalog.endpoints.length === 0) {
    process.stdout.write("No inference endpoints yet. Create one in the Ditto app: Settings → Developer → Inference endpoints.\n");
    return;
  }
  const rows = catalog.endpoints.map((e) => [
    e.slug === defaultSlug ? "*" : " ",
    e.slug,
    e.model,
    spendColumn(e),
    e.recordTrace ? "traces" : "",
  ]);
  const widths = [1, 0, 0, 0];
  for (const r of rows) for (let i = 1; i < 4; i++) widths[i] = Math.max(widths[i], r[i].length);
  process.stdout.write(`  ${pad("SLUG", widths[1])}  ${pad("MODEL", widths[2])}  ${pad("SPEND (tokens)", widths[3])}\n`);
  for (const r of rows) {
    process.stdout.write(`${r[0]} ${pad(r[1], widths[1])}  ${pad(r[2], widths[2])}  ${pad(r[3], widths[3])}  ${r[4]}\n`);
  }
  process.stdout.write(`\nGateway: ${catalog.baseUrl}${defaultSlug ? `  (* = default)` : ""}\n`);
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
        new Option("--expires <duration>", "server-side safety expiry for the key")
          .choices([...KEY_EXPIRIES])
          .default("1d"),
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
      `  heyditto ${harness}                       pick an endpoint, mint a key, launch
  heyditto ${harness} --endpoint my-endpoint --budget 500000
  heyditto ${harness} --yellow --worktree feature-x
  heyditto ${harness} -p "summarize this repo" --output-format json
  heyditto ${harness} --resume                 reopen the last session in its thread
  heyditto ${harness} -- --verbose             forward flags to ${harness}
  (see also: heyditto ${other})`,
    );
  }
}
