/**
 * Host bridge protocol v1 — the JSON frames a Remote Control host (this CLI,
 * or ditto-desktop) exchanges with the backend over one WebSocket. Field
 * names are the contract shared with the backend; keep them stable.
 */

export const HOST_WS_PATH = "/api/v5/hosts/ws";
export const PROTOCOL_VERSION = "1.1";

export type HostKind = "cli" | "desktop";
export type SessionMode = "tui" | "headless";
export type SessionStatus = "idle" | "running";
export type HarnessName = "claude-code" | "codex" | "grok";
export type PromptDeliveryMode = "queue" | "steer";

export interface PromptDeliveryCapabilities {
  /** The host retains busy prompts in its own FIFO. */
  queue: boolean;
  /** The host can force immediate native prompt submission while busy. */
  steer: boolean;
  interrupt: boolean;
  /** Notifications are scheduled by the native client, without a queue guarantee. */
  nativeScheduling?: boolean;
  /** Pending dialogs clear only on this socket’s exact resolvedPromptId. */
  promptResolution?: boolean;
}

export interface HostCapabilities {
  harnesses: HarnessName[];
  attachments: true;
  headless: boolean;
  teleport: boolean;
  promptDelivery?: PromptDeliveryCapabilities;
}

export interface HelloFrame {
  type: "hello";
  kind: HostKind;
  name: string;
  platform: string;
  version: string;
  capabilities: HostCapabilities;
  /** Identity from an earlier `welcome`, so the same machine keeps its host id. */
  hostId?: string;
}

export interface WelcomeFrame {
  type: "welcome";
  hostId: string;
  heartbeatSeconds: number;
  serverTime: string;
}

export interface SessionAnnounceFrame {
  type: "session.announce";
  sessionId: string;
  harness: HarnessName;
  cwd: string;
  mode: SessionMode;
  status: SessionStatus;
}

export interface SessionStatusFrame {
  type: "session.status";
  sessionId: string;
  status: SessionStatus;
  /** Exact dialog resolved by native metadata or an explicit answer. */
  resolvedPromptId?: string;
}

export interface SessionClosedFrame {
  type: "session.closed";
  sessionId: string;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** Presigned GET url, valid for about 15 minutes. */
  url: string;
}

export type TurnKind = "prompt" | "command" | "answer";

export interface TurnDeliverFrame {
  type: "turn.deliver";
  turnId: string;
  sessionId: string;
  /** Default "prompt". */
  kind?: TurnKind;
  text: string;
  /** Prompt only. Omitted means normal queued delivery. Never silently downgraded. */
  deliveryMode?: PromptDeliveryMode;
  attachments?: Attachment[];
  /** kind "command": a harness slash command / skill from the session's catalog. */
  command?: { name: string; args?: string };
  /** kind "answer": the user's reply to a `prompt.request`. */
  answer?: { promptId: string; value: string };
}

export type CommandSource = "builtin" | "custom" | "skill" | "plugin";

/** One entry of a session's command catalog (`session.commands`). */
export interface CommandEntry {
  /** As typed after the slash (Claude `review`, `frontend-design:frontend-design`; Codex `prompts:deploy`), or `$skill` for Codex skills. */
  name: string;
  description: string;
  source: CommandSource;
  argsHint?: string;
  /** Whether the command works in a headless session (`claude -p "/name args"` / `codex exec`). */
  headless: boolean;
}

export interface SessionCommandsFrame {
  type: "session.commands";
  sessionId: string;
  harness: HarnessName;
  commands: CommandEntry[];
}

export type PromptKind = "permission" | "question" | "choice";

export interface PromptRequestFrame {
  type: "prompt.request";
  promptId: string;
  sessionId: string;
  kind: PromptKind;
  text: string;
  options?: Array<{ id: string; label: string }>;
  default?: string;
}

export interface PromptAnswerFrame {
  type: "prompt.answer";
  promptId: string;
  value: string;
}

export interface TurnInterruptFrame {
  type: "turn.interrupt";
  turnId: string;
}

export interface CheckpointRequestFrame {
  type: "checkpoint.request";
  sessionId: string;
  reason?: string;
}

export interface TurnAckFrame {
  type: "turn.ack";
  turnId: string;
}
export interface TurnStartedFrame {
  type: "turn.started";
  turnId: string;
}
export interface TurnFinishedFrame {
  response?: string;
  type: "turn.finished";
  turnId: string;
  exitCode?: number | null;
  interrupted?: boolean;
  error?: string;
  /** The command cannot run in this session's mode (e.g. a TUI-only builtin in headless mode). */
  unsupported?: string;
}
export interface CheckpointDoneFrame {
  type: "checkpoint.done";
  sessionId: string;
  generation: number;
}
export interface CheckpointFailedFrame {
  type: "checkpoint.failed";
  sessionId: string;
  error: string;
}
export interface PingFrame {
  type: "ping";
  t?: number;
}
export interface PongFrame {
  type: "pong";
  t?: number;
}

/** Frames the host sends. */
export type HostFrame =
  | HelloFrame
  | SessionAnnounceFrame
  | SessionStatusFrame
  | SessionClosedFrame
  | SessionCommandsFrame
  | PromptRequestFrame
  | TurnAckFrame
  | TurnStartedFrame
  | TurnFinishedFrame
  | CheckpointDoneFrame
  | CheckpointFailedFrame
  | PingFrame
  | PongFrame;

/** Frames the backend sends. */
export type ServerFrame =
  | WelcomeFrame
  | TurnDeliverFrame
  | TurnInterruptFrame
  | CheckpointRequestFrame
  | PromptAnswerFrame
  | PingFrame
  | PongFrame;

export function isServerFrame(value: unknown): value is ServerFrame {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
