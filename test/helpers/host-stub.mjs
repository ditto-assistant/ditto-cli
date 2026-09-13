import { createHash } from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";
import { ALPHA, MINTED_PLAINTEXT } from "./stub-api.mjs";

/**
 * Stub backend for Remote Control tests: the endpoint + key routes the launch
 * needs, the host bridge WebSocket at /api/v5/hosts/ws (bearer-checked), and
 * presigned-style attachment downloads at /attachments/<id>.
 */
export function startHostStub({ apiKey = "ditto_mcp_test", endpoints = [ALPHA] } = {}) {
  const calls = [];
  const frames = [];
  const sockets = [];
  const attachments = new Map();
  const waiters = [];

  const notify = () => {
    for (const w of [...waiters]) {
      const hit = frames.find((f, i) => i >= w.from && w.pred(f));
      if (hit) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(hit);
      }
    }
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      const json = (status, payload) => {
        res.setHeader("content-type", "application/json");
        res.statusCode = status;
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      if (req.url === "/api/v5/inference/endpoints" && req.method === "GET") {
        return json(200, { baseUrl: "https://api.example.test/v1", endpoints, limit: 5, used: endpoints.length });
      }
      const m = req.url.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)(\/keys(?:\/([^/]+))?)?$/);
      if (m && m[2] === "/keys" && req.method === "POST") {
        const input = JSON.parse(body);
        return json(201, {
          id: "key-2",
          endpointId: m[1],
          name: input.name,
          keyHint: "zz99",
          key: MINTED_PLAINTEXT,
          expiresAt: "2027-09-05T00:00:00Z",
          spendLimitTokens: input.spendLimitTokens ?? null,
          spendPeriod: input.spendPeriod ?? "never",
        });
      }
      if (m && m[3] && req.method === "DELETE") return json(204);
      const a = req.url.match(/^\/attachments\/([^/?]+)/);
      if (a && attachments.has(a[1])) {
        const bytes = attachments.get(a[1]);
        res.setHeader("content-type", "application/octet-stream");
        res.statusCode = 200;
        return res.end(bytes);
      }
      json(404, {});
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/v5/hosts/ws") {
      socket.destroy();
      return;
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("message", (data) => {
        let frame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        frames.push({ ...frame, _conn: sockets.indexOf(ws) });
        if (frame.type === "hello") {
          ws.send(JSON.stringify({ type: "welcome", hostId: frame.hostId ?? "host-1", heartbeatSeconds: 30, serverTime: new Date().toISOString() }));
        }
        if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong", t: frame.t }));
        notify();
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        calls,
        frames,
        /** Number of WebSocket connections accepted so far. */
        connections: () => sockets.length,
        /** Registers bytes and returns the attachment descriptor a turn.deliver carries. */
        addAttachment(id, name, bytes, mime = "text/plain") {
          attachments.set(id, bytes);
          return { id, name, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), url: `${base}/attachments/${id}` };
        },
        /** Sends a frame on the most recent host connection. */
        send(frame) {
          const ws = sockets[sockets.length - 1];
          if (!ws) throw new Error("no host connected");
          ws.send(JSON.stringify(frame));
        },
        /** Resolves with the first frame (at or after index `from`) matching `pred`. */
        waitFor(pred, { timeout = 10_000, from = 0 } = {}) {
          const hit = frames.find((f, i) => i >= from && pred(f));
          if (hit) return Promise.resolve(hit);
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              waiters.splice(waiters.findIndex((w) => w.resolve === done), 1);
              reject(new Error(`timed out waiting for a frame; saw: ${frames.map((f) => f.type).join(", ")}`));
            }, timeout);
            const done = (f) => {
              clearTimeout(timer);
              resolve(f);
            };
            waiters.push({ pred, from, resolve: done });
          });
        },
        /** Closes every host connection server-side (simulates a backend restart). */
        dropClients() {
          for (const ws of sockets) ws.terminate();
        },
        close: () =>
          new Promise((r) => {
            for (const ws of sockets) ws.terminate();
            wss.close();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}
