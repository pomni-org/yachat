(() => {
  "use strict";

  if (window.__yachatInteractionHotfixInstalled) return;
  window.__yachatInteractionHotfixInstalled = true;

  function repairMoreLayer() {
    const panel = document.querySelector("[data-side-panel]");
    const backdrop = document.querySelector("[data-chat-more-backdrop]");
    if (!panel || !backdrop || backdrop.parentElement === panel) return;

    // The sheet lives inside the profile panel. Keeping the backdrop in body put
    // it in a higher stacking context than the sheet, so it blurred and swallowed
    // every tap. Put both layers in the same stacking context instead.
    panel.append(backdrop);
  }

  function addedMoreLayer(record) {
    return [...record.addedNodes].some((node) => (
      node instanceof Element
      && (node.matches("[data-chat-more-backdrop]") || node.querySelector("[data-chat-more-backdrop]"))
    ));
  }

  const layerObserver = new MutationObserver((records) => {
    if (records.some(addedMoreLayer)) repairMoreLayer();
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