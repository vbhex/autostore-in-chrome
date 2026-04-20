/**
 * WebSocket server that talks to the Chrome extension.
 *
 * Single-client: only one extension connection is live at a time. The most
 * recent successful hello wins; any older socket is closed. This avoids the
 * "which tab is the user in" ambiguity when the user reloads the extension.
 *
 * The bridge calls `call(method, params)` for every MCP tool invocation. That
 * promise resolves when the extension sends back the matching rpc-response.
 * If no extension is connected, calls reject immediately — the MCP client
 * sees the error and can tell the user "install / enable the extension."
 */
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  DEFAULT_PORT,
  type HelloMessage,
  type RpcRequest,
  type RpcResponse,
  type WireMessage,
  writePort,
} from "./handshake.js";

export interface BridgeServerOpts {
  token: string;
  port?: number;
  version?: string;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
  startedAt: number;
};

export class BridgeServer {
  private wss: WebSocketServer;
  private activeSocket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private token: string;
  private version: string;

  constructor(private opts: BridgeServerOpts) {
    this.token = opts.token;
    this.version = opts.version ?? "0.1.0";
    const port = opts.port ?? DEFAULT_PORT;

    // 127.0.0.1 ONLY — never bind to 0.0.0.0. Loopback is the trust boundary.
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    writePort(port);

    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.wss.on("listening", () => {
      process.stderr.write(`[bridge] listening on 127.0.0.1:${port}\n`);
    });
    this.wss.on("error", (e) => {
      process.stderr.write(`[bridge] ws error: ${(e as Error).message}\n`);
    });
  }

  private onConnection(ws: WebSocket) {
    let helloSeen = false;

    ws.on("message", (raw) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(1002, "bad json");
        return;
      }

      if (!helloSeen) {
        if (msg.type !== "hello") {
          ws.close(1008, "expected hello");
          return;
        }
        const hello = msg as HelloMessage;
        if (hello.token !== this.token) {
          ws.close(1008, "bad token");
          return;
        }
        helloSeen = true;

        // Replace any previous active socket.
        if (this.activeSocket && this.activeSocket !== ws) {
          try { this.activeSocket.close(1000, "superseded"); } catch { /* ignore */ }
        }
        this.activeSocket = ws;
        ws.send(JSON.stringify({ type: "hello-ack", bridgeVersion: this.version }));
        process.stderr.write(`[bridge] extension connected (chrome=${hello.chromeVersion ?? "?"})\n`);
        return;
      }

      // Only rpc-response is meaningful after handshake.
      if (msg.type === "rpc-response") {
        const resp = msg as RpcResponse;
        const p = this.pending.get(resp.id);
        if (!p) return; // stale
        this.pending.delete(resp.id);
        if (resp.ok) p.resolve(resp.result);
        else p.reject(new Error(resp.error ?? `${p.method} failed`));
      }
    });

    ws.on("close", () => {
      if (this.activeSocket === ws) {
        this.activeSocket = null;
        // Fail every outstanding call — the extension went away.
        for (const [id, p] of this.pending) {
          p.reject(new Error("extension disconnected"));
          this.pending.delete(id);
        }
        process.stderr.write(`[bridge] extension disconnected\n`);
      }
    });
  }

  /** True if an extension is connected and authenticated right now. */
  isConnected(): boolean {
    return this.activeSocket !== null && this.activeSocket.readyState === WebSocket.OPEN;
  }

  /** Send an RPC to the extension. Rejects if no extension or on timeout. */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.activeSocket || this.activeSocket.readyState !== WebSocket.OPEN) {
        return reject(new Error(
          "No AutoStore Chrome extension connected. Install the extension from in-chrome/extension/ and make sure Chrome is running.",
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

  close() {
    for (const [, p] of this.pending) p.reject(new Error("bridge shutting down"));
    this.pending.clear();
    this.wss.close();
  }
}
