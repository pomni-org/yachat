(() => {
  "use strict";

  if (window.__yachatComposerEnterStableInstalled) return;

  const form = document.querySelector('[data-form="message"]');
  const editor = form?.querySelector('[data-rich-message-editor]');
  const transport = form?.querySelector('[data-message-input]');
  if (!form || !editor || !transport || form.querySelector('[data-native-ios-message-input]')) return;

  window.__yachatComposerEnterStableInstalled = true;
  form.dataset.yachatComposerEnter = "explicit-line-break-v4";

  // A text input silently removes line breaks from assigned values. The rich
  // editor is the visible control, so its transport can safely become hidden
  // while retaining the same DOM node and application reference.
  if (transport instanceof HTMLInputElement) transport.type = "hidden";

  const originalSync = form.__yachatSyncRichEditor;

  function isSentinel(node) {
    return node?.nodeType === Node.ELEMENT_NODE
      && node.matches?.('br[data-yachat-caret-sentinel]');
  }

  function removeSentinels() {
    editor.querySelectorAll('br[data-yachat-caret-sentinel]').forEach((node) => node.remove());
  }

  function textWithoutSentinels() {
    const parts = [];

    function append(value) {
      parts.push(String(value || ""));
    }

    function endsWithNewline() {
      return (parts[parts.length - 1] || "").endsWith("\n");
    }

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        append(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || isSentinel(node)) return;
      if (node.tagName === "BR") {
        append("\n");
        return;
      }

      const block = node.tagName === "DIV" || node.tagName === "P";
      if (block && parts.length && !endsWithNewline()) append("\n");
      [...node.childNodes].forEach(walk);
      if (block && parts.length && !endsWithNewline()) append("\n");
    }

    [...editor.childNodes].forEach(walk);
    return parts.join("").replace(/\u00a0/g, " ").replace(/\r/g, "");
  }

  function syncTransport({ dispatch = true } = {}) {
    try { originalSync?.({ dispatch: false }); } catch {}
    const text = textWithoutSentinels();
    const changed = transport.value !== text;
    if (changed) transport.value = text;
    if (changed && dispatch) transport.dispatchEvent(new Event("input", { bubbles: true }));
    return text;
  }

  form.__yachatSyncRichEditor = syncTransport;

  function editorRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range : null;
  }

  function rangeIsAtEnd(range) {
    const tail = document.createRange();
    tail.selectNodeContents(editor);
    try {
      tail.setStart(range.endContainer, range.endOffset);
    } catch {
      return true;
    }
    const fragment = tail.cloneContents();
    const text = String(fragment.textContent || "").replace(/\u200b/g, "");
    const meaningfulElement = [...fragment.querySelectorAll("br, img, video, figure, a")]
      .some((node) => !isSentinel(node));
    return !text && !meaningfulElement;
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

    const atEnd = rangeIsAtEnd(range);
    removeSentinels();
    range.deleteContents();

    const lineBreak = document.createElement("br");
    range.insertNode(lineBreak);

    if (atEnd) {
      const sentinel = document.createElement("br");
      sentinel.dataset.yachatCaretSentinel = "";
      lineBreak.after(sentinel);
      range.setStartBefore(sentinel);
    } else {
      range.setStartAfter(lineBreak);
    }
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertLineBreak",
      data: null
    }));
    syncTransport({ dispatch: true });
  }

  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (form.querySelector(".message-mention-strip:not([hidden])")) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    insertLineBreak();
  }, true);

  editor.addEventListener("input", (event) => {
    if (event.inputType !== "insertLineBreak") removeSentinels();
    syncTransport({ dispatch: true });
  });
})();
