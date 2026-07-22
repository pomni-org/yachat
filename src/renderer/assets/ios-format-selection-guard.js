(() => {
  "use strict";

  if (window.__yachatIosFormatSelectionGuardInstalled) return;

  const form = document.querySelector('[data-form="message"]');
  const textarea = form?.querySelector('[data-native-ios-message-input]');
  const toolbar = form?.querySelector('.ios-format-toolbar');
  if (!form || !textarea || !toolbar) return;

  window.__yachatIosFormatSelectionGuardInstalled = true;

  function keepTextareaSelection(event) {
    if (!event.target.closest('[data-ios-format]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // WebKit may focus the toolbar control before its bubble listener runs,
  // collapsing textarea.selectionStart/End. The formatter already saved the
  // last real range on `select`; block only the focus-changing press event.
  toolbar.addEventListener('pointerdown', keepTextareaSelection, true);
  toolbar.addEventListener('mousedown', keepTextareaSelection, true);
  toolbar.addEventListener('touchstart', keepTextareaSelection, {
    capture: true,
    passive: false
  });
})();
