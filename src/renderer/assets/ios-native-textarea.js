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
  if (!form || !transport || !richEditor) return;

  window.__yachatIosNativeTextareaInstalled = true;
  form.dataset.yachatIosComposer = "native-textarea-v5";
  form.classList.add("is-native-ios-textarea-composer");

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

  if (!document.querySelector("style[data-yachat-ios-native-textarea]")) {
    const style = document.createElement("style");
    style.dataset.yachatIosNativeTextarea = "";
    style.textContent = `
      .composer.is-native-ios-textarea-composer [data-rich-message-editor],
      .composer.is-native-ios-textarea-composer [data-action="open-stickers"] {
        display: none !important;
        pointer-events: none !important;
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

  function syncNative({ dispatch = true } = {}) {
    const value = String(textarea.value || "").replace(/\r/g, "");
    mirrorToLegacyEditor(value);
    const changed = transport.value !== value;
    if (changed) transport.value = value;
    if (changed && dispatch) transport.dispatchEvent(new Event("input", { bubbles: true }));
    resizeTextarea();
    return value;
  }

  function setNativeValue(value = "", { focus = false, caret = "end", dispatch = true } = {}) {
    textarea.value = String(value || "").replace(/\r/g, "");
    syncNative({ dispatch });
    if (focus) {
      textarea.focus({ preventScroll: true });
      const position = caret === "start" ? 0 : textarea.value.length;
      textarea.setSelectionRange(position, position);
    }
  }

  function syncReadonly() {
    const readonly = transport.disabled || form.classList.contains("is-readonly");
    textarea.disabled = readonly;
    textarea.readOnly = readonly;
    textarea.placeholder = transport.placeholder || "Сообщение";
    textarea.setAttribute("aria-label", textarea.placeholder);
  }

  function insertNativeLineBreak(start = textarea.selectionStart, end = textarea.selectionEnd) {
    textarea.setRangeText("\n", start, end, "end");
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertLineBreak",
      data: null
    }));
  }

  textarea.addEventListener("input", () => syncNative());
  textarea.addEventListener("change", () => syncNative());
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
  textarea.addEventListener("keyup", (event) => {
    if (event.key === "Enter") enterHandledByKeydown = false;
  });
  textarea.addEventListener("focus", resizeTextarea);

  form.__yachatSyncRichEditor = syncNative;
  form.__yachatSetNativeComposerValue = setNativeValue;

  if (typeof startEditMessage === "function" && !startEditMessage.__yachatNativeTextarea) {
    const previousStartEditMessage = startEditMessage;
    const wrappedStartEditMessage = function startEditMessageWithNativeTextarea(message) {
      const result = previousStartEditMessage.apply(this, arguments);
      setNativeValue(message?.text || transport.value || "", { focus: true, dispatch: false });
      return result;
    };
    Object.defineProperty(wrappedStartEditMessage, "__yachatNativeTextarea", { value: true });
    startEditMessage = wrappedStartEditMessage;
  }

  if (typeof createTransientOutgoingMessage === "function" && !createTransientOutgoingMessage.__yachatNativeTextarea) {
    const previousCreateTransient = createTransientOutgoingMessage;
    const wrappedCreateTransient = function createTransientWithNativeTextarea() {
      syncNative({ dispatch: false });
      const result = previousCreateTransient.apply(this, arguments);
      queueMicrotask(() => setNativeValue("", { dispatch: false }));
      return result;
    };
    Object.defineProperty(wrappedCreateTransient, "__yachatNativeTextarea", { value: true });
    createTransientOutgoingMessage = wrappedCreateTransient;
  }

  const messengerApi = typeof yachatApi !== "undefined" ? yachatApi?.messenger : null;
  if (messengerApi?.updateMessage && !messengerApi.updateMessage.__yachatNativeTextarea) {
    const previousUpdateMessage = messengerApi.updateMessage.bind(messengerApi);
    const wrappedUpdateMessage = async function updateMessageWithNativeTextarea(payload = {}) {
      syncNative({ dispatch: false });
      const result = await previousUpdateMessage(payload);
      setNativeValue("", { dispatch: false });
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
