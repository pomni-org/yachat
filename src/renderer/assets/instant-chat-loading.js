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
  let selectionVersion = 0;

  function cacheMessages(chatId, messages) {
    const id = String(chatId || "");
    const list = Array.isArray(messages) ? messages : [];
    if (id) messageCache.set(id, list);
    return list;
  }

  function currentMessagesFor(chatId) {
    const id = String(chatId || "");
    return messageCache.get(id) || [];
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
    indicator.textContent = state.language === "en" ? "Loading messages…" : "Загрузка сообщений…";
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

  async function hydrateChat(chatId, version, options = {}) {
    const id = String(chatId || "");
    if (!id) return [];

    showMessageLoading(id);
    const jobs = [yachatApi.messenger.messages(id)];
    if (options.markRead !== false && yachatApi.messenger?.markRead) {
      jobs.push(Promise.resolve(yachatApi.messenger.markRead({ chatId: id })));
    }

    const [messagesResult] = await Promise.allSettled(jobs);
    const messages = messagesResult.status === "fulfilled"
      ? cacheMessages(id, messagesResult.value)
      : currentMessagesFor(id);

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

  const originalShowMessenger = showMessenger;
  showMessenger = async function instantShowMessenger(account, options = {}) {
    const result = await originalShowMessenger(account, options);
    const activeId = String(state.activeChatId || "");
    if (!activeId) return result;

    if (Array.isArray(state.messages) && state.messages.length) {
      cacheMessages(activeId, state.messages);
    }

    if (options.snapshot?.deferredMessages || window.__yachatQuickBootstrapUsed) {
      const version = ++selectionVersion;
      state.messages = currentMessagesFor(activeId);
      renderMessages();
      showMessageLoading(activeId);
      void hydrateChat(activeId, version, { markRead: true });
    }

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
    showMessageLoading(id);

    return hydrateChat(id, version, { markRead: true });
  };
})();
