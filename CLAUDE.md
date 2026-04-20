# autostore-in-chrome

**Chrome extension + local MCP bridge that lets the AutoStore agent drive the
user's real Chrome** — no separate Playwright browser, no cookie transplant,
no fresh logins. Alongside `browser-mcp` (which gives the LLM a *scripted*
Chromium), this gives it the user's *actual* Chrome with all its existing
sessions.

## When to use which

| | browser-mcp | autostore-in-chrome |
|---|---|---|
| Headless / CI / cron | ✅ | ❌ Chrome must be running |
| Day-to-day listing work alongside a human | OK | ✅ preferred |
| Fresh machine, no login state | ✅ (scripted login helper) | ❌ needs user's Chrome logged in |
| Anti-bot fingerprint | Playwright (gets flagged sometimes) | Real Chrome (never flagged) |
| Reuses 1688 / eBay / Amazon / Etsy existing logins | ❌ (must re-login per profile) | ✅ zero setup |

Agents should try `autostore-in-chrome` first and fall back to `browser-mcp`
when the bridge reports `connected:false`.

## Architecture

```
┌─────────────────┐  stdio (MCP)  ┌──────────────────┐  ws://127.0.0.1:43117  ┌────────────────────┐
│ Claude Code /   │ ────────────▶ │  bridge (Node)   │ ◀───────────────────── │ Chrome extension   │
│ Mac app agent   │               │  — this repo     │                        │ service worker     │
└─────────────────┘               └──────────────────┘                        └────────────────────┘
                                           ▲                                             │
                                           │                                             │ chrome.debugger / chrome.tabs
                                   token in ~/.autostore-in-chrome/token                 ▼
                                                                                   user's real tabs
```

1. **bridge/** — Node process. Stdio MCP server on one side, localhost
   WebSocket on the other. Generates an auth token on first run under
   `~/.autostore-in-chrome/token` (0600 perms). Never binds to 0.0.0.0.
2. **extension/** — MV3 Chrome extension. Service worker connects to the
   bridge on 127.0.0.1 with the token. Handles RPC calls by dispatching to
   `chrome.tabs`, `chrome.scripting`, `chrome.debugger`.

## Wire protocol

Symmetric JSON messages over WS:

```ts
{ type: "hello", token, chromeVersion }            // extension → bridge
{ type: "hello-ack", bridgeVersion }               // bridge → extension
{ type: "rpc-request", id, method, params }        // bridge → extension
{ type: "rpc-response", id, ok, result|error }     // extension → bridge
```

## Tools (MVP)

| Tool | Purpose |
|------|---------|
| `bridge_status` | Is an extension connected? Use first when the session starts. |
| `list_open_tabs` | Every tab in the user's Chrome, optionally filtered by URL substring. |
| `snapshot` | ARIA accessibility tree of a tab as YAML. |
| `click` | Click a single CSS-selected element in a tab. |

More follow the same pattern — add a tool def in `bridge/src/tools.ts`, add
a handler branch in `extension/service-worker.js → dispatch()`.

## Setup

### Bridge

```bash
cd bridge
npm install
npm run build
node dist/index.js       # stdio MCP — does nothing alone
```

Register with Claude Code:

```bash
claude mcp add -s user autostore-in-chrome node /Users/jameswalstonn/Documents/autostore/in-chrome/bridge/dist/index.js
```

### Extension (dev — unpacked)

1. `chrome://extensions/` → **Developer mode** ON
2. **Load unpacked** → pick `in-chrome/extension/`
3. Click the extension icon in the toolbar → popup opens
4. Paste the token from `cat ~/.autostore-in-chrome/token` → Save & connect
5. Badge should go green (**ON**)

## Security

- WS binds **127.0.0.1 only**. Loopback is the trust boundary.
- Token is 32-byte random hex. 0600 perms. Both sides must match or handshake fails.
- Extension has `debugger` permission, which Chrome flags to the user at install
  time (yellow "Debugging" banner across the top). That's the price for CDP
  access. Same permission Playwright uses.

## Mac app integration (future)

The AutoStore Mac app is the natural installer:
- Bundles extension + bridge binary.
- Auto-spawns bridge on app launch.
- Shows the token in a copy-to-clipboard UI for the user to paste into the
  extension popup once.
- Badge status is surfaced in the Mac app's main status bar.

## File layout

```
in-chrome/
  bridge/
    src/
      index.ts        — MCP stdio entry
      ws-server.ts    — localhost WebSocket + RPC to extension
      tools.ts        — MCP tool defs, forward to bridge.call()
      handshake.ts    — token + port management
    package.json
    tsconfig.json
  extension/
    manifest.json     — MV3, minimal permissions
    service-worker.js — WS client + chrome.* dispatchers
    popup.html
    popup.js          — token/port config UI
    icon128.png
  CLAUDE.md
  .gitignore
```
