(() => {
  "use strict";

  if (
    typeof yachatApi === "undefined"
    || !yachatApi?.messenger?.updateChat
    || !yachatApi?.messenger?.chats
    || typeof panelBody === "undefined"
    || !panelBody
  ) {
    return;
  }

  const messenger = yachatApi.messenger;
  const originalUpdateChat = messenger.updateChat.bind(messenger);
  const originalChats = messenger.chats.bind(messenger);
  const savingChatIds = new Set();

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function avatarValue(chat) {
    return String(chat?.avatarDataUrl || "");
  }

  function findChat(chats, chatId) {
    return (Array.isArray(chats) ? chats : []).find((chat) => (
      String(chat?.id || "") === String(chatId || "")
    )) || null;
  }

  function feedback(success, message) {
    if (typeof showActionFeedback !== "function") return;
    showActionFeedback(message, success
      ? { icon: "image" }
      : { tone: "error", icon: "circle-alert", duration: 4200 });
  }

  function syncInterface() {
    try { renderChatList(); } catch {}
    try { renderActiveChat(); } catch {}
    try { renderPanel(); } catch {}
  }

  async function authoritativeChats() {
    const chats = await originalChats();
    return Array.isArray(chats) ? chats : [];
  }

  messenger.updateChat = async function updateChatWithPersistenceCheck(payload = {}) {
    const result = await originalUpdateChat(payload);
    if (!hasOwn(payload, "avatarDataUrl")) {
      return result;
    }

    const expectedAvatar = String(payload.avatarDataUrl || "");
    let chats = Array.isArray(result?.chats) ? result.chats : await authoritativeChats();
    let savedChat = findChat(chats, payload.chatId);

    if (!savedChat || avatarValue(savedChat) !== expectedAvatar) {
      chats = await authoritativeChats();
      savedChat = findChat(chats, payload.chatId);
    }

    if (!savedChat || avatarValue(savedChat) !== expectedAvatar) {
      const retry = await originalUpdateChat(payload);
      chats = Array.isArray(retry?.chats) ? retry.chats : await authoritativeChats();
      savedChat = findChat(chats, payload.chatId);
    }

    if (!savedChat || avatarValue(savedChat) !== expectedAvatar) {
      throw new Error("Аватар не сохранился на сервере.");
    }

    return {
      ...result,
      chat: savedChat,
      chats
    };
  };

  async function persistActiveChatAvatar(avatarDataUrl, sourceControl = null) {
    const chat = typeof getActiveChat === "function" ? getActiveChat() : null;
    const chatId = String(chat?.id || "");
    if (!chatId || savingChatIds.has(chatId)) return;

    const expectedAvatar = String(avatarDataUrl || "");
    const previousAvatar = avatarValue(chat);
    const title = String(
      panelBody.querySelector("[data-chat-title]")?.value
      || (typeof getChatTitle === "function" ? getChatTitle(chat) : chat.title)
      || ""
    ).trim();
    const description = String(
      panelBody.querySelector("[data-chat-description]")?.value
      ?? chat.description
      ?? ""
    ).trim();

    savingChatIds.add(chatId);
    if (sourceControl) sourceControl.disabled = true;
    state.pendingChatAvatarDataUrl = expectedAvatar;
    syncInterface();

    try {
      const result = await messenger.updateChat({
        chatId,
        title,
        description,
        avatarDataUrl: expectedAvatar
      });
      const savedChat = result?.chat || findChat(result?.chats, chatId);
      if (!savedChat || avatarValue(savedChat) !== expectedAvatar) {
        throw new Error("Аватар не сохранился на сервере.");
      }

      state.chats = typeof mergeChatIntoList === "function"
        ? mergeChatIntoList(result.chats || state.chats, savedChat)
        : (Array.isArray(result.chats) ? result.chats : state.chats);
      state.pendingChatAvatarDataUrl = null;
      syncInterface();
      feedback(true, state.language === "en" ? "Avatar saved" : "Аватар сохранён");
    } catch (error) {
      state.pendingChatAvatarDataUrl = null;
      const current = findChat(state.chats, chatId);
      if (current) current.avatarDataUrl = previousAvatar;
      try {
        state.chats = await authoritativeChats();
      } catch {
        // The previous server state remains in memory when the refresh also fails.
      }
      syncInterface();
      feedback(false, String(error?.message || (state.language === "en" ? "Avatar was not saved" : "Аватар не сохранился")));
    } finally {
      savingChatIds.delete(chatId);
      if (sourceControl?.isConnected) sourceControl.disabled = false;
    }
  }

  panelBody.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-chat-avatar-input]");
    if (!input) return;

    event.stopImmediatePropagation();
    const file = input.files?.[0];
    if (!file) return;

    try {
      const avatarDataUrl = await readAvatarFile(file);
      await persistActiveChatAvatar(avatarDataUrl, input);
    } catch (error) {
      if (!error?.cancelled) {
        feedback(false, String(error?.message || "Не удалось открыть изображение."));
      }
    } finally {
      input.value = "";
    }
  }, true);

  panelBody.addEventListener("click", (event) => {
    const button = event.target.closest('[data-panel-action="remove-chat-avatar"]');
    if (!button) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void persistActiveChatAvatar("", button);
  }, true);
})();