(() => {
  "use strict";

  if (typeof yachatApi === "undefined" || !yachatApi?.messenger?.updateChat || !yachatApi?.messenger?.chats) {
    return;
  }

  const CHANNEL_ID = "yachat-channel";
  const messenger = yachatApi.messenger;
  const originalUpdateChat = messenger.updateChat.bind(messenger);
  const originalChats = messenger.chats.bind(messenger);
  const savingAvatarChatIds = new Set();
  let lastAuthoritativeAvatar = "";
  let hasAuthoritativeChannel = false;
  let refreshingProfile = false;

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function avatarValue(chat) {
    return String(chat?.avatarDataUrl || "");
  }

  function findChat(chats, chatId) {
    return (Array.isArray(chats) ? chats : []).find((chat) => String(chat?.id || "") === String(chatId || "")) || null;
  }

  function applyAuthoritativeChats(chats) {
    if (!Array.isArray(chats)) {
      return [];
    }

    const channel = findChat(chats, CHANNEL_ID);
    if (channel) {
      hasAuthoritativeChannel = true;
      lastAuthoritativeAvatar = avatarValue(channel);
    }
    if (typeof state !== "undefined" && Array.isArray(state.chats)) {
      state.chats = chats;
    }
    return chats;
  }

  async function authoritativeChats() {
    return applyAuthoritativeChats(await originalChats());
  }

  messenger.chats = async function chatsWithAuthoritativeChannelAvatar(...args) {
    return applyAuthoritativeChats(await originalChats(...args));
  };

  messenger.updateChat = async function updateChatWithPersistenceCheck(payload = {}) {
    const result = await originalUpdateChat(payload);
    const returnedChats = Array.isArray(result?.chats) ? applyAuthoritativeChats(result.chats) : [];

    if (!hasOwn(payload, "avatarDataUrl")) {
      return {
        ...result,
        ...(returnedChats.length ? { chats: returnedChats } : {})
      };
    }

    const expectedAvatar = String(payload.avatarDataUrl || "");
    let chats = await authoritativeChats();
    let savedChat = findChat(chats, payload.chatId);

    if (!savedChat || avatarValue(savedChat) !== expectedAvatar) {
      await originalUpdateChat(payload);
      chats = await authoritativeChats();
      savedChat = findChat(chats, payload.chatId);
    }

    if (!savedChat || avatarValue(savedChat) !== expectedAvatar) {
      throw new Error("Аватар не сохранился на сервере. ЯЧат не будет притворяться, что всё получилось.");
    }

    if (String(payload.chatId || "") === CHANNEL_ID) {
      hasAuthoritativeChannel = true;
      lastAuthoritativeAvatar = expectedAvatar;
    }

    return {
      ...result,
      chat: savedChat,
      chats
    };
  };

  function syncAvatarInterface() {
    if (typeof renderChatList === "function") renderChatList();
    if (typeof renderActiveChat === "function") renderActiveChat();
    if (typeof renderPanel === "function") renderPanel();
  }

  function avatarFeedback(message, tone = "success") {
    if (typeof showActionFeedback !== "function") return;
    showActionFeedback(message, tone === "error"
      ? { tone: "error", icon: "circle-alert", duration: 4200 }
      : { icon: "image" });
  }

  async function persistSelectedAvatar(avatarDataUrl, sourceControl = null) {
    const chat = typeof getActiveChat === "function" ? getActiveChat() : null;
    const chatId = String(chat?.id || "");
    if (!chatId || savingAvatarChatIds.has(chatId)) return;

    const expectedAvatar = String(avatarDataUrl || "");
    const previousAvatar = avatarValue(chat);
    const title = String(
      panelBody?.querySelector?.("[data-chat-title]")?.value
      || (typeof getChatTitle === "function" ? getChatTitle(chat) : chat.title)
      || ""
    ).trim();
    const description = String(
      panelBody?.querySelector?.("[data-chat-description]")?.value
      ?? chat.description
      ?? ""
    ).trim();

    savingAvatarChatIds.add(chatId);
    if (sourceControl) sourceControl.disabled = true;
    state.pendingChatAvatarDataUrl = expectedAvatar;
    syncAvatarInterface();

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

      applyAuthoritativeChats(result.chats || state.chats);
      state.pendingChatAvatarDataUrl = null;
      syncAvatarInterface();
      avatarFeedback(state.language === "en" ? "Avatar saved" : "Аватар сохранён");
    } catch (error) {
      state.pendingChatAvatarDataUrl = null;
      const currentChat = findChat(state.chats, chatId);
      if (currentChat) currentChat.avatarDataUrl = previousAvatar;
      try {
        await authoritativeChats();
      } catch {
        // Keep the last known server state when a refresh is unavailable too.
      }
      syncAvatarInterface();
      avatarFeedback(
        String(error?.message || (state.language === "en" ? "Avatar was not saved" : "Аватар не сохранился")),
        "error"
      );
    } finally {
      savingAvatarChatIds.delete(chatId);
      if (sourceControl?.isConnected) sourceControl.disabled = false;
    }
  }

  if (typeof chatAvatarSource === "function") {
    const originalChatAvatarSource = chatAvatarSource;
    chatAvatarSource = function authoritativeChatAvatarSource(chat) {
      if (String(chat?.id || "") !== CHANNEL_ID) {
        return originalChatAvatarSource(chat);
      }

      const pending = typeof state !== "undefined" ? state.pendingChatAvatarDataUrl : null;
      if (pending !== null && pending !== undefined) {
        return String(pending || "");
      }

      const liveChannel = typeof state !== "undefined" ? findChat(state.chats, CHANNEL_ID) : null;
      if (liveChannel) {
        return avatarValue(liveChannel) || originalChatAvatarSource(liveChannel);
      }
      if (hasAuthoritativeChannel) {
        return lastAuthoritativeAvatar;
      }
      return avatarValue(chat) || originalChatAvatarSource(chat);
    };
  }

  if (typeof openPanel === "function" && typeof renderPanel === "function") {
    const originalOpenPanel = openPanel;
    openPanel = function openPanelWithFreshChannelAvatar(type) {
      originalOpenPanel(type);
      const activeChat = typeof getActiveChat === "function" ? getActiveChat() : null;
      if ((type || "settings") !== "chat" || activeChat?.id !== CHANNEL_ID || refreshingProfile) {
        return;
      }

      refreshingProfile = true;
      authoritativeChats()
        .then(() => {
          if (typeof state !== "undefined" && state.activePanel === "chat" && getActiveChat()?.id === CHANNEL_ID) {
            if (typeof renderChatList === "function") renderChatList();
            if (typeof renderActiveChat === "function") renderActiveChat();
            renderPanel();
          }
        })
        .catch(() => {})
        .finally(() => {
          refreshingProfile = false;
        });
    };
  }

  panelBody?.addEventListener("change", async (event) => {
    const input = event.target.closest("[data-chat-avatar-input]");
    if (!input) return;

    event.stopImmediatePropagation();
    const file = input.files?.[0];
    if (!file) return;

    try {
      const avatarDataUrl = await readAvatarFile(file);
      await persistSelectedAvatar(avatarDataUrl, input);
    } catch (error) {
      if (!error?.cancelled) {
        avatarFeedback(String(error?.message || "Не удалось открыть изображение."), "error");
      }
    } finally {
      input.value = "";
    }
  }, true);

  panelBody?.addEventListener("click", (event) => {
    const removeButton = event.target.closest('[data-panel-action="remove-chat-avatar"]');
    if (!removeButton) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void persistSelectedAvatar("", removeButton);
  }, true);

  if (typeof state !== "undefined") {
    const initialChannel = findChat(state.chats, CHANNEL_ID);
    if (initialChannel) {
      hasAuthoritativeChannel = true;
      lastAuthoritativeAvatar = avatarValue(initialChannel);
    }
  }
})();