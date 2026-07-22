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
    let pointerGesture = null;
    let suppressClickUntil = 0;
    let suppressClickRow = null;

    if (!document.querySelector("style[data-yachat-ios-switch-v2]")) {
      const style = document.createElement("style");
      style.dataset.yachatIosSwitchV2 = "";
      style.textContent = `
        .settings-toggle-row {
          cursor: pointer;
          touch-action: pan-y;
          -webkit-tap-highlight-color: transparent;
          user-select: none;
        }

        .settings-toggle-row .settings-switch {
          flex: 0 0 46px;
          pointer-events: none;
          background: color-mix(in srgb, var(--muted), transparent 45%) !important;
          transform: translateZ(0);
          transition:
            background-color 180ms cubic-bezier(.2, .8, .2, 1),
            box-shadow 180ms ease !important;
        }

        .settings-toggle-row .settings-switch::after {
          transform: translate3d(0, 0, 0) scale(1);
          will-change: transform;
          transition: transform 180ms cubic-bezier(.2, .85, .25, 1.15) !important;
        }

        .settings-toggle-row.is-on .settings-switch {
          background: var(--accent) !important;
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent), transparent 68%);
        }

        .settings-toggle-row.is-on .settings-switch::after {
          transform: translate3d(18px, 0, 0) scale(1);
        }

        .settings-toggle-row.is-pressing .settings-switch::after {
          transform: translate3d(0, 0, 0) scale(.88);
        }

        .settings-toggle-row.is-on.is-pressing .settings-switch::after {
          transform: translate3d(18px, 0, 0) scale(.88);
        }
      `;
      document.head.append(style);
    }

    function syncRow(row, checked) {
      const input = row?.querySelector?.("input[data-settings-toggle]");
      if (!input) return;
      const next = Boolean(checked);
      input.checked = next;
      row.classList.toggle("is-on", next);
      row.setAttribute("aria-checked", next ? "true" : "false");
    }

    function decorateRows(root = document) {
      root.querySelectorAll?.(".settings-toggle-row").forEach((row) => {
        const input = row.querySelector("input[data-settings-toggle]");
        if (!input) return;
        row.tabIndex = 0;
        row.setAttribute("role", "switch");
        input.tabIndex = -1;
        syncRow(row, input.checked);
      });
    }

    function toggleRow(row) {
      const input = row?.querySelector?.("input[data-settings-toggle]");
      if (!input || input.disabled) return;
      syncRow(row, !input.checked);

      // Let WebKit paint the switch before local/server persistence work runs.
      requestAnimationFrame(() => {
        if (!input.isConnected) return;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    window.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest?.(".settings-toggle-row");
      if (!row || event.button !== 0) return;
      pointerGesture = {
        row,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY
      };
      row.classList.add("is-pressing");
    }, true);

    window.addEventListener("pointerup", (event) => {
      const gesture = pointerGesture;
      pointerGesture = null;
      if (!gesture || gesture.pointerId !== event.pointerId) return;

      gesture.row.classList.remove("is-pressing");
      const moved = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
      suppressClickUntil = performance.now() + 700;
      suppressClickRow = gesture.row;

      if (moved > 12 || !gesture.row.isConnected) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(gesture.row);
    }, true);

    window.addEventListener("pointercancel", () => {
      pointerGesture?.row?.classList?.remove("is-pressing");
      pointerGesture = null;
    }, true);

    window.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest?.(".settings-toggle-row");
      if (!row) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (row === suppressClickRow && performance.now() < suppressClickUntil) {
        return;
      }
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
    const transport = document.querySelector("[data-message-input]");
    const richEditor = document.querySelector("[data-rich-message-editor]");
    const send = form?.querySelector(".send-button");
    if (!form || !(transport instanceof HTMLInputElement) || !send) return;

    const preservedText = String(richEditor?.innerText || richEditor?.textContent || transport.value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "");

    richEditor?.remove();
    document.querySelector(".rich-selection-toolbar")?.remove();

    const textarea = document.createElement("textarea");
    textarea.className = "ios-native-message-input";
    textarea.dataset.iosMessageInput = "";
    textarea.rows = 1;
    textarea.value = preservedText;
    textarea.placeholder = transport.placeholder || "Сообщение";
    textarea.autocapitalize = "sentences";
    textarea.spellcheck = true;
    textarea.setAttribute("enterkeyhint", "enter");
    textarea.setAttribute("aria-label", textarea.placeholder);
    transport.insertAdjacentElement("afterend", textarea);

    const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (valueDescriptor?.get && valueDescriptor?.set) {
      Object.defineProperty(transport, "value", {
        configurable: true,
        enumerable: valueDescriptor.enumerable,
        get() {
          return valueDescriptor.get.call(transport);
        },
        set(value) {
          const text = String(value ?? "");
          valueDescriptor.set.call(transport, text);
          if (textarea.value !== text) {
            textarea.value = text;
            resizeTextarea();
          }
        }
      });
      transport.value = preservedText;
    } else {
      transport.value = preservedText;
    }

    const nativeFocus = textarea.focus.bind(textarea);
    transport.focus = (options) => {
      if (textarea.value !== transport.value) textarea.value = transport.value;
      resizeTextarea();
      nativeFocus(options);
    };
    transport.setSelectionRange = (start, end, direction) => {
      textarea.setSelectionRange(start, end, direction);
    };

    transport.classList.add("rich-composer-transport");
    transport.tabIndex = -1;
    transport.setAttribute("aria-hidden", "true");
    transport.style.setProperty("display", "none", "important");

    form.classList.add("is-native-ios-composer");

    if (!document.querySelector("style[data-yachat-ios-native-composer-v2]")) {
      const style = document.createElement("style");
      style.dataset.yachatIosNativeComposerV2 = "";
      style.textContent = `
        .composer.is-native-ios-composer {
          align-items: flex-end;
        }

        .composer.is-native-ios-composer [data-message-input] {
          display: none !important;
        }

        .composer.is-native-ios-composer .ios-native-message-input {
          display: block !important;
          min-width: 0 !important;
          width: 100% !important;
          min-height: 42px !important;
          max-height: 132px !important;
          margin: 0 !important;
          padding: 10px 4px !important;
          overflow-y: auto !important;
          resize: none !important;
          border: 0 !important;
          outline: 0 !important;
          background: transparent !important;
          color: var(--text) !important;
          font: inherit !important;
          line-height: 1.35 !important;
          white-space: pre-wrap !important;
          overflow-wrap: anywhere !important;
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

    function resizeTextarea() {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(132, Math.max(42, textarea.scrollHeight))}px`;
    }

    function syncTransport(event = null) {
      transport.value = textarea.value;
      const inputEvent = typeof InputEvent === "function"
        ? new InputEvent("input", {
            bubbles: true,
            inputType: event?.inputType || "insertText",
            data: event?.data ?? null,
            isComposing: Boolean(event?.isComposing)
          })
        : new Event("input", { bubbles: true });
      transport.dispatchEvent(inputEvent);
      resizeTextarea();
    }

    textarea.addEventListener("input", syncTransport);
    textarea.addEventListener("compositionend", syncTransport);

    // A textarea keeps Enter as a newline. Even if WebKit decides to submit the
    // surrounding form, only the real send button is allowed to authorize it.
    form.addEventListener("submit", (event) => {
      if (event.submitter !== send) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    form.addEventListener("submit", (event) => {
      if (event.submitter !== send) return;
      transport.value = textarea.value;
      queueMicrotask(() => {
        if (!transport.value) {
          textarea.value = "";
          resizeTextarea();
        }
      });
    });

    const attributeObserver = new MutationObserver(() => {
      textarea.placeholder = transport.placeholder || "Сообщение";
      textarea.setAttribute("aria-label", textarea.placeholder);
      textarea.disabled = transport.disabled;
    });
    attributeObserver.observe(transport, {
      attributes: true,
      attributeFilter: ["placeholder", "disabled"]
    });

    textarea.disabled = transport.disabled;
    resizeTextarea();

    if (transport.value) {
      transport.dispatchEvent(new Event("input", { bubbles: true }));
    }

    installNativeMentions(form, textarea);
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