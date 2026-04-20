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
  /** Open a URL. If tabId is given, navigate that tab; otherwise create a new one. */
  open_url: z.object({
    url: z.string().url(),
    tabId: z.number().int().optional(),
  }),
  /** Fill a text field matched by CSS selector. Replaces existing value by default. */
  type: z.object({
    tabId: z.number().int(),
    selector: z.string().min(1),
    text: z.string(),
    append: z.boolean().optional(),
    /** After typing, also dispatch the Enter key (useful for chat send). */
    submit: z.boolean().optional(),
  }),
  /** Run a JS expression in the page context. Returns the result (must be JSON-serializable). */
  eval: z.object({
    tabId: z.number().int(),
    expression: z.string().min(1),
  }),
  /**
   * Find (optionally in all frames) a visible element by partial visible text.
   * Returns label, bounding rect, and total match count. Walks open shadow roots.
   * Use this instead of crafting selectors against React-rendered pages.
   */
  find_by_text: z.object({
    tabId: z.number().int(),
    text: z.string().min(1),
    tag: z.string().optional(),
    nth: z.number().int().nonnegative().optional(),
    frameUrlContains: z.string().optional(),
  }),
  /** Find element by partial visible text and click it. Walks open shadow roots. */
  click_by_text: z.object({
    tabId: z.number().int(),
    text: z.string().min(1),
    tag: z.string().optional(),
    nth: z.number().int().nonnegative().optional(),
    frameUrlContains: z.string().optional(),
  }),
  /**
   * Atomic fill-and-submit for modals / inline edit dialogs. Locates an input
   * (by CSS selector OR by nearby label text), sets its value React-safely,
   * clicks the submit button (by visible text, substring match), waits for the
   * side effect, and returns a ground-truth snapshot (title, URL, whether a
   * dialog is still open, head of page text). Use this for eBay "Edit quantity"
   * / "Edit price" / any single-field modal — one call, no skipped steps.
   */
  fill_submit: z.object({
    tabId: z.number().int(),
    selector: z.string().optional(),
    nearLabel: z.string().optional(),
    value: z.string(),
    submitText: z.string().optional(),
    submitTag: z.string().optional(),
  }),
  /**
   * Computer-use actions — drive the browser like a human via CDP input events.
   *
   * Actions:
   *   screenshot   — capture PNG of the tab (returns base64 data)
   *   left_click   — click at coordinate
   *   right_click  — right-click at coordinate
   *   double_click — double-click at coordinate
   *   mouse_move   — move pointer without clicking
   *   left_click_drag — drag from coordinate to end_coordinate
   *   type         — type a string (dispatches key events character by character)
   *   key          — press a keyboard shortcut, e.g. "Enter", "ctrl+c", "ctrl+shift+t"
   *   scroll       — scroll at coordinate in a direction by scroll_amount ticks
   */
  computer: z.object({
    tabId: z.number().int(),
    action: z.enum([
      "screenshot",
      "left_click", "right_click", "middle_click", "double_click",
      "mouse_move", "left_click_drag",
      "type", "key",
      "scroll",
    ]),
    coordinate:     z.tuple([z.number(), z.number()]).optional(),
    end_coordinate: z.tuple([z.number(), z.number()]).optional(),
    text:             z.string().optional(),
    key:              z.string().optional(),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount:    z.number().optional(),
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
