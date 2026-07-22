(() => {
  "use strict";

  if (window.__yachatFrontendFirstRuntimeInstalled) return;
  window.__yachatFrontendFirstRuntimeInstalled = true;

  function chatById(chatId) {
    return state.chats.find((chat) => chat.id === chatId) || null;
  }

  function messagePreview(message) {
    const text = String(message?.text || "").trim();
    if (text) return text;
    const kind = String(message?.attachments?.[0]?.kind || "");
    if (kind === "image") return "Фото";
    if (kind === "video") return "Видео";
    return kind ? "Файл" : "";
  }

  function mergePersistedMessage(chat, message) {
    if (!message?.id) return null;
    const normalized = {
      ...message,
      chatId: chat.id,
      clientOnly: false,
      deliveryStatus: message.deliveryStatus || "sent"
    };
    const index = state.messages.findIndex((item) => item.id === normalized.id);
    if (index >= 0) state.messages[index] = { ...state.messages[index], ...normalized };
    else state.messages.push(normalized);
    state.messages.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    return normalized;
  }

  function updateChatPreview(chatId, message = null) {
    const chat = chatById(chatId);
    if (!chat) return;
    const source = message || [...state.messages]
      .filter((item) => item.chatId === chatId || state.activeChatId === chatId)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
    chat.lastMessage = source ? messagePreview(source) : "";
    chat.lastAt = source?.createdAt || chat.updatedAt || chat.createdAt || null;
    if (state.activeChatId === chatId) chat.unread = 0;
  }

  function renderChatState(chatId) {
    renderChatList();
    if (state.activeChatId === chatId) {
      renderActiveChat();
      renderMessages();
    }
  }

  if (typeof deliverTransientMessage === "function" && !deliverTransientMessage.__yachatFrontendFirst) {
    const wrappedDeliver = async function deliverFrontendFirst(chat, message) {
      if (!chat || !message || !yachatApi?.messenger?.send) return false;
      message.deliveryStatus = "sending";
      setTransientMessage(chat.id, message);
      if (state.activeChatId === chat.id) renderMessages();

      try {
        const result = await yachatApi.messenger.send({
          chatId: chat.id,
          clientMessageId: message.id,
          text: message.text,
          formattedHtml: message.formattedHtml || "",
          attachments: message.attachments,
          replyToMessageId: message.replyToMessageId || null
        });

        removeTransientMessage(chat.id, message.id);
        let persisted = null;
        if (result?.message) {
          persisted = mergePersistedMessage(chat, result.message);
        } else if (Array.isArray(result?.messages)) {
          state.messages = result.messages;
          persisted = state.messages.find((item) => item.id === message.id) || state.messages.at(-1) || null;
        } else {
          throw new Error("Message acknowledgement is missing");
        }
        if (Array.isArray(result?.chats)) state.chats = result.chats;
        updateChatPreview(chat.id, persisted);
        renderChatState(chat.id);
        return true;
      } catch (error) {
        message.deliveryStatus = "failed";
        setTransientMessage(chat.id, message);
        if (state.activeChatId === chat.id) renderMessages();
        showActionFeedback(translatedServerMessage(error?.message, "feedbackSendFailed"), {
          tone: "error",
          icon: "circle-alert",
          duration: 3200
        });
        return false;
      }
    };
    Object.defineProperty(wrappedDeliver, "__yachatFrontendFirst", { value: true });
    deliverTransientMessage = wrappedDeliver;
  }

  if (typeof deleteMessages === "function" && !deleteMessages.__yachatFrontendFirst) {
    const wrappedDelete = async function deleteFrontendFirst(messageIds, scope = "self") {
      const chat = getActiveChat();
      const ids = [...new Set(Array.isArray(messageIds) ? messageIds : [])].map(String).filter(Boolean);
      if (!chat || ids.length === 0) return;

      const transient = transientMessagesForChat(chat.id);
      const transientIds = new Set(transient.map((message) => String(message.id)));
      const persistedIds = ids.filter((id) => !transientIds.has(id));
      const previousMessages = [...state.messages];
      const previousChats = state.chats.map((item) => ({ ...item }));
      const removedTransient = transient.filter((message) => ids.includes(String(message.id)));

      ids.forEach((id) => removeTransientMessage(chat.id, id));
      state.messages = state.messages.filter((message) => !ids.includes(String(message.id)));
      updateChatPreview(chat.id);
      renderChatState(chat.id);

      try {
        if (persistedIds.length > 0 && yachatApi.messenger?.deleteMessage) {
          const result = await yachatApi.messenger.deleteMessage({
            chatId: chat.id,
            messageIds: persistedIds,
            scope
          });
          if (!result?.ok && !Array.isArray(result?.messages)) {
            throw new Error("Message deletion acknowledgement is missing");
          }
          if (Array.isArray(result?.messages)) state.messages = result.messages;
          if (Array.isArray(result?.chats)) state.chats = result.chats;
        }

        ids.forEach((id) => state.selectedMessageIds.delete(id));
        if (state.editingMessageId && ids.includes(String(state.editingMessageId))) state.editingMessageId = null;
        if (state.replyToMessage && ids.includes(String(state.replyToMessage.messageId))) state.replyToMessage = null;
        state.selectingMessages = state.selectedMessageIds.size > 0;
        renderComposerContext();
        renderChatState(chat.id);
      } catch (error) {
        state.messages = previousMessages;
        state.chats = previousChats;
        removedTransient.forEach((message) => setTransientMessage(chat.id, message));
        renderComposerContext();
        renderChatState(chat.id);
        throw error;
      }
    };
    Object.defineProperty(wrappedDelete, "__yachatFrontendFirst", { value: true });
    deleteMessages = wrappedDelete;
  }
})();
