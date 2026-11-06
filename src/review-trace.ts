// Agent trace extraction for `heyditto review local --trace` (DITTO-2434).
//
// A coding agent passes the path of its own session file. Review then sees
// the prompt the agent was given and what it did, next to the linked issue
// and the diff, and can request changes when a written requirement is
// missing. The file is only read: it is never modified, moved or deleted.

import { readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface AgentTrace {
  format: string;
  initialPrompt: string;
  steps: string[];
  truncated?: boolean;
}

// The backend and engine enforce the same bounds.
export const MAX_TRACE_FILE_BYTES = 256 << 20;
export const MAX_PROMPT_BYTES = 16000;
export const MAX_STEP_BYTES = 2048;
export const MAX_STEPS = 400;
export const MAX_STEPS_BYTES = 48 << 10;
const HEAD_STEPS = 120;

function clip(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  // Cut on a code point boundary: the decoder drops a split trailing sequence.
  let cut = buf.subarray(0, bytes - 3).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut + "…";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clean = (text: string) => text.replace(/\0/g, "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

function toolStep(name: string, input: unknown): string {
  let detail = "";
  if (typeof input === "string") detail = input;
  else if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    // The fields that say what a tool call touched, most specific first.
    for (const key of ["file_path", "path", "command", "cmd", "pattern", "url", "query", "description"]) {
      if (typeof o[key] === "string" && o[key]) { detail = `${key}=${o[key] as string}`; break; }
    }
    if (!detail) { try { detail = JSON.stringify(o); } catch { detail = ""; } }
  }
  return `tool ${name}${detail ? ": " + oneLine(detail) : ""}`;
}

interface Collected { prompt: string; steps: string[] }

// Claude Code session JSONL: {type:"user"|"assistant", message:{content}}.
function claudeCode(lines: unknown[]): Collected | null {
  const out: Collected = { prompt: "", steps: [] };
  let seen = false;
  for (const raw of lines) {
    const o = raw as { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { role?: string; content?: unknown } };
    if ((o.type !== "user" && o.type !== "assistant") || !o.message || o.isSidechain) continue;
    seen = true;
    const content = o.message.content;
    type Block = { type?: string; text?: string; name?: string; input?: unknown };
    const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.filter(isObject) as Block[] : [];
    for (const b of blocks) {
      if (o.type === "user" && b.type === "text" && !o.isMeta) {
        const text = clean(b.text ?? "");
        if (!text || text.startsWith("Caveat:")) continue;
        if (!out.prompt) out.prompt = text; else out.steps.push("user: " + oneLine(text));
      } else if (o.type === "assistant" && b.type === "text" && b.text?.trim()) out.steps.push("said: " + oneLine(b.text));
      else if (o.type === "assistant" && b.type === "tool_use") out.steps.push(toolStep(b.name ?? "tool", b.input));
    }
  }
  return seen ? out : null;
}

// Codex rollout JSONL: {type:"response_item", payload:{type:"message"|"function_call"|...}}.
function codex(lines: unknown[]): Collected | null {
  const out: Collected = { prompt: "", steps: [] };
  let seen = false;
  for (const raw of lines) {
    const o = raw as { type?: string; payload?: { type?: string; role?: string; content?: { type?: string; text?: string }[]; name?: string; arguments?: string; input?: unknown; action?: { command?: unknown } } };
    if (o.type !== "response_item" || !o.payload) continue;
    seen = true;
    const p = o.payload;
    if (p.type === "message") {
      const text = clean((Array.isArray(p.content) ? p.content.filter(isObject) : []).map(c => typeof c.text === "string" ? c.text : "").join("\n"));
      // Codex injects AGENTS.md, user instructions and an environment block
      // as user turns; a real prompt may itself start with "<".
      if (!text || /^(?:# AGENTS\.md|<environment_context>|<user_instructions>|<permissions instructions>)/.test(text)) continue;
      if (p.role === "user") { if (!out.prompt) out.prompt = text; else out.steps.push("user: " + oneLine(text)); }
      else if (p.role === "assistant") out.steps.push("said: " + oneLine(text));
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      // A local shell call carries its command in action.command.
      const command = p.action?.command;
      let input: unknown = p.input ?? p.arguments ?? (Array.isArray(command) ? { command: command.join(" ") } : typeof command === "string" ? { command } : undefined);
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* raw text input */ } }
      out.steps.push(toolStep(p.name ?? p.type, input));
    }
  }
  return seen ? out : null;
}

// Bound the trace exactly as the backend does. Long sessions keep their
// first steps and their last ones (where the agent says it is done).
export function boundTrace(format: string, prompt: string, steps: string[]): AgentTrace {
  const clipped = steps.map(s => clip(s, MAX_STEP_BYTES)).filter(Boolean);
  let kept = clipped;
  let truncated = false;
  const size = (list: string[]) => list.reduce((n, s) => n + Buffer.byteLength(s), 0);
  if (kept.length > MAX_STEPS || size(kept) > MAX_STEPS_BYTES) {
    truncated = true;
    // The head may use at most half the byte budget, so verbose early steps
    // cannot crowd out the session's ending; the tail fills the rest from
    // the end, skipping a step that does not fit rather than stopping.
    const head: string[] = [];
    let budget = MAX_STEPS_BYTES / 2;
    for (const s of clipped.slice(0, HEAD_STEPS)) {
      const n = Buffer.byteLength(s);
      if (n > budget) break;
      head.push(s);
      budget -= n;
    }
    budget = MAX_STEPS_BYTES - size(head);
    const tail: string[] = [];
    for (let i = clipped.length - 1; i >= head.length && tail.length < MAX_STEPS - head.length; i--) {
      const n = Buffer.byteLength(clipped[i]);
      if (n > budget) continue;
      tail.unshift(clipped[i]);
      budget -= n;
    }
    kept = [...head, ...tail];
  }
  const trace: AgentTrace = { format, initialPrompt: clip(prompt, MAX_PROMPT_BYTES), steps: kept };
  if (truncated) trace.truncated = true;
  return trace;
}

/**
 * Save the exact trace an uncertain admission sent, so its recovery command
 * re-sends the same bytes even though the agent's own session file keeps
 * growing. The file is private (0600), created once, and never deleted.
 */
export async function freezeAgentTrace(trace: AgentTrace, requestId: string): Promise<string> {
  const file = path.join(os.tmpdir(), `ditto-review-trace-${requestId}.json`);
  try { await writeFile(file, JSON.stringify(trace), { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return file;
}

/** Read an agent trace: Claude Code or Codex JSONL, or {initialPrompt, steps} JSON. */
export async function readAgentTrace(file: string): Promise<AgentTrace> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("--trace must name a file");
  if (info.size > MAX_TRACE_FILE_BYTES) throw new Error("--trace file is larger than 256 MiB");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(await readFile(file));
  const trimmed = text.trim();
  let whole: unknown;
  if (trimmed.startsWith("{")) { try { whole = JSON.parse(trimmed); } catch { /* JSONL, one object per line */ } }
  if (whole && typeof whole === "object" && !Array.isArray(whole)) {
    // A single JSON object (pretty-printed or not): the generic shape any agent can write.
    const o = whole as Partial<AgentTrace>;
    const prompt = typeof o.initialPrompt === "string" ? clean(o.initialPrompt) : "";
    if (prompt) {
      const format = typeof o.format === "string" && o.format.trim() ? o.format.trim().slice(0, 40) : "json";
      const trace = boundTrace(format, prompt, Array.isArray(o.steps) ? o.steps.filter((s): s is string => typeof s === "string").map(s => oneLine(clean(s))) : []);
      // A frozen trace (see freezeAgentTrace) reproduces the one it saved.
      if (o.truncated === true) trace.truncated = true;
      return trace;
    }
  }
  const lines: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { lines.push(JSON.parse(line)); } catch { /* a torn last line while the agent is still writing */ }
  }
  for (const [format, parse] of [["claude-code", claudeCode], ["codex", codex]] as const) {
    const got = parse(lines);
    if (got && got.prompt) return boundTrace(format, got.prompt, got.steps.map(clean).filter(Boolean));
  }
  throw new Error("--trace is not a Claude Code or Codex session file, or {\"initialPrompt\", \"steps\"} JSON, with a user prompt");
}
