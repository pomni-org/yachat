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
          transition: background-color 180ms cubic-bezier(.2,.8,.2,1), box-shadow 180ms ease !important;
        }
        .settings-toggle-row .settings-switch::after {
          transform: translate3d(0,0,0) scale(1);
          will-change: transform;
          transition: transform 180ms cubic-bezier(.2,.85,.25,1.15) !important;
        }
        .settings-toggle-row.is-on .settings-switch {
          background: var(--accent) !important;
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent), transparent 68%);
        }
        .settings-toggle-row.is-on .settings-switch::after {
          transform: translate3d(18px,0,0) scale(1);
        }
        .settings-toggle-row.is-pressing .settings-switch::after {
          transform: translate3d(0,0,0) scale(.88);
        }
        .settings-toggle-row.is-on.is-pressing .settings-switch::after {
          transform: translate3d(18px,0,0) scale(.88);
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
      requestAnimationFrame(() => {
        if (input.isConnected) input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    window.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest?.(".settings-toggle-row");
      if (!row || event.button !== 0) return;
      pointerGesture = { row, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
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
      if (row === suppressClickRow && performance.now() < suppressClickUntil) return;
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
    const richShadow = document.querySelector("[data-rich-message-editor]");
    const send = form?.querySelector(".send-button");
    if (!form || !(transport instanceof HTMLInputElement) || !richShadow || !send) return;

    const inputValueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (!inputValueDescriptor?.get || !inputValueDescriptor?.set) return;

    const allowedTypes = new Set(["STRONG", "EM", "U", "S", "CODE", "A"]);
    const typeOrder = ["A", "STRONG", "EM", "U", "S", "CODE"];
    const model = { text: "", marks: [] };
    let syncingShadow = false;
    let internalTransportWrite = false;
    let beforeInputText = "";
    let savedSelection = null;
    let allowSubmitUntil = 0;

    function escapeText(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function escapeAttribute(value) {
      return escapeText(value).replace(/"/g, "&quot;");
    }

    function safeUrl(value) {
      const source = String(value || "").trim();
      if (!source) return "";
      const prepared = /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : `https://${source}`;
      try {
        const url = new URL(prepared, window.location.origin);
        return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : "";
      } catch {
        return "";
      }
    }

    function normalizeMarks(marks, length = model.text.length) {
      return (Array.isArray(marks) ? marks : [])
        .map((mark) => {
          const type = String(mark?.type || "").toUpperCase();
          return {
            type,
            start: Math.max(0, Math.min(length, Number(mark?.start) || 0)),
            end: Math.max(0, Math.min(length, Number(mark?.end) || 0)),
            href: type === "A" ? safeUrl(mark.href) : ""
          };
        })
        .filter((mark) => allowedTypes.has(mark.type) && mark.end > mark.start && (mark.type !== "A" || mark.href));
    }

    function parseShadowHtml(html) {
      const root = document.createElement("div");
      root.innerHTML = String(html || "");
      const textParts = [];
      const marks = [];
      let offset = 0;

      function appendText(value) {
        const text = String(value || "").replace(/\u00a0/g, " ");
        textParts.push(text);
        offset += text.length;
      }

      function endsWithNewline() {
        const last = textParts[textParts.length - 1] || "";
        return last.endsWith("\n");
      }

      function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          appendText(node.nodeValue || "");
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName.toUpperCase();
        if (tag === "BR") {
          appendText("\n");
          return;
        }

        const isBlock = tag === "DIV" || tag === "P";
        if (isBlock && offset > 0 && !endsWithNewline()) appendText("\n");

        const type = tag === "B" ? "STRONG" : tag === "I" ? "EM" : tag === "DEL" ? "S" : tag;
        const start = offset;
        [...node.childNodes].forEach(walk);
        const end = offset;
        if (allowedTypes.has(type) && end > start) {
          const href = type === "A" ? safeUrl(node.getAttribute("href")) : "";
          if (type !== "A" || href) marks.push({ type, start, end, href });
        }

        if (isBlock && offset > 0 && !endsWithNewline()) appendText("\n");
      }

      [...root.childNodes].forEach(walk);
      const text = textParts.join("").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/g, "");
      return { text, marks: normalizeMarks(marks, text.length) };
    }

    function markOpen(mark) {
      if (mark.type === "A") return `<a href="${escapeAttribute(mark.href)}" target="_blank" rel="noopener noreferrer">`;
      return `<${mark.type.toLowerCase()}>`;
    }

    function markClose(mark) {
      return `</${mark.type.toLowerCase()}>`;
    }

    function buildHtml() {
      const marks = normalizeMarks(model.marks);
      if (!model.text) return "";
      const boundaries = new Set([0, model.text.length]);
      marks.forEach((mark) => {
        boundaries.add(mark.start);
        boundaries.add(mark.end);
      });
      const points = [...boundaries].sort((a, b) => a - b);
      let html = "";

      for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        if (end <= start) continue;
        const active = marks
          .filter((mark) => mark.start <= start && mark.end >= end)
          .sort((left, right) => typeOrder.indexOf(left.type) - typeOrder.indexOf(right.type));
        active.forEach((mark) => { html += markOpen(mark); });
        html += escapeText(model.text.slice(start, end)).replace(/\n/g, "<br>");
        [...active].reverse().forEach((mark) => { html += markClose(mark); });
      }
      return html;
    }

    const field = document.createElement("div");
    field.className = "ios-rich-message-field";
    const preview = document.createElement("div");
    preview.className = "ios-rich-message-preview message-editor";
    preview.setAttribute("aria-hidden", "true");
    const textarea = document.createElement("textarea");
    textarea.className = "ios-native-message-input";
    textarea.dataset.iosMessageInput = "";
    textarea.rows = 1;
    textarea.placeholder = transport.placeholder || "Сообщение";
    textarea.autocapitalize = "sentences";
    textarea.spellcheck = true;
    textarea.setAttribute("enterkeyhint", "enter");
    textarea.setAttribute("aria-label", textarea.placeholder);
    field.append(preview, textarea);
    transport.insertAdjacentElement("afterend", field);

    richShadow.removeAttribute("data-rich-message-editor");
    richShadow.dataset.iosRichShadow = "";
    richShadow.setAttribute("aria-hidden", "true");
    richShadow.style.setProperty("display", "none", "important");
    transport.classList.add("rich-composer-transport");
    transport.tabIndex = -1;
    transport.setAttribute("aria-hidden", "true");
    transport.style.setProperty("display", "none", "important");
    form.classList.add("is-native-ios-composer", "has-ios-rich-formatting");

    if (!document.querySelector("style[data-yachat-ios-native-composer-v3]")) {
      const style = document.createElement("style");
      style.dataset.yachatIosNativeComposerV3 = "";
      style.textContent = `
        .composer.is-native-ios-composer { align-items: flex-end; }
        .composer.is-native-ios-composer [data-message-input],
        .composer.is-native-ios-composer [data-ios-rich-shadow] { display: none !important; }
        .ios-rich-message-field {
          position: relative;
          display: grid;
          min-width: 0;
          width: 100%;
          grid-column: 3;
          align-self: end;
          grid-template-areas: "stack";
        }
        .ios-rich-message-preview,
        .ios-native-message-input {
          grid-area: stack;
          box-sizing: border-box;
          min-width: 0 !important;
          width: 100% !important;
          min-height: 42px !important;
          max-height: 132px !important;
          margin: 0 !important;
          padding: 10px 4px !important;
          border: 0 !important;
          outline: 0 !important;
          background: transparent !important;
          font: inherit !important;
          font-size: 16px !important;
          line-height: 1.35 !important;
          white-space: pre-wrap !important;
          overflow-wrap: anywhere !important;
        }
        .ios-rich-message-preview {
          position: relative;
          z-index: 0;
          overflow: hidden !important;
          color: var(--text) !important;
          pointer-events: none;
          user-select: none;
        }
        .ios-native-message-input {
          position: relative;
          z-index: 1;
          overflow-y: auto !important;
          resize: none !important;
          color: transparent !important;
          -webkit-text-fill-color: transparent !important;
          caret-color: var(--accent) !important;
          -webkit-user-select: text !important;
          user-select: text !important;
          pointer-events: auto !important;
          opacity: 1 !important;
        }
        .ios-native-message-input::placeholder {
          color: var(--muted) !important;
          -webkit-text-fill-color: var(--muted) !important;
          opacity: .82;
        }
        .ios-rich-format-toolbar {
          max-width: calc(100vw - 16px);
          touch-action: manipulation;
        }
        .ios-rich-format-toolbar button.is-active { background: rgba(255,255,255,.18); }
        :root[data-theme="light"] .ios-rich-format-toolbar button.is-active { background: rgba(15,23,42,.13); }
      `;
      document.head.append(style);
    }

    function nativeTransportValue() {
      return String(inputValueDescriptor.get.call(transport) || "");
    }

    function writeNativeTransport(value) {
      internalTransportWrite = true;
      inputValueDescriptor.set.call(transport, String(value || ""));
      internalTransportWrite = false;
    }

    function renderPreview() {
      preview.innerHTML = buildHtml();
      preview.style.transform = `translateY(${-textarea.scrollTop}px)`;
    }

    function resizeTextarea() {
      textarea.style.height = "auto";
      const next = Math.min(132, Math.max(42, textarea.scrollHeight));
      textarea.style.height = `${next}px`;
      field.style.height = `${next}px`;
      preview.style.height = `${next}px`;
      renderPreview();
    }

    function writeShadow() {
      syncingShadow = true;
      richShadow.innerHTML = buildHtml();
      syncingShadow = false;
    }

    function dispatchTransportInput(sourceEvent = null) {
      const event = typeof InputEvent === "function"
        ? new InputEvent("input", {
            bubbles: true,
            inputType: sourceEvent?.inputType || "insertText",
            data: sourceEvent?.data ?? null,
            isComposing: Boolean(sourceEvent?.isComposing)
          })
        : new Event("input", { bubbles: true });
      transport.dispatchEvent(event);
    }

    function setModel(next, { updateShadow = true, dispatch = false } = {}) {
      model.text = String(next?.text || "").replace(/\r/g, "");
      model.marks = normalizeMarks(next?.marks, model.text.length);
      if (textarea.value !== model.text) textarea.value = model.text;
      writeNativeTransport(model.text);
      if (updateShadow) writeShadow();
      resizeTextarea();
      if (dispatch) dispatchTransportInput();
    }

    function transformMarks(replaceStart, replaceEnd, insertedLength) {
      const delta = insertedLength - (replaceEnd - replaceStart);
      const next = [];
      normalizeMarks(model.marks).forEach((mark) => {
        const item = { ...mark };
        if (item.end <= replaceStart) {
          next.push(item);
          return;
        }
        if (item.start >= replaceEnd) {
          item.start += delta;
          item.end += delta;
          next.push(item);
          return;
        }
        if (item.start <= replaceStart && item.end >= replaceEnd) {
          item.end += delta;
          if (item.end > item.start) next.push(item);
          return;
        }
        if (item.start < replaceStart && item.end <= replaceEnd) {
          item.end = replaceStart;
          if (item.end > item.start) next.push(item);
          return;
        }
        if (item.start >= replaceStart && item.end > replaceEnd) {
          item.start = replaceStart + insertedLength;
          item.end += delta;
          if (item.end > item.start) next.push(item);
        }
      });
      model.marks = next;
    }

    function applyTextareaChange(event) {
      const oldText = beforeInputText;
      const newText = textarea.value.replace(/\r/g, "");
      let prefix = 0;
      while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < oldText.length - prefix
        && suffix < newText.length - prefix
        && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
      ) suffix += 1;
      const oldEnd = oldText.length - suffix;
      const newEnd = newText.length - suffix;
      transformMarks(prefix, oldEnd, newEnd - prefix);
      model.text = newText;
      model.marks = normalizeMarks(model.marks, model.text.length);
      writeNativeTransport(model.text);
      writeShadow();
      resizeTextarea();
      dispatchTransportInput(event);
    }

    Object.defineProperty(transport, "value", {
      configurable: true,
      enumerable: inputValueDescriptor.enumerable,
      get() { return inputValueDescriptor.get.call(transport); },
      set(value) {
        const text = String(value ?? "").replace(/\r/g, "");
        inputValueDescriptor.set.call(transport, text);
        if (internalTransportWrite || text === model.text) return;
        setModel({ text, marks: [] });
      }
    });

    const parsedInitial = parseShadowHtml(richShadow.innerHTML);
    setModel(parsedInitial.text ? parsedInitial : { text: nativeTransportValue(), marks: [] });

    const shadowObserver = new MutationObserver(() => {
      if (syncingShadow) return;
      const parsed = parseShadowHtml(richShadow.innerHTML);
      setModel(parsed, { updateShadow: false, dispatch: true });
    });
    shadowObserver.observe(richShadow, { childList: true, subtree: true, characterData: true });

    richShadow.focus = (options) => textarea.focus(options);

    textarea.addEventListener("beforeinput", () => { beforeInputText = model.text; });
    textarea.addEventListener("input", applyTextareaChange);
    textarea.addEventListener("compositionstart", () => { beforeInputText = model.text; });
    textarea.addEventListener("compositionend", (event) => {
      if (textarea.value !== model.text) applyTextareaChange(event);
    });
    textarea.addEventListener("scroll", renderPreview, { passive: true });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.stopPropagation();
    });

    const attributeObserver = new MutationObserver(() => {
      textarea.placeholder = transport.placeholder || "Сообщение";
      textarea.setAttribute("aria-label", textarea.placeholder);
      textarea.disabled = transport.disabled;
    });
    attributeObserver.observe(transport, { attributes: true, attributeFilter: ["placeholder", "disabled"] });
    textarea.disabled = transport.disabled;

    const toolbar = document.createElement("div");
    toolbar.className = "rich-selection-toolbar ios-rich-format-toolbar";
    toolbar.hidden = true;
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Форматирование");
    toolbar.innerHTML = `
      <button type="button" data-ios-rich-command="STRONG" aria-label="Жирный"><strong>Ж</strong></button>
      <button type="button" data-ios-rich-command="EM" aria-label="Курсив"><em>К</em></button>
      <button type="button" data-ios-rich-command="U" aria-label="Подчёркнутый"><u>П</u></button>
      <button type="button" data-ios-rich-command="S" aria-label="Зачёркнутый"><s>З</s></button>
      <button type="button" data-ios-rich-command="A" aria-label="Ссылка">↗</button>
    `;
    document.body.append(toolbar);

    function selectionHasType(type, start, end) {
      return normalizeMarks(model.marks).some((mark) => mark.type === type && mark.start <= start && mark.end >= end);
    }

    function positionToolbar() {
      if (document.activeElement !== textarea) {
        toolbar.hidden = true;
        savedSelection = null;
        return;
      }
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
        toolbar.hidden = true;
        savedSelection = null;
        return;
      }
      savedSelection = { start, end };
      toolbar.hidden = false;
      toolbar.querySelectorAll("[data-ios-rich-command]").forEach((button) => {
        button.classList.toggle("is-active", selectionHasType(button.dataset.iosRichCommand, start, end));
      });
      const rect = field.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const left = Math.max(8, Math.min(window.innerWidth - toolbarRect.width - 8, rect.left + rect.width / 2 - toolbarRect.width / 2));
      const top = Math.max(8, rect.top - toolbarRect.height - 8);
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
    }

    function removeTypeInRange(type, start, end) {
      const next = [];
      normalizeMarks(model.marks).forEach((mark) => {
        if (mark.type !== type || mark.end <= start || mark.start >= end) {
          next.push(mark);
          return;
        }
        if (mark.start < start) next.push({ ...mark, end: start });
        if (mark.end > end) next.push({ ...mark, start: end });
      });
      model.marks = next;
    }

    function applyFormat(type) {
      const selection = savedSelection;
      if (!selection || selection.end <= selection.start) return;
      const { start, end } = selection;
      if (selectionHasType(type, start, end)) {
        removeTypeInRange(type, start, end);
      } else {
        let href = "";
        if (type === "A") {
          const raw = window.prompt("Вставьте ссылку");
          if (!raw) return;
          href = safeUrl(raw);
          if (!href) {
            window.yachatFeedback?.show?.("Ссылка не распознана", { tone: "error", icon: "circle-alert" });
            return;
          }
        }
        model.marks.push({ type, start, end, href });
      }
      model.marks = normalizeMarks(model.marks);
      writeShadow();
      renderPreview();
      writeNativeTransport(model.text);
      dispatchTransportInput();
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(start, end);
      requestAnimationFrame(positionToolbar);
    }

    toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
    toolbar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ios-rich-command]");
      if (button) applyFormat(button.dataset.iosRichCommand);
    });

    ["select", "keyup", "pointerup", "touchend", "focus"].forEach((name) => {
      textarea.addEventListener(name, () => requestAnimationFrame(positionToolbar));
    });
    textarea.addEventListener("blur", () => window.setTimeout(() => {
      if (!toolbar.contains(document.activeElement)) {
        toolbar.hidden = true;
        savedSelection = null;
      }
    }, 0));
    document.addEventListener("selectionchange", () => requestAnimationFrame(positionToolbar));
    window.visualViewport?.addEventListener("resize", () => requestAnimationFrame(positionToolbar));

    send.addEventListener("pointerdown", () => { allowSubmitUntil = performance.now() + 1200; }, true);
    send.addEventListener("click", () => { allowSubmitUntil = performance.now() + 1200; }, true);
    form.addEventListener("submit", (event) => {
      const allowed = event.submitter === send || performance.now() < allowSubmitUntil;
      if (!allowed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      writeNativeTransport(model.text);
      writeShadow();
      toolbar.hidden = true;
    }, true);

    installNativeMentions(form, textarea, () => { beforeInputText = model.text; });
    resizeTextarea();
  }

  function installNativeMentions(form, input, prepareInput) {
    const mention = { strip: null, start: -1, end: -1, query: "", users: [], directory: [], loading: false, loaded: false, activeIndex: 0 };

    function cleanUser(raw) {
      if (!raw) return null;
      const id = String(raw.id || "").trim();
      const username = String(raw.username || "").trim().replace(/^@+/, "");
      if (!id || !username) return null;
      return { ...raw, id, username, displayName: String(raw.displayName || raw.previewName || username).trim(), avatarDataUrl: String(raw.avatarDataUrl || "") };
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
      } catch {}
      items.push(...mention.directory);
      let ownId = "";
      try { ownId = String(state?.account?.id || ""); } catch {}
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
        if (event.target instanceof Element && event.target.closest("[data-ios-mention-user]")) event.preventDefault();
      });
      strip.addEventListener("click", (event) => {
        const button = event.target instanceof Element ? event.target.closest("[data-ios-mention-user]") : null;
        const user = mention.users.find((item) => item.id === button?.dataset.iosMentionUser);
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
      mention.users = localUsers().filter((user) => !query || `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(query)).slice(0, 18);
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
      if (!match) return hideStrip();
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
      prepareInput?.();
      input.setRangeText(replacement, mention.start, mention.end, "end");
      hideStrip();
      input.focus({ preventScroll: true });
      input.dispatchEvent(typeof InputEvent === "function"
        ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: replacement })
        : new Event("input", { bubbles: true }));
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
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) updateMentionContext();
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