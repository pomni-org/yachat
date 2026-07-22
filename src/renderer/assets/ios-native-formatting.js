(() => {
  "use strict";

  if (window.__yachatIosNativeFormattingInstalled) return;

  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (!isIos) return;

  const form = document.querySelector('[data-form="message"]');
  const textarea = form?.querySelector('[data-native-ios-message-input]');
  const sendButton = form?.querySelector('.send-button');
  if (!form || !textarea) return;

  window.__yachatIosNativeFormattingInstalled = true;
  form.dataset.yachatIosFormatting = "range-model-v1";

  const formatOrder = ["link", "code", "bold", "italic", "underline", "strike"];
  const tagByType = {
    bold: "strong",
    italic: "em",
    underline: "u",
    strike: "s",
    code: "code"
  };
  const labelByType = {
    bold: "Ж",
    italic: "К",
    underline: "П",
    strike: "З",
    code: "</>"
  };

  let ranges = [];
  let previousValue = textarea.value;
  let submittedHtml = "";
  let toolbarPinned = false;

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

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function normalizedRanges() {
    const length = textarea.value.length;
    const result = [];
    const seen = new Set();
    for (const item of ranges) {
      const start = Math.max(0, Math.min(length, Number(item.start) || 0));
      const end = Math.max(start, Math.min(length, Number(item.end) || 0));
      if (end <= start || !formatOrder.includes(item.type)) continue;
      const href = item.type === "link" ? safeUrl(item.href) : "";
      if (item.type === "link" && !href) continue;
      const key = `${item.type}:${start}:${end}:${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ start, end, type: item.type, href });
    }
    return result.sort((a, b) => a.start - b.start || a.end - b.end || formatOrder.indexOf(a.type) - formatOrder.indexOf(b.type));
  }

  function mergeAdjacent(input) {
    const sorted = [...input].sort((a, b) => a.type.localeCompare(b.type) || a.href.localeCompare(b.href) || a.start - b.start || a.end - b.end);
    const merged = [];
    for (const item of sorted) {
      const last = merged.at(-1);
      if (last && last.type === item.type && last.href === item.href && item.start <= last.end) {
        last.end = Math.max(last.end, item.end);
      } else {
        merged.push({ ...item });
      }
    }
    return merged;
  }

  function commitRanges(next) {
    ranges = mergeAdjacent(next);
    ranges = normalizedRanges();
    updateToolbarState();
  }

  function diffWindow(before, after) {
    let prefix = 0;
    const prefixLimit = Math.min(before.length, after.length);
    while (prefix < prefixLimit && before[prefix] === after[prefix]) prefix += 1;

    let suffix = 0;
    const suffixLimit = Math.min(before.length - prefix, after.length - prefix);
    while (
      suffix < suffixLimit
      && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) suffix += 1;

    return {
      oldStart: prefix,
      oldEnd: before.length - suffix,
      newEnd: after.length - suffix,
      delta: after.length - before.length
    };
  }

  function rebaseRanges(before, after) {
    if (before === after || ranges.length === 0) return;
    const { oldStart, oldEnd, newEnd, delta } = diffWindow(before, after);
    const next = [];

    for (const item of ranges) {
      if (item.end <= oldStart) {
        next.push({ ...item });
        continue;
      }
      if (item.start >= oldEnd) {
        next.push({ ...item, start: item.start + delta, end: item.end + delta });
        continue;
      }
      if (item.start < oldStart && item.end > oldEnd) {
        next.push({ ...item, end: item.end + delta });
        continue;
      }
      if (item.start < oldStart && item.end <= oldEnd) {
        if (oldStart > item.start) next.push({ ...item, end: oldStart });
        continue;
      }
      if (item.start >= oldStart && item.end > oldEnd) {
        const shiftedEnd = item.end + delta;
        if (shiftedEnd > newEnd) next.push({ ...item, start: newEnd, end: shiftedEnd });
      }
    }
    commitRanges(next);
  }

  function selection() {
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  }

  function selectionCovered(type, start, end) {
    if (end <= start) return false;
    const matching = normalizedRanges()
      .filter((item) => item.type === type && item.start < end && item.end > start)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    let cursor = start;
    for (const item of matching) {
      if (item.start > cursor) return false;
      cursor = Math.max(cursor, item.end);
      if (cursor >= end) return true;
    }
    return false;
  }

  function removeFormatWithin(type, start, end) {
    const next = [];
    for (const item of ranges) {
      if (item.type !== type || item.end <= start || item.start >= end) {
        next.push(item);
        continue;
      }
      if (item.start < start) next.push({ ...item, end: start });
      if (item.end > end) next.push({ ...item, start: end });
    }
    return next;
  }

  function applyFormat(type, href = "") {
    const { start, end } = selection();
    if (end <= start) {
      window.yachatFeedback?.show?.("Сначала выделите текст", { tone: "error", icon: "circle-alert" });
      textarea.focus({ preventScroll: true });
      return;
    }

    const covered = selectionCovered(type, start, end);
    const next = removeFormatWithin(type, start, end);
    if (!covered) {
      const safeHref = type === "link" ? safeUrl(href) : "";
      if (type === "link" && !safeHref) {
        window.yachatFeedback?.show?.("Ссылка не распознана", { tone: "error", icon: "circle-alert" });
        return;
      }
      next.push({ start, end, type, href: safeHref });
    }
    commitRanges(next);
    submittedHtml = serializeFormattedHtml();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(start, end);
  }

  function activeFormatsForSegment(start, end) {
    return normalizedRanges().filter((item) => item.start <= start && item.end >= end);
  }

  function serializeFormattedHtml() {
    const text = textarea.value;
    if (!text) return "";
    const activeRanges = normalizedRanges();
    if (activeRanges.length === 0) return "";

    const boundaries = new Set([0, text.length]);
    activeRanges.forEach((item) => {
      boundaries.add(item.start);
      boundaries.add(item.end);
    });
    const points = [...boundaries].sort((a, b) => a - b);
    let html = "";

    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (end <= start) continue;
      let segment = escapeHtml(text.slice(start, end)).replace(/\n/g, "<br>");
      const active = activeFormatsForSegment(start, end)
        .sort((a, b) => formatOrder.indexOf(a.type) - formatOrder.indexOf(b.type));
      for (let itemIndex = active.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const item = active[itemIndex];
        if (item.type === "link") {
          segment = `<a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer">${segment}</a>`;
        } else {
          const tag = tagByType[item.type];
          if (tag) segment = `<${tag}>${segment}</${tag}>`;
        }
      }
      html += segment;
    }
    return html;
  }

  function parseFormattedHtml(formattedHtml, fallbackText = "") {
    const template = document.createElement("template");
    template.innerHTML = String(formattedHtml || "").slice(0, 24000);
    let text = "";
    const parsedRanges = [];

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue || "";
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "BR") {
        text += "\n";
        return;
      }

      const type = {
        STRONG: "bold",
        B: "bold",
        EM: "italic",
        I: "italic",
        U: "underline",
        S: "strike",
        DEL: "strike",
        CODE: "code",
        A: "link"
      }[node.tagName] || "";
      const href = type === "link" ? safeUrl(node.getAttribute("href")) : "";
      const start = text.length;
      [...node.childNodes].forEach(walk);
      const end = text.length;
      if (type && end > start && (type !== "link" || href)) {
        parsedRanges.push({ start, end, type, href });
      }
    }

    [...template.content.childNodes].forEach(walk);
    const cleanFallback = String(fallbackText || "").replace(/\r/g, "");
    if (!text && cleanFallback) return { text: cleanFallback, ranges: [] };
    if (cleanFallback && text !== cleanFallback) return { text: cleanFallback, ranges: [] };
    return { text, ranges: parsedRanges };
  }

  function setFormatting(formattedHtml = "", fallbackText = textarea.value) {
    const parsed = parseFormattedHtml(formattedHtml, fallbackText);
    if (textarea.value !== parsed.text) {
      textarea.value = parsed.text;
      form.__yachatSyncRichEditor?.({ dispatch: false });
    }
    previousValue = textarea.value;
    commitRanges(parsed.ranges);
    submittedHtml = serializeFormattedHtml();
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "composer-tool ios-format-toggle";
  toggle.dataset.action = "toggle-ios-formatting";
  toggle.setAttribute("aria-label", "Форматирование");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "Aa";
  sendButton?.insertAdjacentElement("beforebegin", toggle);

  const toolbar = document.createElement("div");
  toolbar.className = "ios-format-toolbar";
  toolbar.hidden = true;
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Форматирование текста");
  toolbar.innerHTML = `
    ${["bold", "italic", "underline", "strike", "code"].map((type) => `
      <button type="button" data-ios-format="${type}" aria-label="${type}">${labelByType[type]}</button>
    `).join("")}
    <button type="button" data-ios-format="link" aria-label="Ссылка">↗</button>
  `;
  form.append(toolbar);

  if (!document.querySelector("style[data-yachat-ios-formatting]")) {
    const style = document.createElement("style");
    style.dataset.yachatIosFormatting = "";
    style.textContent = `
      .composer.is-native-ios-textarea-composer .ios-format-toggle {
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        min-width: var(--composer-control, 44px);
        height: var(--composer-control, 44px);
        padding: 0 8px;
        font: inherit;
        font-weight: 650;
        letter-spacing: -.02em;
      }
      .composer.is-native-ios-textarea-composer .ios-format-toolbar {
        position: absolute;
        z-index: 40;
        left: 52px;
        right: 52px;
        bottom: calc(100% + 7px);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 6px;
        border: 1px solid color-mix(in srgb, var(--card-edge), transparent 20%);
        border-radius: 16px;
        background: color-mix(in srgb, var(--card), transparent 2%);
        box-shadow: 0 10px 28px rgba(0, 0, 0, .18);
        backdrop-filter: blur(18px);
      }
      .composer.is-native-ios-textarea-composer .ios-format-toolbar[hidden] {
        display: none !important;
      }
      .composer.is-native-ios-textarea-composer .ios-format-toolbar button {
        min-width: 36px;
        height: 34px;
        padding: 0 8px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-weight: 650;
      }
      .composer.is-native-ios-textarea-composer .ios-format-toolbar button.is-active {
        background: var(--accent);
        color: #fff;
      }
    `;
    document.head.append(style);
  }

  function updateToolbarVisibility() {
    const { start, end } = selection();
    const visible = toolbarPinned || (document.activeElement === textarea && end > start);
    toolbar.hidden = !visible;
    toggle.setAttribute("aria-expanded", visible ? "true" : "false");
  }

  function updateToolbarState() {
    const { start, end } = selection();
    toolbar.querySelectorAll("[data-ios-format]").forEach((button) => {
      button.classList.toggle("is-active", end > start && selectionCovered(button.dataset.iosFormat, start, end));
    });
    updateToolbarVisibility();
  }

  toggle.addEventListener("pointerdown", (event) => event.preventDefault());
  toggle.addEventListener("click", () => {
    toolbarPinned = !toolbarPinned;
    updateToolbarVisibility();
    textarea.focus({ preventScroll: true });
  });

  toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
  toolbar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ios-format]");
    if (!button) return;
    const type = button.dataset.iosFormat;
    if (type === "link") {
      const raw = window.prompt("Вставьте ссылку");
      if (!raw) return;
      applyFormat(type, raw);
    } else {
      applyFormat(type);
    }
  });

  textarea.addEventListener("input", () => {
    const current = textarea.value;
    rebaseRanges(previousValue, current);
    previousValue = current;
    submittedHtml = serializeFormattedHtml();
  });
  textarea.addEventListener("select", updateToolbarState);
  textarea.addEventListener("keyup", updateToolbarState);
  textarea.addEventListener("pointerup", updateToolbarState);
  textarea.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!toolbar.contains(document.activeElement) && !toggle.contains(document.activeElement)) {
        toolbarPinned = false;
        updateToolbarVisibility();
      }
    }, 0);
  });

  document.addEventListener("selectionchange", () => {
    if (document.activeElement === textarea) updateToolbarState();
  });

  form.addEventListener("submit", () => {
    submittedHtml = serializeFormattedHtml();
  }, true);

  const previousSetNativeValue = form.__yachatSetNativeComposerValue;
  if (typeof previousSetNativeValue === "function") {
    form.__yachatSetNativeComposerValue = function setNativeValueWithFormatting(value = "", options = {}) {
      const result = previousSetNativeValue(value, options);
      previousValue = textarea.value;
      if (!options.keepFormatting) commitRanges([]);
      return result;
    };
  }

  if (typeof createTransientOutgoingMessage === "function" && !createTransientOutgoingMessage.__yachatIosFormatting) {
    const previousCreateTransient = createTransientOutgoingMessage;
    const wrappedCreateTransient = function createFormattedTransient(chat, payload = {}) {
      const message = previousCreateTransient.apply(this, arguments);
      message.formattedHtml = payload.formattedHtml || submittedHtml || serializeFormattedHtml();
      submittedHtml = "";
      return message;
    };
    Object.defineProperty(wrappedCreateTransient, "__yachatIosFormatting", { value: true });
    createTransientOutgoingMessage = wrappedCreateTransient;
  }

  if (typeof startEditMessage === "function" && !startEditMessage.__yachatIosFormatting) {
    const previousStartEditMessage = startEditMessage;
    const wrappedStartEditMessage = function startFormattedEdit(message) {
      const result = previousStartEditMessage.apply(this, arguments);
      setFormatting(message?.formattedHtml || "", message?.text || textarea.value);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      return result;
    };
    Object.defineProperty(wrappedStartEditMessage, "__yachatIosFormatting", { value: true });
    startEditMessage = wrappedStartEditMessage;
  }

  const messengerApi = typeof yachatApi !== "undefined" ? yachatApi?.messenger : null;
  if (messengerApi?.send && !messengerApi.send.__yachatIosFormatting) {
    const previousSend = messengerApi.send.bind(messengerApi);
    const wrappedSend = function sendFormattedNativeMessage(payload = {}) {
      const transient = typeof getMessageById === "function" ? getMessageById(payload.clientMessageId) : null;
      const formattedHtml = payload.formattedHtml || transient?.formattedHtml || submittedHtml || serializeFormattedHtml();
      return previousSend(formattedHtml ? { ...payload, formattedHtml } : payload);
    };
    Object.defineProperty(wrappedSend, "__yachatIosFormatting", { value: true });
    messengerApi.send = wrappedSend;
  }

  if (messengerApi?.updateMessage && !messengerApi.updateMessage.__yachatIosFormatting) {
    const previousUpdate = messengerApi.updateMessage.bind(messengerApi);
    const wrappedUpdate = async function updateFormattedNativeMessage(payload = {}) {
      const formattedHtml = payload.formattedHtml || submittedHtml || serializeFormattedHtml();
      const result = await previousUpdate(formattedHtml ? { ...payload, formattedHtml } : payload);
      submittedHtml = "";
      commitRanges([]);
      return result;
    };
    Object.defineProperty(wrappedUpdate, "__yachatIosFormatting", { value: true });
    messengerApi.updateMessage = wrappedUpdate;
  }

  form.__yachatGetNativeFormattedHtml = serializeFormattedHtml;
  form.__yachatSetNativeFormatting = setFormatting;
  updateToolbarState();
})();
