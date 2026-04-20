/**
 * RPC method registry.
 *
 * Every HTTP client call lands here. Each method validates its params with
 * zod and then forwards to the extension via ExtensionBus.call(). The
 * extension's service worker dispatches on `method` and calls the matching
 * chrome.* API.
 *
 * To add a tool: define a zod schema here, add a branch in the extension's
 * service-worker.js dispatch(). That's it — no codegen, no MCP layer.
 */
import { z } from "zod";
import type { ExtensionBus } from "./extension-bus.js";

const schemas = {
  list_open_tabs: z.object({
    urlContains: z.string().optional(),
  }),
  snapshot: z.object({
    tabId: z.number().int(),
  }),
  click: z.object({
    tabId: z.number().int(),
    selector: z.string().min(1),
  }),
} as const;

export type RpcMethod = keyof typeof schemas;

export function isKnownMethod(m: string): m is RpcMethod {
  return Object.prototype.hasOwnProperty.call(schemas, m);
}

export async function dispatch(
  bus: ExtensionBus,
  method: string,
  params: unknown,
): Promise<unknown> {
  // `daemon_status` is answered locally — it's about the daemon, not the extension.
  if (method === "daemon_status") {
    return bus.status();
  }

  if (!isKnownMethod(method)) {
    throw new Error(`unknown method: ${method}`);
  }
  const schema = schemas[method];
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new Error(`invalid params for ${method}: ${parsed.error.message}`);
  }
  return bus.call(method, parsed.data as Record<string, unknown>);
}

export function listMethods(): string[] {
  return ["daemon_status", ...Object.keys(schemas)];
}
