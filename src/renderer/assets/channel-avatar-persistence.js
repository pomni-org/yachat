(() => {
  "use strict";

  if (typeof yachatApi === "undefined" || !yachatApi?.messenger?.updateChat || !yachatApi?.messenger?.chats) {
    return;
  }

  const messenger = yachatApi.messenger;
  const originalUpdateChat = messenger.updateChat.bind(messenger);
  const originalChats = messenger.chats.bind(messenger);

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function avatarValue(chat) {
    return String(chat?.avatarDataUrl || "");
  }

  function findChat(chats, chatId) {
    return (Array.isArray(chats) ? chats : []).find((chat) => String(chat?.id || "") === String(chatId || "")) || null;
  }

  async function authoritativeChats() {
    return await originalChats();
  }

  messenger.updateChat = async function updateChatWithPersistenceCheck(payload = {}) {
    const result = await originalUpdateChat(payload);
    if (!hasOwn(payload, "avatarDataUrl")) {
      return result;
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

    return {
      ...result,
      chat: savedChat,
      chats
    };
  };
})();
