import { Command } from "commander";
import { cmdTeleport } from "../teleport/commands.js";
import { type ForkOptions, forkSession } from "./fork.js";

/**
 * `heyditto fork <session>`: copy a coding session's conversation into a new
 * session (optionally in a new worktree), locally or straight into Ditto Cloud.
 */
export async function cmdFork(ref: string, options: ForkOptions): Promise<void> {
  const result = await forkSession(ref, options);
  const { session } = result;
  const asJson = options.output === "json";
  if (options.cloud) {
    const root = session.worktree ?? session.cwd;
    process.stderr.write(`Forked ${result.from} → ${session.id}; teleporting ${root} to Ditto Cloud…\n`);
    await cmdTeleport(root, {
      cloud: true,
      endpoint: options.endpoint,
      prompt: options.prompt,
      session: session.harnessSessionId,
      harness: session.harness,
      output: options.output,
    });
    return;
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ from: result.from, session, transcript: result.transcript }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Forked ${result.from} → ${session.id} (${session.harness}${session.worktree ? `, worktree ${session.worktree}` : ""}).\n`);
  process.stdout.write(`Open it with: heyditto ${session.harness} --resume ${session.id}\n`);
}

export function registerForkCommand(program: Command, addExamples: (c: Command, ex: string) => Command): void {
  const fork = program
    .command("fork <session>")
    .description("start a new session from a copy of an existing conversation, locally or in Ditto Cloud")
    .summary("fork a coding session")
    .option("-w, --worktree [name]", "put the fork in <repo>/.worktrees/<name> (a fresh branch of the same name)")
    .option("--cloud", "teleport the fork and resume it in a Ditto Code cloud job")
    .option("-e, --endpoint <slug>", "inference endpoint for the cloud session (with --cloud)")
    .option("--prompt <text>", "first instruction for the cloud session (with --cloud)")
    .option("-o, --output <format>", "text (default) or json")
    .option("--json", "print machine-readable output")
    .action(async (ref: string, options: ForkOptions & { json?: boolean }) => {
      await cmdFork(ref, { ...options, output: options.json ? "json" : options.output });
    });
  addExamples(
    fork,
    `  heyditto fork 3f1c…                    copy the conversation into a new local session
  heyditto fork 3f1c… --worktree try-b   same, on a fresh branch in .worktrees/try-b
  heyditto fork 3f1c… --cloud            continue the copy in Ditto Cloud
  heyditto sessions                       find session ids`,
  );
}
