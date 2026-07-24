(() => {
  "use strict";

  if (
    window.__yachatActiveChatIdentityGuardInstalled
    || typeof state === "undefined"
    || typeof getActiveChat !== "function"
  ) {
    return;
  }

  window.__yachatActiveChatIdentityGuardInstalled = true;

  let lastResolvedChat = null;

  function normalizeChatIdentity(chat) {
    if (!chat || typeof chat !== "object") return chat;

    if (chat.id === "yachat-favorites") {
      chat.kind = "saved";
      return chat;
    }

    if (chat.kind === "saved") {
      chat.kind = Array.isArray(chat.participantIds) && chat.participantIds.length > 2
        ? "group"
        : "private";
    }

    return chat;
  }

  function normalizeChatList() {
    if (!Array.isArray(state.chats)) return;
    state.chats.forEach(normalizeChatIdentity);
  }

  getActiveChat = function guardedGetActiveChat() {
    normalizeChatList();

    if (state.pendingSearchChat?.id === state.activeChatId) {
      lastResolvedChat = normalizeChatIdentity(state.pendingSearchChat);
      return lastResolvedChat;
    }

    const exact = state.chats.find((chat) => chat.id === state.activeChatId) || null;
    if (exact) {
      lastResolvedChat = normalizeChatIdentity(exact);
      return lastResolvedChat;
    }

    if (lastResolvedChat?.id === state.activeChatId) {
      return lastResolvedChat;
    }

    lastResolvedChat = null;
    return null;
  };

  const renderFunctions = ["renderChatList", "renderActiveChat", "renderPanel"];
  renderFunctions.forEach((name) => {
    const original = globalThis[name];
    if (typeof original !== "function" || original.__yachatIdentityGuarded) return;

    const wrapped = function guardedRender(...args) {
      normalizeChatList();
      return original.apply(this, args);
    };
    Object.defineProperty(wrapped, "__yachatIdentityGuarded", { value: true });
    globalThis[name] = wrapped;
  });
})();
