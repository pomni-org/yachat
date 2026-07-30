(() => {
  "use strict";

  if (
    window.__yachatInstantChatLoadingInstalled
    || typeof state === "undefined"
    || typeof yachatApi === "undefined"
    || !yachatApi?.messenger
    || typeof showMessenger !== "function"
    || typeof selectChat !== "function"
  ) {
    return;
  }
  window.__yachatInstantChatLoadingInstalled = true;

  const messageCache = new Map();
  const inFlightMessages = new Map();
  const MIN_ACTIVE_POLL_MS = 1200; // retained as a build compatibility marker; realtime disables active polling.
  const PREFETCH_BATCH = 3;
  const PREFETCH_INITIAL_LIMIT = 12;
  const SYSTEM_CHAT_IDS_LOCAL = new Set(["yachat-codes", "yachat-channel"]);
  let selectionVersion = 0;
  let cacheOwnerId = "";
  let prefetchGeneration = 0;

  function accountId() {
    return String(state?.account?.id || "");
  }

  function resetCacheForAccount() {
    const nextOwner = accountId();
    if (cacheOwnerId === nextOwner) return;
    cacheOwnerId = nextOwner;
    messageCache.clear();
    inFlightMessages.clear();
    prefetchGeneration += 1;
  }

  function cacheMessages(chatId, messages) {
    resetCacheForAccount();
    const id = String(chatId || "");
    const list = Array.isArray(messages) ? messages : [];
    if (id) messageCache.set(id, list);
    return list;
  }

  function currentMessagesFor(chatId) {
    resetCacheForAccount();
    return messageCache.get(String(chatId || "")) || [];
  }

  function rememberCurrentMessages() {
    const id = String(state.activeChatId || "");
    if (id && Array.isArray(state.messages)) cacheMessages(id, state.messages);
  }

  function ensureLoadingStyle() {
    if (document.querySelector("[data-instant-chat-loading-style]")) return;
    const style = document.createElement("style");
    style.dataset.instantChatLoadingStyle = "";
    style.textContent = `
      .chat-message-loading {
        align-self: center;
        margin: auto;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 13px;
        opacity: .68;
      }
      .chat-message-loading::before {
        content: "";
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: 8px;
        border-radius: 50%;
        background: currentColor;
        animation: yachat-cache-pulse 850ms ease-in-out infinite alternate;
      }
      @keyframes yachat-cache-pulse { to { opacity: .25; transform: scale(.72); } }
    `;
    document.head.append(style);
  }

  function showMessageLoading(chatId) {
    if (String(state.activeChatId || "") !== String(chatId || "") || !messageList) return;
    messageList.setAttribute("aria-busy", "true");
    if (state.messages.length || messageList.querySelector("[data-chat-message-loading]")) return;
    ensureLoadingStyle();
    const indicator = document.createElement("div");
    indicator.className = "chat-message-loading";
    indicator.dataset.chatMessageLoading = "";
    indicator.textContent = state.language === "en" ? "Syncing history" : "Синхронизация истории";
    messageList.append(indicator);
  }

  function hideMessageLoading(chatId) {
    if (String(state.activeChatId || "") !== String(chatId || "") || !messageList) return;
    messageList.removeAttribute("aria-busy");
    messageList.querySelector("[data-chat-message-loading]")?.remove();
  }

  const originalMessages = yachatApi.messenger.messages.bind(yachatApi.messenger);
  yachatApi.messenger.messages = function deduplicatedMessages(chatId) {
    const id = String(chatId || "");
    if (!id) return Promise.resolve([]);
    if (inFlightMessages.has(id)) return inFlightMessages.get(id);

    const request = Promise.resolve(originalMessages(id))
      .then((messages) => cacheMessages(id, messages))
      .finally(() => inFlightMessages.delete(id));
    inFlightMessages.set(id, request);
    return request;
  };

  if (typeof applyMessengerSnapshot === "function") {
    const originalApplyMessengerSnapshot = applyMessengerSnapshot;
    applyMessengerSnapshot = async function cacheAwareSnapshot(snapshot = {}, selectedChatId, options = {}) {
      rememberCurrentMessages();
      const result = await originalApplyMessengerSnapshot(snapshot, selectedChatId, options);
      const activeId = String(state.activeChatId || "");
      if (activeId && Array.isArray(state.messages)) cacheMessages(activeId, state.messages);
      queuePrefetch();
      return result;
    };
  }

  async function hydrateChat(chatId, version, options = {}) {
    const id = String(chatId || "");
    if (!id) return [];

    if (!currentMessagesFor(id).length) showMessageLoading(id);
    const jobs = [Promise.resolve(yachatApi.messenger.messages(id))];
    if (
      options.markRead !== false
      && !SYSTEM_CHAT_IDS_LOCAL.has(id)
      && yachatApi.messenger?.markRead
    ) {
      jobs.push(Promise.resolve(yachatApi.messenger.markRead({ chatId: id })));
    }

    const [messagesResult, readResult] = await Promise.allSettled(jobs);
    const messages = messagesResult.status === "fulfilled"
      ? cacheMessages(id, messagesResult.value)
      : currentMessagesFor(id);

    if (readResult?.status === "fulfilled" && Array.isArray(readResult.value?.chats)) {
      state.chats = readResult.value.chats;
    }

    if (selectionVersion === version && String(state.activeChatId || "") === id) {
      state.messages = messages;
      const chat = state.chats.find((item) => String(item?.id || "") === id);
      if (chat) chat.unread = 0;
      renderChatList();
      renderActiveChat();
      renderMessages();
      hideMessageLoading(id);
    }

    return messages;
  }

  async function prefetchChat(chatId, generation) {
    const id = String(chatId || "");
    if (!id || messageCache.has(id) || generation !== prefetchGeneration) return;
    try {
      const messages = await yachatApi.messenger.messages(id);
      if (generation === prefetchGeneration) cacheMessages(id, messages);
    } catch {
      // Prefetch is opportunistic. Opening the chat still performs a foreground load.
    }
  }

  async function prefetchRecentChats() {
    resetCacheForAccount();
    if (!state.account || !Array.isArray(state.chats)) return;
    const generation = ++prefetchGeneration;
    const activeId = String(state.activeChatId || "");
    const ids = state.chats
      .filter((chat) => chat?.id && chat.id !== activeId && chat.canSend !== false)
      .sort((left, right) => (
        new Date(right?.lastAt || 0).getTime() - new Date(left?.lastAt || 0).getTime()
      ))
      .slice(0, PREFETCH_INITIAL_LIMIT)
      .map((chat) => String(chat.id));

    for (let index = 0; index < ids.length; index += PREFETCH_BATCH) {
      if (generation !== prefetchGeneration) return;
      await Promise.allSettled(
        ids.slice(index, index + PREFETCH_BATCH).map((id) => prefetchChat(id, generation))
      );
    }
  }

  function queuePrefetch() {
    const schedule = window.requestIdleCallback
      ? (callback) => window.requestIdleCallback(callback, { timeout: 1200 })
      : (callback) => window.setTimeout(callback, 120);
    schedule(() => void prefetchRecentChats());
  }

  const originalShowMessenger = showMessenger;
  showMessenger = async function instantShowMessenger(account, options = {}) {
    const result = await originalShowMessenger(account, options);
    resetCacheForAccount();
    const activeId = String(state.activeChatId || "");
    if (activeId && Array.isArray(state.messages)) {
      cacheMessages(activeId, state.messages);
    }

    if (activeId && (options.snapshot?.deferredMessages || window.__yachatQuickBootstrapUsed)) {
      const version = ++selectionVersion;
      const cached = currentMessagesFor(activeId);
      if (cached.length) {
        state.messages = cached;
        renderMessages();
      } else {
        showMessageLoading(activeId);
      }
      void hydrateChat(activeId, version, { markRead: true });
    }

    queuePrefetch();
    return result;
  };

  const originalSelectChat = selectChat;
  selectChat = async function instantSelectChat(chatId, options = {}) {
    const id = String(chatId || "");
    const target = state.chats.find((chat) => String(chat?.id || "") === id);
    if (!target) return originalSelectChat(chatId, options);

    rememberCurrentMessages();
    const version = ++selectionVersion;

    closeMessageMenu();
    closeForwardPicker();
    state.editingMessageId = null;
    state.replyToMessage = null;
    state.selectedMessageIds.clear();
    state.selectingMessages = false;
    state.pendingSearchChat = null;
    state.activeChatId = id;
    state.messages = currentMessagesFor(id);
    target.unread = 0;

    renderComposerContext();
    setMobileDialogOpen(true);
    renderChatList();
    renderActiveChat();
    renderMessages();
    updateChatRoute(getActiveChat(), options);

    if (!state.messages.length) showMessageLoading(id);
    void hydrateChat(id, version, { markRead: true });
    return state.messages;
  };

  document.addEventListener("yachat:realtime-status", (event) => {
    if (["connected", "ready"].includes(String(event.detail?.status || ""))) {
      queuePrefetch();
    }
  });

  window.yachatMessageCache = Object.freeze({
    get: (chatId) => currentMessagesFor(chatId),
    remember: rememberCurrentMessages,
    prefetch: queuePrefetch,
    size: () => messageCache.size
  });
})();
