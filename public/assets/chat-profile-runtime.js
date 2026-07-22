(() => {
  "use strict";

  if (
    typeof state === "undefined"
    || typeof getActiveChat !== "function"
    || typeof renderPanel !== "function"
    || window.__yachatChatProfileRuntimeInstalled
  ) {
    return;
  }
  window.__yachatChatProfileRuntimeInstalled = true;

  const FAVORITES_AVATAR = "/assets/yachat-favorites.svg?v=47";
  const loadedGroupProfiles = new Set();
  const loadingGroupProfiles = new Map();
  let openMoreChatId = "";

  const labels = {
    ru: {
      username: "Юзернейм группы",
      usernameHint: "По нему участники смогут открыть группу по ссылке ЯЧата.",
      usernamePlaceholder: "например, yachat_team",
      more: "Ещё",
      close: "Закрыть",
      invalid: "Юзернейм: 3–24 латинские буквы, цифры или подчёркивание.",
      taken: "Этот юзернейм уже занят.",
      saveFailed: "Не удалось сохранить данные группы."
    },
    en: {
      username: "Group username",
      usernameHint: "Members can use it to open the group with a YaChat link.",
      usernamePlaceholder: "for example, yachat_team",
      more: "More",
      close: "Close",
      invalid: "Username: 3–24 Latin letters, digits, or underscores.",
      taken: "This username is already taken.",
      saveFailed: "Could not save the group."
    }
  };

  function l(key) {
    const language = state.language === "en" ? "en" : "ru";
    return labels[language][key] || labels.ru[key] || key;
  }

  function authToken() {
    return localStorage.getItem("yachat-http-auth-token") || "";
  }

  async function api(pathname, options = {}) {
    const response = await fetch(pathname, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(authToken() ? { Authorization: `Bearer ${authToken()}` } : {}),
        ...(options.headers || {})
      }
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(result?.detail || result?.error || "Request failed.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function normalizeGroupUsername(value) {
    return String(value || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 24);
  }

  function validGroupUsername(value) {
    return value === "" || /^[a-z0-9_]{3,24}$/.test(value);
  }

  function mergeGroupProfile(profile) {
    const chatId = String(profile?.chatId || "");
    if (!chatId) return null;
    const chat = (state.chats || []).find((item) => item.id === chatId);
    if (!chat) return null;
    chat.profileUsername = String(profile.profileUsername || "");
    chat.profileUrl = String(profile.profileUrl || "");
    chat.groupProfileLoaded = true;
    if (profile.title) chat.title = profile.title;
    if (Object.prototype.hasOwnProperty.call(profile, "description")) {
      chat.description = String(profile.description || "");
      chat.profileAbout = chat.description;
    }
    if (profile.avatarDataUrl) chat.avatarDataUrl = profile.avatarDataUrl;
    return chat;
  }

  async function loadGroupProfile(chatId, force = false) {
    const id = String(chatId || "");
    if (!id || (!force && loadedGroupProfiles.has(id))) return null;
    if (loadingGroupProfiles.has(id)) return loadingGroupProfiles.get(id);

    const promise = api(`/api/group-profile?chatId=${encodeURIComponent(id)}`)
      .then((profile) => {
        loadedGroupProfiles.add(id);
        const chat = mergeGroupProfile(profile);
        if (chat && state.activePanel === "chat" && getActiveChat()?.id === id) {
          renderPanel();
        }
        return profile;
      })
      .catch((error) => {
        if (error.status === 404 || error.status === 400) loadedGroupProfiles.add(id);
        return null;
      })
      .finally(() => loadingGroupProfiles.delete(id));

    loadingGroupProfiles.set(id, promise);
    return promise;
  }

  const originalChatAvatarSource = chatAvatarSource;
  chatAvatarSource = function patchedChatAvatarSource(chat) {
    if (chat?.id === "yachat-favorites" || chat?.kind === "saved") {
      return FAVORITES_AVATAR;
    }
    return originalChatAvatarSource(chat);
  };

  const originalGetChatAvatarText = getChatAvatarText;
  getChatAvatarText = function patchedGetChatAvatarText(chat) {
    if (chat?.id === "yachat-favorites" || chat?.kind === "saved") {
      return "★";
    }
    return originalGetChatAvatarText(chat);
  };

  const originalChatProfileUsername = chatProfileUsername;
  chatProfileUsername = function patchedChatProfileUsername(chat) {
    if (chat?.kind === "group") {
      return String(chat?.profileUsername || "").replace(/^@+/, "");
    }
    return originalChatProfileUsername(chat);
  };

  const originalChatProfileUrl = chatProfileUrl;
  chatProfileUrl = function patchedChatProfileUrl(chat) {
    if (chat?.kind === "group") {
      const username = chatProfileUsername(chat);
      return username
        ? `https://yachat.vercel.app/${encodeURIComponent(username)}`
        : String(chat?.inviteUrl || chat?.inviteCode || "");
    }
    return originalChatProfileUrl(chat);
  };

  function ensureMoreBackdrop() {
    let backdrop = document.querySelector("[data-chat-more-backdrop]");
    if (!backdrop) {
      backdrop = document.createElement("button");
      backdrop.type = "button";
      backdrop.className = "chat-more-backdrop";
      backdrop.dataset.chatMoreBackdrop = "";
      backdrop.setAttribute("aria-label", l("close"));
      backdrop.hidden = true;
      document.body.append(backdrop);
    }
    return backdrop;
  }

  function applyMoreState() {
    const chat = getActiveChat();
    const stack = panelBody?.querySelector("[data-chat-profile-more]");
    const backdrop = ensureMoreBackdrop();
    const open = Boolean(stack && chat && openMoreChatId === chat.id);

    if (stack) {
      if (!stack.querySelector("[data-chat-more-header]")) {
        const header = document.createElement("header");
        header.className = "chat-more-sheet-header";
        header.dataset.chatMoreHeader = "";
        header.innerHTML = `
          <strong>${escapeHtml(l("more"))}</strong>
          <button type="button" data-chat-more-close aria-label="${escapeHtml(l("close"))}">${iconSvg("x")}</button>
        `;
        stack.prepend(header);
        hydrateIcons(stack);
      }
      stack.hidden = !open;
      stack.classList.toggle("is-open", open);
    }

    backdrop.hidden = !open;
    document.body.classList.toggle("chat-more-open", open);
  }

  function injectGroupUsernameField() {
    const chat = getActiveChat();
    if (!chat || chat.kind !== "group" || !canOwnActiveGroup(chat) || state.activePanel !== "chat") {
      return;
    }

    const titleInput = panelBody?.querySelector("[data-chat-title]");
    const titleField = titleInput?.closest(".panel-field");
    if (!titleField || panelBody.querySelector("[data-group-username-field]")) return;

    const field = document.createElement("label");
    field.className = "panel-field group-username-field";
    field.dataset.groupUsernameField = "";
    field.innerHTML = `
      <span>${escapeHtml(l("username"))}</span>
      <div class="username-input-shell is-panel">
        <b aria-hidden="true">@</b>
        <input
          type="text"
          maxlength="24"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          value="${escapeHtml(String(chat.profileUsername || ""))}"
          placeholder="${escapeHtml(l("usernamePlaceholder"))}"
          data-group-username
        />
      </div>
      <small>${escapeHtml(l("usernameHint"))}</small>
    `;
    titleField.insertAdjacentElement("afterend", field);
  }

  const originalRenderPanel = renderPanel;
  renderPanel = function patchedRenderPanel() {
    originalRenderPanel();
    const chat = getActiveChat();
    if (state.activePanel === "chat" && chat?.kind === "group") {
      injectGroupUsernameField();
      if (!loadedGroupProfiles.has(chat.id)) void loadGroupProfile(chat.id);
    }
    applyMoreState();
  };

  const originalClosePanel = closePanel;
  closePanel = function patchedClosePanel() {
    openMoreChatId = "";
    originalClosePanel();
    applyMoreState();
  };

  toggleChatProfileMore = function patchedToggleChatProfileMore() {
    const chat = getActiveChat();
    if (!chat) return;
    openMoreChatId = openMoreChatId === chat.id ? "" : chat.id;
    applyMoreState();
  };

  saveActiveChat = async function saveActiveChatWithUsername(submitButton) {
    const chat = getActiveChat();
    if (!chat || !yachatApi.messenger?.updateChat) return;

    const title = panelBody?.querySelector("[data-chat-title]")?.value || getChatTitle(chat);
    const description = panelBody?.querySelector("[data-chat-description]")?.value || "";
    const avatarDataUrl = state.pendingChatAvatarDataUrl === null
      ? chat.avatarDataUrl || ""
      : state.pendingChatAvatarDataUrl;
    const usernameInput = panelBody?.querySelector("[data-group-username]");
    const username = normalizeGroupUsername(usernameInput?.value || chat.profileUsername || "");

    if (usernameInput) usernameInput.value = username;
    if (!validGroupUsername(username)) {
      showActionFeedback(l("invalid"), { tone: "error", icon: "circle-alert" });
      usernameInput?.focus();
      return;
    }

    setLoading(submitButton, true);
    try {
      const result = await yachatApi.messenger.updateChat({
        chatId: chat.id,
        title,
        description,
        avatarDataUrl
      });
      state.pendingChatAvatarDataUrl = null;
      state.chats = mergeChatIntoList(result.chats || await yachatApi.messenger.chats(), result.chat);
      state.messages = result.messages || state.messages;

      if (chat.kind === "group" && canOwnActiveGroup(chat)) {
        const profile = await api("/api/group-profile", {
          method: "POST",
          body: JSON.stringify({ chatId: chat.id, username })
        });
        loadedGroupProfiles.add(chat.id);
        mergeGroupProfile(profile);
      }

      renderChatList();
      renderActiveChat();
      renderPanel();
    } catch (error) {
      const message = /already taken|reserved/i.test(String(error?.message || ""))
        ? l("taken")
        : translatedServerMessage(error?.message, "errSendMessage") || l("saveFailed");
      showActionFeedback(message, { tone: "error", icon: "circle-alert", duration: 3400 });
    } finally {
      setLoading(submitButton, false);
    }
  };

  panelBody?.addEventListener("input", (event) => {
    const input = event.target.closest("[data-group-username]");
    if (!input) return;
    const selection = input.selectionStart;
    input.value = normalizeGroupUsername(input.value);
    const next = Math.min(selection ?? input.value.length, input.value.length);
    input.setSelectionRange?.(next, next);
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-chat-more-close]") || event.target.closest("[data-chat-more-backdrop]")) {
      openMoreChatId = "";
      applyMoreState();
      return;
    }

    const action = event.target.closest("[data-chat-profile-more] [data-panel-action]");
    if (action && action.dataset.panelAction !== "chat-profile-more") {
      openMoreChatId = "";
      window.setTimeout(applyMoreState, 0);
    }
  }, true);

  const originalOpenRouteTarget = typeof openRouteTargetFromLocation === "function"
    ? openRouteTargetFromLocation
    : null;
  if (originalOpenRouteTarget) {
    openRouteTargetFromLocation = async function openUserOrGroupRoute() {
      const username = typeof routeUsernameFromLocation === "function"
        ? routeUsernameFromLocation()
        : "";
      if (username && state.account) {
        try {
          const profile = await api(`/api/group-profile/by-username?username=${encodeURIComponent(username)}`);
          if (profile?.chatId) {
            let chat = (state.chats || []).find((item) => item.id === profile.chatId);
            if (!chat) {
              state.chats = await yachatApi.messenger.chats();
              chat = state.chats.find((item) => item.id === profile.chatId);
            }
            if (chat) {
              mergeGroupProfile(profile);
              hideErrorPage?.();
              await selectChat(profile.chatId, { preserveRoute: true });
              return;
            }
          }
        } catch {
          // It can still be a user route; let the original router resolve it.
        }
      }
      return originalOpenRouteTarget();
    };
  }

  function repairFavoritesAvatarDom(root = document) {
    root.querySelectorAll?.(".is-favorites").forEach((avatar) => {
      const image = avatar.querySelector("img") || document.createElement("img");
      image.src = FAVORITES_AVATAR;
      image.alt = "";
      if (!image.parentNode) avatar.replaceChildren(image);
      avatar.classList.add("has-image");
    });
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) repairFavoritesAvatarDom(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  repairFavoritesAvatarDom();
  renderChatList();
  renderActiveChat();
  if (state.activePanel) renderPanel();
  window.setTimeout(() => {
    repairFavoritesAvatarDom();
    if (location.pathname !== "/") void openRouteTargetFromLocation?.();
  }, 350);
})();
