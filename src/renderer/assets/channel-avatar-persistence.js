(() => {
  "use strict";

  if (typeof yachatApi === "undefined" || !yachatApi?.messenger?.updateChat || !yachatApi?.messenger?.chats) {
    return;
  }

  const CHANNEL_ID = "yachat-channel";
  const messenger = yachatApi.messenger;
  const originalUpdateChat = messenger.updateChat.bind(messenger);
  const originalChats = messenger.chats.bind(messenger);
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
            renderChatList?.();
            renderActiveChat?.();
            renderPanel();
          }
        })
        .catch(() => {})
        .finally(() => {
          refreshingProfile = false;
        });
    };
  }

  if (typeof state !== "undefined") {
    const initialChannel = findChat(state.chats, CHANNEL_ID);
    if (initialChannel) {
      hasAuthoritativeChannel = true;
      lastAuthoritativeAvatar = avatarValue(initialChannel);
    }
  }
})();