(() => {
  "use strict";

  const PRESENCE_POLL_MS = 2500;
  const TYPING_RENEW_MS = 3500;
  const TYPING_STOP_DELAY_MS = 900;
  const presenceState = {
    chatId: "",
    snapshot: null,
    pollTimer: null,
    typingRenewTimer: null,
    typingStopTimer: null,
    typingChatId: "",
    typingSent: false,
    requestId: 0,
    rendering: false
  };

  const subtitleTarget = document.querySelector("[data-dialog-subtitle]");
  const messagesTarget = document.querySelector("[data-message-list]");
  const inputTarget = document.querySelector("[data-message-input]");
  const formTarget = document.querySelector('[data-form="message"]');

  function activeChat() {
    try {
      return typeof getActiveChat === "function" ? getActiveChat() : null;
    } catch {
      return null;
    }
  }

  function language() {
    try {
      return state?.language === "en" ? "en" : "ru";
    } catch {
      return "ru";
    }
  }

  function authToken() {
    return localStorage.getItem("yachat-http-auth-token") || "";
  }

  function requestHeaders() {
    const token = authToken();
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  function pluralSubscribers(count) {
    const value = Math.max(0, Number.parseInt(count, 10) || 0);
    if (language() === "en") {
      return `${value} ${value === 1 ? "subscriber" : "subscribers"}`;
    }
    const mod100 = value % 100;
    const mod10 = value % 10;
    const noun = mod100 >= 11 && mod100 <= 14
      ? "подписчиков"
      : mod10 === 1
        ? "подписчик"
        : mod10 >= 2 && mod10 <= 4
          ? "подписчика"
          : "подписчиков";
    return `${value} ${noun}`;
  }

  function createDots(className = "typing-dots") {
    const dots = document.createElement("span");
    dots.className = className;
    dots.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      dots.append(document.createElement("i"));
    }
    return dots;
  }

  function typingLabel(chat, users) {
    const firstName = String(users?.[0]?.displayName || "").trim();
    if (chat?.kind === "group" && firstName) {
      if (users.length > 1) {
        return language() === "en"
          ? `${firstName} and ${users.length - 1} more are typing`
          : `${firstName} и ещё ${users.length - 1} печатают`;
      }
      return language() === "en" ? `${firstName} is typing` : `${firstName} печатает`;
    }
    return language() === "en" ? "Typing" : "Печатает";
  }

  function privateStatusLabel(status) {
    if (language() === "en") {
      if (status === "online") {
        return "Online";
      }
      if (status === "recent") {
        return "Last seen recently";
      }
      return "Last seen a long time ago";
    }

    if (status === "online") {
      return "В сети";
    }
    if (status === "recent") {
      return "Был(а) недавно";
    }
    return "Давно не был(а)";
  }

  function renderSubtitle() {
    if (!subtitleTarget || presenceState.rendering) {
      return;
    }

    const chat = activeChat();
    if (!chat) {
      return;
    }

    const snapshot = presenceState.chatId === chat.id ? presenceState.snapshot : null;
    const users = Array.isArray(snapshot?.typingUsers) ? snapshot.typingUsers : [];
    let text = "";
    let typing = false;

    if (chat.kind === "bot" || chat.id === "yachat-codes") {
      text = language() === "en" ? "Bot" : "Бот";
    } else if (users.length > 0 && (chat.kind === "private" || chat.kind === "group")) {
      text = typingLabel(chat, users);
      typing = true;
    } else if (chat.kind === "private") {
      text = privateStatusLabel(snapshot?.status);
    } else if (chat.kind === "group" || chat.kind === "channel" || chat.id === "yachat-channel") {
      const fallbackCount = Array.isArray(chat.participantIds) ? chat.participantIds.length : 0;
      text = pluralSubscribers(snapshot?.subscriberCount ?? fallbackCount);
    } else {
      try {
        text = typeof getChatSubtitle === "function" ? getChatSubtitle(chat) : "";
      } catch {
        text = "";
      }
    }

    const signature = `${chat.id}|${typing ? "typing" : "text"}|${text}`;
    const hasDots = Boolean(subtitleTarget.querySelector(".typing-dots"));
    const currentText = subtitleTarget.textContent.trim();
    if (
      subtitleTarget.dataset.presenceSignature === signature
      && currentText === text
      && hasDots === typing
      && subtitleTarget.classList.contains("is-typing") === typing
    ) {
      return;
    }

    presenceState.rendering = true;
    try {
      subtitleTarget.replaceChildren();
      subtitleTarget.dataset.presenceSignature = signature;
      subtitleTarget.classList.toggle("is-typing", typing);
      subtitleTarget.append(document.createTextNode(text));
      if (typing) {
        subtitleTarget.append(document.createTextNode(" "), createDots());
      }
    } finally {
      presenceState.rendering = false;
    }
  }

  function renderTypingBubble() {
    if (!messagesTarget || presenceState.rendering) {
      return;
    }

    const chat = activeChat();
    const snapshot = chat && presenceState.chatId === chat.id ? presenceState.snapshot : null;
    const users = Array.isArray(snapshot?.typingUsers) ? snapshot.typingUsers : [];
    const existing = messagesTarget.querySelector("[data-typing-indicator]");
    const shouldShow = Boolean(chat && users.length > 0 && (chat.kind === "private" || chat.kind === "group"));

    if (!shouldShow) {
      existing?.remove();
      return;
    }

    if (existing) {
      return;
    }

    const wasNearBottom = messagesTarget.scrollHeight - messagesTarget.scrollTop - messagesTarget.clientHeight < 120;
    const bubble = document.createElement("article");
    bubble.className = "message-bubble is-typing-indicator";
    bubble.dataset.typingIndicator = "";
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-label", typingLabel(chat, users));
    bubble.append(createDots("typing-bubble-dots"));
    messagesTarget.append(bubble);

    if (wasNearBottom) {
      requestAnimationFrame(() => {
        messagesTarget.scrollTop = messagesTarget.scrollHeight;
      });
    }
  }

  function renderPresenceUi() {
    renderSubtitle();
    renderTypingBubble();
  }

  async function fetchPresence() {
    const chat = activeChat();
    const token = authToken();
    if (!chat?.id || !token) {
      presenceState.chatId = "";
      presenceState.snapshot = null;
      renderPresenceUi();
      return;
    }

    const requestId = ++presenceState.requestId;
    const chatId = chat.id;
    try {
      const response = await fetch(`/api/presence?chatId=${encodeURIComponent(chatId)}`, {
        headers: requestHeaders(),
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error("Presence request failed");
      }
      const snapshot = await response.json();
      if (requestId !== presenceState.requestId || activeChat()?.id !== chatId) {
        return;
      }
      presenceState.chatId = chatId;
      presenceState.snapshot = snapshot;
      renderPresenceUi();
    } catch {
      if (requestId === presenceState.requestId) {
        presenceState.chatId = chatId;
        presenceState.snapshot = null;
        renderPresenceUi();
      }
    }
  }

  function schedulePresencePoll(delay = PRESENCE_POLL_MS) {
    window.clearTimeout(presenceState.pollTimer);
    presenceState.pollTimer = window.setTimeout(async () => {
      await fetchPresence();
      schedulePresencePoll();
    }, delay);
  }

  async function postTyping(chatId, typing, keepalive = false) {
    if (!chatId || !authToken()) {
      return;
    }
    try {
      await fetch("/api/presence", {
        method: "POST",
        headers: requestHeaders(),
        body: JSON.stringify({ chatId, typing }),
        keepalive
      });
    } catch {
      // Typing is transient. A missed pulse must not break the chat.
    }
  }

  function stopTyping({ keepalive = false } = {}) {
    window.clearTimeout(presenceState.typingStopTimer);
    window.clearInterval(presenceState.typingRenewTimer);
    presenceState.typingStopTimer = null;
    presenceState.typingRenewTimer = null;
    const chatId = presenceState.typingChatId;
    const shouldNotify = presenceState.typingSent && chatId;
    presenceState.typingSent = false;
    presenceState.typingChatId = "";
    if (shouldNotify) {
      void postTyping(chatId, false, keepalive);
    }
  }

  function startTyping() {
    const chat = activeChat();
    const text = String(inputTarget?.value || "").trim();
    if (!chat || !text || !["private", "group"].includes(chat.kind)) {
      stopTyping();
      return;
    }

    if (presenceState.typingChatId && presenceState.typingChatId !== chat.id) {
      stopTyping();
    }

    presenceState.typingChatId = chat.id;
    window.clearTimeout(presenceState.typingStopTimer);
    presenceState.typingStopTimer = window.setTimeout(stopTyping, TYPING_STOP_DELAY_MS);

    if (!presenceState.typingSent) {
      presenceState.typingSent = true;
      void postTyping(chat.id, true);
    }

    if (!presenceState.typingRenewTimer) {
      presenceState.typingRenewTimer = window.setInterval(() => {
        if (presenceState.typingSent && presenceState.typingChatId && String(inputTarget?.value || "").trim()) {
          void postTyping(presenceState.typingChatId, true);
        }
      }, TYPING_RENEW_MS);
    }
  }

  inputTarget?.addEventListener("input", startTyping);
  inputTarget?.addEventListener("focus", startTyping);
  inputTarget?.addEventListener("blur", () => stopTyping());
  formTarget?.addEventListener("submit", () => stopTyping());

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-chat-id]")) {
      stopTyping();
      window.setTimeout(() => {
        void fetchPresence();
      }, 80);
    }
  }, true);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopTyping({ keepalive: true });
    } else {
      void fetchPresence();
    }
  });
  window.addEventListener("pagehide", () => stopTyping({ keepalive: true }));

  const subtitleObserver = subtitleTarget
    ? new MutationObserver(() => renderSubtitle())
    : null;
  subtitleObserver?.observe(subtitleTarget, { childList: true, characterData: true, subtree: true });

  const messagesObserver = messagesTarget
    ? new MutationObserver(() => renderTypingBubble())
    : null;
  messagesObserver?.observe(messagesTarget, { childList: true });

  void fetchPresence();
  schedulePresencePoll();
})();
