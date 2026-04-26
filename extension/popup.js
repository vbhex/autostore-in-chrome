/**
 * Popup: shows pairing status with the local AutoStore Mac app daemon.
 *
 * No login UI — the daemon's GET /pair endpoint hands out a bridge token
 * + the user identity (which the Mac app wrote after Deakee OAuth).
 *
 * States:
 *   1. Waiting   — daemon not reachable. Show "Start AutoStore" hint.
 *   2. Paired    — daemon returned a token + user. Show user badge.
 */

// ─── DOM refs ──────────────────────────────────────────────
const $loginSection    = document.getElementById("login-section");
const $loggedInSection = document.getElementById("logged-in-section");
const $logoutBtn       = document.getElementById("logout");
const $status          = document.getElementById("status");
const $userName        = document.getElementById("user-name");
const $userEmail       = document.getElementById("user-email");
const $avatarInitial   = document.getElementById("avatar-initial");

// ─── Status helpers ────────────────────────────────────────
function setStatus(text, type = "warn") {
  $status.textContent = text;
  $status.className = `status ${type}`;
}

// ─── State sync ────────────────────────────────────────────
async function syncFromStorage() {
  const { autoStoreUser, bridgeToken } =
    await chrome.storage.local.get(["autoStoreUser", "bridgeToken"]);

  if (autoStoreUser && bridgeToken) {
    showPaired(autoStoreUser);
  } else {
    showWaiting();
  }
  await refreshStatus();
}

function showPaired(user) {
  $loginSection.style.display    = "none";
  $loggedInSection.style.display = "block";
  $userName.textContent          = user.name  || user.email || "AutoStore";
  $userEmail.textContent         = user.email || "";
  $avatarInitial.textContent     = ((user.name || user.email || "A")[0] || "A").toUpperCase();
}

function showWaiting() {
  $loginSection.style.display    = "block";
  $loggedInSection.style.display = "none";
}

// React to storage changes — covers the "paired while popup open" case.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoStoreUser || changes.bridgeToken) {
    syncFromStorage();
  }
});

// ─── Forget device (clears local pairing only) ────────────
$logoutBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove([
    "bridgeToken", "bridgePort", "autoStoreJwt", "autoStoreUser"
  ]);
  showWaiting();
  setStatus("Forgotten. Restart AutoStore on this Mac to pair again.", "warn");
});

// ─── Live status poll ──────────────────────────────────────
async function refreshStatus() {
  const text = await chrome.action.getBadgeText({});
  if (text === "ON") {
    setStatus("✅ Connected — browser control active", "ok");
  } else if (text === "OFF") {
    const { autoStoreUser } = await chrome.storage.local.get("autoStoreUser");
    setStatus(
      autoStoreUser
        ? "⚠ Daemon stopped. Start AutoStore on this Mac."
        : "Waiting for AutoStore Mac app…",
      "warn"
    );
  } else {
    setStatus("Connecting…", "warn");
  }
}

// ─── Boot ──────────────────────────────────────────────────
// Ask SW to attempt an unauthenticated pair against the local daemon.
// Succeeds the moment the Mac app is running. Storage observer picks up
// the result and flips the UI to the paired state.
chrome.runtime.sendMessage({ type: "try_pair" }).catch(() => {}).finally(syncFromStorage);
setInterval(() => {
  // Re-attempt pairing every 3s while popup is open — covers "started Mac
  // app right after opening popup" race.
  chrome.runtime.sendMessage({ type: "try_pair" }).catch(() => {});
  refreshStatus();
}, 3000);
