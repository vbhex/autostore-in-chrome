#!/usr/bin/env node
/**
 * autostore-in-chrome bridge — MCP stdio server that forwards tool calls to
 * the AutoStore Chrome extension over a localhost WebSocket.
 *
 * Layout when running:
 *   MCP client (Claude Code, Mac app)
 *       │  stdio
 *       ▼
 *   this process (bridge)
 *       │  ws://127.0.0.1:43117
 *       ▼
 *   Chrome extension service worker
 *       │  chrome.debugger / chrome.tabs APIs
 *       ▼
 *   user's real Chrome tabs
 *
 * Run: `node dist/index.js` — stdin/stdout is MCP, nothing else to configure.
 *
 * Env:
 *   AUTOSTORE_CHROME_PORT=43117    Override WS port (must match extension setting).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BridgeServer } from "./ws-server.js";
import { TOOLS, toolByName } from "./tools.js";
import { loadOrCreateToken, DEFAULT_PORT } from "./handshake.js";

const VERSION = "0.1.0";

const token = loadOrCreateToken();
const port = Number(process.env.AUTOSTORE_CHROME_PORT) || DEFAULT_PORT;
const bridge = new BridgeServer({ token, port, version: VERSION });

const server = new Server(
  { name: "autostore-in-chrome", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema, { target: "openApi3" }) as any,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params;
  const tool = toolByName(name);
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
  }
  try {
    const args = tool.schema.parse(rawArgs ?? {});
    const result = await tool.handler(bridge, args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `${name} failed: ${err.message ?? err}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[bridge] autostore-in-chrome v${VERSION} ready (port ${port})\n`);
  process.stderr.write(`[bridge] waiting for Chrome extension to connect...\n`);
}

async function shutdown() {
  try { bridge.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  process.stderr.write(`fatal: ${e.stack ?? e}\n`);
  process.exit(1);
});
