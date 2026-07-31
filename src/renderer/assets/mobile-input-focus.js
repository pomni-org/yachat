(() => {
  "use strict";

  if (window.__yachatMobileInputFocusInstalled) return;
  window.__yachatMobileInputFocusInstalled = true;

  const FIELD_SHELL = [
    ".auth-form label",
    ".modal-field",
    ".search-field",
    ".device-code-input-shell",
    ".report-reason-field",
    ".settings-field",
    ".profile-field",
    ".composer"
  ].join(",");
  const CONTROL = [
    "input:not([type='hidden']):not(:disabled)",
    "textarea:not(:disabled)",
    "select:not(:disabled)",
    "[contenteditable='true']"
  ].join(",");
  const LEADING_BOUNDARY_BREAKS = /^(?:[^\S\r\n]*(?:\r\n|\r|\n))+/;
  const TRAILING_BOUNDARY_BREAKS = /(?:(?:\r\n|\r|\n)[^\S\r\n]*)+$/;

  function normalizeMessageBoundaryBreaks(value) {
    const normalized = String(value ?? "")
      .replace(LEADING_BOUNDARY_BREAKS, "")
      .replace(TRAILING_BOUNDARY_BREAKS, "");
    return normalized.trim() ? normalized : "";
  }

  function focusControl(target) {
    if (!(target instanceof Element)) return;
    if (target.closest("button, a, [role='button']")) return;
    if (target.matches(CONTROL)) return;
    const shell = target.closest(FIELD_SHELL);
    const control = shell?.querySelector(CONTROL);
    if (!(control instanceof HTMLElement) || control === document.activeElement) return;
    control.focus({ preventScroll: true });
  }

  document.addEventListener("pointerup", (event) => {
    if (event.pointerType && event.pointerType !== "touch" && event.pointerType !== "pen") return;
    focusControl(event.target);
  }, true);

  document.addEventListener("touchend", (event) => {
    focusControl(event.target);
  }, { capture: true, passive: true });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest?.('[data-form="message"]');
    const input = form?.querySelector?.("[data-message-input]");
    if (!input || typeof input.value !== "string") return;
    const normalized = normalizeMessageBoundaryBreaks(input.value);
    if (input.value !== normalized) input.value = normalized;
  }, true);

  window.yachatMessageBoundaryBreaks = Object.freeze({
    normalize: normalizeMessageBoundaryBreaks
  });
})();
