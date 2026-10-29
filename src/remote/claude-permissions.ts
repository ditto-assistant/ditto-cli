import { createHash } from "node:crypto";
import { captureClaudeToolResultAnchor, readClaudeToolResults, type ClaudeToolResultAnchor } from "./claude-tool-results.js";

interface ToolOperation {
  key: string;
  session: string;
  signature: string;
  toolUseId: string;
  anchor: Promise<ClaudeToolResultAnchor | undefined>;
}
export interface ClaudePermissionToken {
  session: string;
  signature: string;
  operation?: ToolOperation;
  ambiguous: boolean;
  resolved: boolean;
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("tool metadata too deep");
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key], depth + 1)]));
  return value;
}

function metadata(payload: Record<string, unknown>) {
  const session = payload.session_id;
  if (typeof session !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session)) return;
  if (typeof payload.agent_id === "string" && payload.agent_id && payload.agent_id !== session) return;
  if (typeof payload.tool_name !== "string" || payload.tool_name.length > 256) return;
  try {
    const input = JSON.stringify([payload.tool_name, payload.tool_input]);
    if (Buffer.byteLength(input) > 65536) return;
    const normalized = JSON.stringify(canonical(JSON.parse(input)));
    return { session, signature: createHash("sha256").update(normalized).digest("hex") };
  } catch { return; }
}

/** Correlates only this input epoch. Ambiguous/missing metadata never clears a dialog. */
export class ClaudePermissionTracker {
  private readonly operations = new Map<string, ToolOperation>();
  private active?: ClaudePermissionToken;
  private timer?: NodeJS.Timeout;
  private epoch = 0;
  constructor(private readonly resolved: (token: ClaudePermissionToken) => void) {}

  get pending(): boolean { return Boolean(this.active && !this.active.resolved); }
  get toolBusy(): boolean { return this.operations.size > 0; }

  reset(): void {
    this.epoch++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active = undefined;
    this.operations.clear();
  }

  preTool(payload: Record<string, unknown>): void {
    const meta = metadata(payload);
    const id = payload.tool_use_id;
    if (!meta || typeof id !== "string" || !id || id.length > 256 || typeof payload.transcript_path !== "string") return;
    const key = `${meta.session}:${id}`;
    if (this.operations.has(key)) return;
    const operation = { ...meta, key, toolUseId: id, anchor: captureClaudeToolResultAnchor(payload.transcript_path, meta.session) };
    this.operations.set(key, operation);
    while (this.operations.size > 128) this.operations.delete(this.operations.keys().next().value as string);
    const active = this.active;
    if (active && !active.resolved && active.session === meta.session && active.signature === meta.signature) {
      if (active.operation && active.operation !== operation) active.ambiguous = true;
      else if (!active.ambiguous) active.operation = operation;
    }
  }

  permissionRequest(payload: Record<string, unknown>): void {
    const meta = metadata(payload);
    if (!meta) return;
    const matches = [...this.operations.values()].filter(op => op.session === meta.session && op.signature === meta.signature);
    if (this.active && !this.active.resolved && this.active.operation === matches[0] && matches.length === 1) return;
    const alreadyPending = this.pending;
    this.active = { ...meta, operation: matches.length === 1 ? matches[0] : undefined, ambiguous: alreadyPending || matches.length > 1, resolved: false };
    this.poll(this.active, this.epoch);
  }

  question(payload: Record<string, unknown>): ClaudePermissionToken | undefined {
    const meta = metadata(payload);
    if (!meta || typeof payload.tool_use_id !== "string") return;
    const operation = this.operations.get(`${meta.session}:${payload.tool_use_id}`);
    if (!operation) return;
    this.active = { ...meta, operation, ambiguous: this.pending, resolved: false };
    this.poll(this.active, this.epoch);
    return this.active;
  }

  notification(payload: Record<string, unknown>): ClaudePermissionToken | undefined {
    if (typeof payload.agent_id === "string" && payload.agent_id && payload.agent_id !== payload.session_id) return;
    return this.active?.session === payload.session_id ? this.active : undefined;
  }

  toolFinished(payload: Record<string, unknown>): void {
    const meta = metadata(payload);
    const id = payload.tool_use_id;
    if (!meta || typeof id !== "string") return;
    const operation = this.operations.get(`${meta.session}:${id}`);
    if (!operation || operation.signature !== meta.signature) return;
    const active = this.active;
    if (active && !active.ambiguous && active.operation === operation) this.complete(active);
    this.operations.delete(operation.key);
  }

  answered(token: ClaudePermissionToken | undefined): void {
    // An explicit answer retains the old user-controlled answer behavior.
    if (token && token === this.active) { token.ambiguous = false; this.complete(token); }
  }

  private complete(token: ClaudePermissionToken): void {
    if (token !== this.active || token.resolved || token.ambiguous) return;
    token.resolved = true;
    if (token.operation) this.operations.delete(token.operation.key);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.resolved(token);
  }

  private poll(token: ClaudePermissionToken, epoch: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (token !== this.active || token.resolved || epoch !== this.epoch) return;
      if (!token.ambiguous && token.operation) {
        const anchor = await token.operation.anchor;
        const results = anchor ? await readClaudeToolResults(anchor, [token.operation.toolUseId]) : [];
        if (token === this.active && epoch === this.epoch && !token.ambiguous && results.some(result => result.toolUseId === token.operation?.toolUseId)) this.complete(token);
      }
      if (token === this.active && !token.resolved && epoch === this.epoch) this.poll(token, epoch);
    }, 500);
    this.timer.unref();
  }
}
