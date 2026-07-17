(() => {
  "use strict";

  const form = document.querySelector('[data-form="message"]');
  const editor = document.querySelector("[data-rich-message-editor]");
  const messageListElement = document.querySelector("[data-message-list]");

  if (!form || !editor || !messageListElement) {
    return;
  }

  const mentionState = {
    strip: null,
    range: null,
    query: "",
    candidates: [],
    directory: [],
    directoryLoaded: false,
    directoryLoading: false,
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
      ? {
          loading: "Loading contacts…",
          empty: "No matching contacts",
          open: "Open profile"
        }
      : {
          loading: "Загружаю контакты…",
          empty: "Подходящих контактов нет",
          open: "Открыть профиль"
        };
  }

  function cleanUser(raw) {
    if (!raw) return null;
    try {
      if (typeof normalizeUser === "function") {
        return normalizeUser(raw);
      }
    } catch {
      // Fall through to the small local normalizer.
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

  function activeChat() {
    try {
      return typeof getActiveChat === "function" ? getActiveChat() : null;
    } catch {
      return null;
    }
  }

  function activeParticipantIds() {
    const chat = activeChat();
    return new Set((Array.isArray(chat?.participantIds) ? chat.participantIds : [])
      .map((id) => String(id || ""))
      .filter(Boolean));
  }

  function localUsers() {
    const chat = activeChat();
    const collections = [];

    if (chat?.pendingSearchUser) collections.push(chat.pendingSearchUser);
    collections.push(...Object.values(chat?.participantProfiles || {}));

    try {
      if (typeof historicalChatUsers === "function") {
        collections.push(...historicalChatUsers(""));
      }
    } catch {
      // Historical contacts are optional.
    }

    try {
      collections.push(...(Array.isArray(state?.contactMatches) ? state.contactMatches : []));
      collections.push(...(Array.isArray(state?.chatSearchUsers) ? state.chatSearchUsers : []));
      collections.push(...(Array.isArray(state?.createChatUsers) ? state.createChatUsers : []));
    } catch {
      // State can be unavailable during the first boot frame.
    }

    collections.push(...mentionState.directory);
    return collections;
  }

  function dedupeUsers(items) {
    const ownId = String(globalThis.state?.account?.id || "");
    const byKey = new Map();

    items.forEach((item) => {
      const user = cleanUser(item);
      if (!user?.id || !user.username || user.id === ownId || user.bot) return;
      const key = user.id || user.username.toLocaleLowerCase();
      if (!byKey.has(key)) byKey.set(key, user);
    });

    return [...byKey.values()];
  }

  function allKnownUsers() {
    const participantIds = activeParticipantIds();
    return dedupeUsers(localUsers()).sort((left, right) => {
      const leftParticipant = participantIds.has(String(left.id)) ? 1 : 0;
      const rightParticipant = participantIds.has(String(right.id)) ? 1 : 0;
      if (leftParticipant !== rightParticipant) return rightParticipant - leftParticipant;
      return String(left.displayName || left.username).localeCompare(
        String(right.displayName || right.username),
        language() === "en" ? "en" : "ru"
      );
    });
  }

  function userSearchText(user) {
    return `${user.displayName || ""} ${user.username || ""}`.toLocaleLowerCase();
  }

  async function ensureDirectory() {
    if (mentionState.directoryLoaded || mentionState.directoryLoading) return;
    mentionState.directoryLoading = true;
    renderStrip();

    try {
      const usersApi = typeof yachatApi !== "undefined" ? yachatApi?.users : null;
      const users = usersApi?.list ? await usersApi.list() : [];
      mentionState.directory = dedupeUsers(Array.isArray(users) ? users : []);
      mentionState.directoryLoaded = true;
    } catch {
      mentionState.directoryLoaded = true;
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
      if (event.target.closest("[data-mention-user-id]")) {
        event.preventDefault();
      }
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
    mentionState.candidates = allKnownUsers()
      .filter((user) => !query || userSearchText(user).includes(query))
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

  function currentMentionContext() {
    if (editor.getAttribute("aria-disabled") === "true" || editor.contentEditable === "false") {
      return null;
    }

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
    const context = currentMentionContext();
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

  function setCaretAfter(node) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
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
    setCaretAfter(textNode);
    hideStrip();
    editor.focus({ preventScroll: true });
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: `@${username} `
    }));
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

  function userMap() {
    const map = new Map();
    allKnownUsers().forEach((user) => {
      map.set(String(user.username || "").toLocaleLowerCase(), user);
    });
    return map;
  }

  function decorateTextNode(node, users) {
    const source = node.nodeValue || "";
    const pattern = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}._-]{3,32})/gu;
    const matches = [...source.matchAll(pattern)].filter((match) => users.has(match[2].toLocaleLowerCase()));
    if (matches.length === 0) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach((match) => {
      const prefixLength = match[1].length;
      const mentionStart = match.index + prefixLength;
      if (mentionStart > cursor) {
        fragment.append(document.createTextNode(source.slice(cursor, mentionStart)));
      }

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

    if (cursor < source.length) {
      fragment.append(document.createTextNode(source.slice(cursor)));
    }
    node.replaceWith(fragment);
  }

  function decorateMessages() {
    const users = userMap();
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
    mentionState.decorateFrame = requestAnimationFrame(decorateMessages);
  }

  async function resolveUser(username, userId = "") {
    const lowerUsername = String(username || "").replace(/^@+/, "").toLocaleLowerCase();
    const local = allKnownUsers().find((user) => (
      String(user.id) === String(userId) || String(user.username).toLocaleLowerCase() === lowerUsername
    ));
    if (local) return local;

    try {
      const usersApi = typeof yachatApi !== "undefined" ? yachatApi?.users : null;
      const result = usersApi?.search
        ? await usersApi.search(lowerUsername)
        : usersApi?.list
          ? await usersApi.list()
          : [];
      const users = dedupeUsers(Array.isArray(result) ? result : []);
      mentionState.directory = dedupeUsers([...mentionState.directory, ...users]);
      return users.find((user) => (
        String(user.id) === String(userId) || String(user.username).toLocaleLowerCase() === lowerUsername
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
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === "Enter" && mentionState.candidates[mentionState.activeIndex]) {
      event.preventDefault();
      insertMention(mentionState.candidates[mentionState.activeIndex]);
      return;
    }
    if (event.key === "Escape") {
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

  void ensureDirectory();
  scheduleDecorate();
})();