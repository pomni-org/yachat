(() => {
  const AUTH_TOKEN_KEY = "yachat-http-auth-token";
  const POLL_INTERVAL_MS = 2500;
  const TYPING_HEARTBEAT_MS = 3000;
  const TYPING_IDLE_MS = 4800;

  const presenceState = {
    activeChatId: "",
    chatKind: "",
    remoteTyping: null,
    subscriberCount: 0,
    ownTyping: false,
    typingIdleTimer: null,
    typingHeartbeatTimer: null,
    pollTimer: null,
    requestId: 0,
    applyingDom: false
  };

  const subtitle = document.querySelector("[data-dialog-subtitle]");
  const dialogAvatar = document.querySelector("[data-dialog-avatar]");
  const messageList = document.querySelector("[data-message-list]");
  const messageInput = document.querySelector("[data-message-input]");
  const messageForm = document.querySelector('[data-form="message"]');
  const chatList = document.querySelector("[data-chat-list]");

  if (!subtitle || !dialogAvatar || !messageList || !messageInput || !messageForm || !chatList) {
    return;
  }

  function authToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || "";
  }

  function activeChatId() {
    return chatList.querySelector(".chat-row.is-active[data-chat-id]")?.dataset.chatId || "";
  }

  function activeChatKind() {
    if (dialogAvatar.classList.contains("is-favorites")) return "saved";
    if (dialogAvatar.classList.contains("is-bot")) return "bot";
    if (dialogAvatar.classList.contains("is-channel")) return "channel";
    if (dialogAvatar.classList.contains("is-group")) return "group";
    return "private";
  }

  function typingDots(className) {
    return `<span class="${className}" aria-hidden="true"><i></i><i></i><i></i></span>`;
  }

  function subscriberLabel(value) {
    const count = Math.max(0, Number.parseInt(value, 10) || 0);
    const mod100 = count % 100;
    const mod10 = count % 10;
    const noun = mod100 >= 11 && mod100 <= 14
      ? "подписчиков"
      : mod10 === 1
        ? "подписчик"
        : mod10 >= 2 && mod10 <= 4
          ? "подписчика"
          : "подписчиков";
    return `${count.toLocaleString("ru-RU")} ${noun}`;
  }

  function parseExistingCount() {
    const match = String(subtitle.textContent || "").match(/\d[\d\s]*/);
    return match ? Number.parseInt(match[0].replace(/\s/g, ""), 10) || 0 : 0;
  }

  function setSubtitleText(value) {
    if (subtitle.textContent !== value || subtitle.children.length > 0) {
      subtitle.textContent = value;
    }
  }

  function setSubtitleHtml(value) {
    if (subtitle.innerHTML !== value) {
      subtitle.innerHTML = value;
    }
  }

  function renderSubtitle() {
    const kind = presenceState.chatKind || activeChatKind();
    subtitle.classList.add("is-live-status");

    if (kind === "saved") {
      subtitle.classList.remove("is-live-status");
      return;
    }

    if (kind === "bot") {
      setSubtitleText("Бот");
      return;
    }

    const typingName = String(presenceState.remoteTyping?.displayName || "").trim();
    if (presenceState.remoteTyping) {
      const prefix = kind === "group" && typingName
        ? `${escapeText(typingName)} печатает`
        : "печатает";
      setSubtitleHtml(`<span>${prefix}</span>${typingDots("live-typing-dots")}`);
      return;
    }

    if (kind === "group" || kind === "channel") {
      setSubtitleText(subscriberLabel(presenceState.subscriberCount || parseExistingCount()));
      return;
    }

    setSubtitleText(presenceState.online ? "в сети" : "давно не был(а)");
  }

  function escapeText(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderTypingBubble() {
    const existing = messageList.querySelector("[data-presence-typing]");
    if (!presenceState.remoteTyping || presenceState.chatKind === "bot" || presenceState.chatKind === "channel" || presenceState.chatKind === "saved") {
      existing?.remove();
      return;
    }

    const bubble = existing || document.createElement("article");
    bubble.className = "message-bubble typing-message-bubble";
    bubble.dataset.presenceTyping = "";
    bubble.setAttribute("aria-label", "Собеседник печатает");

    const name = presenceState.chatKind === "group"
      ? String(presenceState.remoteTyping.displayName || "").trim()
      : "";
    const content = `${name ? `<span class="typing-bubble-author">${escapeText(name)}</span>` : ""}${typingDots("typing-bubble-dots")}`;
    if (bubble.innerHTML !== content) {
      bubble.innerHTML = content;
    }

    if (!existing) {
      messageList.append(bubble);
    }
    messageList.scrollTop = messageList.scrollHeight;
  }

  function applyPresence(payload = {}) {
    presenceState.applyingDom = true;
    presenceState.chatKind = payload.kind || activeChatKind();
    presenceState.remoteTyping = payload.typingUser || null;
    presenceState.subscriberCount = Number(payload.subscriberCount) || 0;
    presenceState.online = Boolean(payload.online);
    renderSubtitle();
    renderTypingBubble();
    queueMicrotask(() => {
      presenceState.applyingDom = false;
    });
  }

  async function requestPresence(method = "GET", body = null) {
    const token = authToken();
    const chatId = activeChatId();
    if (!token || !chatId) {
      return null;
    }

    const url = new URL("/api/presence", window.location.origin);
    url.searchParams.set("chatId", chatId);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify({ chatId, ...body }) : undefined,
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`presence ${response.status}`);
    }
    return response.json();
  }

  async function pollPresence() {
    const requestId = ++presenceState.requestId;
    const chatId = activeChatId();
    const kind = activeChatKind();

    if (chatId !== presenceState.activeChatId) {
      if (presenceState.ownTyping) {
        sendTyping(false).catch(() => {});
      }
      presenceState.activeChatId = chatId;
      presenceState.chatKind = kind;
      presenceState.remoteTyping = null;
      presenceState.subscriberCount = parseExistingCount();
      renderSubtitle();
      renderTypingBubble();
    }

    try {
      const payload = await requestPresence("GET");
      if (payload && requestId === presenceState.requestId && chatId === activeChatId()) {
        applyPresence(payload);
      }
    } catch {
      presenceState.chatKind = kind;
      presenceState.subscriberCount ||= parseExistingCount();
      renderSubtitle();
      renderTypingBubble();
    } finally {
      window.clearTimeout(presenceState.pollTimer);
      presenceState.pollTimer = window.setTimeout(pollPresence, POLL_INTERVAL_MS);
    }
  }

  async function sendTyping(typing) {
    const next = Boolean(typing && messageInput.value.trim());
    presenceState.ownTyping = next;
    window.clearTimeout(presenceState.typingHeartbeatTimer);

    try {
      await requestPresence("POST", { typing: next });
    } catch {
      return;
    }

    if (next) {
      presenceState.typingHeartbeatTimer = window.setTimeout(() => {
        sendTyping(true).catch(() => {});
      }, TYPING_HEARTBEAT_MS);
    }
  }

  function scheduleTypingStop() {
    window.clearTimeout(presenceState.typingIdleTimer);
    presenceState.typingIdleTimer = window.setTimeout(() => {
      sendTyping(false).catch(() => {});
    }, TYPING_IDLE_MS);
  }

  messageInput.addEventListener("input", () => {
    if (!messageInput.value.trim()) {
      sendTyping(false).catch(() => {});
      return;
    }
    if (!presenceState.ownTyping) {
      sendTyping(true).catch(() => {});
    }
    scheduleTypingStop();
  });

  messageInput.addEventListener("blur", () => {
    sendTyping(false).catch(() => {});
  });

  messageForm.addEventListener("submit", () => {
    window.setTimeout(() => sendTyping(false).catch(() => {}), 0);
  }, true);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      sendTyping(false).catch(() => {});
    } else {
      pollPresence();
    }
  });

  window.addEventListener("pagehide", () => {
    if (presenceState.ownTyping) {
      const token = authToken();
      const chatId = activeChatId();
      if (token && chatId) {
        fetch("/api/presence", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ chatId, typing: false }),
          keepalive: true
        }).catch(() => {});
      }
    }
  });

  const observer = new MutationObserver(() => {
    if (presenceState.applyingDom) return;
    const nextChatId = activeChatId();
    if (nextChatId !== presenceState.activeChatId) {
      pollPresence();
      return;
    }
    renderSubtitle();
    renderTypingBubble();
  });

  observer.observe(chatList, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  observer.observe(dialogAvatar, { attributes: true, attributeFilter: ["class"] });
  observer.observe(subtitle, { childList: true, subtree: true, characterData: true });
  observer.observe(messageList, { childList: true });

  pollPresence();
})();
