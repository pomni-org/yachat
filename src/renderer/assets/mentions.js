(() => {
  "use strict";

  const editor = document.querySelector("[data-rich-message-editor]");
  const composer = document.querySelector('[data-form="message"]');
  const messageList = document.querySelector("[data-message-list]");

  if (!editor || !composer || !messageList) return;

  const mention = {
    strip: null,
    users: [],
    selectedIndex: 0,
    range: null,
    query: "",
    requestId: 0,
    byUsername: new Map()
  };

  function appState() {
    try {
      return typeof state !== "undefined" ? state : null;
    } catch {
      return null;
    }
  }

  function api() {
    try {
      return typeof yachatApi !== "undefined" ? yachatApi : null;
    } catch {
      return null;
    }
  }

  function currentChat() {
    try {
      return typeof getActiveChat === "function" ? getActiveChat() : null;
    } catch {
      return null;
    }
  }

  function html(value) {
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

  function username(value) {
    return String(value || "").trim().replace(/^@+/, "").toLocaleLowerCase();
  }

  function normalizeUser(value = {}) {
    const id = String(value.id || value.userId || value.profileUserId || "").trim();
    const handle = username(value.username || value.profileUsername);
    if (!id || !handle) return null;

    return {
      id,
      username: handle,
      displayName: String(value.displayName || value.previewName || value.title || handle).trim() || handle,
      avatarDataUrl: String(value.avatarDataUrl || ""),
      avatarAccent: String(value.avatarAccent || "#471AFF"),
      verified: Boolean(value.verified)
    };
  }

  function mergeUsers(...groups) {
    const ownId = String(appState()?.account?.id || "");
    const seen = new Set();
    const result = [];

    groups.flat().forEach((value) => {
      const user = normalizeUser(value);
      if (!user || user.id === ownId || seen.has(user.id)) return;
      seen.add(user.id);
      result.push(user);
      mention.byUsername.set(user.username, user);
    });

    return result;
  }

  function usersFromChat(chat) {
    if (!chat) return [];

    const stateValue = appState();
    const profiles = chat.participantProfiles && typeof chat.participantProfiles === "object"
      ? Object.values(chat.participantProfiles)
      : [];
    const peerId = Array.isArray(chat.participantIds)
      ? chat.participantIds.find((id) => String(id) !== String(stateValue?.account?.id || ""))
      : "";
    const peer = chat.kind === "private" && chat.profileUsername
      ? [{
          id: chat.profileUserId || chat.peerId || peerId,
          username: chat.profileUsername,
          displayName: chat.title,
          avatarDataUrl: chat.avatarDataUrl,
          avatarAccent: chat.avatarAccent,
          verified: chat.verified
        }]
      : [];

    return mergeUsers(profiles, peer);
  }

  function knownUsers() {
    const stateValue = appState();
    return mergeUsers(
      usersFromChat(currentChat()),
      stateValue?.contactMatches || [],
      stateValue?.createChatUsers || [],
      stateValue?.chatSearchUsers || [],
      (stateValue?.chats || []).flatMap(usersFromChat)
    );
  }

  function avatar(user) {
    if (user.avatarDataUrl) {
      return `<span class="mention-person-avatar"><img src="${html(user.avatarDataUrl)}" alt="" /></span>`;
    }
    const initial = user.displayName.slice(0, 1).toUpperCase() || "Я";
    return `<span class="mention-person-avatar" style="--mention-avatar:${html(user.avatarAccent)}">${html(initial)}</span>`;
  }

  function verified(user) {
    if (!user.verified) return "";
    let icon = "";
    try {
      icon = typeof iconSvg === "function" ? iconSvg("badge-check") : "✓";
    } catch {
      icon = "✓";
    }
    return `<span class="mention-person-verified" aria-label="Подтверждённый профиль">${icon}</span>`;
  }

  function ensureStrip() {
    if (mention.strip?.isConnected) return mention.strip;

    mention.strip = document.createElement("section");
    mention.strip.className = "mention-people-strip";
    mention.strip.hidden = true;
    mention.strip.setAttribute("role", "listbox");
    mention.strip.setAttribute("aria-label", "Упомянуть человека");
    mention.strip.innerHTML = '<div class="mention-people-scroller" data-mention-people></div>';
    composer.insertAdjacentElement("afterbegin", mention.strip);

    mention.strip.addEventListener("pointerdown", (event) => {
      if (event.target.closest("[data-mention-user-id]")) event.preventDefault();
    });
    mention.strip.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mention-user-id]");
      const user = button && mention.users.find((item) => item.id === button.dataset.mentionUserId);
      if (user) insertUser(user);
    });

    return mention.strip;
  }

  function closeStrip() {
    if (mention.strip) mention.strip.hidden = true;
    mention.users = [];
    mention.selectedIndex = 0;
    mention.range = null;
    mention.query = "";
  }

  function renderStrip() {
    if (!mention.users.length) return closeStrip();

    const strip = ensureStrip();
    const target = strip.querySelector("[data-mention-people]");
    mention.selectedIndex = Math.min(mention.selectedIndex, mention.users.length - 1);
    strip.hidden = false;
    target.innerHTML = mention.users.map((user, index) => `
      <button
        class="mention-person${index === mention.selectedIndex ? " is-selected" : ""}"
        type="button"
        role="option"
        aria-selected="${index === mention.selectedIndex}"
        data-mention-user-id="${html(user.id)}"
      >
        ${avatar(user)}
        <span class="mention-person-copy">
          <strong>${html(user.displayName)} ${verified(user)}</strong>
          <small>@${html(user.username)}</small>
        </span>
      </button>
    `).join("");
  }

  function triggerAtCaret() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;

    const caret = selection.getRangeAt(0);
    if (!editor.contains(caret.endContainer)) return null;

    let node = caret.endContainer;
    let offset = caret.endOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      const previous = node.childNodes?.[Math.max(0, offset - 1)];
      if (previous?.nodeType !== Node.TEXT_NODE) return null;
      node = previous;
      offset = previous.nodeValue?.length || 0;
    }

    const match = String(node.nodeValue || "")
      .slice(0, offset)
      .match(/(^|\s)@([\p{L}\p{N}_.-]{0,32})$/u);
    if (!match) return null;

    const range = document.createRange();
    range.setStart(node, offset - match[2].length - 1);
    range.setEnd(node, offset);
    return { query: username(match[2]), range };
  }

  function filtered(users, query) {
    if (!query) return users.slice(0, 12);
    return users.filter((user) =>
      `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(query)
    ).slice(0, 12);
  }

  async function refresh() {
    const trigger = triggerAtCaret();
    if (!trigger) return closeStrip();

    mention.range = trigger.range.cloneRange();
    mention.query = trigger.query;
    mention.selectedIndex = 0;
    const local = filtered(knownUsers(), trigger.query);
    mention.users = local;
    renderStrip();

    const usersApi = api()?.users;
    if (trigger.query.length < 2 || !usersApi?.search) return;

    const requestId = ++mention.requestId;
    try {
      const remote = await usersApi.search(trigger.query);
      if (requestId !== mention.requestId || mention.query !== trigger.query) return;
      mention.users = filtered(mergeUsers(local, remote), trigger.query);
      renderStrip();
    } catch {
      // Уже найденные контакты остаются доступны без каталога.
    }
  }

  function insertUser(user) {
    if (!mention.range || !editor.contains(mention.range.commonAncestorContainer)) return closeStrip();

    const selection = window.getSelection();
    const range = mention.range;
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

  function decorateLinks() {
    messageList.querySelectorAll('a[href*="/@"]').forEach((link) => {
      try {
        const match = decodeURIComponent(new URL(link.href, window.location.origin).pathname).match(/^\/@([^/]+)$/);
        const handle = username(match?.[1]);
        if (!handle) return;
        link.classList.add("message-mention");
        link.dataset.mentionUsername = handle;
        link.removeAttribute("target");
        link.removeAttribute("rel");
      } catch {
        // Обычные ссылки не являются упоминаниями.
      }
    });
  }

  async function openProfile(rawUsername) {
    const handle = username(rawUsername);
    if (!handle) return;

    closeStrip();
    const usersApi = api()?.users;
    let user = mention.byUsername.get(handle) || null;

    if (!user && usersApi?.byUsername) {
      try {
        user = normalizeUser(await usersApi.byUsername(handle));
      } catch {
        user = null;
      }
    }
    if (!user && usersApi?.search) {
      try {
        user = mergeUsers(await usersApi.search(handle)).find((item) => item.username === handle) || null;
      } catch {
        user = null;
      }
    }

    try {
      const existing = user && typeof findPrivateChatForUser === "function"
        ? findPrivateChatForUser(user.id)
        : (appState()?.chats || []).find((chat) => username(chat.profileUsername) === handle);

      if (existing?.id && typeof selectChat === "function") {
        await selectChat(existing.id);
      } else if (user && typeof openPendingPrivateChat === "function") {
        await openPendingPrivateChat(user);
      } else {
        window.history.pushState({}, "", `/@${encodeURIComponent(handle)}`);
        if (typeof openRouteTargetFromLocation === "function") await openRouteTargetFromLocation();
      }

      if (typeof openPanel === "function") openPanel("chat");
    } catch {
      window.yachatFeedback?.show?.("Профиль временно недоступен", {
        tone: "error",
        icon: "circle-alert"
      });
    }
  }

  editor.addEventListener("input", () => requestAnimationFrame(refresh));
  editor.addEventListener("keydown", (event) => {
    if (!mention.strip || mention.strip.hidden || !mention.users.length) return;

    if (["ArrowRight", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      mention.selectedIndex = (mention.selectedIndex + 1) % mention.users.length;
      renderStrip();
    } else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      mention.selectedIndex = (mention.selectedIndex - 1 + mention.users.length) % mention.users.length;
      renderStrip();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertUser(mention.users[mention.selectedIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeStrip();
    } else {
      return;
    }

    mention.strip.querySelector(".mention-person.is-selected")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest(".message-mention, a[href*='/@']");
    if (link && messageList.contains(link)) {
      event.preventDefault();
      event.stopPropagation();
      void openProfile(link.dataset.mentionUsername || link.textContent);
      return;
    }

    if (!event.target.closest(".mention-people-strip, [data-rich-message-editor]")) closeStrip();
  }, true);

  composer.addEventListener("submit", closeStrip, true);
  document.addEventListener("visibilitychange", () => document.hidden && closeStrip());

  new MutationObserver(decorateLinks).observe(messageList, { childList: true, subtree: true });
  decorateLinks();
})();
