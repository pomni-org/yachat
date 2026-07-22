(() => {
  "use strict";

  const CONTACT_SELECTOR = "[data-contact-user-id]";
  let openingUserId = "";

  function sameId(left, right) {
    return String(left ?? "").trim() === String(right ?? "").trim();
  }

  function contactById(userId) {
    const targetId = String(userId || "").trim();
    if (!targetId) return null;

    return (Array.isArray(state?.contactMatches) ? state.contactMatches : [])
      .find((item) => sameId(item?.id, targetId)) || null;
  }

  function chatById(chatId) {
    return (Array.isArray(state?.chats) ? state.chats : [])
      .find((chat) => sameId(chat?.id, chatId)) || null;
  }

  function privateChatForUser(userId) {
    const targetId = String(userId || "").trim();
    if (!targetId) return null;

    if (typeof findPrivateChatForUser === "function") {
      const found = findPrivateChatForUser(userId);
      if (found) return found;
    }

    return (Array.isArray(state?.chats) ? state.chats : []).find((chat) => {
      if (chat?.kind !== "private") return false;

      const ids = [
        ...(Array.isArray(chat?.participantIds) ? chat.participantIds : []),
        ...Object.keys(chat?.participantProfiles || {})
      ];
      return ids.some((id) => sameId(id, targetId));
    }) || null;
  }

  function clearChatInteractionState() {
    if (typeof closeMessageMenu === "function") closeMessageMenu();
    if (typeof closeForwardPicker === "function") closeForwardPicker();
    state.editingMessageId = null;
    state.replyToMessage = null;
    state.selectedMessageIds?.clear?.();
    state.selectingMessages = false;
    state.pendingSearchChat = null;
  }

  function renderOpenedChat(options = {}) {
    if (typeof renderComposerContext === "function") renderComposerContext();
    if (typeof setMobileDialogOpen === "function") setMobileDialogOpen(true);
    if (typeof renderChatList === "function") renderChatList();
    if (typeof renderActiveChat === "function") renderActiveChat();
    if (typeof renderMessages === "function") renderMessages();

    if (typeof updateChatRoute === "function") {
      const chat = typeof getActiveChat === "function" ? getActiveChat() : chatById(state.activeChatId);
      if (chat) updateChatRoute(chat, options);
    }
  }

  async function loadOpenedChatMessages(chatId) {
    if (!yachatApi?.messenger?.messages) return null;
    try {
      const messages = await yachatApi.messenger.messages(chatId);
      return Array.isArray(messages) ? messages : null;
    } catch {
      return null;
    }
  }

  async function markOpenedChatRead(chatId) {
    if (!yachatApi?.messenger?.markRead) return null;
    try {
      return await yachatApi.messenger.markRead({ chatId });
    } catch {
      // Opening a chat must never depend on a secondary read-receipt request.
      return null;
    }
  }

  async function selectChatReliably(chatId, options = {}) {
    const chat = chatById(chatId);
    const resolvedId = chat?.id ?? chatId;
    const targetKey = String(resolvedId ?? "").trim();
    if (!targetKey) throw new Error(state?.language === "en" ? "Chat was not found" : "Чат не найден");

    clearChatInteractionState();
    state.activeChatId = resolvedId;
    state.messages = [];

    // Open the interface immediately. Network calls below may be slow or fail.
    renderOpenedChat(options);

    const messageRequest = loadOpenedChatMessages(resolvedId);
    const readRequest = markOpenedChatRead(resolvedId);

    const messages = await messageRequest;
    if (sameId(state.activeChatId, resolvedId) && messages) {
      state.messages = messages;
      if (typeof renderMessages === "function") renderMessages();
    }

    const readResult = await readRequest;
    if (!sameId(state.activeChatId, resolvedId) || !readResult) return;

    if (Array.isArray(readResult.chats)) state.chats = readResult.chats;
    if (Array.isArray(readResult.messages)) state.messages = readResult.messages;
    renderOpenedChat(options);
  }

  // The original implementation waited for markRead before opening the UI.
  // A slow or failed read receipt therefore made every chat look unclickable.
  try {
    selectChat = selectChatReliably;
  } catch {
    // The capture handlers still use the reliable implementation directly.
  }

  async function createOrOpenContactChat(user, options = {}) {
    const existing = privateChatForUser(user.id);
    if (existing) {
      if (options.closePanelOnOpen && typeof closePanel === "function") closePanel();
      await selectChatReliably(existing.id, options);
      return existing;
    }

    if (yachatApi?.messenger?.createChat) {
      const profile = typeof contactProfilePayload === "function"
        ? contactProfilePayload(user)
        : {
            id: user.id,
            username: user.username || "",
            displayName: user.displayName || user.previewName || user.username || "",
            previewName: user.previewName || user.displayName || user.username || "",
            bio: user.bio || "",
            contact: user.contact || user.matchedContact || "",
            avatarDataUrl: user.avatarDataUrl || "",
            avatarAccent: user.avatarAccent || "#471AFF",
            verified: Boolean(user.verified)
          };

      const result = await yachatApi.messenger.createChat({
        kind: "private",
        participantIds: [user.id],
        participantProfiles: { [String(user.id)]: profile },
        title: user.displayName || user.previewName || user.username || ""
      });

      if (Array.isArray(result?.chats)) state.chats = result.chats;
      else if (yachatApi.messenger.chats) state.chats = await yachatApi.messenger.chats();

      const created = result?.chat || privateChatForUser(user.id);
      if (!created?.id) throw new Error(state?.language === "en" ? "Chat was not created" : "Чат не создан");

      if (options.closePanelOnOpen && typeof closePanel === "function") closePanel();
      await selectChatReliably(created.id, options);
      return created;
    }

    if (typeof openPendingPrivateChat === "function") {
      await openPendingPrivateChat(user, options);
      return typeof getActiveChat === "function" ? getActiveChat() : null;
    }

    throw new Error(state?.language === "en" ? "Private chat opener is unavailable" : "Не удалось открыть личный чат");
  }

  async function openContactChat(userId, sourceButton = null) {
    const user = contactById(userId);
    if (!user) throw new Error(state?.language === "en" ? "Contact was not found" : "Контакт не найден");

    if (sourceButton && typeof setLoading === "function") setLoading(sourceButton, true);
    try {
      await createOrOpenContactChat(user, { closePanelOnOpen: true });
    } finally {
      if (sourceButton?.isConnected && typeof setLoading === "function") setLoading(sourceButton, false);
    }
  }

  try {
    openPrivateChatWithContact = openContactChat;
  } catch {
    // The capture handler below uses the same implementation directly.
  }

  async function openContactRow(row) {
    const userId = String(row?.dataset?.contactUserId || "").trim();
    if (!userId || openingUserId) return;

    openingUserId = userId;
    row.disabled = true;
    row.setAttribute("aria-busy", "true");

    try {
      await openContactChat(userId, row);
    } catch (error) {
      const fallback = state?.language === "en" ? "Could not open chat" : "Не удалось открыть чат";
      const message = typeof translatedServerMessage === "function"
        ? translatedServerMessage(error?.message, "errSendMessage")
        : String(error?.message || fallback);

      if (typeof showActionFeedback === "function") {
        showActionFeedback(message || fallback, {
          tone: "error",
          icon: "circle-alert",
          duration: 4200
        });
      }
    } finally {
      openingUserId = "";
      if (row?.isConnected) {
        row.disabled = false;
        row.removeAttribute("aria-busy");
      }
    }
  }

  document.addEventListener("click", (event) => {
    const row = event.target.closest(CONTACT_SELECTOR);
    if (!row) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void openContactRow(row);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(CONTACT_SELECTOR);
    if (!row) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void openContactRow(row);
  }, true);
})();