(() => {
  "use strict";

  if (window.__yachatMobileChatRuntimeInstalled) return;
  window.__yachatMobileChatRuntimeInstalled = true;

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

    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.addedNodes.length)) decorateRows();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    decorateRows();
  }

  function installEditorGeometry() {
    const form = document.querySelector('[data-form="message"]');
    const editor = form?.querySelector('[data-rich-message-editor]');
    if (!form || !(editor instanceof HTMLElement)) return;
    if (editor.dataset.yachatStableMultiline === "true") return;

    editor.dataset.yachatStableMultiline = "true";
    form.classList.add("has-stable-multiline-editor");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.setAttribute("enterkeyhint", "enter");

    if (isIos) {
      document.body.classList.add("yachat-ios-native-formatting");
      editor.dataset.iosNativeFormatting = "true";
      editor.style.setProperty("-webkit-user-select", "text");
      editor.style.setProperty("-webkit-touch-callout", "default");
    }

    let metricsFrame = 0;

    function editorText() {
      return String(editor.innerText || editor.textContent || "")
        .replace(/\u00a0/g, " ")
        .replace(/\r/g, "");
    }

    function updateMetrics() {
      metricsFrame = 0;
      if (!editor.isConnected) return;

      const computed = getComputedStyle(editor);
      const lineHeight = Number.parseFloat(computed.lineHeight) || 22;
      const verticalPadding = (Number.parseFloat(computed.paddingTop) || 0)
        + (Number.parseFloat(computed.paddingBottom) || 0);
      const singleLineHeight = lineHeight + verticalPadding + 3;
      const hasLineBreak = /\n/.test(editorText()) || Boolean(editor.querySelector("br, div, p"));
      const multiline = hasLineBreak || editor.scrollHeight > singleLineHeight;
      const scrollable = editor.scrollHeight > editor.clientHeight + 1;

      editor.classList.toggle("is-multiline", multiline);
      editor.classList.toggle("is-scrollable", scrollable);
      form.classList.toggle("has-multiline-message", multiline);
      form.classList.toggle("has-scrollable-message", scrollable);
    }

    function scheduleMetrics() {
      cancelAnimationFrame(metricsFrame);
      metricsFrame = requestAnimationFrame(updateMetrics);
    }

    ["input", "compositionend", "cut", "paste", "keyup"].forEach((name) => {
      editor.addEventListener(name, scheduleMetrics, { passive: name !== "paste" });
    });
    editor.addEventListener("scroll", scheduleMetrics, { passive: true });
    form.addEventListener("submit", () => {
      requestAnimationFrame(() => requestAnimationFrame(scheduleMetrics));
    }, true);
    window.visualViewport?.addEventListener("resize", scheduleMetrics, { passive: true });
    window.addEventListener("resize", scheduleMetrics, { passive: true });

    requestAnimationFrame(scheduleMetrics);
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

  installSettingsToggleRepair();
  installEditorGeometry();
  installMobileNavigationSync();
})();