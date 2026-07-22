(() => {
  "use strict";

  if (window.__yachatUiStabilityInstalled) return;
  window.__yachatUiStabilityInstalled = true;

  let reconcileTimer = 0;

  const RECOVERY_UI_SELECTOR = [
    "body",
    "[data-side-panel]",
    "[data-message-menu-layer]",
    "[data-message-menu]",
    "[data-forward-picker]",
    "[data-chat-more-backdrop]",
    "[data-chat-profile-more]",
    "[data-avatar-crop-modal]",
    "[data-avatar-modal]",
    "[data-info-modal]",
    "[data-delete-profile-modal]",
    "[data-create-chat-modal]",
    ".group-flow-layer"
  ].join(",");

  function visible(element) {
    if (!element || element.hidden || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
  }

  function resetPointerState() {
    if (typeof state !== "undefined") {
      window.clearTimeout(state.messagePressTimer);
      state.messagePressTimer = null;
      state.messagePressStart = null;
      state.ignoreNextMessageClick = false;
      if (state.avatarCrop) {
        state.avatarCrop.dragging = false;
        state.avatarCrop.dragStart = null;
      }
    }

    document.querySelectorAll("[data-avatar-crop-frame]").forEach((frame) => {
      frame.classList.remove("is-dragging");
    });
    document.body.classList.remove("pointer-dragging", "touch-dragging");
  }

  function reconcileUi() {
    reconcileTimer = 0;

    const groupFlow = document.querySelector(".group-flow-layer:not([hidden])");
    if (!visible(groupFlow)) document.body.classList.remove("group-creation-open");

    const panel = document.querySelector("[data-side-panel]");
    const chatPanelOpen = visible(panel)
      && typeof state !== "undefined"
      && state.activePanel === "chat";
    if (!chatPanelOpen) document.body.classList.remove("chat-profile-open");

    const messageLayer = document.querySelector("[data-message-menu-layer]");
    const messageMenu = document.querySelector("[data-message-menu]");
    if (messageLayer && (!visible(messageMenu) || !messageMenu.children.length)) {
      messageLayer.hidden = true;
      messageLayer.style.pointerEvents = "none";
    }

    const forwardPicker = document.querySelector("[data-forward-picker]");
    if (forwardPicker && typeof state !== "undefined" && !state.forwardMessage) {
      forwardPicker.hidden = true;
      forwardPicker.style.pointerEvents = "none";
    }

    const moreBackdrop = document.querySelector("[data-chat-more-backdrop]");
    const moreSheet = document.querySelector("[data-chat-profile-more].is-open");
    if (!visible(moreBackdrop) || !visible(moreSheet)) {
      document.body.classList.remove("chat-more-open");
    }

    document.querySelectorAll([
      "[data-avatar-crop-modal][hidden]",
      "[data-avatar-modal][hidden]",
      "[data-info-modal][hidden]",
      "[data-delete-profile-modal][hidden]",
      "[data-create-chat-modal][hidden]",
      "[data-forward-picker][hidden]",
      "[data-message-menu-layer][hidden]",
      ".group-flow-layer[hidden]"
    ].join(",")).forEach((layer) => {
      if (layer.style.pointerEvents !== "none") {
        layer.style.pointerEvents = "none";
      }
      if (layer.getAttribute("aria-hidden") !== "true") {
        layer.setAttribute("aria-hidden", "true");
      }
    });

    document.querySelectorAll([
      "[data-avatar-crop-modal]:not([hidden])",
      "[data-avatar-modal]:not([hidden])",
      "[data-info-modal]:not([hidden])",
      "[data-delete-profile-modal]:not([hidden])",
      "[data-create-chat-modal]:not([hidden])",
      "[data-forward-picker]:not([hidden])",
      "[data-message-menu-layer]:not([hidden])",
      ".group-flow-layer:not([hidden])"
    ].join(",")).forEach((layer) => {
      if (layer.style.pointerEvents) {
        layer.style.removeProperty("pointer-events");
      }
      if (layer.hasAttribute("aria-hidden")) {
        layer.removeAttribute("aria-hidden");
      }
    });

    if (document.body.style.pointerEvents === "none") {
      document.body.style.removeProperty("pointer-events");
    }
    if (document.documentElement.style.pointerEvents === "none") {
      document.documentElement.style.removeProperty("pointer-events");
    }
  }

  function scheduleReconcile(delay = 0) {
    window.clearTimeout(reconcileTimer);
    reconcileTimer = window.setTimeout(reconcileUi, delay);
  }

  function nodeTouchesRecoveryUi(node) {
    if (!(node instanceof Element)) return false;
    return node.matches(RECOVERY_UI_SELECTOR) || Boolean(node.querySelector(RECOVERY_UI_SELECTOR));
  }

  function mutationNeedsRecovery(records) {
    return records.some((record) => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;

      // Text entry must be left completely alone. On iOS, global DOM work during a
      // contenteditable input event can collapse the caret to the start of the field.
      if (target?.closest("[data-form='message'], [data-rich-message-editor]")) {
        return false;
      }

      if (record.type === "attributes") {
        return Boolean(target?.matches(RECOVERY_UI_SELECTOR) || target?.closest(RECOVERY_UI_SELECTOR));
      }

      return [...record.addedNodes, ...record.removedNodes].some(nodeTouchesRecoveryUi);
    });
  }

  ["pointercancel", "touchcancel", "lostpointercapture"].forEach((type) => {
    document.addEventListener(type, () => {
      resetPointerState();
      scheduleReconcile();
    }, true);
  });
  window.addEventListener("blur", () => {
    resetPointerState();
    scheduleReconcile();
  }, true);
  window.addEventListener("pagehide", () => {
    resetPointerState();
    scheduleReconcile();
  }, true);
  window.addEventListener("pageshow", (event) => {
    resetPointerState();
    scheduleReconcile();
    if (event.persisted && typeof state !== "undefined" && state.account) {
      try {
        renderChatList?.();
        renderActiveChat?.();
        renderMessages?.();
        if (state.activePanel) renderPanel?.();
      } catch {
        // Recovery continues with a server refresh below.
      }
      Promise.resolve(refreshMessengerFromServer?.())
        .catch(() => {})
        .finally(() => startMessengerPolling?.());
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      resetPointerState();
    } else {
      scheduleReconcile(25);
    }
  });
  window.addEventListener("error", () => {
    resetPointerState();
    scheduleReconcile(20);
  });
  window.addEventListener("unhandledrejection", () => {
    resetPointerState();
    scheduleReconcile(20);
  });

  const observer = new MutationObserver((records) => {
    if (mutationNeedsRecovery(records)) scheduleReconcile(30);
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "style"]
  });

  scheduleReconcile();
})();