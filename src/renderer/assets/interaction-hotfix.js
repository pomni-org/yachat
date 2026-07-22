(() => {
  "use strict";

  if (window.__yachatInteractionHotfixInstalled) return;
  window.__yachatInteractionHotfixInstalled = true;

  const RELEASE_VERSION = "53";
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

  installMessageTransportFix();
  installBrandQualityFix();

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

  let capturedRange = null;
  let composing = false;
  let restoreFrame = 0;
  let restoreTimer = 0;

  function rangeBelongsToEditor(range) {
    try {
      return Boolean(range && editor.contains(range.commonAncestorContainer));
    } catch {
      return false;
    }
  }

  function captureCaret() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (rangeBelongsToEditor(range)) capturedRange = range.cloneRange();
  }

  function restoreCaret() {
    if (composing || !capturedRange || !editor.isConnected) return;

    const selection = window.getSelection();
    const editorHasFocus = document.activeElement === editor
      || Boolean(selection?.anchorNode && editor.contains(selection.anchorNode));
    if (!selection || !editorHasFocus || !rangeBelongsToEditor(capturedRange)) return;

    try {
      selection.removeAllRanges();
      selection.addRange(capturedRange.cloneRange());
    } catch {
      capturedRange = null;
    }
  }

  function scheduleCaretRestore() {
    queueMicrotask(restoreCaret);
    cancelAnimationFrame(restoreFrame);
    restoreFrame = requestAnimationFrame(restoreCaret);
    window.clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(restoreCaret, 45);
  }

  editor.addEventListener("compositionstart", () => {
    composing = true;
  }, true);

  editor.addEventListener("compositionend", () => {
    composing = false;
    captureCaret();
    scheduleCaretRestore();
  }, true);

  // Capture phase runs after WebKit has inserted the character but before the
  // existing transport/presence listeners. The saved range is therefore the
  // exact caret position the user expects after that character.
  editor.addEventListener("input", (event) => {
    if (event.isComposing || composing) return;
    captureCaret();
  }, true);

  editor.addEventListener("input", (event) => {
    if (event.isComposing || composing) return;
    scheduleCaretRestore();
  });

  editor.addEventListener("keyup", captureCaret);
  editor.addEventListener("pointerup", captureCaret);
  editor.addEventListener("focus", captureCaret);
  editor.addEventListener("blur", () => {
    cancelAnimationFrame(restoreFrame);
    window.clearTimeout(restoreTimer);
  });
})();
