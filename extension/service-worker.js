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
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
      console.log("[autostore-in-chrome] handshake OK, daemon v" + (msg.daemonVersion ?? "?"));
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
    case "open_url":       return openUrl(params);
    case "type":           return typeInto(params);
    case "eval":           return evalInPage(params);
    default: throw new Error(`unknown method: ${method}`);
  }
}

async function listOpenTabs({ urlContains } = {}) {
  const tabs = await chrome.tabs.query({});
  const filtered = urlContains
    ? tabs.filter((t) => (t.url ?? "").toLowerCase().includes(urlContains.toLowerCase()))
    : tabs;
  return filtered.map((t) => ({
    tabId: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
}

/**
 * ARIA snapshot via the debugger protocol. Playwright-style YAML output
 * isn't available in pure CDP, so we walk the accessibility tree and
 * emit a compact YAML-ish format ourselves.
 */
async function snapshot({ tabId }) {
  const debuggee = { tabId };
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

async function click({ tabId, selector }) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
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

async function openUrl({ url, tabId } = {}) {
  if (!url) throw new Error("open_url: url required");
  let tab;
  if (typeof tabId === "number") {
    tab = await chrome.tabs.update(tabId, { url, active: true });
  } else {
    tab = await chrome.tabs.create({ url, active: true });
  }
  // Wait until the tab is done loading (or until 20s).
  await new Promise((resolve) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdate); resolve(); }, 20_000);
    function onUpdate(id, info) {
      if (id === tab.id && info.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(onUpdate);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
  // Refetch to get the final URL (redirects may have happened).
  const finalTab = await chrome.tabs.get(tab.id);
  return { tabId: finalTab.id, url: finalTab.url, title: finalTab.title };
}

/**
 * Fill a text field in the page. Works with plain <input> / <textarea> AND
 * contenteditable divs (Wangwang uses the latter). Dispatches input events so
 * React/Vue re-render.
 */
async function typeInto({ tabId, selector, text, append, submit } = {}) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, text, append, submit) => {
      const els = document.querySelectorAll(sel);
      if (els.length === 0) return { ok: false, error: `no element matches ${sel}` };
      if (els.length > 1)  return { ok: false, error: `${els.length} elements match ${sel} — must be exactly one` };
      const el = els[0];
      el.scrollIntoView({ behavior: "instant", block: "center" });
      el.focus?.();
      const tag = el.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") {
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
        const newVal = append ? (el.value || "") + text : text;
        setter.call(el, newVal);
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        if (!append) el.innerHTML = "";
        // Insert text at caret for better compatibility with rich editors.
        document.execCommand?.("insertText", false, text);
        if (!el.innerText.includes(text)) {
          // Fallback for editors that swallow execCommand.
          el.textContent = (append ? (el.textContent || "") : "") + text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
        }
      } else {
        return { ok: false, error: `element is not an input/textarea/contenteditable (tag=${tag})` };
      }
      if (submit) {
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, {
            key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
          }));
        }
      }
      return { ok: true };
    },
    args: [selector, text, !!append, !!submit],
  });
  if (!result?.ok) throw new Error(result?.error ?? "type failed");
  return { typed: selector, length: text.length };
}

/**
 * Run arbitrary JS in the page's main world. Expression is wrapped so a
 * bare expression returns its value — same semantics as DevTools console.
 * Return value must be JSON-serializable.
 */
async function evalInPage({ tabId, expression }) {
  const [{ result, error }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (expr) => {
      try {
        // eslint-disable-next-line no-new-func
        let v = new Function(`return (${expr});`)();
        // If the expression returned a Promise, await it so callers can run async logic.
        if (v && typeof v.then === "function") v = await v;
        return { ok: true, value: v === undefined ? null : v };
      } catch (e) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
    args: [expression],
  });
  if (error) throw new Error(error);
  if (!result?.ok) throw new Error(result?.error ?? "eval failed");
  return { value: result.value };
}

// ─────────────────────────── lifecycle ───────────────────────────

chrome.runtime.onInstalled.addListener(() => { connect(); ensureKeepaliveAlarm(); });
chrome.runtime.onStartup.addListener(() => { connect(); ensureKeepaliveAlarm(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.bridgeToken || changes.bridgePort)) {
    // Reconnect with new credentials.
    if (ws) try { ws.close(); } catch { /* ignore */ }
    connect();
  }
});

// ─────────────────────────── MV3 keepalive ───────────────────────────
// MV3 service workers get suspended after ~30s of inactivity, which
// silently drops our WS. Two defenses running in parallel:
//
//   1. chrome.alarms fires every 25s. Each alarm event wakes the SW if
//      it was suspended and re-runs the handler, which reconnects the
//      WS if it's not OPEN. Minimum period in unpacked is 30s, but Chrome
//      rounds ours up and we still get at-most 30s cold windows.
//
//   2. When the WS is open, we also send a "ping" frame every 20s.
//      Incoming messages reset the SW idle timer, so the daemon will
//      write a pong back that keeps us hot between alarm fires.
//
// Either mechanism alone is insufficient — together the extension stays
// connected indefinitely.

const KEEPALIVE_ALARM = "autostore-in-chrome-keepalive";

function ensureKeepaliveAlarm() {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Reconnect if WS is dead; no-op if it's healthy.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
  } else {
    try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* ignore */ }
  }
});

// Kick it off once at worker boot.
ensureKeepaliveAlarm();
connect();
