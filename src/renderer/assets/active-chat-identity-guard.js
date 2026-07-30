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

  const FAVORITES_ID = "yachat-favorites";
  const SYSTEM_IDS = new Set([FAVORITES_ID, "yachat-codes", "yachat-channel"]);
  const PRESENCE_FIELDS = [
    "online",
    "isOnline",
    "presence",
    "status",
    "lastSeen",
    "lastSeenAt",
    "typing",
    "typingText",
    "typingUsers"
  ];
  let lastResolvedChat = null;

  function stripPresence(chat) {
    PRESENCE_FIELDS.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(chat, field)) {
        delete chat[field];
      }
    });
    return chat;
  }

  function normalizeChatIdentity(chat) {
    if (!chat || typeof chat !== "object") return chat;

    const id = String(chat.id || "");
    if (id === FAVORITES_ID) {
      chat.id = FAVORITES_ID;
      chat.kind = "saved";
      chat.system = true;
      chat.isSystem = true;
      chat.savedMessages = true;
      chat.canSend = true;
      chat.participantIds = [];
      chat.participantProfiles = {};
      return stripPresence(chat);
    }

    if (chat.kind === "saved") {
      chat.kind = Array.isArray(chat.participantIds) && chat.participantIds.length > 2
        ? "group"
        : "private";
      chat.savedMessages = false;
    }

    if (SYSTEM_IDS.has(id)) {
      return stripPresence(chat);
    }

    return chat;
  }

  function normalizeChatArray(chats) {
    const output = [];
    const seen = new Set();

    (Array.isArray(chats) ? chats : []).forEach((chat) => {
      const normalized = normalizeChatIdentity(chat);
      const id = String(normalized?.id || "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      output.push(normalized);
    });

    return output;
  }

  function normalizeChatList() {
    if (!Array.isArray(state.chats)) return;
    state.chats = normalizeChatArray(state.chats);
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
      return normalizeChatIdentity(lastResolvedChat);
    }

    lastResolvedChat = null;
    return null;
  };

  if (typeof applyMessengerSnapshot === "function") {
    const originalApplyMessengerSnapshot = applyMessengerSnapshot;
    applyMessengerSnapshot = async function identitySafeSnapshot(snapshot = {}, ...args) {
      const safeSnapshot = {
        ...snapshot,
        chats: normalizeChatArray(snapshot?.chats)
      };
      const result = await originalApplyMessengerSnapshot(safeSnapshot, ...args);
      normalizeChatList();
      return result;
    };
  }

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

  window.__yachatNormalizeChatIdentity = normalizeChatIdentity;
  document.documentElement.dataset.yachatFavoritesIdentity = "strict-v2";
})();
