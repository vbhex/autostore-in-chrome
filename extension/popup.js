/**
 * Popup: Deakee OAuth2 login → exchanges code for AutoStore JWT →
 * exchanges JWT for daemon bridge token → saves to chrome.storage.
 *
 * States:
 *  1. Logged out  — show "Continue with Deakee" button
 *  2. Logged in   — show user badge + logout + daemon status
 */

const DEFAULT_BACKEND  = "https://api.spriterock.com";
const DEFAULT_PORT     = 43117;
const DEAKEE_AUTH_URL  = "https://deakee.com/en/auth/oauth/authorize";
const OAUTH_CLIENT_ID  = "autostore";
const OAUTH_SCOPE      = "profile";

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

// ─── Load saved state ──────────────────────────────────────
async function init() {
  const { autoStoreJwt, autoStoreUser, autoStoreBackend } =
    await chrome.storage.local.get(["autoStoreJwt", "autoStoreUser", "autoStoreBackend"]);

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

// ─── Deakee OAuth2 login ───────────────────────────────────
$loginBtn.addEventListener("click", async () => {
  const backend = ($backendUrl.value.trim() || DEFAULT_BACKEND).replace(/\/$/, "");

  $loginBtn.disabled    = true;
  $loginBtn.textContent = "Opening Deakee…";
  setError("");

  try {
    // The chromiumapp.org redirect URL is unique to this extension and
    // is registered in Deakee's oauth2_apps table.
    const redirectURL = chrome.identity.getRedirectURL();

    const state = Math.random().toString(36).slice(2);
    const params = new URLSearchParams({
      client_id:     OAUTH_CLIENT_ID,
      redirect_uri:  redirectURL,
      response_type: "code",
      scope:         OAUTH_SCOPE,
      state,
    });
    const authURL = `${DEAKEE_AUTH_URL}?${params}`;

    // Open Deakee consent page in a browser popup and wait for callback
    const responseURL = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authURL, interactive: true },
        (url) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!url) {
            reject(new Error("Login cancelled"));
          } else {
            resolve(url);
          }
        }
      );
    });

    // Extract code from the callback URL
    const cbParams = new URL(responseURL).searchParams;
    const code = cbParams.get("code");
    if (!code) throw new Error("No authorization code received from Deakee");

    $loginBtn.textContent = "Signing in…";

    // 1. Exchange code → AutoStore JWT via backend
    const exchangeRes = await fetch(`${backend}/api/auth/deakee/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirectURL }),
    });

    if (!exchangeRes.ok) {
      const err = await exchangeRes.json().catch(() => ({}));
      throw new Error(err.message ?? `Token exchange failed (${exchangeRes.status})`);
    }

    const { access_token: jwt, user } = await exchangeRes.json();

    // 2. Exchange JWT for the local daemon bridge token
    const port = DEFAULT_PORT;
    let bridgeToken = null;
    try {
      const authRes = await fetch(`http://127.0.0.1:${port}/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jwt }),
      });
      if (authRes.ok) {
        const data = await authRes.json();
        bridgeToken = data.token ?? null;
      }
    } catch {
      // Daemon might not be running yet — that's fine, service worker will retry
    }

    // 3. Persist and reconnect
    await chrome.storage.local.set({
      autoStoreJwt: jwt,
      autoStoreUser: user,
      autoStoreBackend: backend,
      ...(bridgeToken ? { bridgeToken, bridgePort: port } : {}),
    });

    chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});

    showLoggedIn(user);
    setStatus(
      bridgeToken ? "✅ Connected to daemon" : "⚠ Signed in — start AutoStore to activate",
      bridgeToken ? "ok" : "warn"
    );
  } catch (e) {
    if (e.message?.includes("cancel") || e.message?.includes("Cancel")) {
      setError(""); // user dismissed — silent
    } else {
      setError(e.message ?? "Sign in failed.");
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
