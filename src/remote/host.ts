import os from "node:os";
import { packageVersion } from "../config.js";
import { readStoredAuth, updateStoredAuth } from "../store.js";
import {
  type CheckpointRequestFrame,
  HOST_WS_PATH,
  type HostCapabilities,
  type HostFrame,
  type PromptAnswerFrame,
  type ServerFrame,
  type SessionAnnounceFrame,
  type SessionCommandsFrame,
  type SessionStatus,
  type TurnDeliverFrame,
  type WelcomeFrame,
  isServerFrame,
} from "./protocol.js";

/**
 * The host side of the bridge: one WebSocket to the backend that announces
 * the coding sessions this machine runs and receives turns for them.
 *
 * The connection is best effort. A backend without the hosts endpoint, or a
 * flaky network, never blocks the harness: the client keeps retrying in the
 * background with backoff and re-announces every known session when it gets
 * back in, and the harness keeps running locally the whole time.
 */

export interface HostHandlers {
  onTurn: (turn: TurnDeliverFrame) => void;
  onInterrupt: (turnId: string) => void;
  onCheckpoint: (request: CheckpointRequestFrame) => void;
  onPromptAnswer?: (answer: PromptAnswerFrame) => void;
}

export interface HostClientOptions {
  baseUrl: string;
  apiKey: string;
  capabilities: HostCapabilities;
  handlers: HostHandlers;
  name?: string;
  /** Called for status lines; defaults to silence. */
  log?: (line: string) => void;
  /** Overrides for tests. */
  heartbeatSeconds?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const SEEN_TURNS_MAX = 1000;

function wsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}${HOST_WS_PATH}`;
  u.search = "";
  return u.toString();
}

export class HostClient {
  readonly options: HostClientOptions;
  hostId?: string;
  private socket?: WebSocket;
  private connected = false;
  private closing = false;
  private attempt = 0;
  private heartbeat?: NodeJS.Timeout;
  private missedPongs = 0;
  private readonly sessions = new Map<string, SessionAnnounceFrame>();
  private readonly catalogs = new Map<string, SessionCommandsFrame>();
  private readonly seenTurns: string[] = [];
  private readonly seenSet = new Set<string>();
  private welcomeWaiters: Array<() => void> = [];

  constructor(options: HostClientOptions) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Starts connecting; resolves after the first `welcome` or after `timeoutMs` (still retrying in the background). */
  async start(timeoutMs = 4000): Promise<boolean> {
    this.hostId = (await readStoredAuth())?.hostId;
    void this.connectLoop();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.welcomeWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async connectLoop(): Promise<void> {
    while (!this.closing) {
      try {
        await this.connectOnce();
      } catch (err) {
        this.options.log?.(`remote control: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.closing) return;
      const base = this.options.reconnectBaseMs ?? 1000;
      const max = this.options.reconnectMaxMs ?? 30_000;
      const delay = Math.min(max, base * 2 ** Math.min(this.attempt, 6)) * (0.75 + Math.random() * 0.5);
      this.attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl(this.options.baseUrl), {
        // Node's WebSocket (undici) accepts request headers; browsers do not, but this is the CLI.
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
      } as unknown as string[]);
      this.socket = socket;
      // Resolves only once the socket closes after a successful welcome, so the
      // loop never opens a second connection next to a live one.
      let welcomed = false;
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      socket.addEventListener("open", () => {
        this.send({
          type: "hello",
          kind: "cli",
          name: this.options.name ?? os.hostname(),
          platform: `${process.platform}-${process.arch}`,
          version: packageVersion,
          capabilities: this.options.capabilities,
          ...(this.hostId ? { hostId: this.hostId } : {}),
        });
      });
      socket.addEventListener("message", (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return;
        }
        if (!isServerFrame(parsed)) return;
        if (parsed.type === "welcome") {
          welcomed = true;
          this.onWelcome(parsed);
          return;
        }
        this.dispatch(parsed);
      });
      socket.addEventListener("error", () => fail("connection failed"));
      socket.addEventListener("close", (event) => {
        this.stopHeartbeat();
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected && !this.closing) this.options.log?.(`remote control: disconnected (${event.code}); reconnecting`);
        if (welcomed) {
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        fail(`closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
      });
    });
  }

  private onWelcome(frame: WelcomeFrame): void {
    this.connected = true;
    this.attempt = 0;
    this.missedPongs = 0;
    if (frame.hostId && frame.hostId !== this.hostId) {
      this.hostId = frame.hostId;
      void updateStoredAuth({ hostId: frame.hostId }).catch(() => undefined);
    }
    this.startHeartbeat(frame.heartbeatSeconds || this.options.heartbeatSeconds || 30);
    for (const session of this.sessions.values()) {
      this.send(session);
      const catalog = this.catalogs.get(session.sessionId);
      if (catalog) this.send(catalog);
    }
    const waiters = this.welcomeWaiters;
    this.welcomeWaiters = [];
    for (const w of waiters) w();
  }

  private dispatch(frame: ServerFrame): void {
    switch (frame.type) {
      case "ping":
        this.send({ type: "pong", t: frame.t });
        return;
      case "pong":
        this.missedPongs = 0;
        return;
      case "turn.deliver":
        if (this.seenSet.has(frame.turnId)) {
          this.send({ type: "turn.ack", turnId: frame.turnId });
          return;
        }
        this.remember(frame.turnId);
        this.options.handlers.onTurn(frame);
        return;
      case "turn.interrupt":
        this.options.handlers.onInterrupt(frame.turnId);
        return;
      case "checkpoint.request":
        this.options.handlers.onCheckpoint(frame);
        return;
      case "prompt.answer":
        this.options.handlers.onPromptAnswer?.(frame);
        return;
      default:
        return;
    }
  }

  private remember(turnId: string): void {
    this.seenSet.add(turnId);
    this.seenTurns.push(turnId);
    if (this.seenTurns.length > SEEN_TURNS_MAX) {
      const old = this.seenTurns.shift();
      if (old) this.seenSet.delete(old);
    }
  }

  private startHeartbeat(seconds: number): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.missedPongs >= 3) {
        this.options.log?.("remote control: heartbeat lost; reconnecting");
        this.socket?.close(4000, "heartbeat lost");
        return;
      }
      this.missedPongs += 1;
      this.send({ type: "ping", t: Date.now() });
    }, Math.max(1, seconds) * 1000);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  send(frame: HostFrame): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  announce(session: Omit<SessionAnnounceFrame, "type">): void {
    const frame: SessionAnnounceFrame = { type: "session.announce", ...session };
    this.sessions.set(session.sessionId, frame);
    this.send(frame);
  }

  /** Announces a session's command catalog; re-sent with the session after a reconnect. */
  commands(frame: Omit<SessionCommandsFrame, "type">): void {
    const full: SessionCommandsFrame = { type: "session.commands", ...frame };
    this.catalogs.set(frame.sessionId, full);
    this.send(full);
  }

  status(sessionId: string, status: SessionStatus): void {
    const known = this.sessions.get(sessionId);
    if (known) known.status = status;
    this.send({ type: "session.status", sessionId, status });
  }

  closed(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.catalogs.delete(sessionId);
    this.send({ type: "session.closed", sessionId });
  }

  /** Announces every session closed and stops reconnecting. */
  close(): void {
    this.closing = true;
    this.stopHeartbeat();
    for (const id of [...this.sessions.keys()]) this.closed(id);
    this.socket?.close(1000, "host exiting");
    this.socket = undefined;
  }
}
