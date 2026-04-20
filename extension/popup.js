/**
 * Popup: lets the user paste the bridge token and port, saves them to
 * chrome.storage.local (which triggers the service worker to reconnect),
 * and shows live connection status.
 */
const $token = document.getElementById("token");
const $port = document.getElementById("port");
const $status = document.getElementById("status");
const $save = document.getElementById("save");
const $clear = document.getElementById("clear");

async function refresh() {
  const { bridgeToken, bridgePort } = await chrome.storage.local.get(["bridgeToken", "bridgePort"]);
  $token.value = bridgeToken ?? "";
  $port.value = String(bridgePort ?? 43117);
  // Badge text == extension status; surface it here too.
  const text = await chrome.action.getBadgeText({});
  $status.textContent = text === "ON"
    ? "✅ connected to bridge"
    : text === "OFF"
      ? "⚠ not connected. Start the bridge and re-save."
      : "… connecting";
}

$save.addEventListener("click", async () => {
  const t = $token.value.trim();
  const p = Number($port.value.trim()) || 43117;
  await chrome.storage.local.set({ bridgeToken: t, bridgePort: p });
  $status.textContent = "… reconnecting";
  setTimeout(refresh, 800);
});

$clear.addEventListener("click", async () => {
  await chrome.storage.local.remove(["bridgeToken", "bridgePort"]);
  $token.value = "";
  $port.value = "43117";
  $status.textContent = "disconnected";
});

refresh();
setInterval(refresh, 2000);
