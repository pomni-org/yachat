(() => {
  "use strict";

  if (window.__yachatUiStabilityInstalled) return;
  window.__yachatUiStabilityInstalled = true;

  const optimizedRefresh = typeof refreshMessengerFromServer === "function"
    ? refreshMessengerFromServer
    : null;
  const ACTIVE_POLL_MS = 1200;
  const IDLE_POLL_MS = 8000;
  const BACKGROUND_POLL_MS = 30000;
  const layerObservers = [];
  const observedLayers = new WeakSet();
  let reconcileTimer = 0;
  let bodyObserver = null;

  const RECOVERY_UI_SELECTOR = [
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

  function scheduleReconcile(delay = 0) {
    window.clearTimeout(reconcileTimer);
    reconcileTimer = window.setTimeout(reconcileUi, delay);
  }

  function observeRecoveryLayers() {
    document.querySelectorAll(RECOVERY_UI_SELECTOR).forEach((layer) => {
      if (observedLayers.has(layer)) return;
      observedLayers.add(layer);

      const observer = new MutationObserver(() => scheduleReconcile(24));
      observer.observe(layer, {
        attributes: true,
        attributeFilter: ["hidden", "class", "style"],
        childList: layer.matches("[data-message-menu], [data-forward-picker], [data-chat-profile-more]")
      });
      layerObservers.push(observer);
    });
  }

  function reconcileUi() {
    reconcileTimer = 0;
    observeRecoveryLayers();

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
      if (messageLayer.style.pointerEvents !== "none") messageLayer.style.pointerEvents = "none";
    }

    const forwardPicker = document.querySelector("[data-forward-picker]");
    if (forwardPicker && typeof state !== "undefined" && !state.forwardMessage) {
      forwardPicker.hidden = true;
      if (forwardPicker.style.pointerEvents !== "none") forwardPicker.style.pointerEvents = "none";
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
      if (layer.style.pointerEvents !== "none") layer.style.pointerEvents = "none";
      if (layer.getAttribute("aria-hidden") !== "true") layer.setAttribute("aria-hidden", "true");
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
      if (layer.style.pointerEvents) layer.style.removeProperty("pointer-events");
      if (layer.hasAttribute("aria-hidden")) layer.removeAttribute("aria-hidden");
    });

    if (document.body.style.pointerEvents === "none") document.body.style.removeProperty("pointer-events");
    if (document.documentElement.style.pointerEvents === "none") document.documentElement.style.removeProperty("pointer-events");
  }

  function stableMessengerPollDelay() {
    if (document.visibilityState !== "visible") return BACKGROUND_POLL_MS;
    return typeof activeChatIsVisible === "function" && activeChatIsVisible()
      ? ACTIVE_POLL_MS
      : IDLE_POLL_MS;
  }

  function enforceOptimizedRuntime() {
    if (optimizedRefresh && window.__yachatChatLoadOptimizationInstalled) {
      refreshMessengerFromServer = optimizedRefresh;
    }
    messengerPollDelay = stableMessengerPollDelay;

    document.documentElement.dataset.yachatRuntimeGuard = "optimized-refresh-v2";
    document.documentElement.dataset.yachatActivePollMs = String(ACTIVE_POLL_MS);

    if (
      typeof state !== "undefined"
      && state.account
      && typeof stopMessengerPolling === "function"
      && typeof startMessengerPolling === "function"
    ) {
      stopMessengerPolling();
      startMessengerPolling();
    }
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

  window.addEventListener("pagehide", resetPointerState, true);
  window.addEventListener("pageshow", (event) => {
    resetPointerState();
    scheduleReconcile();
    if (event.persisted && typeof state !== "undefined" && state.account) {
      Promise.resolve(refreshMessengerFromServer?.())
        .catch(() => {})
        .finally(() => startMessengerPolling?.());
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") resetPointerState();
    else scheduleReconcile(25);
  });

  window.addEventListener("error", () => {
    resetPointerState();
    scheduleReconcile(20);
  });
  window.addEventListener("unhandledrejection", () => {
    resetPointerState();
    scheduleReconcile(20);
  });

  bodyObserver = new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList")) observeRecoveryLayers();
    scheduleReconcile(30);
  });
  bodyObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "style"],
    childList: true
  });

  observeRecoveryLayers();
  scheduleReconcile();
  window.setTimeout(enforceOptimizedRuntime, 0);
  window.setTimeout(enforceOptimizedRuntime, 250);
})();
