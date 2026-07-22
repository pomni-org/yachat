(() => {
  "use strict";

  if (window.__yachatIosFormatSelectionGuardInstalled) return;

  const form = document.querySelector('[data-form="message"]');
  const textarea = form?.querySelector('[data-native-ios-message-input]');
  const toolbar = form?.querySelector('.ios-format-toolbar');
  if (!form || !textarea || !toolbar) return;

  window.__yachatIosFormatSelectionGuardInstalled = true;
  let suppressSelectionChangeUntil = 0;

  function keepTextareaSelection(event) {
    if (!event.target.closest('[data-ios-format]')) return;
    suppressSelectionChangeUntil = performance.now() + 750;
    event.preventDefault();
  }

  // WebKit may collapse textarea.selectionStart/End between a toolbar press
  // and its click. Preserve the formatter's last real range during that small
  // window, while still allowing the formatter's own pointer and click logic.
  toolbar.addEventListener('pointerdown', keepTextareaSelection, true);
  toolbar.addEventListener('mousedown', keepTextareaSelection, true);
  toolbar.addEventListener('touchstart', keepTextareaSelection, {
    capture: true,
    passive: false
  });

  document.addEventListener('selectionchange', (event) => {
    if (performance.now() >= suppressSelectionChangeUntil) return;
    event.stopImmediatePropagation();
  }, true);
})();
