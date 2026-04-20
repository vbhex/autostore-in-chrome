/**
 * Handshake + transport config shared between bridge and extension.
 *
 * Security model: the bridge binds WS to 127.0.0.1 only and emits a random
 * token. The token is written to disk under ~/.autostore-in-chrome/ — a path
 * only processes on this machine can read. The Chrome extension loads the
 * token on startup (via a local file read that only runs inside the extension
 * service worker) and sends it in the first WS message. No token == no bridge.
 *
 * Why not TLS? Loopback is trusted. The extension can't ship a valid cert for
 * 127.0.0.1 anyway; adding self-signed would just teach users to click past
 * browser warnings.
 */
import { homedir } from "os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const CONFIG_DIR = join(homedir(), ".autostore-in-chrome");
export const TOKEN_FILE = join(CONFIG_DIR, "token");
export const PORT_FILE = join(CONFIG_DIR, "port");
export const DEFAULT_PORT = 43117; // arbitrary; overridden via AUTOSTORE_CHROME_PORT

/** Ensure the config dir exists and return the token. Generates one if absent. */
export function loadOrCreateToken(): string {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

export function writePort(port: number) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PORT_FILE, String(port), { mode: 0o600 });
}

/** First message the extension sends. */
export interface HelloMessage {
  type: "hello";
  token: string;
  extensionId?: string;
  chromeVersion?: string;
}

/** First message the bridge sends back, on success. */
export interface HelloAckMessage {
  type: "hello-ack";
  bridgeVersion: string;
}

/** Any non-hello message — RPC request from bridge, RPC response from extension. */
export interface RpcRequest {
  type: "rpc-request";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  type: "rpc-response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type WireMessage = HelloMessage | HelloAckMessage | RpcRequest | RpcResponse;
