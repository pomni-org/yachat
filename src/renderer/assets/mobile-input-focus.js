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
})();
