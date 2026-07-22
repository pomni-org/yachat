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
  let expectedCaretOffset = 0;
  let beforeInputLength = 0;
  let repairFrame = 0;

  function editorText() {
    return String(editor.innerText || editor.textContent || "").replace(/\r/g, "");
  }

  function textLength() {
    return editorText().length;
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
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ALL, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (node.nodeType === Node.ELEMENT_NODE && node.nodeName === "BR") return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    let remaining = target;
    let node = walker.nextNode();
    let lastNode = null;

    while (node) {
      lastNode = node;
      const size = node.nodeType === Node.TEXT_NODE ? (node.nodeValue?.length || 0) : 1;
      if (remaining <= size) {
        if (node.nodeType === Node.TEXT_NODE) {
          range.setStart(node, Math.min(remaining, size));
        } else if (remaining === 0) {
          range.setStartBefore(node);
        } else {
          range.setStartAfter(node);
        }
        range.collapse(true);
        return range;
      }
      remaining -= size;
      node = walker.nextNode();
    }

    if (lastNode) range.setStartAfter(lastNode);
    else range.selectNodeContents(editor);
    range.collapse(false);
    return range;
  }

  function rememberCaret() {
    const offset = selectionOffset();
    if (offset === null) return;
    lastCaretOffset = offset;
    expectedCaretOffset = offset;
  }

  function selectionIsHealthy() {
    if (document.activeElement !== editor) return false;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    return editor.contains(range.startContainer) && editor.contains(range.endContainer);
  }

  function expectedOffsetAfterInput(event) {
    const currentLength = textLength();
    const lengthDelta = currentLength - beforeInputLength;
    const inputType = String(event?.inputType || "");

    if (inputType.startsWith("deleteContentBackward")) return Math.max(0, lastCaretOffset - 1);
    if (inputType.startsWith("delete")) return Math.max(0, Math.min(lastCaretOffset, currentLength));
    if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
      return Math.min(currentLength, lastCaretOffset + Math.max(1, lengthDelta));
    }
    if (inputType.startsWith("insert")) {
      return Math.min(currentLength, lastCaretOffset + Math.max(0, lengthDelta));
    }
    return Math.min(currentLength, Math.max(lastCaretOffset, lastCaretOffset + lengthDelta));
  }

  function repairCaret() {
    repairFrame = 0;
    if (composing || !editor.isConnected || editor.getAttribute("aria-disabled") === "true") return;
    if (selectionIsHealthy()) {
      rememberCaret();
      return;
    }

    const fallback = Math.max(0, Math.min(expectedCaretOffset, textLength()));
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = rangeAtOffset(fallback);
    selection?.removeAllRanges();
    selection?.addRange(range);
    lastCaretOffset = selectionOffset() ?? fallback;
    expectedCaretOffset = lastCaretOffset;
  }

  function scheduleRepair() {
    cancelAnimationFrame(repairFrame);
    queueMicrotask(repairCaret);
    repairFrame = requestAnimationFrame(repairCaret);
  }

  function insertLineBreakFallback(offset) {
    if (!selectionIsHealthy()) {
      expectedCaretOffset = offset;
      repairCaret();
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    range.deleteContents();
    const lineBreak = document.createElement("br");
    range.insertNode(lineBreak);
    range.setStartAfter(lineBreak);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    lastCaretOffset = Math.min(textLength(), offset + 1);
    expectedCaretOffset = lastCaretOffset;
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertLineBreak",
      data: null
    }));
  }

  editor.addEventListener("beforeinput", () => {
    rememberCaret();
    beforeInputLength = textLength();
  }, true);

  editor.addEventListener("input", (event) => {
    expectedCaretOffset = expectedOffsetAfterInput(event);
    if (selectionIsHealthy()) rememberCaret();
    else scheduleRepair();
  }, true);

  editor.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || composing) return;
    const htmlBefore = editor.innerHTML;
    const lengthBefore = textLength();
    const offsetBefore = selectionOffset() ?? lastCaretOffset;
    requestAnimationFrame(() => {
      if (event.defaultPrevented || composing || !editor.isConnected) return;
      const browserChangedEditor = editor.innerHTML !== htmlBefore
        || textLength() !== lengthBefore
        || (selectionOffset() ?? offsetBefore) !== offsetBefore;
      if (!browserChangedEditor) insertLineBreakFallback(offsetBefore);
    });
  }, true);

  editor.addEventListener("keyup", rememberCaret, true);
  editor.addEventListener("pointerup", rememberCaret, true);
  editor.addEventListener("compositionstart", () => {
    composing = true;
    rememberCaret();
    beforeInputLength = textLength();
  }, true);
  editor.addEventListener("compositionend", () => {
    composing = false;
    expectedCaretOffset = Math.min(textLength(), Math.max(lastCaretOffset, lastCaretOffset + textLength() - beforeInputLength));
    if (selectionIsHealthy()) rememberCaret();
    else scheduleRepair();
  }, true);

  document.addEventListener("selectionchange", () => {
    if (document.activeElement === editor) rememberCaret();
  });

  if (!document.querySelector("style[data-yachat-ios-composer-caret-guard]")) {
    const style = document.createElement("style");
    style.dataset.yachatIosComposerCaretGuard = "";
    style.textContent = `
      .composer.is-ios-native-emoji-only [data-action="open-stickers"] {
        display: none !important;
        pointer-events: none !important;
      }
      .composer.is-ios-native-emoji-only .composer-bottom-row > .message-editor {
        padding-right: 17px !important;
      }
    `;
    document.head.append(style);
  }

  if (emojiButton) {
    emojiButton.hidden = true;
    emojiButton.disabled = true;
    emojiButton.tabIndex = -1;
    emojiButton.setAttribute("aria-hidden", "true");
    emojiButton.style.setProperty("display", "none", "important");
    form.classList.add("is-ios-native-emoji-only");
  }

  requestAnimationFrame(() => {
    rememberCaret();
    if (document.activeElement === editor) repairCaret();
  });
})();
