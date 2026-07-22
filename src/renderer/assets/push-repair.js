(() => {
  "use strict";

  const REPAIR_VERSION = "53";
  const REPAIR_MARKER = `yachat-push-repair-${REPAIR_VERSION}`;
  const AUTH_TOKEN_KEY = "yachat-http-auth-token";
  let repairPromise = null;
  let testAttemptedThisPage = false;

  function token() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || "";
  }

  function supported() {
    return window.isSecureContext
      && "serviceWorker" in navigator
      && "PushManager" in window
      && "Notification" in window;
  }

  function base64Url(buffer) {
    const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function urlBase64ToUint8Array(value) {
    const source = String(value || "");
    const padding = "=".repeat((4 - source.length % 4) % 4);
    const raw = window.atob(`${source}${padding}`.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  }

  async function serverJson(pathname, options = {}) {
    const authToken = token();
    if (!authToken) {
      throw new Error("Push repair requires an authenticated YaChat session.");
    }

    const response = await fetch(pathname, {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      throw new Error(payload?.detail || payload?.error || `Push request failed: HTTP ${response.status}`);
    }
    return payload;
  }

  function subscriptionMatchesKey(subscription, publicKey) {
    const key = subscription?.options?.applicationServerKey;
    return !key || base64Url(key) === String(publicKey || "");
  }

  async function currentSubscription(registration, publicKey) {
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !subscriptionMatchesKey(subscription, publicKey)) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }
    return subscription;
  }

  function contentEncoding() {
    const encodings = Array.isArray(PushManager.supportedContentEncodings)
      ? PushManager.supportedContentEncodings
      : [];
    return encodings.includes("aes128gcm") ? "aes128gcm" : encodings[0] || "aes128gcm";
  }

  async function repairPushSubscription() {
    if (!supported() || !token() || Notification.permission !== "granted") {
      return null;
    }
    if (repairPromise) {
      return repairPromise;
    }

    repairPromise = (async () => {
      const config = await serverJson(`/api/push/public-key?repair=${Date.now()}`);
      if (!config.enabled || !config.publicKey) {
        throw new Error("Push is not configured on the YaChat server.");
      }

      const registration = await navigator.serviceWorker.register(`/sw.js?v=${REPAIR_VERSION}`, {
        scope: "/",
        updateViaCache: "none"
      });
      await registration.update().catch(() => {});
      const readyRegistration = await navigator.serviceWorker.ready;
      const subscription = await currentSubscription(readyRegistration || registration, config.publicKey);
      const serialized = subscription.toJSON();
      serialized.contentEncoding = contentEncoding();

      const saved = await serverJson("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify(serialized)
      });
      if (!saved.ok || !saved.subscriptions) {
        throw new Error("YaChat server did not retain the push subscription.");
      }

      if (!testAttemptedThisPage && localStorage.getItem(REPAIR_MARKER) !== "done") {
        testAttemptedThisPage = true;
        const tested = await serverJson("/api/push/test", {
          method: "POST",
          body: "{}"
        });
        if (tested.sent > 0) {
          localStorage.setItem(REPAIR_MARKER, "done");
        }
      }

      if (typeof state !== "undefined") {
        state.notificationsReady = true;
      }
      return saved;
    })()
      .catch((error) => {
        console.warn("YaChat push repair failed:", error);
        return null;
      })
      .finally(() => {
        repairPromise = null;
      });

    return repairPromise;
  }

  if (typeof enablePushNotifications === "function") {
    const originalEnablePushNotifications = enablePushNotifications;
    enablePushNotifications = async function enablePushNotificationsWithRepair(...args) {
      try {
        await originalEnablePushNotifications(...args);
      } catch (error) {
        console.warn("YaChat legacy push registration failed:", error);
      }
      return repairPushSubscription();
    };
  }

  const scheduleRepair = () => {
    window.setTimeout(() => void repairPushSubscription(), 0);
  };

  scheduleRepair();
  window.setTimeout(scheduleRepair, 3000);
  window.setTimeout(scheduleRepair, 10_000);
  window.addEventListener("online", scheduleRepair);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      scheduleRepair();
    }
  });
})();
