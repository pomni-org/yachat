(() => {
  "use strict";

  if (window.__yachatComposerEnterStableInstalled) return;

  const form = document.querySelector('[data-form="message"]');
  const editor = form?.querySelector('[data-rich-message-editor]');
  if (!form || !editor || form.querySelector('[data-native-ios-message-input]')) return;

  window.__yachatComposerEnterStableInstalled = true;
  form.dataset.yachatComposerEnter = "explicit-line-break-v2";

  function editorRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range : null;
  }

  function insertLineBreak() {
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    const activeRange = editorRange();
    const range = activeRange || document.createRange();

    if (!activeRange) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }

    range.deleteContents();
    const lineBreak = document.createElement("br");
    range.insertNode(lineBreak);
    range.setStartAfter(lineBreak);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertLineBreak",
      data: null
    }));
    try {
      form.__yachatSyncRichEditor?.({ dispatch: true });
    } catch {}
  }

  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (form.querySelector(".message-mention-strip:not([hidden])")) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    insertLineBreak();
  }, true);
})();
