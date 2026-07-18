(() => {
  "use strict";

  if (typeof yachatApi === "undefined" || !yachatApi?.messenger?.updateChat || !yachatApi?.messenger?.chats) {
    return;
  }

  const CHANNEL_ID = "yachat-channel";
  const AUTH_TOKEN_KEY = "yachat-http-auth-token";
  const AVATAR_TARGET_CHARS = 1_100_000;
  const messenger = yachatApi.messenger;
  const originalUpdateChat = messenger.updateChat.bind(messenger);
  const originalChats = messenger.chats.bind(messenger);
  const nativeFetch = window.fetch.bind(window);
  const savingAvatarChatIds = new Set();
  let lastAuthoritativeAvatar = "";
  let hasAuthoritativeChannel = false;
  let channelRevision = 0;
  let channelSavePromise = null;
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

  function serverAvailable() {
    return ["http:", "https:"].includes(window.location.protocol) && Boolean(localStorage.getItem(AUTH_TOKEN_KEY));
  }

  async function serverJson(pathname, options = {}) {
    const token = localStorage.getItem(AUTH_TOKEN_KEY) || "";
    if (!token) {
      throw new Error("Сессия ЯЧата не найдена. Войдите в аккаунт заново.");
    }

    const response = await nativeFetch(pathname, {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.toLowerCase().includes("application/json");
    const payload = isJson ? await response.json().catch(() => null) : null;

    if (!response.ok) {
      const fallback = response.status === 413
        ? "Аватар слишком большой для сервера. ЯЧат уменьшил бы его, но браузер не смог обработать изображение."
        : `Сервер не сохранил аватар: HTTP ${response.status}.`;
      throw new Error(payload?.detail || payload?.error || fallback);
    }
    if (!isJson || !payload) {
      throw new Error("Сервер вернул некорректный ответ при сохранении аватара.");
    }
    return payload;
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

  async function fetchServerChats(options = {}) {
    if (!serverAvailable()) {
      return originalChats();
    }

    const requestedRevision = channelRevision;
    const chats = await serverJson(`/api/chats?avatarRefresh=${Date.now()}`);
    const stale = requestedRevision !== channelRevision;
    const saving = savingAvatarChatIds.has(CHANNEL_ID);
    if ((stale || saving) && !options.forceApply) {
      return Array.isArray(state?.chats) ? state.chats : chats;
    }
    return applyAuthoritativeChats(chats);
  }

  async function fetchStoredChannel(options = {}) {
    if (!serverAvailable()) {
      const chats = await originalChats();
      return { chat: findChat(chats, CHANNEL_ID), chats };
    }

    const requestedRevision = channelRevision;
    const result = await serverJson(`/api/chat/update?chatId=${encodeURIComponent(CHANNEL_ID)}&avatarRefresh=${Date.now()}`);
    const stale = requestedRevision !== channelRevision;
    const saving = savingAvatarChatIds.has(CHANNEL_ID);
    if ((!stale && !saving) || options.forceApply) {
      applyAuthoritativeChats(result.chats || []);
    }
    return result;
  }

  function loadAvatarImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Не удалось подготовить аватар для отправки на сервер."));
      image.src = source;
    });
  }

  async function compactAvatarDataUrl(source) {
    const value = String(source || "");
    if (!value.startsWith("data:image/") || value.length <= AVATAR_TARGET_CHARS) {
      return value;
    }

    const image = await loadAvatarImage(value);
    const naturalWidth = image.naturalWidth || image.width || 1;
    const naturalHeight = image.naturalHeight || image.height || 1;
    let best = value;

    for (const side of [640, 512, 384]) {
      const canvas = document.createElement("canvas");
      canvas.width = side;
      canvas.height = side;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) {
        break;
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      const scale = Math.max(side / naturalWidth, side / naturalHeight);
      const width = naturalWidth * scale;
      const height = naturalHeight * scale;
      context.clearRect(0, 0, side, side);
      context.drawImage(image, (side - width) / 2, (side - height) / 2, width, height);

      for (const quality of [0.9, 0.82, 0.74]) {
        const candidate = canvas.toDataURL("image/webp", quality);
        if (candidate.startsWith("data:image/webp") && candidate.length < best.length) {
          best = candidate;
        }
        if (best.length <= AVATAR_TARGET_CHARS) {
          return best;
        }
      }
    }

    if (best.length > 7_500_000) {
      throw new Error("Аватар не удалось уменьшить до безопасного размера для сервера.");
    }
    return best;
  }

  async function sha256Text(value) {
    if (!globalThis.crypto?.subtle || typeof TextEncoder !== "function") {
      return "";
    }
    const bytes = new TextEncoder().encode(String(value || ""));
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function verifyStoredAvatar(result, expectedAvatar) {
    const expected = String(expectedAvatar || "");
    const returned = String(result?.avatarDataUrl ?? result?.chat?.avatarDataUrl ?? "");
    if (!result?.persisted || returned !== expected) {
      throw new Error("Сервер вернул другую аватарку после сохранения.");
    }

    const expectedHash = await sha256Text(expected);
    if (expectedHash && result.avatarSha256 && result.avatarSha256 !== expectedHash) {
      throw new Error("Контрольная сумма аватарки на сервере не совпала.");
    }
  }

  async function performChannelSave(payload = {}) {
    const outgoing = { ...payload, chatId: CHANNEL_ID };
    if (hasOwn(outgoing, "avatarDataUrl")) {
      outgoing.avatarDataUrl = await compactAvatarDataUrl(outgoing.avatarDataUrl);
    }

    channelRevision += 1;
    savingAvatarChatIds.add(CHANNEL_ID);
    try {
      const saved = await serverJson("/api/chat/update", {
        method: "POST",
        body: JSON.stringify(outgoing)
      });

      if (hasOwn(outgoing, "avatarDataUrl")) {
        await verifyStoredAvatar(saved, outgoing.avatarDataUrl);
      }

      const verified = await fetchStoredChannel({ forceApply: true });
      if (hasOwn(outgoing, "avatarDataUrl")) {
        await verifyStoredAvatar(verified, outgoing.avatarDataUrl);
      }
      applyAuthoritativeChats(verified.chats || saved.chats || []);
      return {
        ...saved,
        ...verified,
        chat: verified.chat || saved.chat,
        chats: verified.chats || saved.chats
      };
    } finally {
      savingAvatarChatIds.delete(CHANNEL_ID);
    }
  }

  async function saveChannelOnServer(payload = {}) {
    if (!serverAvailable()) {
      return originalUpdateChat(payload);
    }

    while (channelSavePromise) {
      await channelSavePromise.catch(() => {});
    }
    const operation = performChannelSave(payload);
    channelSavePromise = operation;
    try {
      return await operation;
    } finally {
      if (channelSavePromise === operation) {
        channelSavePromise = null;
      }
    }
  }

  messenger.chats = async function chatsWithAuthoritativeChannelAvatar(...args) {
    if (!serverAvailable()) {
      return applyAuthoritativeChats(await originalChats(...args));
    }
    return fetchServerChats();
  };

  messenger.updateChat = async function updateChatWithServerOnlyChannelWrite(payload = {}) {
    if (String(payload?.chatId || "") !== CHANNEL_ID) {
      return originalUpdateChat(payload);
    }
    return saveChannelOnServer(payload);
  };

  function syncAvatarInterface() {
    if (typeof renderChatList === "function") renderChatList();
    if (typeof renderActiveChat === "function") renderActiveChat();
    if (typeof renderPanel === "function") renderPanel();
  }

  function avatarFeedback(message, tone = "success") {
    if (typeof showActionFeedback !== "function") return;
    showActionFeedback(message, tone === "error"
      ? { tone: "error", icon: "circle-alert", duration: 5200 }
      : { icon: "image" });
  }

  async function persistSelectedAvatar(avatarDataUrl, sourceControl = null) {
    const chat = typeof getActiveChat === "function" ? getActiveChat() : null;
    if (String(chat?.id || "") !== CHANNEL_ID) {
      return;
    }

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

    if (sourceControl) sourceControl.disabled = true;
    state.pendingChatAvatarDataUrl = String(avatarDataUrl || "");
    syncAvatarInterface();

    try {
      const result = await saveChannelOnServer({
        chatId: CHANNEL_ID,
        title,
        description,
        avatarDataUrl: avatarDataUrl || ""
      });
      state.pendingChatAvatarDataUrl = null;
      applyAuthoritativeChats(result.chats || state.chats);
      syncAvatarInterface();
      avatarFeedback(state.language === "en" ? "Avatar saved on the server" : "Аватар сохранён на сервере");
    } catch (error) {
      state.pendingChatAvatarDataUrl = null;
      const currentChat = findChat(state.chats, CHANNEL_ID);
      if (currentChat) currentChat.avatarDataUrl = previousAvatar;
      try {
        await fetchStoredChannel({ forceApply: true });
      } catch {
        // The visible error below remains the source of truth.
      }
      syncAvatarInterface();
      avatarFeedback(
        String(error?.message || (state.language === "en" ? "Avatar was not saved" : "Аватар не сохранился")),
        "error"
      );
    } finally {
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
      const requestedRevision = channelRevision;
      fetchStoredChannel()
        .then((result) => {
          if (
            requestedRevision === channelRevision
            && !savingAvatarChatIds.has(CHANNEL_ID)
            && typeof state !== "undefined"
            && state.activePanel === "chat"
            && getActiveChat()?.id === CHANNEL_ID
          ) {
            applyAuthoritativeChats(result.chats || []);
            syncAvatarInterface();
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
    if (!input || getActiveChat?.()?.id !== CHANNEL_ID) return;

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
    if (!removeButton || getActiveChat?.()?.id !== CHANNEL_ID) return;

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
