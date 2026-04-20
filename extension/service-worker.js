/**
 * AutoStore in-Chrome extension — service worker.
 *
 * Maintains a persistent WS connection to the local bridge. Handles RPC
 * requests by calling chrome.* APIs on the user's real tabs.
 *
 * Flow:
 *   1. User installs extension and opens the popup once — paste bridge token
 *      (read from ~/.autostore-in-chrome/token on their machine, shown to
 *      them by the Mac app or the bridge's first-run message).
 *   2. Popup saves token to chrome.storage.local.
 *   3. Service worker connects to ws://127.0.0.1:43117, sends {type:"hello", token}.
 *   4. Bridge replies with {type:"hello-ack"}, then fires rpc-request messages
 *      whenever an MCP tool is called.
 *   5. Service worker dispatches by method, runs the chrome.* API, sends back
 *      rpc-response.
 *
 * Reconnection: if the WS drops (bridge restarted, sleep/wake, etc.) we back
 * off and retry. The user doesn't need to do anything.
 */

const DEFAULT_PORT = 43117;

// MV3 service workers can be suspended. Keep state in chrome.storage, not globals.
let ws = null;
let reconnectTimer = null;
let connectAttempt = 0;

async function getConfig() {
  const { bridgeToken, bridgePort } = await chrome.storage.local.get(["bridgeToken", "bridgePort"]);
  return { token: bridgeToken ?? "", port: bridgePort ?? DEFAULT_PORT };
}

async function connect() {
  clearTimeout(reconnectTimer);
  const { token, port } = await getConfig();
  if (!token) {
    console.log("[autostore-in-chrome] no bridge token configured — open the popup and paste it.");
    scheduleReconnect(10_000);
    return;
  }

  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    console.warn("[autostore-in-chrome] WS construct failed:", e);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    console.log("[autostore-in-chrome] WS open — sending hello");
    connectAttempt = 0;
    ws.send(JSON.stringify({
      type: "hello",
      token,
      chromeVersion: navigator.userAgent.match(/Chrome\/(\S+)/)?.[1] ?? "unknown",
    }));
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); }
    catch { return; }
    if (msg.type === "hello-ack") {
      console.log("[autostore-in-chrome] handshake OK, bridge v" + msg.bridgeVersion);
      setBadge("ON", "#1db954");
      return;
    }
    if (msg.type === "rpc-request") handleRpc(msg).catch((e) => sendRpcError(msg.id, e));
  });

  ws.addEventListener("close", () => {
    console.log("[autostore-in-chrome] WS closed");
    ws = null;
    setBadge("OFF", "#d33");
    scheduleReconnect();
  });

  ws.addEventListener("error", (e) => {
    console.warn("[autostore-in-chrome] WS error:", e);
    // `close` will follow; handle there.
  });
}

function scheduleReconnect(ms) {
  connectAttempt += 1;
  const delay = ms ?? Math.min(30_000, 500 * Math.pow(2, connectAttempt));
  reconnectTimer = setTimeout(connect, delay);
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ─────────────────────────── RPC handlers ───────────────────────────

async function handleRpc(msg) {
  const { id, method, params } = msg;
  try {
    const result = await dispatch(method, params ?? {});
    ws?.send(JSON.stringify({ type: "rpc-response", id, ok: true, result }));
  } catch (e) {
    sendRpcError(id, e);
  }
}

function sendRpcError(id, err) {
  ws?.send(JSON.stringify({
    type: "rpc-response",
    id,
    ok: false,
    error: err?.message ?? String(err),
  }));
}

async function dispatch(method, params) {
  switch (method) {
    case "list_open_tabs": return listOpenTabs(params);
    case "snapshot":       return snapshot(params);
    case "click":          return click(params);
    default: throw new Error(`unknown method: ${method}`);
  }
}

async function listOpenTabs({ url_contains } = {}) {
  const tabs = await chrome.tabs.query({});
  const filtered = url_contains
    ? tabs.filter((t) => (t.url ?? "").toLowerCase().includes(url_contains.toLowerCase()))
    : tabs;
  return filtered.map((t) => ({
    tab_id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    window_id: t.windowId,
  }));
}

/**
 * ARIA snapshot via the debugger protocol. Playwright-style YAML output
 * isn't available in pure CDP, so we walk the accessibility tree and
 * emit a compact YAML-ish format ourselves.
 */
async function snapshot({ tab_id }) {
  const debuggee = { tabId: tab_id };
  await chrome.debugger.attach(debuggee, "1.3");
  try {
    await chrome.debugger.sendCommand(debuggee, "Accessibility.enable");
    const { nodes } = await chrome.debugger.sendCommand(debuggee, "Accessibility.getFullAXTree");
    return { snapshot: renderAxTree(nodes) };
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch { /* ignore */ }
  }
}

function renderAxTree(nodes) {
  // Build child-index, then DFS from the root.
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => !n.parentId);
  const lines = [];
  for (const r of roots) walk(r, 0);
  return lines.join("\n");

  function walk(n, depth) {
    const ignored = n.ignored;
    if (!ignored) {
      const role = n.role?.value ?? "node";
      const name = n.name?.value ?? "";
      const label = name ? `${role} "${truncate(name, 80)}"` : role;
      lines.push(`${"  ".repeat(depth)}- ${label}`);
    }
    for (const cid of n.childIds ?? []) {
      const c = byId.get(cid);
      if (c) walk(c, ignored ? depth : depth + 1);
    }
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function click({ tab_id, selector }) {
  const [{ result, success }] = await chrome.scripting.executeScript({
    target: { tabId: tab_id },
    func: (sel) => {
      const els = document.querySelectorAll(sel);
      if (els.length === 0) return { success: false, error: `no element matches ${sel}` };
      if (els.length > 1)  return { success: false, error: `${els.length} elements match ${sel} — must be exactly one` };
      const el = els[0];
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.click();
      return { success: true };
    },
    args: [selector],
  });
  if (!result?.success) throw new Error(result?.error ?? "click failed");
  return { clicked: selector };
}

// ─────────────────────────── lifecycle ───────────────────────────

chrome.runtime.onInstalled.addListener(() => { connect(); });
chrome.runtime.onStartup.addListener(() => { connect(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bridgeToken || changes.bridgePort)) {
    // Reconnect with new credentials.
    if (ws) try { ws.close(); } catch { /* ignore */ }
    connect();
  }
});

// Kick it off once at worker boot.
connect();
