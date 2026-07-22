(() => {
  "use strict";

  if (window.__yachatIosComposerCaretGuardInstalled) return;
  window.__yachatIosComposerCaretGuardInstalled = true;

  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/i.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  if (!isIos) return;

  const form = document.querySelector('[data-form="message"]');
  const editor = form?.querySelector('[data-rich-message-editor]');
  const emojiButton = form?.querySelector('[data-action="open-stickers"]');
  if (!form || !editor) return;

  let composing = false;
  let lastCaretOffset = 0;
  let repairFrame = 0;

  function textLength(root = editor) {
    return String(root.innerText || root.textContent || "").replace(/\r/g, "").length;
  }

  function selectionOffset() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    const prefix = document.createRange();
    prefix.selectNodeContents(editor);
    try {
      prefix.setEnd(range.endContainer, range.endOffset);
    } catch {
      return null;
    }
    return prefix.toString().replace(/\r/g, "").length;
  }

  function rangeAtOffset(offset) {
    const target = Math.max(0, Math.min(Number(offset) || 0, textLength()));
    const range = document.createRange();
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    let lastText = null;

    while (node) {
      lastText = node;
      const size = node.nodeValue?.length || 0;
      if (remaining <= size) {
        range.setStart(node, remaining);
        range.collapse(true);
        return range;
      }
      remaining -= size;
      node = walker.nextNode();
    }

    if (lastText) {
      range.setStart(lastText, lastText.nodeValue?.length || 0);
    } else {
      range.selectNodeContents(editor);
    }
    range.collapse(false);
    return range;
  }

  function rememberCaret() {
    const offset = selectionOffset();
    if (offset !== null) lastCaretOffset = offset;
  }

  function selectionIsHealthy() {
    if (document.activeElement !== editor) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    return editor.contains(range.startContainer) && editor.contains(range.endContainer);
  }

  function repairCaret() {
    repairFrame = 0;
    if (composing || !editor.isConnected || editor.getAttribute("aria-disabled") === "true") return;
    if (selectionIsHealthy()) {
      rememberCaret();
      return;
    }

    const fallback = Math.max(lastCaretOffset, textLength());
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = rangeAtOffset(fallback);
    selection?.removeAllRanges();
    selection?.addRange(range);
    lastCaretOffset = selectionOffset() ?? fallback;
  }

  function scheduleRepair() {
    cancelAnimationFrame(repairFrame);
    queueMicrotask(repairCaret);
    repairFrame = requestAnimationFrame(repairCaret);
  }

  editor.addEventListener("beforeinput", rememberCaret, true);
  editor.addEventListener("input", scheduleRepair, true);
  editor.addEventListener("keyup", rememberCaret, true);
  editor.addEventListener("pointerup", rememberCaret, true);
  editor.addEventListener("compositionstart", () => { composing = true; }, true);
  editor.addEventListener("compositionend", () => {
    composing = false;
    rememberCaret();
    scheduleRepair();
  }, true);

  document.addEventListener("selectionchange", () => {
    if (document.activeElement === editor) rememberCaret();
  });

  if (emojiButton) {
    emojiButton.hidden = true;
    emojiButton.disabled = true;
    emojiButton.tabIndex = -1;
    emojiButton.setAttribute("aria-hidden", "true");
    form.classList.add("is-ios-native-emoji-only");
  }

  requestAnimationFrame(() => {
    rememberCaret();
    if (document.activeElement === editor) repairCaret();
  });
})();
