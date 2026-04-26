/**
 * Popup: shows a "Continue with Deakee" button. Delegates the actual OAuth
 * flow to the service worker (because Chrome closes popups when they lose
 * focus, which would kill the await chain when the OAuth window opens).
 *
 * States:
 *  1. Logged out  — show button, send {type:"login_with_deakee"} to SW
 *  2. Logged in   — show user badge + logout + daemon connection status
 *
 * The popup also listens for chrome.storage changes so the UI flips to
 * logged-in even when the OAuth completed while this popup was closed.
 */

const DEFAULT_BACKEND  = "https://api.spriterock.com";

// ─── DOM refs ──────────────────────────────────────────────
const $loginSection    = document.getElementById("login-section");
const $loggedInSection = document.getElementById("logged-in-section");
const $backendUrl      = document.getElementById("backend-url");
const $advancedToggle  = document.getElementById("advanced-toggle");
const $advancedSection = document.getElementById("advanced-section");
const $errorMsg        = document.getElementById("error-msg");
const $loginBtn        = document.getElementById("login");
const $logoutBtn       = document.getElementById("logout");
const $status          = document.getElementById("status");
const $userName        = document.getElementById("user-name");
const $userEmail       = document.getElementById("user-email");
const $avatarInitial   = document.getElementById("avatar-initial");

// ─── Advanced toggle ───────────────────────────────────────
$advancedToggle.addEventListener("click", () => {
  const visible = $advancedSection.classList.toggle("visible");
  $advancedToggle.textContent = visible ? "Advanced ▾" : "Advanced ▸";
});

// ─── Status helpers ────────────────────────────────────────
function setStatus(text, type = "warn") {
  $status.textContent = text;
  $status.className = `status ${type}`;
}

function setError(msg) {
  $errorMsg.textContent = msg;
}

// ─── State sync ────────────────────────────────────────────
async function syncFromStorage() {
  const { autoStoreJwt, autoStoreUser, autoStoreBackend } =
    await chrome.storage.local.get(["autoStoreJwt", "autoStoreUser", "autoStoreBackend"]);

  $backendUrl.value = autoStoreBackend || DEFAULT_BACKEND;

  if (autoStoreJwt && autoStoreUser) {
    showLoggedIn(autoStoreUser);
  } else {
    showLoggedOut();
  }
  await refreshStatus();
}

function showLoggedIn(user) {
  $loginSection.style.display    = "none";
  $loggedInSection.style.display = "block";
  $userName.textContent          = user.name  || user.email || "AutoStore";
  $userEmail.textContent         = user.email || "";
  $avatarInitial.textContent     = ((user.name || user.email || "A")[0] || "A").toUpperCase();
}

function showLoggedOut() {
  $loginSection.style.display    = "block";
  $loggedInSection.style.display = "none";
  $errorMsg.textContent          = "";
}

// React to storage changes — handles the "popup closed mid-OAuth" case.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoStoreJwt || changes.autoStoreUser) {
    syncFromStorage();
  }
});

// ─── Deakee OAuth login (delegated to SW) ──────────────────
$loginBtn.addEventListener("click", async () => {
  const backend = ($backendUrl.value.trim() || DEFAULT_BACKEND).replace(/\/$/, "");
  await chrome.storage.local.set({ autoStoreBackend: backend });

  $loginBtn.disabled    = true;
  $loginBtn.textContent = "Opening Deakee…";
  setError("");

  try {
    // SW does the OAuth — popup may close during this, that's fine.
    const result = await chrome.runtime.sendMessage({ type: "login_with_deakee" });
    if (!result?.ok) throw new Error(result?.error || "Login failed");
    // Storage observer will flip the UI.
  } catch (e) {
    const msg = e?.message || "";
    if (!msg.toLowerCase().includes("cancel")) {
      setError(msg || "Sign in failed.");
    }
  } finally {
    $loginBtn.disabled    = false;
    $loginBtn.textContent = "Continue with Deakee";
  }
});

// ─── Logout ────────────────────────────────────────────────
$logoutBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove([
    "bridgeToken", "bridgePort", "autoStoreJwt", "autoStoreUser"
  ]);
  showLoggedOut();
  setStatus("Signed out. Daemon disconnected.", "warn");
});

// ─── Live status poll ──────────────────────────────────────
async function refreshStatus() {
  const text = await chrome.action.getBadgeText({});
  if (text === "ON") {
    setStatus("✅ Connected — browser control active", "ok");
  } else if (text === "OFF") {
    const { autoStoreJwt } = await chrome.storage.local.get("autoStoreJwt");
    setStatus(
      autoStoreJwt
        ? "⚠ Daemon not running. Start AutoStore on this Mac."
        : "Sign in to connect.",
      "warn"
    );
  } else {
    setStatus("Connecting…", "warn");
  }
}

// ─── Boot ──────────────────────────────────────────────────
syncFromStorage();
setInterval(refreshStatus, 2000);
