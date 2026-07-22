(() => {
  "use strict";

  if (window.__yachatIosNativeRuntimeInstalled) return;
  window.__yachatIosNativeRuntimeInstalled = true;

  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);

  if (!isIos) return;

  function installSettingsToggleRepair() {
    function decorateRows(root = document) {
      root.querySelectorAll?.(".settings-toggle-row").forEach((row) => {
        const input = row.querySelector("input[data-settings-toggle]");
        if (!input) return;
        row.tabIndex = 0;
        row.setAttribute("role", "switch");
        row.setAttribute("aria-checked", input.checked ? "true" : "false");
        input.tabIndex = -1;
      });
    }

    function toggleRow(row) {
      const input = row?.querySelector?.("input[data-settings-toggle]");
      if (!input || input.disabled) return;
      input.checked = !input.checked;
      row.setAttribute("aria-checked", input.checked ? "true" : "false");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Capture on window happens before document/label handlers. This prevents
    // WebKit from performing a second implicit label click after we changed the
    // checkbox, which was the reason ON worked while OFF immediately reverted.
    window.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest?.(".settings-toggle-row");
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(row);
    }, true);

    window.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest?.(".settings-toggle-row");
      if (!row || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(row);
    }, true);

    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.addedNodes.length)) decorateRows();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    decorateRows();
  }

  function installNativeComposer() {
    const form = document.querySelector('[data-form="message"]');
    const input = document.querySelector("[data-message-input]");
    const richEditor = document.querySelector("[data-rich-message-editor]");
    if (!form || !(input instanceof HTMLInputElement)) return;

    const preservedText = String(richEditor?.innerText || richEditor?.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "");
    if (!input.value && preservedText) input.value = preservedText;

    richEditor?.remove();
    document.querySelector(".rich-selection-toolbar")?.remove();
    input.classList.remove("rich-composer-transport");
    input.removeAttribute("aria-hidden");
    input.tabIndex = 0;
    input.autocapitalize = "sentences";
    input.spellcheck = true;
    input.setAttribute("enterkeyhint", "send");
    input.style.removeProperty("display");
    input.style.removeProperty("position");
    input.style.removeProperty("opacity");
    input.style.removeProperty("pointer-events");
    form.classList.add("is-native-ios-composer");

    if (!document.querySelector("style[data-yachat-ios-native-composer]")) {
      const style = document.createElement("style");
      style.dataset.yachatIosNativeComposer = "";
      style.textContent = `
        .composer.is-native-ios-composer [data-message-input] {
          display: block !important;
          min-width: 0 !important;
          width: 100% !important;
          height: auto !important;
          padding: 10px 4px !important;
          border: 0 !important;
          outline: 0 !important;
          background: transparent !important;
          color: var(--text) !important;
          font: inherit !important;
          line-height: 1.35 !important;
          -webkit-user-select: text !important;
          user-select: text !important;
          pointer-events: auto !important;
          opacity: 1 !important;
        }
        .composer.is-native-ios-composer .rich-selection-toolbar {
          display: none !important;
        }
      `;
      document.head.append(style);
    }

    // Keep the send button and typing presence in sync if a character was
    // already present when the runtime switched from contenteditable.
    if (input.value) input.dispatchEvent(new Event("input", { bubbles: true }));

    installNativeMentions(form, input);
  }

  function installNativeMentions(form, input) {
    const mention = {
      strip: null,
      start: -1,
      end: -1,
      query: "",
      users: [],
      directory: [],
      loading: false,
      loaded: false,
      activeIndex: 0
    };

    function cleanUser(raw) {
      if (!raw) return null;
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

    function localUsers() {
      const items = [];
      try {
        const chat = typeof getActiveChat === "function" ? getActiveChat() : null;
        if (chat?.pendingSearchUser) items.push(chat.pendingSearchUser);
        items.push(...Object.values(chat?.participantProfiles || {}));
        if (typeof historicalChatUsers === "function") items.push(...historicalChatUsers(""));
        items.push(...(Array.isArray(state?.contactMatches) ? state.contactMatches : []));
        items.push(...(Array.isArray(state?.chatSearchUsers) ? state.chatSearchUsers : []));
        items.push(...(Array.isArray(state?.createChatUsers) ? state.createChatUsers : []));
      } catch {
        // The account may still be loading.
      }
      items.push(...mention.directory);

      const ownId = (() => {
        try { return String(state?.account?.id || ""); } catch { return ""; }
      })();
      const unique = new Map();
      items.forEach((item) => {
        const user = cleanUser(item);
        if (!user || user.id === ownId || user.bot) return;
        if (!unique.has(user.id)) unique.set(user.id, user);
      });
      return [...unique.values()];
    }

    function ensureStrip() {
      if (mention.strip?.isConnected) return mention.strip;
      const strip = document.createElement("div");
      strip.className = "message-mention-strip";
      strip.hidden = true;
      strip.setAttribute("role", "listbox");
      strip.setAttribute("aria-label", "Отметить контакт");
      form.prepend(strip);
      strip.addEventListener("pointerdown", (event) => {
        if ((event.target instanceof Element) && event.target.closest("[data-ios-mention-user]")) {
          event.preventDefault();
        }
      });
      strip.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const button = target?.closest?.("[data-ios-mention-user]");
        if (!button) return;
        const user = mention.users.find((item) => item.id === button.dataset.iosMentionUser);
        if (user) insertMention(user);
      });
      mention.strip = strip;
      return strip;
    }

    function avatar(user) {
      const initial = String(user.displayName || user.username || "Я").slice(0, 1).toUpperCase();
      return user.avatarDataUrl
        ? `<span class="message-mention-avatar"><img src="${escapeHtml(user.avatarDataUrl)}" alt="" /></span>`
        : `<span class="message-mention-avatar">${escapeHtml(initial)}</span>`;
    }

    function hideStrip() {
      mention.start = -1;
      mention.end = -1;
      mention.query = "";
      mention.users = [];
      mention.activeIndex = 0;
      if (mention.strip) mention.strip.hidden = true;
    }

    function renderStrip() {
      const strip = ensureStrip();
      if (mention.start < 0) {
        strip.hidden = true;
        return;
      }
      const query = mention.query.toLocaleLowerCase();
      mention.users = localUsers()
        .filter((user) => !query || `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(query))
        .slice(0, 18);
      if (mention.activeIndex >= mention.users.length) mention.activeIndex = Math.max(0, mention.users.length - 1);

      if (mention.loading && !mention.users.length) {
        strip.innerHTML = '<span class="message-mention-status">Загружаю контакты…</span>';
      } else if (!mention.users.length) {
        strip.innerHTML = '<span class="message-mention-status">Подходящих контактов нет</span>';
      } else {
        strip.innerHTML = mention.users.map((user, index) => `
          <button class="message-mention-option${index === mention.activeIndex ? " is-active" : ""}" type="button" role="option" aria-selected="${index === mention.activeIndex}" data-ios-mention-user="${escapeHtml(user.id)}">
            ${avatar(user)}
            <span class="message-mention-copy"><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></span>
          </button>
        `).join("");
      }
      strip.hidden = false;
    }

    async function loadDirectory() {
      if (mention.loaded || mention.loading) return;
      mention.loading = true;
      renderStrip();
      try {
        const result = await yachatApi?.users?.list?.();
        mention.directory = Array.isArray(result) ? result.map(cleanUser).filter(Boolean) : [];
        mention.loaded = true;
      } catch {
        mention.loaded = false;
      } finally {
        mention.loading = false;
        renderStrip();
      }
    }

    function updateMentionContext() {
      const caret = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
      const before = input.value.slice(0, caret);
      const match = before.match(/(^|\s)@([\p{L}\p{N}._-]{0,32})$/u);
      if (!match) {
        hideStrip();
        return;
      }
      mention.start = caret - match[0].length + match[1].length;
      mention.end = caret;
      mention.query = match[2] || "";
      mention.activeIndex = 0;
      renderStrip();
      void loadDirectory();
    }

    function insertMention(user) {
      if (mention.start < 0 || mention.end < mention.start) return;
      const username = String(user.username || "").replace(/^@+/, "");
      const replacement = `@${username} `;
      input.value = `${input.value.slice(0, mention.start)}${replacement}${input.value.slice(mention.end)}`;
      const caret = mention.start + replacement.length;
      input.focus({ preventScroll: true });
      input.setSelectionRange(caret, caret);
      hideStrip();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function moveActive(direction) {
      if (!mention.users.length) return;
      mention.activeIndex = (mention.activeIndex + direction + mention.users.length) % mention.users.length;
      renderStrip();
      mention.strip?.querySelector(".message-mention-option.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    input.addEventListener("input", updateMentionContext);
    input.addEventListener("click", updateMentionContext);
    input.addEventListener("keyup", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
        updateMentionContext();
      }
    });
    input.addEventListener("keydown", (event) => {
      if (!mention.strip || mention.strip.hidden) return;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        moveActive(1);
      } else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        moveActive(-1);
      } else if (event.key === "Enter" && mention.users[mention.activeIndex]) {
        event.preventDefault();
        insertMention(mention.users[mention.activeIndex]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        hideStrip();
      }
    });
    input.addEventListener("blur", () => window.setTimeout(() => {
      if (!form.contains(document.activeElement)) hideStrip();
    }, 0));
    form.addEventListener("submit", hideStrip, true);
  }

  installSettingsToggleRepair();
  installNativeComposer();
})();
