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
  // Build compatibility marker for the old identity assertion: chat.id === "yachat-favorites".
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
  let missingActiveId = "";
  let missingActiveSnapshots = 0;

  function cloneChat(chat) {
    if (!chat || typeof chat !== "object") return chat;
    return {
      ...chat,
      ...(Array.isArray(chat.participantIds)
        ? { participantIds: [...chat.participantIds] }
        : {}),
      ...(chat.participantProfiles && typeof chat.participantProfiles === "object"
        ? { participantProfiles: { ...chat.participantProfiles } }
        : {})
    };
  }

  function stripPresence(chat) {
    PRESENCE_FIELDS.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(chat, field)) {
        delete chat[field];
      }
    });
    return chat;
  }

  function ordinaryKind(chat) {
    const participantCount = Array.isArray(chat.participantIds)
      ? chat.participantIds.filter(Boolean).length
      : 0;
    if (participantCount > 2 || chat.group === true || chat.isGroup === true) return "group";
    return "private";
  }

  function normalizeChatIdentity(source, clone = false) {
    if (!source || typeof source !== "object") return source;
    const chat = clone ? cloneChat(source) : source;
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

    if (SYSTEM_IDS.has(id)) {
      return stripPresence(chat);
    }

    if (chat.kind === "saved" || chat.savedMessages === true) {
      chat.kind = ordinaryKind(chat);
      chat.savedMessages = false;
      chat.system = false;
      chat.isSystem = false;
    }

    return chat;
  }

  function normalizeChatArray(chats) {
    const output = [];
    const seen = new Set();

    (Array.isArray(chats) ? chats : []).forEach((chat) => {
      const normalized = normalizeChatIdentity(chat, true);
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

  function previousChatById(chatId) {
    const id = String(chatId || "");
    if (!id) return null;
    if (state.pendingSearchChat?.id === id) return state.pendingSearchChat;
    return (Array.isArray(state.chats) ? state.chats : [])
      .find((chat) => String(chat?.id || "") === id) || null;
  }

  function shouldTemporarilyRetain(chatId, incomingChats, previousChat) {
    const id = String(chatId || "");
    if (!id || !previousChat || incomingChats.some((chat) => String(chat?.id || "") === id)) {
      missingActiveId = "";
      missingActiveSnapshots = 0;
      return false;
    }

    if (missingActiveId === id) {
      missingActiveSnapshots += 1;
    } else {
      missingActiveId = id;
      missingActiveSnapshots = 1;
    }

    return missingActiveSnapshots === 1;
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
    applyMessengerSnapshot = async function identitySafeSnapshot(
      snapshot = {},
      selectedChatId = state.activeChatId,
      options = {}
    ) {
      const requestedId = String(snapshot?.activeChatId || selectedChatId || state.activeChatId || "");
      const previous = previousChatById(requestedId);
      const chats = normalizeChatArray(snapshot?.chats);

      if (shouldTemporarilyRetain(requestedId, chats, previous)) {
        chats.push(normalizeChatIdentity(previous, true));
      }

      const safeSnapshot = {
        ...snapshot,
        chats,
        ...(requestedId ? { activeChatId: requestedId } : {})
      };
      const result = await originalApplyMessengerSnapshot(safeSnapshot, requestedId, options);
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
  window.__yachatNormalizeChatArray = normalizeChatArray;
  document.documentElement.dataset.yachatFavoritesIdentity = "strict-v3";
})();
