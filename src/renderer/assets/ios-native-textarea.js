(() => {
  "use strict";

  if (window.__yachatIosNativeTextareaInstalled) return;

  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (!isIos) return;

  const form = document.querySelector('[data-form="message"]');
  const transport = form?.querySelector('[data-message-input]');
  const richEditor = form?.querySelector('[data-rich-message-editor]');
  const sendButtonElement = form?.querySelector('.send-button');
  if (!form || !transport || !richEditor) return;

  window.__yachatIosNativeTextareaInstalled = true;
  form.dataset.yachatIosComposer = "native-textarea-v8";
  form.classList.add("is-native-ios-textarea-composer");

  const FORMAT_TAGS = new Set(["strong", "em", "u", "s", "code", "a"]);
  const FORMAT_ORDER = new Map([
    ["a", 0],
    ["strong", 1],
    ["em", 2],
    ["u", 3],
    ["s", 4],
    ["code", 5]
  ]);
  const TAG_ALIASES = new Map([["b", "strong"], ["i", "em"], ["del", "s"]]);

  // Text inputs erase line breaks. Keep the same transport node because the
  // application stores its reference, but switch it to a multiline-safe type.
  transport.type = "hidden";

  const textarea = document.createElement("textarea");
  textarea.className = "ios-native-message-input";
  textarea.dataset.nativeIosMessageInput = "";
  textarea.rows = 1;
  textarea.value = String(transport.value || richEditor.innerText || richEditor.textContent || "").replace(/\r/g, "");
  textarea.placeholder = transport.placeholder || "Сообщение";
  textarea.setAttribute("aria-label", textarea.placeholder);
  textarea.setAttribute("autocomplete", "off");
  textarea.setAttribute("autocorrect", "on");
  textarea.setAttribute("autocapitalize", "sentences");
  textarea.setAttribute("spellcheck", "true");
  textarea.setAttribute("enterkeyhint", "enter");

  richEditor.hidden = true;
  richEditor.tabIndex = -1;
  richEditor.contentEditable = "false";
  richEditor.setAttribute("aria-hidden", "true");
  richEditor.style.setProperty("display", "none", "important");
  richEditor.insertAdjacentElement("beforebegin", textarea);

  const emojiButton = form.querySelector('[data-action="open-stickers"]');
  if (emojiButton) {
    emojiButton.hidden = true;
    emojiButton.disabled = true;
    emojiButton.tabIndex = -1;
    emojiButton.setAttribute("aria-hidden", "true");
    emojiButton.style.setProperty("display", "none", "important");
  }

  const formatToolbar = document.createElement("div");
  formatToolbar.className = "ios-native-format-toolbar";
  formatToolbar.hidden = true;
  formatToolbar.setAttribute("role", "toolbar");
  formatToolbar.setAttribute("aria-label", "Форматирование выделенного текста");
  formatToolbar.innerHTML = `
    <button type="button" data-ios-format="strong" aria-label="Жирный"><strong>Ж</strong></button>
    <button type="button" data-ios-format="em" aria-label="Курсив"><em>К</em></button>
    <button type="button" data-ios-format="u" aria-label="Подчёркнутый"><u>П</u></button>
    <button type="button" data-ios-format="s" aria-label="Зачёркнутый"><s>З</s></button>
    <button type="button" data-ios-format="code" aria-label="Моноширинный"><code>&lt;/&gt;</code></button>
    <button type="button" data-ios-format="a" aria-label="Ссылка">↗</button>
  `;
  form.prepend(formatToolbar);

  if (!document.querySelector("style[data-yachat-ios-native-textarea]")) {
    const style = document.createElement("style");
    style.dataset.yachatIosNativeTextarea = "";
    style.textContent = `
      .composer.is-native-ios-textarea-composer [data-rich-message-editor],
      .composer.is-native-ios-textarea-composer [data-action="open-stickers"] {
        display: none !important;
        pointer-events: none !important;
      }

      .composer.is-native-ios-textarea-composer .ios-native-format-toolbar {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        gap: 5px;
        width: max-content;
        max-width: 100%;
        margin: 0 0 7px 52px;
        padding: 5px;
        overflow-x: auto;
        border: 1px solid color-mix(in srgb, var(--card-edge), transparent 18%);
        border-radius: 14px;
        background: color-mix(in srgb, var(--card), var(--field) 28%);
        box-shadow: 0 8px 22px rgba(0, 0, 0, .18);
        -webkit-overflow-scrolling: touch;
      }

      .composer.is-native-ios-textarea-composer .ios-native-format-toolbar[hidden] {
        display: none !important;
      }

      .composer.is-native-ios-textarea-composer .ios-native-format-toolbar button {
        flex: 0 0 34px;
        display: inline-grid;
        place-items: center;
        width: 34px;
        height: 32px;
        padding: 0;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: var(--text);
        font: inherit;
      }

      .composer.is-native-ios-textarea-composer .ios-native-format-toolbar button.is-active {
        background: var(--accent);
        color: #fff;
      }

      .composer.is-native-ios-textarea-composer .composer-bottom-row > .ios-native-message-input,
      .composer.is-native-ios-textarea-composer > .ios-native-message-input {
        box-sizing: border-box !important;
        position: relative !important;
        grid-column: 2 !important;
        grid-row: 1 !important;
        align-self: end !important;
        justify-self: stretch !important;
        display: block !important;
        width: 100% !important;
        min-width: 0 !important;
        min-height: var(--composer-control, 44px) !important;
        max-height: 132px !important;
        margin: 0 !important;
        padding: 11px 17px 10px !important;
        overflow-x: hidden !important;
        overflow-y: hidden;
        border: 1px solid color-mix(in srgb, var(--card-edge), transparent 22%) !important;
        border-radius: 24px !important;
        outline: 0 !important;
        background: color-mix(in srgb, var(--field), var(--card) 30%) !important;
        color: var(--text) !important;
        caret-color: var(--accent) !important;
        box-shadow: 0 1px 0 rgba(255, 255, 255, .04) inset !important;
        font: inherit !important;
        font-size: 16px !important;
        font-weight: 400 !important;
        line-height: 22px !important;
        white-space: pre-wrap !important;
        overflow-wrap: anywhere !important;
        resize: none !important;
        -webkit-appearance: none !important;
        appearance: none !important;
      }

      .composer.is-native-ios-textarea-composer .ios-native-message-input.is-multiline {
        border-radius: 18px !important;
      }

      .composer.is-native-ios-textarea-composer .ios-native-message-input.is-scrollable {
        overflow-y: auto !important;
        overscroll-behavior: contain;
      }

      :root[data-theme="light"] .composer.is-native-ios-textarea-composer .ios-native-message-input {
        border-color: rgba(15, 23, 42, .06) !important;
        background: #fff !important;
        box-shadow: 0 1px 2px rgba(15, 23, 42, .04) !important;
      }
    `;
    document.head.append(style);
  }

  let enterHandledByKeydown = false;
  let previousValue = textarea.value;
  let formatRanges = [];
  let submittedHtml = "";

  function escapeMarkup(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
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

  function normalizeRanges(ranges = formatRanges) {
    const length = textarea.value.length;
    const cleaned = ranges
      .map((range) => ({
        start: Math.max(0, Math.min(length, Number(range.start) || 0)),
        end: Math.max(0, Math.min(length, Number(range.end) || 0)),
        tag: TAG_ALIASES.get(String(range.tag || "").toLowerCase()) || String(range.tag || "").toLowerCase(),
        href: String(range.href || "")
      }))
      .filter((range) => FORMAT_TAGS.has(range.tag) && range.end > range.start)
      .sort((left, right) => left.tag.localeCompare(right.tag) || left.href.localeCompare(right.href) || left.start - right.start || left.end - right.end);

    const merged = [];
    for (const range of cleaned) {
      const previous = merged[merged.length - 1];
      if (previous && previous.tag === range.tag && previous.href === range.href && range.start <= previous.end) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
    }
    formatRanges = merged;
    return merged;
  }

  function serializeFormattedHtml() {
    const text = String(textarea.value || "").replace(/\r/g, "");
    const ranges = normalizeRanges();
    if (!text) return "";

    const boundaries = new Set([0, text.length]);
    ranges.forEach((range) => {
      boundaries.add(range.start);
      boundaries.add(range.end);
    });
    const points = [...boundaries].sort((a, b) => a - b);
    const parts = [];

    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (end <= start) continue;
      const active = ranges
        .filter((range) => range.start <= start && range.end >= end)
        .sort((left, right) => (FORMAT_ORDER.get(left.tag) ?? 99) - (FORMAT_ORDER.get(right.tag) ?? 99));
      let segment = escapeMarkup(text.slice(start, end)).replace(/\n/g, "<br>");
      for (let activeIndex = active.length - 1; activeIndex >= 0; activeIndex -= 1) {
        const range = active[activeIndex];
        if (range.tag === "a") {
          const href = safeUrl(range.href);
          if (href) segment = `<a href="${escapeMarkup(href)}" target="_blank" rel="noopener noreferrer">${segment}</a>`;
        } else {
          segment = `<${range.tag}>${segment}</${range.tag}>`;
        }
      }
      parts.push(segment);
    }
    return parts.join("");
  }

  function parseFormattedHtml(value, expectedText = "") {
    const template = document.createElement("template");
    template.innerHTML = String(value || "").slice(0, 24000);
    const ranges = [];
    let text = "";

    function appendText(content, active) {
      const normalized = String(content || "").replace(/\r/g, "");
      if (!normalized) return;
      const start = text.length;
      text += normalized;
      const end = text.length;
      active.forEach((format) => ranges.push({ start, end, ...format }));
    }

    function walk(node, active = []) {
      if (node.nodeType === Node.TEXT_NODE) {
        appendText(node.nodeValue || "", active);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const original = node.tagName.toLowerCase();
      const tag = TAG_ALIASES.get(original) || original;
      if (tag === "br") {
        appendText("\n", []);
        return;
      }
      const next = [...active];
      if (FORMAT_TAGS.has(tag)) {
        if (tag === "a") {
          const href = safeUrl(node.getAttribute("href"));
          if (href) next.push({ tag, href });
        } else {
          next.push({ tag, href: "" });
        }
      }
      [...node.childNodes].forEach((child) => walk(child, next));
    }

    [...template.content.childNodes].forEach((node) => walk(node));
    const normalizedExpected = String(expectedText || "").replace(/\r/g, "");
    if (normalizedExpected && normalizedExpected !== text) return { text: normalizedExpected, ranges: [] };
    return { text: normalizedExpected || text, ranges };
  }

  function reconcileRanges(before, after) {
    if (before === after || formatRanges.length === 0) return;
    let prefix = 0;
    const shortest = Math.min(before.length, after.length);
    while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;

    let oldEnd = before.length;
    let newEnd = after.length;
    while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }

    const delta = newEnd - oldEnd;
    const next = [];
    for (const range of formatRanges) {
      if (range.end <= prefix) {
        next.push({ ...range });
        continue;
      }
      if (range.start >= oldEnd) {
        next.push({ ...range, start: range.start + delta, end: range.end + delta });
        continue;
      }

      // An edit fully inside a formatted span inherits that span. Boundary
      // insertions stay outside, matching ordinary rich text editors.
      if (prefix > range.start && oldEnd < range.end) {
        next.push({ ...range, end: range.end + delta });
        continue;
      }

      if (range.start < prefix) next.push({ ...range, end: prefix });
      if (range.end > oldEnd) next.push({ ...range, start: newEnd, end: range.end + delta });
    }
    normalizeRanges(next);
  }

  function selectionCovered(tag, start, end) {
    if (end <= start) return false;
    const matching = formatRanges.filter((range) => range.tag === tag && range.start < end && range.end > start);
    let cursor = start;
    for (const range of matching.sort((left, right) => left.start - right.start)) {
      if (range.start > cursor) return false;
      cursor = Math.max(cursor, range.end);
      if (cursor >= end) return true;
    }
    return false;
  }

  function removeFormatFromSelection(tag, start, end) {
    const next = [];
    for (const range of formatRanges) {
      if (range.tag !== tag || range.end <= start || range.start >= end) {
        next.push(range);
        continue;
      }
      if (range.start < start) next.push({ ...range, end: start });
      if (range.end > end) next.push({ ...range, start: end });
    }
    normalizeRanges(next);
  }

  function applyFormat(tag, href = "") {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (end <= start || !FORMAT_TAGS.has(tag)) return;

    if (selectionCovered(tag, start, end)) {
      removeFormatFromSelection(tag, start, end);
    } else {
      if (tag === "a") removeFormatFromSelection("a", start, end);
      formatRanges.push({ start, end, tag, href: tag === "a" ? safeUrl(href) : "" });
      normalizeRanges();
    }
    submittedHtml = serializeFormattedHtml();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(start, end);
    updateFormatToolbar();
  }

  function updateFormatToolbar() {
    const focused = document.activeElement === textarea || formatToolbar.contains(document.activeElement);
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    formatToolbar.hidden = !focused || textarea.disabled || textarea.readOnly || end <= start;
    formatToolbar.querySelectorAll("[data-ios-format]").forEach((button) => {
      button.classList.toggle("is-active", selectionCovered(button.dataset.iosFormat, start, end));
    });
  }

  function resizeTextarea() {
    textarea.style.height = "auto";
    const minimum = Math.max(44, Number.parseFloat(getComputedStyle(textarea).minHeight) || 44);
    const maximum = 132;
    const desired = Math.max(minimum, Math.min(maximum, textarea.scrollHeight));
    textarea.style.height = `${desired}px`;
    const multiline = textarea.value.includes("\n") || textarea.scrollHeight > minimum + 3;
    const scrollable = textarea.scrollHeight > maximum + 1;
    textarea.classList.toggle("is-multiline", multiline);
    textarea.classList.toggle("is-scrollable", scrollable);
    textarea.style.overflowY = scrollable ? "auto" : "hidden";
  }

  function mirrorToLegacyEditor(value) {
    const normalized = String(value || "").replace(/\r/g, "");
    if ((richEditor.innerText || richEditor.textContent || "").replace(/\r/g, "") !== normalized) {
      richEditor.textContent = normalized;
    }
  }

  function updateSendState() {
    if (!sendButtonElement) return;
    const hasText = Boolean(String(textarea.value || "").trim());
    let attachmentCount = 0;
    let editing = false;
    let allowed = true;
    try {
      attachmentCount = Array.isArray(state?.pendingAttachments) ? state.pendingAttachments.length : 0;
      editing = Boolean(state?.editingMessageId);
      allowed = typeof canSendToChat === "function" ? Boolean(canSendToChat(getActiveChat())) : true;
    } catch {
      allowed = true;
    }
    sendButtonElement.disabled = editing
      ? !hasText
      : !allowed || (!hasText && attachmentCount === 0);
  }

  function syncNative({ dispatch = true } = {}) {
    const value = String(textarea.value || "").replace(/\r/g, "");
    reconcileRanges(previousValue, value);
    previousValue = value;
    mirrorToLegacyEditor(value);
    const changed = transport.value !== value;
    if (changed) transport.value = value;
    if (changed && dispatch) transport.dispatchEvent(new Event("input", { bubbles: true }));
    submittedHtml = serializeFormattedHtml();
    resizeTextarea();
    updateSendState();
    updateFormatToolbar();
    return value;
  }

  function setNativeValue(value = "", {
    formattedHtml = "",
    focus = false,
    caret = "end",
    dispatch = true
  } = {}) {
    const normalized = String(value || "").replace(/\r/g, "");
    const parsed = formattedHtml ? parseFormattedHtml(formattedHtml, normalized) : { text: normalized, ranges: [] };
    textarea.value = parsed.text;
    previousValue = parsed.text;
    formatRanges = parsed.ranges;
    normalizeRanges();
    syncNative({ dispatch });
    if (focus) {
      textarea.focus({ preventScroll: true });
      const position = caret === "start" ? 0 : textarea.value.length;
      textarea.setSelectionRange(position, position);
    }
  }

  function clearNative({ dispatch = false } = {}) {
    textarea.value = "";
    previousValue = "";
    formatRanges = [];
    submittedHtml = "";
    syncNative({ dispatch });
  }

  function syncReadonly() {
    const readonly = transport.disabled || form.classList.contains("is-readonly");
    textarea.disabled = readonly;
    textarea.readOnly = readonly;
    textarea.placeholder = transport.placeholder || "Сообщение";
    textarea.setAttribute("aria-label", textarea.placeholder);
    updateSendState();
    updateFormatToolbar();
  }

  function insertNativeLineBreak(start = textarea.selectionStart, end = textarea.selectionEnd) {
    textarea.setRangeText("\n", start, end, "end");
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertLineBreak",
      data: null
    }));
  }

  formatToolbar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-ios-format]")) event.preventDefault();
  });
  formatToolbar.addEventListener("touchstart", (event) => {
    if (event.target.closest("[data-ios-format]")) event.preventDefault();
  }, { passive: false });
  formatToolbar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ios-format]");
    if (!button) return;
    const tag = button.dataset.iosFormat;
    if (tag === "a" && !selectionCovered("a", textarea.selectionStart, textarea.selectionEnd)) {
      const raw = window.prompt("Вставьте ссылку");
      if (!raw) return;
      const href = safeUrl(raw);
      if (!href) {
        window.yachatFeedback?.show?.("Ссылка не распознана", { tone: "error", icon: "circle-alert" });
        return;
      }
      applyFormat("a", href);
      return;
    }
    applyFormat(tag);
  });

  textarea.addEventListener("input", () => syncNative());
  textarea.addEventListener("change", () => syncNative());
  textarea.addEventListener("select", updateFormatToolbar);
  textarea.addEventListener("click", updateFormatToolbar);
  textarea.addEventListener("keyup", (event) => {
    if (event.key === "Enter") enterHandledByKeydown = false;
    updateFormatToolbar();
  });
  textarea.addEventListener("beforeinput", (event) => {
    if (event.isComposing || !["insertLineBreak", "insertParagraph"].includes(event.inputType)) return;
    event.preventDefault();
    if (!enterHandledByKeydown) insertNativeLineBreak();
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.stopPropagation();
    if (event.isComposing) return;

    enterHandledByKeydown = false;
    const mentionStripOpen = Boolean(form.querySelector(".message-mention-strip:not([hidden])"));
    if (mentionStripOpen) return;

    event.preventDefault();
    enterHandledByKeydown = true;
    insertNativeLineBreak();
  });
  textarea.addEventListener("focus", () => {
    resizeTextarea();
    updateFormatToolbar();
  });
  textarea.addEventListener("blur", () => window.setTimeout(updateFormatToolbar, 0));

  form.__yachatSyncRichEditor = syncNative;
  form.__yachatSetNativeComposerValue = setNativeValue;
  form.__yachatNativeFormattedHtml = serializeFormattedHtml;
  form.__yachatNativeFormatRanges = () => formatRanges.map((range) => ({ ...range }));

  form.addEventListener("submit", () => {
    syncNative({ dispatch: false });
    submittedHtml = serializeFormattedHtml();
  }, true);

  if (typeof startEditMessage === "function" && !startEditMessage.__yachatNativeTextarea) {
    const previousStartEditMessage = startEditMessage;
    const wrappedStartEditMessage = function startEditMessageWithNativeTextarea(message) {
      const result = previousStartEditMessage.apply(this, arguments);
      setNativeValue(message?.text || transport.value || "", {
        formattedHtml: message?.formattedHtml || "",
        focus: true,
        dispatch: false
      });
      return result;
    };
    Object.defineProperty(wrappedStartEditMessage, "__yachatNativeTextarea", { value: true });
    startEditMessage = wrappedStartEditMessage;
  }

  if (typeof createTransientOutgoingMessage === "function" && !createTransientOutgoingMessage.__yachatNativeTextarea) {
    const previousCreateTransient = createTransientOutgoingMessage;
    const wrappedCreateTransient = function createTransientWithNativeTextarea() {
      syncNative({ dispatch: false });
      const html = serializeFormattedHtml() || submittedHtml;
      const result = previousCreateTransient.apply(this, arguments);
      result.formattedHtml = html;
      queueMicrotask(() => clearNative({ dispatch: false }));
      return result;
    };
    Object.defineProperty(wrappedCreateTransient, "__yachatNativeTextarea", { value: true });
    createTransientOutgoingMessage = wrappedCreateTransient;
  }

  const messengerApi = typeof yachatApi !== "undefined" ? yachatApi?.messenger : null;
  if (messengerApi?.send && !messengerApi.send.__yachatNativeTextareaFormatting) {
    const previousSend = messengerApi.send.bind(messengerApi);
    const wrappedSend = function sendWithNativeFormatting(payload = {}) {
      const transient = typeof getMessageById === "function" ? getMessageById(payload.clientMessageId) : null;
      const formattedHtml = payload.formattedHtml || transient?.formattedHtml || submittedHtml || serializeFormattedHtml();
      return previousSend(formattedHtml ? { ...payload, formattedHtml } : payload);
    };
    Object.defineProperty(wrappedSend, "__yachatNativeTextareaFormatting", { value: true });
    messengerApi.send = wrappedSend;
  }
  if (messengerApi?.updateMessage && !messengerApi.updateMessage.__yachatNativeTextarea) {
    const previousUpdateMessage = messengerApi.updateMessage.bind(messengerApi);
    const wrappedUpdateMessage = async function updateMessageWithNativeTextarea(payload = {}) {
      syncNative({ dispatch: false });
      const result = await previousUpdateMessage({
        ...payload,
        formattedHtml: payload.formattedHtml || serializeFormattedHtml()
      });
      clearNative({ dispatch: false });
      return result;
    };
    Object.defineProperty(wrappedUpdateMessage, "__yachatNativeTextarea", { value: true });
    messengerApi.updateMessage = wrappedUpdateMessage;
  }

  new MutationObserver(syncReadonly).observe(transport, {
    attributes: true,
    attributeFilter: ["disabled", "placeholder"]
  });

  syncReadonly();
  syncNative({ dispatch: false });
  requestAnimationFrame(resizeTextarea);
})();
