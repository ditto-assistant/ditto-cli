import { type ChildProcess, spawn } from "node:child_process";
import { planClaude } from "../agents/claude.js";
import { planCodex } from "../agents/codex.js";
import { type Harness, type PlanInput, childEnv } from "../agents/types.js";
import { withHookArgs } from "./hooks.js";

/**
 * Headless Remote Control: no terminal UI. Each delivered turn runs one
 * harness invocation (`claude -p --resume …` / `codex exec resume --last …`)
 * with the same endpoint, key and session id as an interactive launch, so the
 * conversation lands in the same Ditto thread and can be picked up again from
 * a TUI later.
 */

export interface HeadlessTurnInput {
  harness: Harness;
  /** Everything but prompt/resume, which this module fills in per turn. */
  base: Omit<PlanInput, "prompt" | "resumeId" | "resumeLast" | "passthrough">;
  prompt: string;
  /** Claude: the session id to resume (after the first turn). Codex: resume the last thread. */
  resumeId?: string;
  resumeLast?: boolean;
  cwd: string;
  /** Extra args (e.g. Codex `-c notify=…`, Claude `--settings …`). */
  extraArgs?: string[];
  onProgress?: (line: string) => void;
}

export interface HeadlessTurn {
  child: ChildProcess;
  exit: Promise<number | null>;
  interrupt(): void;
}

/** One line of progress from Claude's stream-json output, or undefined when the event is not worth showing. */
export function summarizeClaudeEvent(line: string): string | undefined {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const type = ev.type;
  if (type === "assistant") {
    const message = ev.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined;
    for (const part of message?.content ?? []) {
      if (part.type === "tool_use") return `tool ${part.name ?? "?"}`;
      if (part.type === "text" && part.text) return part.text.replace(/\s+/g, " ").slice(0, 100);
    }
    return undefined;
  }
  if (type === "result") {
    const result = typeof ev.result === "string" ? ev.result : "";
    return `done${ev.is_error ? " (error)" : ""}${result ? `: ${result.replace(/\s+/g, " ").slice(0, 100)}` : ""}`;
  }
  return undefined;
}

export function startHeadlessTurn(input: HeadlessTurnInput): HeadlessTurn {
  const planInput: PlanInput = {
    ...input.base,
    prompt: input.prompt,
    resumeId: input.resumeId,
    resumeLast: input.resumeLast,
    passthrough: input.harness === "claude" ? ["--output-format", "stream-json", "--verbose"] : [],
  };
  const plan = input.harness === "claude" ? planClaude(planInput) : planCodex(planInput);
  const args = withHookArgs(input.harness, plan.args, input.extraArgs ?? []);
  const child = spawn(plan.command, args, {
    cwd: input.cwd,
    env: childEnv(plan, input.base.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutBuf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let nl = stdoutBuf.indexOf("\n");
    while (nl !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) {
        const summary = input.harness === "claude" ? summarizeClaudeEvent(line) : line.slice(0, 120);
        if (summary) input.onProgress?.(summary);
      }
      nl = stdoutBuf.indexOf("\n");
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const line = chunk.trim().split("\n").pop();
    if (line) input.onProgress?.(line.slice(0, 160));
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 130 : null)));
  });
  return { child, exit, interrupt: () => child.kill("SIGINT") };
}
