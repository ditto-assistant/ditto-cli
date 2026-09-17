import { randomUUID } from "node:crypto";
import type { Harness } from "../agents/types.js";
import { buildPrompt, downloadAttachments } from "./attachments.js";
import { commandInvocation, discoverCommands, watchCatalog } from "./catalog.js";
import type { HeadlessTurn } from "./headless.js";
import { HostClient, type HostClientOptions } from "./host.js";
import type { HookEvent, HookServer } from "./hooks.js";
import type { PtySession } from "./pty.js";
import type {
  CheckpointRequestFrame,
  CommandEntry,
  HarnessName,
  PromptAnswerFrame,
  PromptRequestFrame,
  SessionMode,
  TurnDeliverFrame,
  TurnFinishedFrame,
} from "./protocol.js";

/**
 * Glue between the host socket and the harness this process runs: turns
 * arrive from the app, get typed into the harness (TUI) or run as one
 * headless invocation, and the turn's lifecycle is reported back. One turn at
 * a time; later turns queue. Answers to a pending harness prompt bypass the
 * queue, since the running turn is what is waiting for them.
 */

export interface RemoteSessionContext {
  harness: Harness;
  sessionId: string;
  cwd: string;
  mode: SessionMode;
  baseUrl: string;
  apiKey: string;
  log: (line: string) => void;
  /** Pushes a teleport checkpoint for the session; resolves with the generation. */
  checkpoint?: (cwd: string) => Promise<number>;
  /** Milliseconds of screen silence after which a TUI turn counts as finished when no hook fired. */
  quietFallbackMs?: number;
  hostOptions?: Partial<HostClientOptions>;
}

export function harnessName(harness: Harness): HarnessName {
  return harness === "claude" ? "claude-code" : harness === "grok" ? "grok" : "codex";
}

interface PendingPrompt extends Omit<PromptRequestFrame, "type"> {
  /** Keystrokes per option id, when they differ from the id itself. */
  keys?: Record<string, string>;
}

const CLAUDE_PERMISSION_OPTIONS = [
  { id: "1", label: "Yes" },
  { id: "2", label: "Yes, and don't ask again this session" },
  { id: "3", label: "No, and tell Claude what to do differently" },
];

export class RemoteSession {
  readonly host: HostClient;
  private readonly ctx: RemoteSessionContext;
  private readonly hooks?: HookServer;
  private pty?: PtySession;
  private runHeadless?: (prompt: string) => HeadlessTurn;
  private readonly queue: TurnDeliverFrame[] = [];
  private current?: { turnId: string; interrupted: boolean; headless?: HeadlessTurn; done: () => void };
  private draining = false;
  private stopped = false;
  private catalog: CommandEntry[] = [];
  private stopWatching?: () => void;
  private pending?: PendingPrompt;

  constructor(ctx: RemoteSessionContext, hooks?: HookServer) {
    this.ctx = ctx;
    this.hooks = hooks;
    this.host = new HostClient({
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      capabilities: {
        harnesses: ["claude-code", "codex", "grok"],
        attachments: true,
        headless: true,
        teleport: Boolean(ctx.checkpoint),
      },
      log: ctx.log,
      handlers: {
        onTurn: (frame) => this.onTurn(frame),
        onInterrupt: (turnId) => this.onInterrupt(turnId),
        onCheckpoint: (request) => void this.onCheckpoint(request),
        onPromptAnswer: (answer) => this.answerPrompt(answer),
      },
      ...ctx.hostOptions,
    });
    hooks?.events.on("hook", (event: HookEvent) => this.onHook(event));
  }

  attachTui(pty: PtySession): void {
    this.pty = pty;
  }

  attachHeadless(run: (prompt: string) => HeadlessTurn): void {
    this.runHeadless = run;
  }

  /** The catalog last announced (tests and diagnostics). */
  get commands(): CommandEntry[] {
    return this.catalog;
  }

  /** Connects (best effort), announces the session and its command catalog. Returns whether the backend answered in time. */
  async start(): Promise<boolean> {
    const ok = await this.host.start();
    this.host.announce({
      sessionId: this.ctx.sessionId,
      harness: harnessName(this.ctx.harness),
      cwd: this.ctx.cwd,
      mode: this.ctx.mode,
      status: "idle",
    });
    await this.refreshCatalog();
    this.stopWatching = watchCatalog(this.ctx.harness, this.ctx.cwd, () => void this.refreshCatalog());
    return ok;
  }

  stop(): void {
    this.stopped = true;
    this.stopWatching?.();
    this.host.close();
  }

  async refreshCatalog(): Promise<void> {
    try {
      this.catalog = await discoverCommands(this.ctx.harness, this.ctx.cwd);
    } catch (err) {
      this.ctx.log(`remote control: could not read the command catalog (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    this.host.commands({
      sessionId: this.ctx.sessionId,
      harness: harnessName(this.ctx.harness),
      commands: this.catalog,
    });
  }

  private finish(turnId: string, fields: Omit<TurnFinishedFrame, "type" | "turnId"> = {}): void {
    this.host.send({ type: "turn.finished", turnId, ...fields });
  }

  private onTurn(frame: TurnDeliverFrame): void {
    this.host.send({ type: "turn.ack", turnId: frame.turnId });
    if (frame.sessionId !== this.ctx.sessionId) {
      this.finish(frame.turnId, { error: "unknown session on this host" });
      return;
    }
    if ((frame.kind ?? "prompt") === "answer") {
      // Not a turn of its own: the running turn is waiting on this.
      this.deliverAnswer(frame);
      return;
    }
    this.queue.push(frame);
    void this.drain();
  }

  private onInterrupt(turnId: string): void {
    const current = this.current;
    if (!current || current.turnId !== turnId) return;
    current.interrupted = true;
    if (current.headless) current.headless.interrupt();
    else this.pty?.interrupt(this.ctx.harness);
  }

  private async onCheckpoint(request: CheckpointRequestFrame): Promise<void> {
    if (!this.ctx.checkpoint) {
      this.host.send({ type: "checkpoint.failed", sessionId: request.sessionId, error: "teleport is not available on this host" });
      return;
    }
    try {
      const generation = await this.ctx.checkpoint(this.ctx.cwd);
      this.host.send({ type: "checkpoint.done", sessionId: request.sessionId, generation });
    } catch (err) {
      this.host.send({ type: "checkpoint.failed", sessionId: request.sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---------------------------------------------------------------------
  // Harness prompts (permission dialogs, questions)
  // ---------------------------------------------------------------------

  private onHook(event: HookEvent): void {
    const payload = event.payload ?? {};
    if (event.source === "claude") {
      switch (event.event) {
        case "UserPromptSubmit":
          // Local typing also moves the session between running and idle, so
          // the app sees the same state whether the prompt came from the
          // phone or the keyboard.
          this.clearPending();
          this.host.status(this.ctx.sessionId, "running");
          return;
        case "Notification":
          if (payload.notification_type === "permission_prompt") {
            this.requestPrompt({
              kind: "permission",
              text: String(payload.message ?? payload.title ?? "Claude Code is asking for permission"),
              options: CLAUDE_PERMISSION_OPTIONS,
              default: "1",
            });
          }
          return;
        case "PreToolUse":
          if (payload.tool_name === "AskUserQuestion") this.requestQuestion(payload.tool_input);
          return;
        case "Stop":
          this.turnEnded();
          return;
        default:
          return;
      }
    }
    // grok hooks arrive through the same relay as Claude's (hook.js with
    // source "grok"): event names snake_case on the wire, and hook_event_name
    // / hookEventName both appear in the payload. grok has no Notification
    // permission event; its ask_user_question surfaces as a PreToolUse hook
    // with the tool's input, answered by typing a digit.
    if (event.source === "grok") {
      const name = String(payload.hook_event_name ?? payload.hookEventName ?? event.event);
      switch (name) {
        case "UserPromptSubmit":
          this.clearPending();
          this.host.status(this.ctx.sessionId, "running");
          return;
        case "PreToolUse":
          if (payload.tool_name === "ask_user_question") this.requestQuestion(payload.tool_input);
          return;
        case "Stop":
          this.turnEnded();
          return;
        default:
          return;
      }
    }
    if (/turn-complete|turn-ended|agent-turn/.test(event.event)) this.turnEnded();
  }
  private turnEnded(): void {
    this.clearPending();
    if (!this.current) this.host.status(this.ctx.sessionId, "idle");
    this.current?.done();
  }

  private requestQuestion(toolInput: unknown): void {
    const input = (toolInput ?? {}) as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label?: string }> }> };
    const q = input.questions?.[0];
    if (!q) return;
    const options = (q.options ?? []).map((o, i) => ({ id: String(i + 1), label: o.label ?? `option ${i + 1}` }));
    this.requestPrompt({
      kind: options.length > 0 ? "choice" : "question",
      text: [q.header, q.question].filter(Boolean).join(": "),
      ...(options.length > 0 ? { options } : {}),
    });
  }

  private requestPrompt(prompt: Omit<PendingPrompt, "promptId" | "sessionId">): void {
    const pending: PendingPrompt = { promptId: randomUUID(), sessionId: this.ctx.sessionId, ...prompt };
    this.pending = pending;
    const { keys: _keys, ...frame } = pending;
    this.host.send({ type: "prompt.request", ...frame });
  }

  private clearPending(): void {
    this.pending = undefined;
  }

  /** `prompt.answer` frame: inject the keystrokes for the pending prompt. */
  private answerPrompt(answer: PromptAnswerFrame): boolean {
    const pending = this.pending;
    if (!pending || pending.promptId !== answer.promptId) return false;
    if (!this.pty) return false;
    const option = pending.options?.find((o) => o.id === answer.value || o.label.toLowerCase() === answer.value.trim().toLowerCase());
    const keys = option ? (pending.keys?.[option.id] ?? option.id) : answer.value;
    this.pty.write(keys);
    // A digit hotkey confirms on its own in Claude Code; the extra Enter is a
    // no-op there and submits typed text everywhere else.
    setTimeout(() => this.pty?.write("\r"), 150).unref?.();
    this.pending = undefined;
    return true;
  }

  /** `turn.deliver {kind: "answer"}`: same as a `prompt.answer`, reported as an instant turn. */
  private deliverAnswer(frame: TurnDeliverFrame): void {
    if (!frame.answer) return this.finish(frame.turnId, { error: "answer turn without an answer" });
    if (!this.pty) return this.finish(frame.turnId, { exitCode: 0, unsupported: "headless sessions cannot answer harness prompts" });
    if (!this.pending) return this.finish(frame.turnId, { error: "no prompt is pending" });
    if (!this.answerPrompt({ type: "prompt.answer", ...frame.answer })) return this.finish(frame.turnId, { error: `prompt ${frame.answer.promptId} is not pending` });
    this.finish(frame.turnId, { exitCode: 0 });
  }

  // ---------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const frame = this.queue.shift() as TurnDeliverFrame;
        await this.runTurn(frame);
      }
    } finally {
      this.draining = false;
    }
  }

  private lookupCommand(name: string): CommandEntry | undefined {
    const bare = name.replace(/^[/$]/, "");
    return this.catalog.find((c) => c.name === name || c.name === bare || c.name === `$${bare}` || c.name === `/${bare}`);
  }

  /** The text that goes into the harness for a turn, or a reason it cannot run here. */
  private async resolveText(frame: TurnDeliverFrame): Promise<{ text: string; entry?: CommandEntry } | { unsupported: string }> {
    const attachments = await downloadAttachments(this.ctx.cwd, frame.turnId, frame.attachments);
    if (attachments.length > 0) {
      this.ctx.log(`remote control: ${attachments.length} attachment(s) saved under .tmp/ditto/attachments/${frame.turnId}`);
    }
    if ((frame.kind ?? "prompt") !== "command") return { text: buildPrompt(frame.text, attachments) };
    const name = frame.command?.name?.trim() || frame.text.trim().replace(/^[/$]/, "").split(/\s+/)[0];
    if (!name) return { unsupported: "command turn without a command name" };
    const entry = this.lookupCommand(name);
    const args = frame.command?.args ?? (frame.command ? undefined : frame.text.trim().split(/\s+/).slice(1).join(" "));
    const invocation = commandInvocation(this.ctx.harness, entry, entry?.name ?? name, args);
    if (this.ctx.mode === "headless") {
      const headlessOk = entry ? entry.headless : false;
      if (!headlessOk) {
        return { unsupported: `${invocation.split(" ")[0]} only works in a terminal session (${entry ? "TUI-only builtin" : "not in this session's catalog"})` };
      }
    }
    return { text: buildPrompt(invocation, attachments), entry };
  }

  private async runTurn(frame: TurnDeliverFrame): Promise<void> {
    const { turnId } = frame;
    this.host.status(this.ctx.sessionId, "running");
    let resolved: Awaited<ReturnType<RemoteSession["resolveText"]>>;
    try {
      resolved = await this.resolveText(frame);
    } catch (err) {
      this.finish(turnId, { error: err instanceof Error ? err.message : String(err) });
      this.host.status(this.ctx.sessionId, "idle");
      return;
    }
    if ("unsupported" in resolved) {
      this.finish(turnId, { exitCode: 0, unsupported: resolved.unsupported });
      this.host.status(this.ctx.sessionId, "idle");
      return;
    }
    const { text, entry } = resolved;

    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.current = { turnId, interrupted: false, done: finish };

    try {
      if (this.pty) {
        this.ctx.log(`remote control: ${entry ? `command ${text.split("\n")[0]}` : "prompt"} received from the app (turn ${turnId.slice(0, 8)})`);
        await this.pty.inject(text);
        this.host.send({ type: "turn.started", turnId });
        // Builtins (/model, /clear …) run no model turn, so no Stop hook
        // fires; a short quiet period ends them.
        const quiet = entry?.source === "builtin" ? Math.min(this.ctx.quietFallbackMs ?? 8000, 1500) : undefined;
        await Promise.race([finished, this.pty.exit, this.quietFallback(finished, quiet)]);
        this.finish(turnId, { exitCode: 0, ...(this.current.interrupted ? { interrupted: true } : {}) });
      } else if (this.runHeadless) {
        const turn = this.runHeadless(text);
        this.current.headless = turn;
        this.host.send({ type: "turn.started", turnId });
        const exitCode = await turn.exit;
        this.finish(turnId, { exitCode, ...(this.current.interrupted ? { interrupted: true } : {}) });
      } else {
        this.finish(turnId, { error: "no harness attached" });
      }
    } catch (err) {
      this.finish(turnId, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.current = undefined;
      this.clearPending();
      this.host.status(this.ctx.sessionId, "idle");
    }
  }

  /**
   * Safety net when a harness never reports its turn end (older builds, hooks
   * disabled, builtin commands): once the screen has been quiet for the limit
   * after the prompt went in, the turn counts as finished. Hooks are the
   * primary signal; a pending prompt never times out this way.
   */
  private quietFallback(finished: Promise<void>, limitMs?: number): Promise<void> {
    const limit = limitMs ?? this.ctx.quietFallbackMs ?? 8000;
    return new Promise<void>((resolve) => {
      let settled = false;
      void finished.then(() => {
        settled = true;
        resolve();
      });
      const started = Date.now();
      const timer = setInterval(() => {
        if (settled) return clearInterval(timer);
        const pty = this.pty;
        if (!pty || this.pending) return;
        if (Date.now() - started > Math.min(2000, limit) && pty.quietFor() >= limit) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
      timer.unref?.();
    });
  }
}
