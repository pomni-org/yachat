(() => {
  "use strict";

  const form = document.querySelector('[data-form="message"]');
  const editor = document.querySelector("[data-rich-message-editor]");
  const messageListElement = document.querySelector("[data-message-list]");

  if (!form || !editor || !messageListElement) return;

  const mentionState = {
    strip: null,
    range: null,
    query: "",
    candidates: [],
    directory: [],
    directoryLoaded: false,
    directoryLoading: false,
    retryAfter: 0,
    activeIndex: 0,
    decorateFrame: 0,
    triggerFrame: 0
  };

  function language() {
    try {
      return state?.language === "en" ? "en" : "ru";
    } catch {
      return "ru";
    }
  }

  function copy() {
    return language() === "en"
      ? { loading: "Loading contacts…", empty: "No matching contacts", open: "Open profile" }
      : { loading: "Загружаю контакты…", empty: "Подходящих контактов нет", open: "Открыть профиль" };
  }

  function accountId() {
    try {
      return String(state?.account?.id || "");
    } catch {
      return "";
    }
  }

  function currentChat() {
    try {
      return typeof getActiveChat === "function" ? getActiveChat() : null;
    } catch {
      return null;
    }
  }

  function cleanUser(raw) {
    if (!raw) return null;

    try {
      if (typeof normalizeUser === "function") return normalizeUser(raw);
    } catch {
      // Use the local normalizer below.
    }

    const id = String(raw.id || "").trim();
    const username = String(raw.username || "").trim().replace(/^@+/, "");
    if (!id || !username) return null;

    return {
      ...raw,
      id,
      username,
      displayName: String(raw.displayName || raw.previewName || username).trim(),
      avatarDataUrl: String(raw.avatarDataUrl || "")
    };
  }

  function dedupeUsers(items) {
    const ownId = accountId();
    const users = new Map();

    items.forEach((item) => {
      const user = cleanUser(item);
      if (!user?.id || !user.username || user.id === ownId || user.bot) return;
      const key = String(user.id);
      if (!users.has(key)) users.set(key, user);
    });

    return [...users.values()];
  }

  function localUsers() {
    const chat = currentChat();
    const users = [];

    if (chat?.pendingSearchUser) users.push(chat.pendingSearchUser);
    users.push(...Object.values(chat?.participantProfiles || {}));

    try {
      if (typeof historicalChatUsers === "function") users.push(...historicalChatUsers(""));
      users.push(...(Array.isArray(state?.contactMatches) ? state.contactMatches : []));
      users.push(...(Array.isArray(state?.chatSearchUsers) ? state.chatSearchUsers : []));
      users.push(...(Array.isArray(state?.createChatUsers) ? state.createChatUsers : []));
    } catch {
      // The app can still be on the sign-in screen.
    }

    users.push(...mentionState.directory);
    return users;
  }

  function knownUsers() {
    const participantIds = new Set((Array.isArray(currentChat()?.participantIds) ? currentChat().participantIds : [])
      .map((id) => String(id || ""))
      .filter(Boolean));

    return dedupeUsers(localUsers()).sort((left, right) => {
      const leftInChat = participantIds.has(String(left.id)) ? 1 : 0;
      const rightInChat = participantIds.has(String(right.id)) ? 1 : 0;
      if (leftInChat !== rightInChat) return rightInChat - leftInChat;
      return String(left.displayName || left.username).localeCompare(
        String(right.displayName || right.username),
        language() === "en" ? "en" : "ru"
      );
    });
  }

  function searchText(user) {
    return `${user.displayName || ""} ${user.username || ""}`.toLocaleLowerCase();
  }

  async function ensureDirectory() {
    if (!accountId() || mentionState.directoryLoaded || mentionState.directoryLoading) return;
    if (Date.now() < mentionState.retryAfter) return;

    mentionState.directoryLoading = true;
    renderStrip();

    try {
      const usersApi = typeof yachatApi !== "undefined" ? yachatApi?.users : null;
      const users = usersApi?.list ? await usersApi.list() : [];
      mentionState.directory = dedupeUsers(Array.isArray(users) ? users : []);
      mentionState.directoryLoaded = true;
      mentionState.retryAfter = 0;
    } catch {
      mentionState.directoryLoaded = false;
      mentionState.retryAfter = Date.now() + 30000;
    } finally {
      mentionState.directoryLoading = false;
      renderStrip();
      scheduleDecorate();
    }
  }

  function ensureStrip() {
    if (mentionState.strip?.isConnected) return mentionState.strip;

    const strip = document.createElement("div");
    strip.className = "message-mention-strip";
    strip.hidden = true;
    strip.setAttribute("role", "listbox");
    strip.setAttribute("aria-label", language() === "en" ? "Mention a contact" : "Отметить контакт");
    form.prepend(strip);

    strip.addEventListener("pointerdown", (event) => {
      if (event.target.closest("[data-mention-user-id]")) event.preventDefault();
    });

    strip.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mention-user-id]");
      if (!button) return;
      const user = mentionState.candidates.find((item) => String(item.id) === button.dataset.mentionUserId);
      if (user) insertMention(user);
    });

    mentionState.strip = strip;
    return strip;
  }

  function avatarHtml(user) {
    const initial = String(user.displayName || user.username || "Я").trim().slice(0, 1).toUpperCase() || "Я";
    return user.avatarDataUrl
      ? `<span class="message-mention-avatar"><img src="${escapeHtml(user.avatarDataUrl)}" alt="" /></span>`
      : `<span class="message-mention-avatar">${escapeHtml(initial)}</span>`;
  }

  function hideStrip() {
    mentionState.range = null;
    mentionState.query = "";
    mentionState.candidates = [];
    mentionState.activeIndex = 0;
    if (mentionState.strip) mentionState.strip.hidden = true;
  }

  function renderStrip() {
    const strip = ensureStrip();
    if (!mentionState.range) {
      strip.hidden = true;
      return;
    }

    const query = mentionState.query.toLocaleLowerCase();
    mentionState.candidates = knownUsers()
      .filter((user) => !query || searchText(user).includes(query))
      .slice(0, 18);

    if (mentionState.activeIndex >= mentionState.candidates.length) {
      mentionState.activeIndex = Math.max(0, mentionState.candidates.length - 1);
    }

    const text = copy();
    if (mentionState.directoryLoading && mentionState.candidates.length === 0) {
      strip.innerHTML = `<span class="message-mention-status">${escapeHtml(text.loading)}</span>`;
    } else if (mentionState.candidates.length === 0) {
      strip.innerHTML = `<span class="message-mention-status">${escapeHtml(text.empty)}</span>`;
    } else {
      strip.innerHTML = mentionState.candidates.map((user, index) => `
        <button
          class="message-mention-option${index === mentionState.activeIndex ? " is-active" : ""}"
          type="button"
          role="option"
          aria-selected="${index === mentionState.activeIndex ? "true" : "false"}"
          data-mention-user-id="${escapeHtml(user.id)}"
        >
          ${avatarHtml(user)}
          <span class="message-mention-copy">
            <strong>${escapeHtml(user.displayName || user.username)}</strong>
            <small>@${escapeHtml(user.username)}</small>
          </span>
        </button>
      `).join("");
    }

    strip.hidden = false;
  }

  function mentionContextAtCaret() {
    if (editor.getAttribute("aria-disabled") === "true" || editor.contentEditable === "false") return null;

    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
    if (!editor.contains(selection.anchorNode)) return null;

    const node = selection.anchorNode;
    if (node?.nodeType !== Node.TEXT_NODE) return null;

    const offset = selection.anchorOffset;
    const beforeCaret = String(node.nodeValue || "").slice(0, offset);
    const match = beforeCaret.match(/(^|[\s\u00a0])@([\p{L}\p{N}._-]{0,32})$/u);
    if (!match) return null;

    const start = offset - match[0].length + match[1].length;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, offset);
    return { range, query: match[2] || "" };
  }

  function updateTrigger() {
    const context = mentionContextAtCaret();
    if (!context) {
      hideStrip();
      return;
    }

    mentionState.range = context.range.cloneRange();
    mentionState.query = context.query;
    mentionState.activeIndex = 0;
    renderStrip();
    void ensureDirectory();
  }

  function scheduleTriggerUpdate() {
    cancelAnimationFrame(mentionState.triggerFrame);
    mentionState.triggerFrame = requestAnimationFrame(updateTrigger);
  }

  function insertMention(user) {
    const range = mentionState.range;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      hideStrip();
      return;
    }

    const username = String(user.username || "").replace(/^@+/, "");
    if (!username) return;

    range.deleteContents();
    const textNode = document.createTextNode(`@${username}\u00a0`);
    range.insertNode(textNode);

    const selection = window.getSelection();
    const caret = document.createRange();
    caret.setStartAfter(textNode);
    caret.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(caret);

    hideStrip();
    editor.focus({ preventScroll: true });
    const inputEvent = typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: `@${username} ` })
      : new Event("input", { bubbles: true });
    editor.dispatchEvent(inputEvent);
  }

  function moveActive(direction) {
    if (!mentionState.candidates.length) return;
    mentionState.activeIndex = (
      mentionState.activeIndex + direction + mentionState.candidates.length
    ) % mentionState.candidates.length;
    renderStrip();
    mentionState.strip
      ?.querySelector(".message-mention-option.is-active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function usersByUsername() {
    const map = new Map();
    knownUsers().forEach((user) => map.set(String(user.username).toLocaleLowerCase(), user));
    return map;
  }

  function decorateTextNode(node, users) {
    const source = node.nodeValue || "";
    const pattern = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}._-]{3,32})/gu;
    const matches = [...source.matchAll(pattern)]
      .filter((match) => users.has(match[2].toLocaleLowerCase()));
    if (matches.length === 0) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;

    matches.forEach((match) => {
      const mentionStart = match.index + match[1].length;
      if (mentionStart > cursor) fragment.append(document.createTextNode(source.slice(cursor, mentionStart)));

      const user = users.get(match[2].toLocaleLowerCase());
      const button = document.createElement("button");
      button.className = "message-mention";
      button.type = "button";
      button.dataset.messageMentionUsername = user.username;
      button.dataset.messageMentionUserId = user.id;
      button.textContent = `@${match[2]}`;
      button.setAttribute("aria-label", `${copy().open}: @${user.username}`);
      fragment.append(button);
      cursor = match.index + match[0].length;
    });

    if (cursor < source.length) fragment.append(document.createTextNode(source.slice(cursor)));
    node.replaceWith(fragment);
  }

  function decorateMessages() {
    const users = usersByUsername();
    if (users.size === 0) return;

    messageListElement.querySelectorAll(".message-bubble > .message-text, .message-bubble > p").forEach((element) => {
      if (element.querySelector(".message-search-hit")) return;

      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue?.includes("@")) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest(".message-mention, button, a, code, pre, mark")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => decorateTextNode(node, users));
    });
  }

  function scheduleDecorate() {
    cancelAnimationFrame(mentionState.decorateFrame);
    mentionState.decorateFrame = requestAnimationFrame(() => {
      decorateMessages();
      if (accountId() && messageListElement.textContent.includes("@") && !mentionState.directoryLoaded) {
        void ensureDirectory();
      }
    });
  }

  async function resolveUser(username, userId = "") {
    const normalizedUsername = String(username || "").replace(/^@+/, "").toLocaleLowerCase();
    const local = knownUsers().find((user) => (
      String(user.id) === String(userId) || String(user.username).toLocaleLowerCase() === normalizedUsername
    ));
    if (local) return local;

    try {
      const usersApi = typeof yachatApi !== "undefined" ? yachatApi?.users : null;
      const result = usersApi?.search
        ? await usersApi.search(normalizedUsername)
        : usersApi?.list
          ? await usersApi.list()
          : [];
      const users = dedupeUsers(Array.isArray(result) ? result : []);
      mentionState.directory = dedupeUsers([...mentionState.directory, ...users]);
      return users.find((user) => (
        String(user.id) === String(userId) || String(user.username).toLocaleLowerCase() === normalizedUsername
      )) || null;
    } catch {
      return null;
    }
  }

  async function openMentionProfile(button) {
    const user = await resolveUser(
      button.dataset.messageMentionUsername,
      button.dataset.messageMentionUserId
    );

    if (!user || typeof openPendingPrivateChat !== "function" || typeof openPanel !== "function") {
      window.yachatFeedback?.show?.(
        language() === "en" ? "Profile is unavailable" : "Профиль недоступен",
        { tone: "error", icon: "circle-alert" }
      );
      return;
    }

    document.querySelector("[data-message-search-close]")?.click();
    await openPendingPrivateChat(user, { closePanelOnOpen: false });
    openPanel("chat");
  }

  editor.addEventListener("input", scheduleTriggerUpdate);
  editor.addEventListener("click", scheduleTriggerUpdate);
  editor.addEventListener("keyup", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
      scheduleTriggerUpdate();
    }
  });

  editor.addEventListener("keydown", (event) => {
    if (!mentionState.strip || mentionState.strip.hidden) return;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Enter" && mentionState.candidates[mentionState.activeIndex]) {
      event.preventDefault();
      insertMention(mentionState.candidates[mentionState.activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      hideStrip();
    }
  });

  editor.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!form.contains(document.activeElement)) hideStrip();
    }, 0);
  });

  form.addEventListener("submit", hideStrip, true);
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-chat-id], [data-search-user-id], [data-action='dialog-back']")) {
      hideStrip();
    }
  }, true);

  messageListElement.addEventListener("click", (event) => {
    const button = event.target.closest("[data-message-mention-username]");
    if (!button || !messageListElement.contains(button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void openMentionProfile(button);
  }, true);

  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(messageListElement, { childList: true, subtree: true });
  scheduleDecorate();
})();