(() => {
  "use strict";

  if (
    typeof refreshMessengerFromServer !== "function"
    || typeof renderChatList !== "function"
    || typeof renderMessages !== "function"
    || typeof renderActiveChat !== "function"
  ) {
    return;
  }

  let refreshInFlight = null;

  function compactDataValue(value) {
    const text = String(value || "");
    if (!text) return "";
    if (text.length <= 96) return text;
    return `${text.length}:${text.slice(0, 40)}:${text.slice(-40)}`;
  }

  function participantProfilesSignature(profiles) {
    return Object.entries(profiles || {})
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([id, profile]) => ({
        id,
        displayName: profile?.displayName || profile?.previewName || "",
        username: profile?.username || "",
        avatar: compactDataValue(profile?.avatarDataUrl),
        verified: Boolean(profile?.verified),
        online: Boolean(profile?.online),
        presence: profile?.presence || profile?.status || "",
        lastSeen: profile?.lastSeen || profile?.lastSeenAt || ""
      }));
  }

  function chatsSignature(chats = state.chats) {
    return JSON.stringify((Array.isArray(chats) ? chats : []).map((chat) => ({
      id: chat?.id || "",
      kind: chat?.kind || "",
      title: chat?.title || "",
      subtitle: chat?.subtitle || "",
      description: chat?.description || "",
      avatar: compactDataValue(chat?.avatarDataUrl),
      lastMessage: chat?.lastMessage || "",
      lastAt: chat?.lastAt || "",
      unread: Number(chat?.unread || 0),
      manualUnread: Boolean(chat?.manualUnread),
      unreadMessageId: chat?.unreadMessageId || "",
      pinned: Boolean(chat?.pinned),
      verified: Boolean(chat?.verified),
      canSend: chat?.canSend !== false,
      blockedByMe: Boolean(chat?.blockedByMe),
      blockedMe: Boolean(chat?.blockedMe),
      typing: chat?.typing || chat?.typingText || "",
      typingUsers: Array.isArray(chat?.typingUsers) ? chat.typingUsers : [],
      online: Boolean(chat?.online),
      presence: chat?.presence || chat?.status || "",
      lastSeen: chat?.lastSeen || chat?.lastSeenAt || "",
      participants: participantProfilesSignature(chat?.participantProfiles)
    })));
  }

  function attachmentSignature(attachment) {
    return {
      id: attachment?.id || "",
      kind: attachment?.kind || "",
      name: attachment?.name || "",
      type: attachment?.type || "",
      size: Number(attachment?.size || 0),
      source: compactDataValue(attachment?.dataUrl || attachment?.url || attachment?.src)
    };
  }

  function messagesSignature(messages = state.messages) {
    return JSON.stringify((Array.isArray(messages) ? messages : []).map((message) => ({
      id: message?.id || "",
      text: message?.text || "",
      author: message?.author || "",
      authorId: message?.authorId || message?.senderId || "",
      createdAt: message?.createdAt || "",
      updatedAt: message?.updatedAt || message?.editedAt || "",
      status: message?.status || "",
      readAt: message?.readAt || "",
      deletedAt: message?.deletedAt || "",
      hiddenFor: Array.isArray(message?.hiddenFor) ? message.hiddenFor : [],
      reactions: message?.reactions || null,
      replyToId: message?.replyToId || message?.replyTo?.id || "",
      forwardedFrom: message?.forwardedFrom || null,
      attachments: (Array.isArray(message?.attachments) ? message.attachments : []).map(attachmentSignature)
    })));
  }

  function activeChatSignature() {
    const chat = typeof getActiveChat === "function" ? getActiveChat() : null;
    if (!chat) return "";
    return JSON.stringify({
      id: chat.id || "",
      title: chat.title || "",
      subtitle: chat.subtitle || "",
      description: chat.description || "",
      avatar: compactDataValue(chat.avatarDataUrl),
      verified: Boolean(chat.verified),
      canSend: chat.canSend !== false,
      blockedByMe: Boolean(chat.blockedByMe),
      blockedMe: Boolean(chat.blockedMe),
      typing: chat.typing || chat.typingText || "",
      typingUsers: Array.isArray(chat.typingUsers) ? chat.typingUsers : [],
      online: Boolean(chat.online),
      presence: chat.presence || chat.status || "",
      lastSeen: chat.lastSeen || chat.lastSeenAt || ""
    });
  }

  function captureScrollState() {
    const messageDistanceFromBottom = messageList
      ? messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight
      : 0;
    return {
      chatTop: chatList?.scrollTop || 0,
      messageTop: messageList?.scrollTop || 0,
      messageNearBottom: messageDistanceFromBottom < 96
    };
  }

  function markBackgroundRender(root, selector) {
    root?.querySelectorAll(selector).forEach((element) => {
      element.classList.add("is-background-sync-render");
    });
  }

  function renderChatsSilently(scrollState) {
    renderChatList();
    markBackgroundRender(chatList, ".chat-row");
    if (chatList) chatList.scrollTop = scrollState.chatTop;
  }

  function renderMessagesSilently(scrollState) {
    renderMessages();
    markBackgroundRender(messageList, ".message-bubble, .message-day");
    if (!messageList) return;

    if (scrollState.messageNearBottom) {
      messageList.scrollTop = messageList.scrollHeight;
    } else {
      messageList.scrollTop = scrollState.messageTop;
    }
  }

  async function markReadBeforeRender() {
    if (
      typeof getActiveChat !== "function"
      || typeof activeChatIsVisible !== "function"
      || !yachatApi?.messenger?.markRead
    ) {
      return;
    }

    const chat = getActiveChat();
    if (!chat || Number(chat.unread || 0) <= 0 || !activeChatIsVisible()) {
      return;
    }

    const result = await yachatApi.messenger.markRead({ chatId: chat.id });
    state.chats = Array.isArray(result?.chats) ? result.chats : state.chats;
    state.messages = Array.isArray(result?.messages) ? result.messages : state.messages;
  }

  async function performSilentRefresh() {
    if (!state.account || !yachatApi?.messenger || state.pendingSearchChat) {
      return;
    }

    const beforeChats = chatsSignature();
    const beforeMessages = messagesSignature();
    const beforeActiveChat = activeChatSignature();
    const beforeActiveId = state.activeChatId;
    const scrollState = captureScrollState();
    const selectedChatId = state.activeChatId;

    if (yachatApi.messenger.snapshot) {
      const snapshot = await yachatApi.messenger.snapshot({
        chatId: selectedChatId,
        username: ""
      });

      state.pendingSearchChat = null;
      state.chats = Array.isArray(snapshot?.chats) ? snapshot.chats : [];
      const preferredChatId = snapshot?.activeChatId || selectedChatId;
      state.activeChatId = state.chats.some((chat) => chat.id === preferredChatId)
        ? preferredChatId
        : state.chats[0]?.id || "yachat-codes";
      state.messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    } else {
      const chats = await yachatApi.messenger.chats();
      state.chats = Array.isArray(chats) ? chats : [];
      state.activeChatId = state.chats.some((chat) => chat.id === selectedChatId)
        ? selectedChatId
        : state.chats[0]?.id || state.activeChatId;
      state.messages = state.activeChatId
        ? await yachatApi.messenger.messages(state.activeChatId)
        : [];
    }

    await markReadBeforeRender();

    const chatsChanged = beforeChats !== chatsSignature();
    const messagesChanged = beforeMessages !== messagesSignature();
    const activeChanged = beforeActiveId !== state.activeChatId
      || beforeActiveChat !== activeChatSignature();

    if (!chatsChanged && !messagesChanged && !activeChanged) {
      return;
    }

    if (activeChanged && typeof renderComposerContext === "function") {
      renderComposerContext();
    }

    if (chatsChanged || activeChanged) {
      renderChatsSilently(scrollState);
    }

    if (activeChanged) {
      renderActiveChat();
    }

    if (messagesChanged || activeChanged) {
      renderMessagesSilently(scrollState);
    }
  }

  refreshMessengerFromServer = function refreshMessengerSilently() {
    if (refreshInFlight) {
      return refreshInFlight;
    }

    refreshInFlight = performSilentRefresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  };
})();