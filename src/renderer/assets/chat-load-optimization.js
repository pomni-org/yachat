(() => {
  "use strict";

  if (
    typeof state === "undefined"
    || typeof yachatApi === "undefined"
    || !yachatApi?.messenger
    || window.__yachatChatLoadOptimizationInstalled
  ) {
    return;
  }
  window.__yachatChatLoadOptimizationInstalled = true;

  const ACTIVE_POLL_MS = 2800;
  const IDLE_POLL_MS = 8000;
  const BACKGROUND_POLL_MS = 30000;
  const CHAT_REFRESH_MS = 5200;
  const FULL_MESSAGE_REFRESH_MS = 40000;
  const MESSAGE_LIMIT = 80;

  let refreshPromise = null;
  let lastChatRefreshAt = 0;
  let lastFullMessageRefreshAt = 0;
  let lastMessageChatId = "";

  function authToken() {
    return localStorage.getItem("yachat-http-auth-token") || "";
  }

  async function apiGet(pathname) {
    const response = await fetch(pathname, {
      headers: {
        "Content-Type": "application/json",
        ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {})
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.detail || payload?.error || "Request failed.");
    }
    return payload;
  }

  async function apiPost(pathname, payload = {}) {
    const response = await fetch(pathname, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {})
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(result?.detail || result?.error || "Request failed.");
    }
    return result;
  }

  function mergedProfiles(previous = {}, incoming = {}) {
    const result = { ...previous };
    Object.entries(incoming || {}).forEach(([id, profile]) => {
      result[id] = { ...(previous?.[id] || {}), ...(profile || {}) };
    });
    return result;
  }

  function mergeChatList(incoming) {
    const previousById = new Map((state.chats || []).map((chat) => [chat.id, chat]));
    return (Array.isArray(incoming) ? incoming : []).map((chat) => {
      const previous = previousById.get(chat.id) || {};
      return {
        ...previous,
        ...chat,
        avatarDataUrl: chat.avatarDataUrl || previous.avatarDataUrl || "",
        ownerAvatarDataUrl: chat.ownerAvatarDataUrl || previous.ownerAvatarDataUrl || "",
        participantProfiles: mergedProfiles(previous.participantProfiles, chat.participantProfiles)
      };
    });
  }

  function chatListFingerprint(chats) {
    return (chats || []).map((chat) => [
      chat.id,
      chat.title,
      chat.subtitle,
      chat.lastAt,
      chat.lastMessage,
      chat.unread,
      chat.avatarDataUrl,
      chat.canSend,
      chat.blockedByMe,
      chat.blockedMe
    ].join("\u001f")).join("\u001e");
  }

  function messageFingerprint(messages) {
    return (messages || []).map((message) => [
      message.id,
      message.editedAt,
      message.deliveryStatus,
      message.text,
      Array.isArray(message.attachments) ? message.attachments.length : 0
    ].join("\u001f")).join("\u001e");
  }

  function mergeMessages(previous, incoming) {
    const byId = new Map((previous || []).map((message) => [message.id, message]));
    (incoming || []).forEach((message) => {
      if (!message?.id) return;
      byId.set(message.id, { ...(byId.get(message.id) || {}), ...message });
    });
    return [...byId.values()].sort((left, right) => (
      new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime()
    ));
  }

  function messageCursor() {
    const latest = (state.messages || [])[state.messages.length - 1];
    const timestamp = new Date(latest?.createdAt || 0).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
    return new Date(Math.max(0, timestamp - 1000)).toISOString();
  }

  async function loadMessages(chatId, full = false) {
    if (!chatId) return [];
    const query = new URLSearchParams({
      chatId,
      limit: String(MESSAGE_LIMIT)
    });
    if (!full) {
      const after = messageCursor();
      if (after) query.set("after", after);
    }
    return apiGet(`/api/messages?${query.toString()}`);
  }

  yachatApi.messenger.messages = (chatId) => loadMessages(String(chatId || ""), true);
  yachatApi.messenger.chats = () => apiGet("/api/chats/poll");

  messengerPollDelay = function optimizedMessengerPollDelay() {
    if (document.visibilityState !== "visible") return BACKGROUND_POLL_MS;
    return activeChatIsVisible() ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  };

  markActiveChatReadIfVisible = async function optimizedMarkActiveChatRead() {
    const chat = getActiveChat();
    if (!chat || Number(chat.unread || 0) <= 0 || !activeChatIsVisible()) return;
    await apiPost("/api/chat/mark-read", { chatId: chat.id });
    chat.unread = 0;
    renderChatList();
  };

  refreshMessengerFromServer = async function optimizedMessengerRefresh() {
    if (!state.account || state.pendingSearchChat) return;
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      const now = Date.now();
      const selectedChatId = state.activeChatId;
      const shouldRefreshChats = now - lastChatRefreshAt >= CHAT_REFRESH_MS;
      const shouldLoadMessages = Boolean(selectedChatId && activeChatIsVisible());
      const shouldFullRefreshMessages = shouldLoadMessages && (
        selectedChatId !== lastMessageChatId
        || !state.messages.length
        || now - lastFullMessageRefreshAt >= FULL_MESSAGE_REFRESH_MS
      );

      const previousChatFingerprint = chatListFingerprint(state.chats);
      const previousMessageFingerprint = messageFingerprint(state.messages);
      const [incomingChats, incomingMessages] = await Promise.all([
        shouldRefreshChats ? yachatApi.messenger.chats() : Promise.resolve(null),
        shouldLoadMessages
          ? loadMessages(selectedChatId, shouldFullRefreshMessages)
          : Promise.resolve(null)
      ]);

      if (incomingChats) {
        state.chats = mergeChatList(incomingChats);
        lastChatRefreshAt = now;
        if (!state.chats.some((chat) => chat.id === state.activeChatId)) {
          state.activeChatId = state.chats[0]?.id || state.activeChatId;
        }
      }

      if (incomingMessages && selectedChatId === state.activeChatId) {
        state.messages = shouldFullRefreshMessages
          ? incomingMessages
          : mergeMessages(state.messages, incomingMessages);
        lastMessageChatId = selectedChatId;
        if (shouldFullRefreshMessages) lastFullMessageRefreshAt = now;
      }

      if (chatListFingerprint(state.chats) !== previousChatFingerprint) {
        renderChatList();
        renderActiveChat();
      }
      if (messageFingerprint(state.messages) !== previousMessageFingerprint) {
        renderMessages();
      }

      await markActiveChatReadIfVisible();
    })().finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  };
})();
