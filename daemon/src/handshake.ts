/**
 * Token + port management shared by daemon and extension.
 *
 * Security model: one random 32-byte hex token, written to
 * ~/.autostore-in-chrome/token with 0600 perms. Every HTTP client and the
 * Chrome extension must present this token. Loopback-only server, so we
 * don't bother with TLS — the trust boundary is the OS user.
 */
import { homedir } from "os";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const CONFIG_DIR = join(homedir(), ".autostore-in-chrome");
export const TOKEN_FILE = join(CONFIG_DIR, "token");
export const PORT_FILE = join(CONFIG_DIR, "port");
export const DEFAULT_PORT = 43117;

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

/** First message the extension sends over WS. */
export interface HelloMessage {
  type: "hello";
  token: string;
  extensionId?: string;
  chromeVersion?: string;
}

/** First message the daemon sends back on success. */
export interface HelloAckMessage {
  type: "hello-ack";
  daemonVersion: string;
}

/** Daemon → extension: please do this thing. */
export interface RpcRequest {
  type: "rpc-request";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** Extension → daemon: here's the result. */
export interface RpcResponse {
  type: "rpc-response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type WireMessage = HelloMessage | HelloAckMessage | RpcRequest | RpcResponse;
