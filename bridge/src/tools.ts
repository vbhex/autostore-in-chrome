/**
 * Tool definitions for the in-chrome bridge.
 *
 * Every tool is a thin forwarder: parse args with zod, call the extension via
 * the WS bridge, return whatever the extension sent back. The real logic lives
 * in the extension service worker (extension/service-worker.ts) — the bridge
 * is just a strongly-typed MCP frontend for it.
 *
 * MVP surface (matches the pitch): list_open_tabs, snapshot, click.
 * Expand as needed — adding a tool here + a matching handler in the extension
 * is the full pattern.
 */
import { z } from "zod";
import type { BridgeServer } from "./ws-server.js";

export interface ToolDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (bridge: BridgeServer, args: z.infer<S>) => Promise<unknown>;
}

function def<S extends z.ZodTypeAny>(d: ToolDef<S>): ToolDef<any> { return d as ToolDef<any>; }

// ─────────────────────────── schemas ───────────────────────────

const ListOpenTabs = z.object({
  url_contains: z.string().optional().describe("Optional substring filter on tab URL (case-insensitive)."),
});

const Snapshot = z.object({
  tab_id: z.number().int().describe("Chrome tab ID (integer from list_open_tabs)."),
});

const Click = z.object({
  tab_id: z.number().int(),
  selector: z.string().describe("CSS selector for the element to click. Must resolve to exactly one node."),
});

const Ping = z.object({});

// ─────────────────────────── definitions ───────────────────────────

export const TOOLS: ToolDef[] = [
  def({
    name: "bridge_status",
    description:
      "Check whether the AutoStore Chrome extension is connected and responsive. " +
      "Use this first when a session starts — if it returns connected:false, prompt the user " +
      "to install or enable the extension before trying anything else.",
    schema: Ping,
    async handler(bridge) {
      return { connected: bridge.isConnected() };
    },
  }),
  def({
    name: "list_open_tabs",
    description:
      "List every tab open in the user's Chrome, with tab_id, url, title, and active flag. " +
      "Use this to find an existing logged-in tab (e.g. an eBay Seller Hub tab) rather than opening a new one.",
    schema: ListOpenTabs,
    async handler(bridge, args) {
      return await bridge.call("list_open_tabs", args);
    },
  }),
  def({
    name: "snapshot",
    description:
      "Get the ARIA accessibility snapshot of the given tab as YAML. Prefer this over screenshots " +
      "for reasoning about page structure — fits in a single LLM turn where a PNG wouldn't.",
    schema: Snapshot,
    async handler(bridge, args) {
      return await bridge.call("snapshot", args);
    },
  }),
  def({
    name: "click",
    description:
      "Click an element in the given tab by CSS selector. The selector must match exactly one node. " +
      "For buttons with variable text, prefer stable attributes (aria-label, data-testid) over text content.",
    schema: Click,
    async handler(bridge, args) {
      return await bridge.call("click", args);
    },
  }),
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}
