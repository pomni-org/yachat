(() => {
  "use strict";

  if (window.__yachatInteractionHotfixInstalled) return;
  window.__yachatInteractionHotfixInstalled = true;

  const RELEASE_VERSION = "54";
  const FULL_QUALITY_CHAT_LOGO = `/assets/yachat-brand-1024.png?v=${RELEASE_VERSION}`;

  function installMessageTransportFix() {
    if (typeof yachatApi === "undefined" || !yachatApi?.messenger) return;

    yachatApi.messenger.send = async function sendMessageThroughPushRoute(payload = {}) {
      const authToken = localStorage.getItem("yachat-http-auth-token") || "";
      const response = await fetch("/api/message", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) {
        throw new Error(result?.detail || result?.error || `Message request failed: HTTP ${response.status}`);
      }
      return result;
    };
  }

  function installDirectorySearchFix() {
    if (typeof yachatApi === "undefined" || !yachatApi?.users) return;

    yachatApi.users.search = async function searchUsersIncludingDigitalId(query = "") {
      const authToken = localStorage.getItem("yachat-http-auth-token") || "";
      const params = new URLSearchParams({ query: String(query || "").trim() });
      const response = await fetch(`/api/users/search?${params}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) {
        throw new Error(result?.detail || result?.error || `User search failed: HTTP ${response.status}`);
      }
      return Array.isArray(result) ? result : Array.isArray(result.users) ? result.users : [];
    };
  }

  function repairChannelLogoImages(root = document) {
    root.querySelectorAll?.(".is-channel img").forEach((image) => {
      if (!image.src.includes("yachat-brand-1024.png")) {
        image.src = FULL_QUALITY_CHAT_LOGO;
      }
      image.removeAttribute("srcset");
      image.decoding = "async";
      image.style.objectFit = "contain";
      image.style.imageRendering = "auto";
      image.style.transform = "none";
    });
  }

  function installBrandQualityFix() {
    if (!document.querySelector("style[data-yachat-brand-quality]")) {
      const style = document.createElement("style");
      style.dataset.yachatBrandQuality = "";
      style.textContent = `
        .chat-avatar.is-channel img,
        .dialog-avatar.is-channel img,
        .dialog-intro-avatar.is-channel img,
        .chat-profile-avatar.is-channel img,
        .avatar-modal-image.is-channel img {
          width: 100% !important;
          height: 100% !important;
          max-width: none !important;
          max-height: none !important;
          object-fit: contain !important;
          object-position: center !important;
          image-rendering: auto !important;
          transform: none !important;
          filter: none !important;
        }
      `;
      document.head.append(style);
    }

    if (typeof chatAvatarSource === "function" && !window.__yachatFullQualityLogoSourceInstalled) {
      window.__yachatFullQualityLogoSourceInstalled = true;
      const originalChatAvatarSource = chatAvatarSource;
      chatAvatarSource = function fullQualityChatAvatarSource(chat) {
        if (chat?.id === "yachat-channel") return FULL_QUALITY_CHAT_LOGO;
        return originalChatAvatarSource(chat);
      };
    }

    repairChannelLogoImages();
    if (typeof renderChatList === "function") renderChatList();
    if (typeof renderActiveChat === "function") renderActiveChat();
    if (typeof renderPanel === "function" && typeof state !== "undefined" && state.activePanel) renderPanel();
    repairChannelLogoImages();
  }

  function installIosPickerFix() {
    const pickerForButton = (button) => button?.matches?.('[data-action="attach-file"]')
      ? document.querySelector("[data-attachment-input]")
      : button?.matches?.('[data-action="attach-document"]')
        ? document.querySelector("[data-document-input]")
        : null;

    function preparePicker(input) {
      if (!input) return;
      input.style.setProperty("display", "block", "important");
      input.style.setProperty("position", "fixed", "important");
      input.style.setProperty("left", "-10000px", "important");
      input.style.setProperty("top", "0", "important");
      input.style.setProperty("width", "1px", "important");
      input.style.setProperty("height", "1px", "important");
      input.style.setProperty("opacity", "0", "important");
      input.style.setProperty("pointer-events", "none", "important");
    }

    document.querySelectorAll("[data-attachment-input], [data-document-input]").forEach(preparePicker);

    document.addEventListener("click", (event) => {
      const button = event.target.closest?.('[data-action="attach-file"], [data-action="attach-document"]');
      const input = pickerForButton(button);
      if (!button || !input) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      try {
        if (typeof getActiveChat === "function" && typeof canSendToChat === "function" && !canSendToChat(getActiveChat())) {
          return;
        }
      } catch {
        return;
      }

      preparePicker(input);
      if (input.disabled) input.disabled = false;
      input.value = "";

      if (typeof input.showPicker === "function") {
        try {
          input.showPicker();
          return;
        } catch {
          // WebKit exposes showPicker in some versions but rejects it. The
          // synchronous click below still has the original user gesture.
        }
      }
      input.click();
    }, true);
  }

  function installIosSettingsSwitchFix() {
    if (!document.querySelector("style[data-yachat-ios-switches]")) {
      const style = document.createElement("style");
      style.dataset.yachatIosSwitches = "";
      style.textContent = `
        .settings-toggle-row {
          cursor: pointer;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
          user-select: none;
        }
        .settings-toggle-row .settings-switch {
          flex: 0 0 46px;
          pointer-events: none;
          transform: translateZ(0);
        }
        .settings-toggle-row .settings-switch::after {
          will-change: transform;
          transform: translate3d(0, 0, 0);
        }
        .settings-toggle-row input:checked + .settings-switch::after {
          transform: translate3d(18px, 0, 0);
        }
      `;
      document.head.append(style);
    }

    function toggleRow(row) {
      const input = row?.querySelector?.("input[data-settings-toggle]");
      if (!input || input.disabled) return;
      input.checked = !input.checked;
      row.setAttribute("role", "switch");
      row.setAttribute("aria-checked", input.checked ? "true" : "false");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    document.addEventListener("click", (event) => {
      const row = event.target.closest?.(".settings-toggle-row");
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(row);
    }, true);

    document.addEventListener("keydown", (event) => {
      const row = event.target.closest?.(".settings-toggle-row");
      if (!row || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(row);
    }, true);
  }

  installMessageTransportFix();
  installDirectorySearchFix();
  installBrandQualityFix();
  installIosPickerFix();
  installIosSettingsSwitchFix();

  function repairMoreLayer() {
    const panel = document.querySelector("[data-side-panel]");
    const backdrop = document.querySelector("[data-chat-more-backdrop]");
    if (!panel || !backdrop || backdrop.parentElement === panel) return;

    // The sheet lives inside the profile panel. Keeping the backdrop in body put
    // it in a higher stacking context than the sheet, so it blurred and swallowed
    // every tap. Put both layers in the same stacking context instead.
    panel.append(backdrop);
  }

  function addedRelevantLayer(record) {
    return [...record.addedNodes].some((node) => (
      node instanceof Element
      && (
        node.matches("[data-chat-more-backdrop], .is-channel")
        || node.querySelector("[data-chat-more-backdrop], .is-channel")
      )
    ));
  }

  const layerObserver = new MutationObserver((records) => {
    if (!records.some(addedRelevantLayer)) return;
    repairMoreLayer();
    repairChannelLogoImages();
  });
  layerObserver.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-panel-action='chat-profile-more']")) {
      queueMicrotask(repairMoreLayer);
      requestAnimationFrame(repairMoreLayer);
    }
  }, true);

  repairMoreLayer();

  const editor = document.querySelector("[data-rich-message-editor]");
  if (!editor) return;

  let composing = false;
  let beforeInputOffset = 0;
  let beforeInputLength = 0;
  let beforeInputType = "";
  let beforeInputData = "";
  let restoreFrame = 0;
  let restoreTimer = 0;

  function editorFocused() {
    const selection = window.getSelection();
    return document.activeElement === editor
      || Boolean(selection?.anchorNode && editor.contains(selection.anchorNode));
  }

  function plainLength() {
    return String(editor.innerText || editor.textContent || "").replace(/\r/g, "").length;
  }

  function caretOffset() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return null;
    try {
      const probe = document.createRange();
      probe.selectNodeContents(editor);
      probe.setEnd(selection.anchorNode, selection.anchorOffset);
      return probe.toString().length;
    } catch {
      return null;
    }
  }

  function restoreCaretOffset(offset) {
    if (!editorFocused() || composing) return;
    const targetOffset = Math.max(0, Math.min(Number(offset) || 0, plainLength()));
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = targetOffset;
    let node = walker.nextNode();

    while (node) {
      const length = node.nodeValue?.length || 0;
      if (remaining <= length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      remaining -= length;
      node = walker.nextNode();
    }

    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function scheduleRestore(offset) {
    queueMicrotask(() => restoreCaretOffset(offset));
    cancelAnimationFrame(restoreFrame);
    restoreFrame = requestAnimationFrame(() => restoreCaretOffset(offset));
    window.clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(() => restoreCaretOffset(offset), 40);
  }

  if (typeof refreshMessengerFromServer === "function" && !window.__yachatComposerPollingGuardInstalled) {
    window.__yachatComposerPollingGuardInstalled = true;
    const previousRefreshMessenger = refreshMessengerFromServer;
    refreshMessengerFromServer = async function refreshWithoutBreakingIosCaret(...args) {
      if (editorFocused()) return undefined;
      return previousRefreshMessenger(...args);
    };
  }

  if (typeof renderActiveChat === "function" && !window.__yachatComposerRenderGuardInstalled) {
    window.__yachatComposerRenderGuardInstalled = true;
    const previousRenderActiveChat = renderActiveChat;
    renderActiveChat = function renderActiveChatWithCaretGuard(...args) {
      const offset = editorFocused() ? caretOffset() : null;
      const result = previousRenderActiveChat(...args);
      if (offset !== null) scheduleRestore(offset);
      return result;
    };
  }

  editor.addEventListener("compositionstart", () => {
    composing = true;
  }, true);

  editor.addEventListener("compositionend", () => {
    composing = false;
    const current = caretOffset();
    if (current !== null) scheduleRestore(current);
  }, true);

  editor.addEventListener("beforeinput", (event) => {
    if (event.isComposing || composing) return;
    beforeInputOffset = caretOffset() ?? plainLength();
    beforeInputLength = plainLength();
    beforeInputType = String(event.inputType || "");
    beforeInputData = String(event.data || "");
  }, true);

  editor.addEventListener("input", (event) => {
    if (event.isComposing || composing || !beforeInputType.startsWith("insert")) return;
    const nextLength = plainLength();
    const insertedLength = Math.max(
      1,
      beforeInputData.length,
      nextLength - beforeInputLength
    );
    const expected = Math.min(nextLength, beforeInputOffset + insertedLength);
    const current = caretOffset();
    if (current === null || current < expected) scheduleRestore(expected);
  });

  editor.addEventListener("blur", () => {
    cancelAnimationFrame(restoreFrame);
    window.clearTimeout(restoreTimer);
  });
})();
