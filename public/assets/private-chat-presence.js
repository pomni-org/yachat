(() => {
  const PATCH_ID = "private-route-read-v1";
  const ACTIVE_POLL_MS = 450;
  const originalGetActiveChat = getActiveChat;
  const originalApplyMessengerSnapshot = applyMessengerSnapshot;
  const originalMessengerPollDelay = messengerPollDelay;
  const markedIncomingByChat = new Map();
  let readRequestInFlight = null;

  function isSystemChatId(chatId) {
    return SYSTEM_CHAT_IDS.has(String(chatId || ""));
  }

  function renderMessengerSurface() {
    renderComposerContext();
    renderChatList();
    renderActiveChat();
    renderMessages();
  }

  function matchingRouteUser(snapshot, followRoute) {
    if (!followRoute) return null;
    const routeUsername = routeUsernameFromLocation();
    const routeUser = normalizeUser(snapshot?.routeUser);
    if (!routeUsername || !routeUser?.id || routeUser.id === state.account?.id) return null;
    return normalizeUsername(routeUser.username) === routeUsername ? routeUser : null;
  }

  getActiveChat = function guardedGetActiveChat() {
    if (state.pendingSearchChat?.id === state.activeChatId) {
      return state.pendingSearchChat;
    }

    const exact = state.chats.find((chat) => chat.id === state.activeChatId);
    if (exact) return exact;

    const ordinary = state.chats.find((chat) => !isSystemChatId(chat.id));
    return ordinary || originalGetActiveChat();
  };

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
      chat?.kind === "private" && getPrivateChatParticipantId(chat) === String(routeUser.id)
    ));

    if (existing) {
      state.pendingSearchChat = null;
      state.activeChatId = existing.id;
      state.messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    } else {
      const pending = createPendingSearchChat(routeUser);
      state.pendingSearchChat = pending;
      state.activeChatId = pending.id;
      state.messages = [];
    }

    renderMessengerSurface();
    setMobileDialogOpen(true);
    hideErrorPage();
  };

  messengerPollDelay = function guardedMessengerPollDelay() {
    return activeChatIsVisible() ? ACTIVE_POLL_MS : originalMessengerPollDelay();
  };

  markActiveChatReadIfVisible = async function guardedMarkActiveChatReadIfVisible() {
    const chat = getActiveChat();
    if (!chat || isSystemChatId(chat.id) || !activeChatIsVisible() || !yachatApi.messenger?.markRead) {
      return;
    }

    const incoming = [...(Array.isArray(state.messages) ? state.messages : [])]
      .reverse()
      .find((message) => message?.author !== "user");
    const unread = Number(chat.unread || 0) > 0;
    const incomingId = String(incoming?.id || "");
    const alreadyMarked = incomingId && markedIncomingByChat.get(chat.id) === incomingId;

    if (!unread && (!incomingId || alreadyMarked)) return;
    if (readRequestInFlight === chat.id) return;

    readRequestInFlight = chat.id;
    try {
      const result = await yachatApi.messenger.markRead({ chatId: chat.id });
      if (incomingId) markedIncomingByChat.set(chat.id, incomingId);
      state.chats = result.chats || state.chats;
      state.messages = result.messages || state.messages;
      renderChatList();
      renderMessages();
    } finally {
      if (readRequestInFlight === chat.id) readRequestInFlight = null;
    }
  };

  document.documentElement.dataset.yachatPrivateChatGuard = PATCH_ID;
  document.documentElement.dataset.yachatReadReceiptPollMs = String(ACTIVE_POLL_MS);
})();
