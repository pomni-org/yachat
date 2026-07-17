(() => {
  "use strict";

  const editor = document.querySelector("[data-rich-message-editor]");
  const composer = document.querySelector('[data-form="message"]');
  const messageListElement = document.querySelector("[data-message-list]");

  if (!editor || !composer || !messageListElement) {
    return;
  }

  const mentionState = {
    strip: null,
    users: [],
    selectedIndex: 0,
    triggerRange: null,
    query: "",
    requestId: 0,
    userByUsername: new Map()
  };

  function applicationState() {
    try {
      return typeof state !== "undefined" ? state : null;
    } catch {
      return null;
    }
  }

  function applicationApi() {
    try {
      return typeof yachatApi !== "undefined" ? yachatApi : null;
    } catch {
      return null;
    }
  }

  function activeChat() {
    try {
      return typeof getActiveChat === "function" ? getActiveChat() : null;
    } catch {
      return null;
    }
  }

  function escape(value) {
    try {
      return typeof escapeHtml === "function"
        ? escapeHtml(String(value ?? ""))
        : String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
    } catch {
      return "";
    }
  }

  function cleanUsername(value) {
    return String(value || "")
      .trim()
      .replace(/^@+/, "")
      .toLocaleLowerCase();
  }

  function normalizeMentionUser(user = {}) {
    const username = cleanUsername(user.username || user.profileUsername);
    const id = String(user.id || user.userId || user.profileUserId || "").trim();
    if (!id || !username) {
      return null;
    }

    return {
      id,
      username,
      displayName: String(user.displayName || user.previewName || user.title || username).trim() || username,
      avatarDataUrl: String(user.avatarDataUrl || ""),
      avatarAccent: String(user.avatarAccent || "#471AFF"),
      verified: Boolean(user.verified),
      verifiedTitle: String(user.verifiedTitle || ""),
      verifiedDescription: String(user.verifiedDescription || "")
    };
  }

  function mergeUsers(...groups) {
    const appState = applicationState();
    const ownId = String(appState?.account?.id || "");
    const seen = new Set();
    const result = [];

    groups.flat().forEach((candidate) => {
      const user = normalizeMentionUser(candidate);
      if (!user || user.id === ownId || seen.has(user.id)) {
        return;
      }
      seen.add(user.id);
      result.push(user);
      mentionState.userByUsername.set(user.username, user);
    });

    return result;
  }

  function chatUsers(chat) {
    if (!chat) {
      return [];
    }

    const appState = applicationState();
    const profiles = chat.participantProfiles && typeof chat.participantProfiles === "object"
      ? Object.values(chat.participantProfiles)
      : [];
    const peerId = Array.isArray(chat.participantIds)
      ? chat.participantIds.find((id) => String(id) !== String(appState?.account?.id || ""))
      : "";
    const directPeer = chat.kind === "private" && chat.profileUsername
      ? [{
          id: chat.profileUserId || chat.peerId || peerId,
          username: chat.profileUsername,
          displayName: chat.title,
          avatarDataUrl: chat.avatarDataUrl,
          avatarAccent: chat.avatarAccent,
          verified: chat.verified,
          verifiedTitle: chat.verifiedTitle,
          verifiedDescription: chat.verifiedDescription
        }]
      : [];

    return mergeUsers(profiles, directPeer);
  }

  function knownUsers() {
    const appState = applicationState();
    const currentChatUsers = chatUsers(activeChat());
    const cachedUsers = [
      ...(appState?.contactMatches || []),
      ...(appState?.createChatUsers || []),
      ...(appState?.chatSearchUsers || [])
    ];
    const historicalUsers = (appState?.chats || []).flatMap(chatUsers);
    return mergeUsers(currentChatUsers, cachedUsers, historicalUsers);
  }

  function verifiedMarkup(user) {
    try {
      return user.verified && typeof renderVerified === "function" ? renderVerified(user) : "";
    } catch {
      return "";
    }
  }

  function avatarMarkup(user) {
    if (user.avatarDataUrl) {
      return `<span class="mention-person-avatar"><img src="${escape(user.avatarDataUrl)}" alt="" /></span>`;
    }
    const initial = String(user.displayName || user.username).trim().slice(0, 1).toUpperCase() || "Я";
    return `<span class="mention-person-avatar" style="--mention-avatar:${escape(user.avatarAccent)}">${escape(initial)}</span>`;
  }

  function ensureStrip() {
    if (mentionState.strip?.isConnected) {
      return mentionState.strip;
    }

    const strip = document.createElement("section");
    strip.className = "mention-people-strip";
    strip.hidden = true;
    strip.setAttribute("role", "listbox");
    strip.setAttribute("aria-label", "Упомянуть человека");
    strip.innerHTML = '<div class="mention-people-scroller" data-mention-people></div>';
    composer.insertAdjacentElement("afterbegin", strip);
    mentionState.strip = strip;

    strip.addEventListener("pointerdown", (event) => {
      if (event.target.closest("[data-mention-user-id]")) {
        event.preventDefault();
      }
    });

    strip.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mention-user-id]");
      if (!button) {
        return;
      }
      const user = mentionState.users.find((item) => item.id === button.dataset.mentionUserId);
      if (user) {
        insertMention(user);
      }
    });

    return strip;
  }

  function closeStrip() {
    if (mentionState.strip) {
      mentionState.strip.hidden = true;
    }
    mentionState.users = [];
    mentionState.selectedIndex = 0;
    mentionState.triggerRange = null;
    mentionState.query = "";
  }

  function renderStrip() {
    const strip = ensureStrip();
    const target = strip.querySelector("[data-mention-people]");
    if (!target) {
      return;
    }

    if (!mentionState.users.length) {
      closeStrip();
      return;
    }

    strip.hidden = false;
    mentionState.selectedIndex = Math.min(mentionState.selectedIndex, mentionState.users.length - 1);
    target.innerHTML = mentionState.users.map((user, index) => `
      <button
        class="mention-person${index === mentionState.selectedIndex ? " is-selected" : ""}"
        type="button"
        role="option"
        aria-selected="${index === mentionState.selectedIndex ? "true" : "false"}"
        data-mention-user-id="${escape(user.id)}"
      >
        ${avatarMarkup(user)}
        <span class="mention-person-copy">
          <strong>${escape(user.displayName)} ${verifiedMarkup(user)}</strong>
          <small>@${escape(user.username)}</small>
        </span>
      </button>
    `).join("");

    try {
      if (typeof hydrateIcons === "function") {
        hydrateIcons(strip);
      }
    } catch {
      // Значки не должны ломать выбор упоминания.
    }
  }

  function currentTrigger() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }

    const caret = selection.getRangeAt(0);
    if (!editor.contains(caret.endContainer)) {
      return null;
    }

    let node = caret.endContainer;
    let offset = caret.endOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      const previous = node.childNodes?.[Math.max(0, offset - 1)];
      if (previous?.nodeType !== Node.TEXT_NODE) {
        return null;
      }
      node = previous;
      offset = previous.nodeValue?.length || 0;
    }

    const before = String(node.nodeValue || "").slice(0, offset);
    const match = before.match(/(^|\s)@([\p{L}\p{N}_.-]{0,32})$/u);
    if (!match) {
      return null;
    }

    const range = document.createRange();
    range.setStart(node, offset - match[2].length - 1);
    range.setEnd(node, offset);
    return {
      query: cleanUsername(match[2]),
      range
    };
  }

  function filterUsers(users, query) {
    const normalized = cleanUsername(query);
    if (!normalized) {
      return users.slice(0, 12);
    }

    return users.filter((user) => {
      const haystack = `${user.displayName} ${user.username}`.toLocaleLowerCase();
      return haystack.includes(normalized);
    }).slice(0, 12);
  }

  async function refreshSuggestions() {
    const trigger = currentTrigger();
    if (!trigger) {
      closeStrip();
      return;
    }

    mentionState.triggerRange = trigger.range.cloneRange();
    mentionState.query = trigger.query;
    mentionState.selectedIndex = 0;

    const localUsers = filterUsers(knownUsers(), trigger.query);
    mentionState.users = localUsers;
    renderStrip();

    const api = applicationApi();
    if (trigger.query.length < 2 || !api?.users?.search) {
      return;
    }

    const requestId = ++mentionState.requestId;
    try {
      const remoteUsers = await api.users.search(trigger.query);
      if (requestId !== mentionState.requestId || mentionState.query !== trigger.query) {
        return;
      }
      mentionState.users = filterUsers(mergeUsers(localUsers, remoteUsers), trigger.query);
      renderStrip();
    } catch {
      // Локальные контакты остаются доступны при временной ошибке каталога.
    }
  }

  function insertMention(user) {
    const range = mentionState.triggerRange;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      closeStrip();
      return;
    }

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    range.deleteContents();

    const link = document.createElement("a");
    link.className = "message-mention";
    link.href = `${window.location.origin}/@${encodeURIComponent(user.username)}`;
    link.dataset.mentionUsername = user.username;
    link.dataset.mentionUserId = user.id;
    link.textContent = `@${user.username}`;

    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(link);
    range.setStartAfter(space);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    editor.focus({ preventScroll: true });
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    closeStrip();
  }

  function decorateMentionLinks(root = messageListElement) {
    root.querySelectorAll('a[href*="/@"]').forEach((link) => {
      let username = "";
      try {
        const url = new URL(link.href, window.location.origin);
        const match = decodeURIComponent(url.pathname).match(/^\/@([^/]+)$/);
        username = cleanUsername(match?.[1]);
      } catch {
        username = "";
      }
      if (!username) {
        return;
      }
      link.classList.add("message-mention");
      link.dataset.mentionUsername = username;
      link.removeAttribute("target");
      link.removeAttribute("rel");
      link.setAttribute("role", "link");
    });
  }

  async function openMentionProfile(username) {
    const normalized = cleanUsername(username);
    if (!normalized) {
      return;
    }

    closeStrip();
    const api = applicationApi();
    let user = mentionState.userByUsername.get(normalized) || null;

    if (!user && api?.users?.byUsername) {
      try {
        user = normalizeMentionUser(await api.users.byUsername(normalized));
      } catch {
        user = null;
      }
    }

    if (!user && api?.users?.search) {
      try {
        user = mergeUsers(await api.users.search(normalized))
          .find((candidate) => candidate.username === normalized) || null;
      } catch {
        user = null;
      }
    }

    try {
      const appState = applicationState();
      const existing = user && typeof findPrivateChatForUser === "function"
        ? findPrivateChatForUser(user.id)
        : (appState?.chats || []).find((chat) => cleanUsername(chat.profileUsername) === normalized);

      if (existing?.id && typeof selectChat === "function") {
        await selectChat(existing.id);
        if (typeof openPanel === "function") {
          openPanel("chat");
        }
        return;
      }

      if (user && typeof openPendingPrivateChat === "function") {
        await openPendingPrivateChat(user);
        if (typeof openPanel === "function") {
          openPanel("chat");
        }
        return;
      }

      window.history.pushState({}, "", `/@${encodeURIComponent(normalized)}`);
      if (typeof openRouteTargetFromLocation === "function") {
        await openRouteTargetFromLocation();
        if (typeof openPanel === "function") {
          openPanel("chat");
        }
      }
    } catch {
      window.yachatFeedback?.show?.("Профиль временно недоступен", {
        tone: "error",
        icon: "circle-alert"
      });
    }
  }

  editor.addEventListener("input", () => {
    window.requestAnimationFrame(refreshSuggestions);
  });

  editor.addEventListener("keydown", (event) => {
    if (!mentionState.strip || mentionState.strip.hidden || !mentionState.users.length) {
      return;
    }

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      mentionState.selectedIndex = (mentionState.selectedIndex + 1) % mentionState.users.length;
      renderStrip();
      mentionState.strip.querySelector(".mention-person.is-selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      mentionState.selectedIndex = (mentionState.selectedIndex - 1 + mentionState.users.length) % mentionState.users.length;
      renderStrip();
      mentionState.strip.querySelector(".mention-person.is-selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(mentionState.users[mentionState.selectedIndex]);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeStrip();
    }
  });

  document.addEventListener("click", (event) => {
    const mention = event.target.closest(".message-mention, a[href*='/@']");
    if (mention && messageListElement.contains(mention)) {
      event.preventDefault();
      event.stopPropagation();
      void openMentionProfile(mention.dataset.mentionUsername || mention.textContent);
      return;
    }

    if (!event.target.closest(".mention-people-strip") && !event.target.closest("[data-rich-message-editor]")) {
      closeStrip();
    }
  }, true);

  composer.addEventListener("submit", closeStrip, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      closeStrip();
    }
  });

  const observer = new MutationObserver(() => decorateMentionLinks());
  observer.observe(messageListElement, { childList: true, subtree: true });
  decorateMentionLinks();
})();
