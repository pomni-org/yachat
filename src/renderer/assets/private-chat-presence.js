(() => {
  "use strict";

  if (
    window.__yachatPrivateChatPresenceGuardInstalled
    || typeof state === "undefined"
    || typeof getActiveChat !== "function"
  ) {
    return;
  }

  window.__yachatPrivateChatPresenceGuardInstalled = true;

  const PATCH_ID = "private-route-read-realtime-v3";
  const SYSTEM_CHAT_IDS_LOCAL = new Set(["yachat-favorites", "yachat-codes", "yachat-channel"]);
  const originalGetActiveChat = getActiveChat;
  const originalApplyMessengerSnapshot = typeof applyMessengerSnapshot === "function"
    ? applyMessengerSnapshot
    : null;
  const markedIncomingByChat = new Map();
  const readRequestsInFlight = new Set();

  function isSystemChatId(chatId) {
    return SYSTEM_CHAT_IDS_LOCAL.has(String(chatId || ""));
  }

  function renderMessengerSurface() {
    renderComposerContext?.();
    renderChatList?.();
    renderActiveChat?.();
    renderMessages?.();
  }

  function matchingRouteUser(snapshot, followRoute) {
    if (!followRoute) return null;
    const routeUsername = routeUsernameFromLocation?.();
    const routeUser = normalizeUser?.(snapshot?.routeUser);
    if (!routeUsername || !routeUser?.id || routeUser.id === state.account?.id) return null;
    return normalizeUsername?.(routeUser.username) === routeUsername ? routeUser : null;
  }

  function mergeReadReceipt(chatId, result) {
    const id = String(chatId || "");
    const current = (Array.isArray(state.chats) ? state.chats : [])
      .find((chat) => String(chat?.id || "") === id);
    if (!current) return;

    current.unread = 0;
    const updated = Array.isArray(result?.chats)
      ? result.chats.find((chat) => String(chat?.id || "") === id)
      : null;
    ["lastReadAt", "readAt"].forEach((field) => {
      if (updated?.[field] !== undefined) current[field] = updated[field];
    });
    if (result?.readAt !== undefined) current.lastReadAt = result.readAt;
  }

  getActiveChat = function guardedGetActiveChat() {
    if (state.pendingSearchChat?.id === state.activeChatId) {
      return state.pendingSearchChat;
    }

    const exact = (Array.isArray(state.chats) ? state.chats : [])
      .find((chat) => chat.id === state.activeChatId);
    return exact || originalGetActiveChat();
  };

  if (originalApplyMessengerSnapshot) {
    applyMessengerSnapshot = async function guardedApplyMessengerSnapshot(
      snapshot = {},
      selectedChatId = state.activeChatId,
      options = {}
    ) {
      const followRoute = options.followRoute !== false;
      const routeUser = matchingRouteUser(snapshot, followRoute);

      if (!routeUser) {
        return originalApplyMessengerSnapshot(snapshot, selectedChatId, options);
      }

      state.chats = Array.isArray(snapshot.chats) ? snapshot.chats : [];
      const existing = state.chats.find((chat) => (
        chat?.kind === "private" && getPrivateChatParticipantId?.(chat) === String(routeUser.id)
      ));

      if (existing) {
        state.pendingSearchChat = null;
        state.activeChatId = existing.id;
        state.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
      } else {
        const pending = createPendingSearchChat?.(routeUser);
        if (!pending) return originalApplyMessengerSnapshot(snapshot, selectedChatId, options);
        state.pendingSearchChat = pending;
        state.activeChatId = pending.id;
        state.messages = [];
      }

      renderMessengerSurface();
      setMobileDialogOpen?.(true);
      hideErrorPage?.();
    };
  }

  markActiveChatReadIfVisible = async function realtimeMarkActiveChatReadIfVisible() {
    const chat = getActiveChat();
    if (
      !chat
      || isSystemChatId(chat.id)
      || !activeChatIsVisible?.()
      || !yachatApi?.messenger?.markRead
    ) {
      return;
    }

    const incoming = [...(Array.isArray(state.messages) ? state.messages : [])]
      .reverse()
      .find((message) => message?.author !== "user");
    const unread = Number(chat.unread || 0) > 0;
    const incomingId = String(incoming?.id || "");
    const alreadyMarked = incomingId && markedIncomingByChat.get(chat.id) === incomingId;

    if (!unread && (!incomingId || alreadyMarked)) return;
    if (readRequestsInFlight.has(chat.id)) return;

    readRequestsInFlight.add(chat.id);
    try {
      const result = await yachatApi.messenger.markRead({ chatId: chat.id });
      if (incomingId) markedIncomingByChat.set(chat.id, incomingId);
      mergeReadReceipt(chat.id, result);
      renderChatList?.();
    } catch {
      // A read receipt is best-effort. Realtime or the degraded fallback will retry later.
    } finally {
      readRequestsInFlight.delete(chat.id);
    }
  };

  document.documentElement.dataset.yachatPrivateChatGuard = PATCH_ID;
  document.documentElement.dataset.yachatReadReceiptTransport = "websocket-with-30s-degraded-fallback";
})();
