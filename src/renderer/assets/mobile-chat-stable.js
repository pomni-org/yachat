(() => {
  "use strict";

  if (window.__yachatMobileChatStableInstalled) return;
  window.__yachatMobileChatStableInstalled = true;

  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);

  function installSettingsToggleRepair() {
    if (!isIos) return;

    let pointerGesture = null;
    let suppressClickUntil = 0;
    let suppressClickRow = null;

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

    if (typeof renderPanel === "function" && !renderPanel.__yachatIosToggleRows) {
      const originalRenderPanel = renderPanel;
      renderPanel = function renderPanelWithIosToggleRows(...args) {
        const result = originalRenderPanel.apply(this, args);
        queueMicrotask(() => decorateRows(typeof panelBody !== "undefined" ? panelBody : document));
        return result;
      };
      Object.defineProperty(renderPanel, "__yachatIosToggleRows", { value: true });
    }

    document.addEventListener("click", (event) => {
      if (event.target.closest?.('[data-rail="settings"], [data-panel-action]')) {
        queueMicrotask(() => decorateRows(typeof panelBody !== "undefined" ? panelBody : document));
      }
    }, true);
    decorateRows();
  }

  function syncMobileNavigationState() {
    let open = false;
    try { open = Boolean(state?.mobileDialogOpen); } catch {}
    document.body.classList.toggle("yachat-mobile-chat-view", open);
  }

  function installMobileNavigationSync() {
    syncMobileNavigationState();

    ["renderActiveChat", "renderChatList"].forEach((name) => {
      const current = globalThis[name];
      if (typeof current !== "function" || current.__yachatMobileNavigationSync) return;
      const wrapped = function mobileNavigationSyncedRender(...args) {
        const result = current.apply(this, args);
        queueMicrotask(syncMobileNavigationState);
        return result;
      };
      Object.defineProperty(wrapped, "__yachatMobileNavigationSync", { value: true });
      globalThis[name] = wrapped;
    });

    document.addEventListener("click", () => queueMicrotask(syncMobileNavigationState), true);
    window.addEventListener("popstate", syncMobileNavigationState);
  }

  function installMobileChatVisibilityGuard() {
    if (typeof activeChatIsVisible !== "function" || activeChatIsVisible.__yachatMobileVisibilityGuard) {
      return;
    }

    const originalActiveChatIsVisible = activeChatIsVisible;
    const guarded = function activeChatVisibleWithMobileState() {
      if (originalActiveChatIsVisible()) {
        return true;
      }

      const mobileViewport = window.matchMedia?.("(max-width: 820px)")?.matches
        || window.innerWidth <= 820;
      if (!mobileViewport || document.visibilityState !== "visible") {
        return false;
      }

      let mobileDialogOpen = false;
      let activeChatId = "";
      let account = null;
      let activePanel = null;
      try {
        mobileDialogOpen = Boolean(state?.mobileDialogOpen);
        activeChatId = String(state?.activeChatId || "");
        account = state?.account || null;
        activePanel = state?.activePanel || null;
      } catch {
        return false;
      }

      const shell = document.querySelector("[data-messenger]");
      return Boolean(
        account
        && activeChatId
        && mobileDialogOpen
        && !activePanel
        && shell
        && !shell.hidden
        && !document.body.classList.contains("app-booting")
      );
    };

    Object.defineProperty(guarded, "__yachatMobileVisibilityGuard", { value: true });
    activeChatIsVisible = guarded;
  }

  installSettingsToggleRepair();
  installMobileNavigationSync();
  installMobileChatVisibilityGuard();
})();
