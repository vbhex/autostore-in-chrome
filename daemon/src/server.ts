/**
 * HTTP + WebSocket server — loopback only.
 *
 * Two protocols share one port (default 43117):
 *
 *   HTTP  — POST /rpc     for outside callers (Mac app, backend, curl)
 *           GET  /health  unauthenticated liveness + extension status
 *
 *   WS    — /ws           for the Chrome extension service worker
 *
 * Both protocols authenticate with the same token (see handshake.ts).
 * HTTP callers send `Authorization: Bearer <token>`; the extension sends
 * it inside its first JSON `hello` frame over WS.
 */
import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebSocketServer } from "ws";
import type { ExtensionBus } from "./extension-bus.js";
import { dispatch, listMethods } from "./rpc.js";

export interface DaemonServerOpts {
  token: string;
  port: number;
  daemonVersion: string;
  bus: ExtensionBus;
}

export function createDaemonServer(opts: DaemonServerOpts) {
  const { token, port, daemonVersion, bus } = opts;

  const http = createServer(async (req, res) => {
    try {
      await handleHttp(req, res, { token, daemonVersion, bus });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  bus.attachTo(wss);

  http.on("upgrade", (req, socket, head) => {
    // Only accept upgrades on /ws. Token is checked inside the hello frame.
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  return {
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        // 127.0.0.1 only — never 0.0.0.0. Loopback is the trust boundary.
        http.listen(port, "127.0.0.1", () => {
          http.off("error", reject);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        wss.close();
        http.close(() => resolve());
      });
    },
  };
}

interface HttpCtx {
  token: string;
  daemonVersion: string;
  bus: ExtensionBus;
}

async function handleHttp(req: IncomingMessage, res: ServerResponse, ctx: HttpCtx) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      daemonVersion: ctx.daemonVersion,
      extension: ctx.bus.status(),
      methods: listMethods(),
    });
    return;
  }

  // Everything else requires auth.
  const auth = req.headers["authorization"];
  const presented =
    typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length).trim()
      : "";
  if (presented !== ctx.token) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/rpc") {
    const body = await readBody(req);
    let parsed: { method?: unknown; params?: unknown };
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "invalid json" });
      return;
    }
    if (typeof parsed.method !== "string") {
      sendJson(res, 400, { ok: false, error: "missing method" });
      return;
    }
    try {
      const result = await dispatch(ctx.bus, parsed.method, parsed.params);
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 200, { ok: false, error: msg });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json).toString(),
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 1_000_000; // 1 MB is plenty for RPC bodies.
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
