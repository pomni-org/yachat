(() => {
  "use strict";

  if (window.__yachatUiStabilityInstalled) return;
  window.__yachatUiStabilityInstalled = true;

  let reconcileTimer = 0;

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
    resetPointerState();

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
      layer.style.pointerEvents = "none";
      layer.setAttribute("aria-hidden", "true");
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
      layer.style.removeProperty("pointer-events");
      layer.removeAttribute("aria-hidden");
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

  ["pointercancel", "touchcancel", "lostpointercapture"].forEach((type) => {
    document.addEventListener(type, () => scheduleReconcile(), true);
  });
  window.addEventListener("blur", () => scheduleReconcile(), true);
  window.addEventListener("pagehide", () => scheduleReconcile(), true);
  window.addEventListener("pageshow", (event) => {
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
  window.addEventListener("error", () => scheduleReconcile(20));
  window.addEventListener("unhandledrejection", () => scheduleReconcile(20));

  const observer = new MutationObserver(() => scheduleReconcile(30));
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "style"]
  });

  scheduleReconcile();
})();
