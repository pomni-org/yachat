(() => {
  "use strict";

  if (window.__yachatTypingStopFixInstalled) {
    return;
  }
  window.__yachatTypingStopFixInstalled = true;

  const IDLE_STOP_MS = 1100;
  const input = document.querySelector("[data-message-input]");
  const form = document.querySelector('[data-form="message"]');
  const originalFetch = window.fetch.bind(window);
  const queues = new Map();
  let lastActivityAt = 0;
  let lastActivityChatId = "";
  let stopTimer = null;
  let generation = 0;

  function authToken() {
    return localStorage.getItem("yachat-http-auth-token") || "";
  }

  function activeChatId() {
    try {
      return typeof getActiveChat === "function" ? String(getActiveChat()?.id || "") : "";
    } catch {
      return "";
    }
  }

  function presencePayload(inputValue, init = {}) {
    const method = String(init?.method || "GET").toUpperCase();
    const url = typeof inputValue === "string"
      ? new URL(inputValue, window.location.origin)
      : new URL(inputValue?.url || "", window.location.origin);
    if (method !== "POST" || url.pathname !== "/api/presence") {
      return null;
    }
    try {
      const payload = JSON.parse(String(init?.body || "{}"));
      return payload && typeof payload === "object" ? payload : null;
    } catch {
      return null;
    }
  }

  function syntheticStoppedResponse() {
    return new Response(JSON.stringify({ ok: true, typing: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  window.fetch = function orderedPresenceFetch(inputValue, init = {}) {
    const payload = presencePayload(inputValue, init);
    if (!payload?.chatId || typeof payload.typing !== "boolean") {
      return originalFetch(inputValue, init);
    }

    const chatId = String(payload.chatId);
    const staleTypingPulse = payload.typing
      && (chatId !== lastActivityChatId || Date.now() - lastActivityAt >= IDLE_STOP_MS);
    const nextInit = staleTypingPulse
      ? { ...init, body: JSON.stringify({ ...payload, typing: false }) }
      : init;

    const previous = queues.get(chatId) || Promise.resolve();
    const request = previous
      .catch(() => {})
      .then(() => originalFetch(inputValue, nextInit));
    const settled = request.finally(() => {
      if (queues.get(chatId) === settled) {
        queues.delete(chatId);
      }
    });
    queues.set(chatId, settled);

    if (staleTypingPulse) {
      void settled.catch(() => {});
      return Promise.resolve(syntheticStoppedResponse());
    }
    return settled;
  };

  function postStopped(chatId, keepalive = false) {
    const token = authToken();
    if (!chatId || !token) {
      return;
    }
    void window.fetch("/api/presence", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ chatId, typing: false }),
      keepalive
    }).catch(() => {});
  }

  function scheduleStop() {
    window.clearTimeout(stopTimer);
    const currentGeneration = ++generation;
    const chatId = activeChatId();
    lastActivityAt = Date.now();
    lastActivityChatId = chatId;

    if (!String(input?.value || "").trim()) {
      postStopped(chatId);
      return;
    }

    stopTimer = window.setTimeout(() => {
      if (currentGeneration !== generation) {
        return;
      }
      postStopped(chatId);
    }, IDLE_STOP_MS);
  }

  function stopImmediately(keepalive = false) {
    window.clearTimeout(stopTimer);
    generation += 1;
    const chatId = lastActivityChatId || activeChatId();
    lastActivityAt = 0;
    lastActivityChatId = "";
    postStopped(chatId, keepalive);
  }

  input?.addEventListener("input", scheduleStop, true);
  input?.addEventListener("focus", scheduleStop, true);
  input?.addEventListener("blur", () => stopImmediately(), true);
  form?.addEventListener("submit", () => stopImmediately(), true);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopImmediately(true);
    }
  });
  window.addEventListener("pagehide", () => stopImmediately(true));
})();
