import { type CliProxy } from "../agents/cliproxy.js";

const MAX_BODY = 8 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024;
const PATHS = new Set(["/v1/messages", "/v1/responses", "/v1/chat/completions"]);

export interface RelayFrame {
  type: string;
  id?: string;
  path?: string;
  body?: string;
  status?: number;
  contentType?: string;
  anthropicVersion?: string;
  anthropicBeta?: string;
}

export function relayWebSocketURL(base: string, endpointID: string): string {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("The relay requires an HTTPS Ditto API origin (or literal loopback for development)");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/v5/inference/endpoints/${encodeURIComponent(endpointID)}/cliproxy-relay`;
  return url.toString();
}

export function validRelayRequest(frame: RelayFrame): boolean {
  return frame.type === "request" && typeof frame.id === "string" && /^[a-f0-9-]{36}$/i.test(frame.id) &&
    typeof frame.path === "string" && PATHS.has(frame.path) && typeof frame.body === "string" &&
    frame.body.length <= 4 * Math.ceil(MAX_BODY / 3) && /^[A-Za-z0-9+/]*={0,2}$/.test(frame.body) &&
    (frame.anthropicVersion === undefined || (typeof frame.anthropicVersion === "string" && /^[0-9-]{1,32}$/.test(frame.anthropicVersion))) &&
    (frame.anthropicBeta === undefined || (typeof frame.anthropicBeta === "string" && /^[a-zA-Z0-9_,. -]{0,4096}$/.test(frame.anthropicBeta)));
}

/** One inference-only socket. The local API key is used only by fixed loopback
 * fetches; it is never included in cloud frames, logs, URLs or saved records. */
export class RelayConnection {
  private requests = new Map<string, AbortController>();
  constructor(private proxy: CliProxy, private send: (frame: RelayFrame) => Promise<void>) {}

  close(): void {
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
  }

  async receive(frame: RelayFrame): Promise<void> {
    if (frame.type === "cancel" && typeof frame.id === "string") {
      this.requests.get(frame.id)?.abort();
      return;
    }
    if (!validRelayRequest(frame)) throw new Error("The cloud sent an unsupported inference relay request");
    const id = frame.id!;
    if (this.requests.has(id)) throw new Error("The cloud reused an active relay request ID");
    if (this.requests.size >= 4) { await this.send({ type: "error", id }); return; }
    const controller = new AbortController();
    this.requests.set(id, controller);
    try {
      const body = Buffer.from(frame.body!, "base64");
      if (body.length > MAX_BODY || body.toString("base64") !== frame.body) throw new Error("Invalid relay body");
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${this.proxy.apiKey}` };
      if (frame.anthropicVersion) headers["anthropic-version"] = frame.anthropicVersion;
      if (frame.anthropicBeta) headers["anthropic-beta"] = frame.anthropicBeta;
      const response = await fetch(`${this.proxy.baseUrl.replace(/\/v1$/, "")}${frame.path}`, {
        method: "POST", headers, body, redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]),
      });
      await this.send({ type: "headers", id, status: response.status, contentType: response.headers.get("content-type")?.slice(0, 128) || "application/json" });
      if (response.body) {
        for await (const chunk of response.body) {
          for (let start = 0; start < chunk.length; start += MAX_CHUNK) {
            await this.send({ type: "chunk", id, body: Buffer.from(chunk.subarray(start, start + MAX_CHUNK)).toString("base64") });
          }
        }
      }
      await this.send({ type: "end", id });
    } catch {
      // Provider errors can contain user prompts or tokens. Never relay an
      // exception message; the Router supplies a public error and reference.
      const cancelled = controller.signal.aborted;
      controller.abort();
      if (!cancelled) await this.send({ type: "error", id }).catch(() => {});
    } finally {
      controller.abort();
      this.requests.delete(id);
    }
  }
}

export async function connectRelay(url: string, accountKey: string, proxy: CliProxy, signal: AbortSignal, ready: () => void, welcomeTimeoutMs = 15_000,
  options: { heartbeatMs?: number; pongTimeoutMs?: number; maxInboundBytes?: number } = {}): Promise<void> {
  if (signal.aborted) return;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${accountKey}` } } as unknown as string[]);
    let welcomed = false;
    let settled = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let lastPong = Date.now();
    const send = async (frame: RelayFrame) => {
      const started = Date.now();
      while (socket.bufferedAmount > 1024 * 1024) {
        if (signal.aborted || socket.readyState !== WebSocket.OPEN || Date.now() - started > 10_000) throw new Error("Relay backpressure timeout");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Relay disconnected");
      socket.send(JSON.stringify(frame));
    };
    const connection = new RelayConnection(proxy, send);
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (heartbeat) clearInterval(heartbeat);
      signal.removeEventListener("abort", stop);
      connection.close();
      socket.close();
      failed && !signal.aborted ? reject(new Error("Ditto relay connection failed; check your login, endpoint ownership and backend version")) : resolve();
    };
    const stop = () => finish(false);
    const deadline = setTimeout(() => finish(true), welcomeTimeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || Buffer.byteLength(event.data, "utf8") > (options.maxInboundBytes ?? 12 * 1024 * 1024)) { finish(true); return; }
      let frame: RelayFrame;
      try { frame = JSON.parse(event.data) as RelayFrame; } catch { finish(true); return; }
      if (!welcomed) {
        if (frame?.type !== "welcome") { finish(true); return; }
        welcomed = true;
        clearTimeout(deadline);
        lastPong = Date.now();
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong >= (options.pongTimeoutMs ?? 60_000)) { finish(true); return; }
          void send({ type: "ping" }).catch(() => finish(true));
        }, options.heartbeatMs ?? 20_000);
        ready();
      } else if (frame?.type === "pong") {
        lastPong = Date.now();
      } else {
        void connection.receive(frame).catch(() => finish(true));
      }
    });
    socket.addEventListener("close", () => finish(!welcomed));
    socket.addEventListener("error", () => finish(true));
  });
}
