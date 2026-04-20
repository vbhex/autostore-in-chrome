/**
 * Popup: email + password login → calls AutoStore backend → exchanges JWT for
 * daemon bridge token → saves to chrome.storage and triggers WS reconnect.
 *
 * States:
 *  1. Logged out  — show login form
 *  2. Logged in   — show user badge + logout button + daemon connection status
 */

const DEFAULT_BACKEND = "https://api.spriterock.com";
const DEFAULT_PORT    = 43117;

// ─── DOM refs ──────────────────────────────────────────────
const $loginSection    = document.getElementById("login-section");
const $loggedInSection = document.getElementById("logged-in-section");
const $email           = document.getElementById("email");
const $password        = document.getElementById("password");
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

// ─── Load saved state ──────────────────────────────────────
async function init() {
  const { bridgeToken, bridgePort, autoStoreJwt, autoStoreUser, autoStoreBackend } =
    await chrome.storage.local.get([
      "bridgeToken", "bridgePort", "autoStoreJwt", "autoStoreUser", "autoStoreBackend"
    ]);

  // Pre-fill backend URL
  $backendUrl.value = autoStoreBackend ?? DEFAULT_BACKEND;

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
  $userName.textContent          = user.name  ?? user.email ?? "AutoStore";
  $userEmail.textContent         = user.email ?? "";
  $avatarInitial.textContent     = (user.name ?? user.email ?? "A")[0].toUpperCase();
}

function showLoggedOut() {
  $loginSection.style.display    = "block";
  $loggedInSection.style.display = "none";
  $errorMsg.textContent          = "";
}

// ─── Login flow ────────────────────────────────────────────
$loginBtn.addEventListener("click", async () => {
  const email    = $email.value.trim();
  const password = $password.value;
  const backend  = ($backendUrl.value.trim() || DEFAULT_BACKEND).replace(/\/$/, "");

  if (!email || !password) {
    setError("Please enter your email and password.");
    return;
  }

  $loginBtn.disabled    = true;
  $loginBtn.textContent = "Signing in…";
  setError("");

  try {
    // 1. Authenticate with AutoStore backend (/api prefix required)
    const loginRes = await fetch(`${backend}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (!loginRes.ok) {
      const err = await loginRes.json().catch(() => ({}));
      throw new Error(err.message ?? `Login failed (${loginRes.status})`);
    }

    const { access_token: jwt, user } = await loginRes.json();

    // 2. Exchange JWT for the local daemon bridge token
    const port = DEFAULT_PORT;
    const authRes = await fetch(`http://127.0.0.1:${port}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt }),
    });

    if (!authRes.ok) {
      const err = await authRes.json().catch(() => ({}));
      throw new Error(
        authRes.status === 401
          ? `Invalid credentials. ${err.error ?? "Please check your email and password."}`
          : err.error ?? `Daemon auth failed (${authRes.status})`
      );
    }

    const { token: bridgeToken } = await authRes.json();

    // 3. Persist everything and trigger service worker reconnect
    await chrome.storage.local.set({
      bridgeToken,
      bridgePort: port,
      autoStoreJwt: jwt,
      autoStoreUser: user,
      autoStoreBackend: backend,
    });

    // Kick the service worker to reconnect immediately
    chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});

    showLoggedIn(user);
    setStatus("✅ Connected to daemon", "ok");
  } catch (e) {
    setError(e.message ?? "Sign in failed.");
  } finally {
    $loginBtn.disabled    = false;
    $loginBtn.textContent = "Sign in";
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
  // Check daemon badge from service worker
  const text = await chrome.action.getBadgeText({});
  if (text === "ON") {
    setStatus("✅ Connected — browser control active", "ok");
  } else if (text === "OFF") {
    const { autoStoreJwt } = await chrome.storage.local.get("autoStoreJwt");
    if (autoStoreJwt) {
      setStatus("⚠ Daemon not running. Start AutoStore on this Mac.", "warn");
    } else {
      setStatus("Sign in to connect.", "warn");
    }
  } else {
    setStatus("Connecting…", "warn");
  }
}

// ─── Boot ──────────────────────────────────────────────────
init();
setInterval(refreshStatus, 2000);
