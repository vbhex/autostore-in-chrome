/**
 * Manages the WebSocket connection from the Chrome extension.
 *
 * Exactly one extension connection is live at a time — the most recent
 * authenticated socket wins. HTTP clients and the extension never speak
 * directly; every RPC goes:
 *
 *   HTTP client → callExtension() → WS to extension → chrome.* API
 *                                 ◀──────── result ◀──────────
 */
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import type {
  HelloMessage,
  RpcRequest,
  RpcResponse,
  WireMessage,
} from "./handshake.js";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  startedAt: number;
};

export interface ExtensionBusOpts {
  token: string;
  daemonVersion: string;
}

export class ExtensionBus {
  private activeSocket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private lastConnectedAt = 0;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(private opts: ExtensionBusOpts) {}

  /** Attach to an existing ws.Server — the daemon shares its HTTP server's upgrade path. */
  attachTo(wss: WebSocketServer) {
    wss.on("connection", (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket) {
    let authed = false;

    ws.on("message", (raw) => {
      let msg: WireMessage;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(1002, "bad json"); return; }

      if (!authed) {
        if (msg.type !== "hello") { ws.close(1008, "expected hello"); return; }
        const hello = msg as HelloMessage;
        if (hello.token !== this.opts.token) { ws.close(1008, "bad token"); return; }
        authed = true;

        // Supersede any earlier socket.
        if (this.activeSocket && this.activeSocket !== ws) {
          try { this.activeSocket.close(1000, "superseded"); } catch { /* ignore */ }
        }
        this.activeSocket = ws;
        this.lastConnectedAt = Date.now();
        ws.send(JSON.stringify({ type: "hello-ack", daemonVersion: this.opts.daemonVersion }));
        process.stderr.write(`[daemon] extension connected (chrome=${hello.chromeVersion ?? "?"})\n`);
        this.startKeepalive();
        return;
      }

      // Extension-initiated keepalive frame (see service-worker.js). Each
      // message we send/receive resets the MV3 service-worker idle timer,
      // so a pong keeps the extension warm.
      if (msg.type === "ping") {
        try { ws.send(JSON.stringify({ type: "pong" })); } catch { /* ignore */ }
        return;
      }

      if (msg.type === "rpc-response") {
        const resp = msg as RpcResponse;
        const p = this.pending.get(resp.id);
        if (!p) return;
        this.pending.delete(resp.id);
        if (resp.ok) p.resolve(resp.result);
        else p.reject(new Error(resp.error ?? `${p.method} failed`));
      }
    });

    ws.on("close", () => {
      if (this.activeSocket === ws) {
        this.activeSocket = null;
        this.stopKeepalive();
        for (const [id, p] of this.pending) {
          p.reject(new Error("extension disconnected"));
          this.pending.delete(id);
        }
        process.stderr.write(`[daemon] extension disconnected\n`);
      }
    });
  }

  private startKeepalive() {
    this.stopKeepalive();
    // MV3 SW gets suspended after ~30s idle. Sending a ping every 20s keeps
    // the inbound message stream alive (each arrival resets the idle timer).
    this.keepaliveTimer = setInterval(() => {
      const ws = this.activeSocket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
    }, 20_000);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  isConnected(): boolean {
    return !!this.activeSocket && this.activeSocket.readyState === WebSocket.OPEN;
  }

  status() {
    return {
      connected: this.isConnected(),
      connectedSinceMs: this.isConnected() ? Date.now() - this.lastConnectedAt : null,
      pendingCalls: this.pending.size,
    };
  }

  /** Send an RPC to the extension and wait for the response. */
  call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 60_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.activeSocket || this.activeSocket.readyState !== WebSocket.OPEN) {
        return reject(new Error(
          "AutoStore Chrome extension is not connected. Install the extension and paste the bridge token into its popup.",
        ));
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        method,
        startedAt: Date.now(),
      });
      const req: RpcRequest = { type: "rpc-request", id, method, params };
      this.activeSocket.send(JSON.stringify(req));
    });
  }

  shutdown() {
    for (const [, p] of this.pending) p.reject(new Error("daemon shutting down"));
    this.pending.clear();
    try { this.activeSocket?.close(1001, "daemon shutdown"); } catch { /* ignore */ }
  }
}
