(() => {
  "use strict";

  if (window.__yachatIosNativeMentionsInstalled) return;

  const form = document.querySelector('[data-form="message"]');
  const textarea = form?.querySelector('[data-native-ios-message-input]');
  if (!form || !textarea) return;

  window.__yachatIosNativeMentionsInstalled = true;
  form.querySelector('[data-rich-message-editor]')?.removeAttribute('data-rich-message-editor');

  const mentionState = {
    strip: null,
    start: -1,
    end: -1,
    query: "",
    candidates: [],
    directory: [],
    directoryLoaded: false,
    directoryLoading: false,
    activeIndex: 0,
    frame: 0
  };

  function html(value) {
    if (typeof escapeHtml === "function") return escapeHtml(value);
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function accountId() {
    try { return String(state?.account?.id || ""); } catch { return ""; }
  }

  function currentChat() {
    try { return typeof getActiveChat === "function" ? getActiveChat() : null; } catch { return null; }
  }

  function cleanUser(raw) {
    if (!raw) return null;
    const id = String(raw.id || "").trim();
    const username = String(raw.username || "").trim().replace(/^@+/, "");
    if (!id || !username || raw.bot || id === accountId()) return null;
    return {
      ...raw,
      id,
      username,
      displayName: String(raw.displayName || raw.previewName || username).trim(),
      avatarDataUrl: String(raw.avatarDataUrl || "")
    };
  }

  function localUsers() {
    const chat = currentChat();
    const users = [];
    if (chat?.pendingSearchUser) users.push(chat.pendingSearchUser);
    users.push(...Object.values(chat?.participantProfiles || {}));
    try {
      if (typeof historicalChatUsers === "function") users.push(...historicalChatUsers(""));
      if (Array.isArray(state?.contactMatches)) users.push(...state.contactMatches);
      if (Array.isArray(state?.chatSearchUsers)) users.push(...state.chatSearchUsers);
      if (Array.isArray(state?.createChatUsers)) users.push(...state.createChatUsers);
    } catch {}
    users.push(...mentionState.directory);
    return users;
  }

  function knownUsers() {
    const map = new Map();
    localUsers().forEach((raw) => {
      const user = cleanUser(raw);
      if (user && !map.has(user.id)) map.set(user.id, user);
    });
    return [...map.values()].sort((left, right) => String(left.displayName).localeCompare(String(right.displayName), "ru"));
  }

  function ensureStrip() {
    if (mentionState.strip?.isConnected) return mentionState.strip;
    const strip = document.createElement("div");
    strip.className = "message-mention-strip";
    strip.hidden = true;
    strip.setAttribute("role", "listbox");
    strip.setAttribute("aria-label", "Отметить контакт");
    form.prepend(strip);

    strip.addEventListener("pointerdown", (event) => {
      if (event.target.closest("[data-ios-mention-user]")) event.preventDefault();
    });
    strip.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ios-mention-user]");
      if (!button) return;
      const user = mentionState.candidates.find((item) => item.id === button.dataset.iosMentionUser);
      if (user) insertMention(user);
    });

    mentionState.strip = strip;
    return strip;
  }

  function hideStrip() {
    mentionState.start = -1;
    mentionState.end = -1;
    mentionState.query = "";
    mentionState.candidates = [];
    mentionState.activeIndex = 0;
    if (mentionState.strip) mentionState.strip.hidden = true;
  }

  function avatar(user) {
    const initial = String(user.displayName || user.username || "Я").slice(0, 1).toUpperCase();
    return user.avatarDataUrl
      ? `<span class="message-mention-avatar"><img src="${html(user.avatarDataUrl)}" alt="" /></span>`
      : `<span class="message-mention-avatar">${html(initial)}</span>`;
  }

  function renderStrip() {
    const strip = ensureStrip();
    if (mentionState.start < 0) {
      strip.hidden = true;
      return;
    }

    const query = mentionState.query.toLocaleLowerCase();
    mentionState.candidates = knownUsers()
      .filter((user) => !query || `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(query))
      .slice(0, 18);

    if (mentionState.activeIndex >= mentionState.candidates.length) mentionState.activeIndex = 0;

    if (mentionState.directoryLoading && mentionState.candidates.length === 0) {
      strip.innerHTML = '<span class="message-mention-status">Загружаю контакты…</span>';
    } else if (mentionState.candidates.length === 0) {
      strip.innerHTML = '<span class="message-mention-status">Подходящих контактов нет</span>';
    } else {
      strip.innerHTML = mentionState.candidates.map((user, index) => `
        <button class="message-mention-option${index === mentionState.activeIndex ? " is-active" : ""}" type="button" role="option" aria-selected="${index === mentionState.activeIndex}" data-ios-mention-user="${html(user.id)}">
          ${avatar(user)}
          <span class="message-mention-copy"><strong>${html(user.displayName)}</strong><small>@${html(user.username)}</small></span>
        </button>
      `).join("");
    }
    strip.hidden = false;
  }

  async function ensureDirectory() {
    if (mentionState.directoryLoaded || mentionState.directoryLoading || !accountId()) return;
    mentionState.directoryLoading = true;
    renderStrip();
    try {
      const users = typeof yachatApi !== "undefined" && yachatApi?.users?.list
        ? await yachatApi.users.list()
        : [];
      mentionState.directory = Array.isArray(users) ? users.map(cleanUser).filter(Boolean) : [];
      mentionState.directoryLoaded = true;
    } catch {
      mentionState.directoryLoaded = false;
    } finally {
      mentionState.directoryLoading = false;
      renderStrip();
    }
  }

  function updateTrigger() {
    if (textarea.disabled || textarea.readOnly || textarea.selectionStart !== textarea.selectionEnd) {
      hideStrip();
      return;
    }
    const caret = textarea.selectionStart;
    const prefix = textarea.value.slice(0, caret);
    const match = prefix.match(/(^|[\s\u00a0])@([\p{L}\p{N}._-]{0,32})$/u);
    if (!match) {
      hideStrip();
      return;
    }

    mentionState.start = caret - match[0].length + match[1].length;
    mentionState.end = caret;
    mentionState.query = match[2] || "";
    mentionState.activeIndex = 0;
    renderStrip();
    void ensureDirectory();
  }

  function scheduleTrigger() {
    cancelAnimationFrame(mentionState.frame);
    mentionState.frame = requestAnimationFrame(updateTrigger);
  }

  function insertMention(user) {
    if (mentionState.start < 0 || mentionState.end < mentionState.start) return hideStrip();
    const username = String(user.username || "").replace(/^@+/, "");
    if (!username) return;
    const insertion = `@${username} `;
    textarea.setRangeText(insertion, mentionState.start, mentionState.end, "end");
    hideStrip();
    textarea.focus({ preventScroll: true });
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: insertion
    }));
  }

  function moveActive(delta) {
    if (!mentionState.candidates.length) return;
    mentionState.activeIndex = (mentionState.activeIndex + delta + mentionState.candidates.length) % mentionState.candidates.length;
    renderStrip();
    mentionState.strip?.querySelector(".message-mention-option.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  textarea.addEventListener("input", scheduleTrigger);
  textarea.addEventListener("click", scheduleTrigger);
  textarea.addEventListener("keyup", scheduleTrigger);
  textarea.addEventListener("keydown", (event) => {
    if (!mentionState.strip || mentionState.strip.hidden) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
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
  textarea.addEventListener("blur", () => window.setTimeout(() => {
    if (!form.contains(document.activeElement)) hideStrip();
  }, 0));
  form.addEventListener("submit", hideStrip, true);
})();
