(() => {
  "use strict";

  if (
    typeof messageInput === "undefined" ||
    typeof messageForm === "undefined" ||
    !(messageInput instanceof HTMLInputElement) ||
    !messageForm
  ) {
    return;
  }

  const transport = messageInput;
  const editor = document.createElement("div");
  let submittedHtml = "";
  let toolbar = null;
  let savedRange = null;

  const allowedTags = new Set(["STRONG", "EM", "U", "S", "CODE", "A", "BR"]);
  const aliases = new Map([
    ["B", "STRONG"],
    ["I", "EM"],
    ["DEL", "S"]
  ]);

  function safeUrl(value) {
    const source = String(value || "").trim();
    if (!source) return "";
    const prepared = /^[a-z][a-z0-9+.-]*:/i.test(source) ? source : `https://${source}`;
    try {
      const url = new URL(prepared, window.location.origin);
      return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function sanitizeHtml(value) {
    const template = document.createElement("template");
    template.innerHTML = String(value || "").slice(0, 24000);
    const output = document.createElement("div");

    function appendNode(node, parent) {
      if (node.nodeType === Node.TEXT_NODE) {
        parent.append(document.createTextNode(node.nodeValue || ""));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const originalTag = node.tagName.toUpperCase();
      const tag = aliases.get(originalTag) || originalTag;

      if (tag === "BR") {
        parent.append(document.createElement("br"));
        return;
      }

      if (originalTag === "DIV" || originalTag === "P") {
        if (parent.childNodes.length && parent.lastChild?.nodeName !== "BR") {
          parent.append(document.createElement("br"));
        }
        [...node.childNodes].forEach((child) => appendNode(child, parent));
        if (parent.lastChild?.nodeName !== "BR") {
          parent.append(document.createElement("br"));
        }
        return;
      }

      if (!allowedTags.has(tag)) {
        [...node.childNodes].forEach((child) => appendNode(child, parent));
        return;
      }

      const element = document.createElement(tag.toLowerCase());
      if (tag === "A") {
        const href = safeUrl(node.getAttribute("href"));
        if (!href) {
          [...node.childNodes].forEach((child) => appendNode(child, parent));
          return;
        }
        element.href = href;
        element.target = "_blank";
        element.rel = "noopener noreferrer";
      }
      [...node.childNodes].forEach((child) => appendNode(child, element));
      parent.append(element);
    }

    [...template.content.childNodes].forEach((node) => appendNode(node, output));
    while (output.lastChild?.nodeName === "BR") output.lastChild.remove();
    return output.innerHTML;
  }

  function plainTextFromHtml(value) {
    const container = document.createElement("div");
    container.innerHTML = sanitizeHtml(value);
    return String(container.innerText || container.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function currentHtml() {
    return sanitizeHtml(editor.innerHTML);
  }

  function currentText() {
    return plainTextFromHtml(editor.innerHTML);
  }

  function syncTransport() {
    transport.value = currentText();
    transport.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function clearEditor(sync = true) {
    editor.replaceChildren();
    if (sync) syncTransport();
  }

  function setEditor(text = "", formattedHtml = "") {
    const html = sanitizeHtml(formattedHtml);
    if (html) editor.innerHTML = html;
    else editor.textContent = String(text || "");
    syncTransport();
  }

  function moveCaretToEnd() {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function syncReadonly() {
    const readonly = transport.disabled || messageForm.classList.contains("is-readonly");
    editor.contentEditable = readonly ? "false" : "true";
    editor.setAttribute("aria-disabled", readonly ? "true" : "false");
    editor.dataset.placeholder = transport.placeholder || "Сообщение";
    editor.setAttribute("aria-label", editor.dataset.placeholder);
  }

  function enhancePhotoCards() {
    const policy = document.querySelector("[data-attachment-policy]");
    if (policy) {
      policy.hidden = true;
      policy.textContent = "";
    }

    document.querySelectorAll("[data-attachment-tray] .attachment-preview").forEach((card) => {
      if (!card.querySelector(".attachment-preview-media img")) return;
      card.classList.add("is-photo");
      card.querySelector(".attachment-preview-copy")?.remove();
      card.querySelector(".attachment-preview-delete")?.remove();
    });
  }

  function messageByBubble(bubble) {
    try {
      return typeof getMessageById === "function" ? getMessageById(bubble.dataset.messageId) : null;
    } catch {
      return null;
    }
  }

  function enhanceRenderedMessages() {
    const list = document.querySelector("[data-message-list]");
    if (!list) return;

    list.querySelectorAll(".message-bubble[data-message-id]").forEach((bubble) => {
      const message = messageByBubble(bubble);
      const textElement = bubble.querySelector(":scope > p, :scope > .message-text");
      if (textElement) {
        textElement.classList.add("message-text");
        const rich = sanitizeHtml(message?.formattedHtml || "");
        if (rich) textElement.innerHTML = rich;
        else textElement.innerHTML = escapeHtml(message?.text || "").replace(/\n/g, "<br>");
      }

      const attachments = [...bubble.querySelectorAll(":scope > .message-attachment")];
      attachments.forEach((attachment) => {
        const image = attachment.querySelector("img");
        if (image) {
          attachment.querySelector("figcaption")?.remove();
          attachment.dataset.photoView = "";
          attachment.dataset.avatarSrc = image.currentSrc || image.src || "";
          attachment.dataset.avatarTitle = "Фото";
          attachment.setAttribute("role", "button");
          attachment.setAttribute("tabindex", "0");
          attachment.setAttribute("aria-label", "Открыть фото");
          image.alt = "Фото";
        }
        if (textElement) bubble.insertBefore(attachment, textElement);
      });
    });
  }

  function ensureToolbar() {
    if (toolbar?.isConnected) return toolbar;
    toolbar = document.createElement("div");
    toolbar.className = "rich-selection-toolbar";
    toolbar.hidden = true;
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Форматирование");
    toolbar.innerHTML = `
      <button type="button" data-rich-command="bold" aria-label="Жирный"><strong>Ж</strong></button>
      <button type="button" data-rich-command="italic" aria-label="Курсив"><em>К</em></button>
      <button type="button" data-rich-command="underline" aria-label="Подчёркнутый"><u>П</u></button>
      <button type="button" data-rich-command="strikeThrough" aria-label="Зачёркнутый"><s>З</s></button>
      <button type="button" data-rich-command="createLink" aria-label="Ссылка">↗</button>
    `;
    document.body.append(toolbar);

    toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
    toolbar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-rich-command]");
      if (!button || !savedRange) return;

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(savedRange);
      editor.focus({ preventScroll: true });

      const command = button.dataset.richCommand;
      if (command === "createLink") {
        const raw = window.prompt("Вставьте ссылку");
        if (!raw) return hideToolbar();
        const url = safeUrl(raw);
        if (!url) {
          window.yachatFeedback?.show?.("Ссылка не распознана", { tone: "error", icon: "circle-alert" });
          return;
        }
        document.execCommand("createLink", false, url);
      } else {
        document.execCommand(command, false);
      }
      syncTransport();
      positionToolbar();
    });
    return toolbar;
  }

  function selectedRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range : null;
  }

  function hideToolbar() {
    if (toolbar) toolbar.hidden = true;
    savedRange = null;
  }

  function positionToolbar() {
    const range = selectedRange();
    if (!range) return hideToolbar();
    savedRange = range.cloneRange();
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return hideToolbar();

    ensureToolbar();
    toolbar.hidden = false;
    const toolbarRect = toolbar.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, rect.left + rect.width / 2 - toolbarRect.width / 2),
      window.innerWidth - toolbarRect.width - margin
    );
    const above = rect.top - toolbarRect.height - 9;
    const top = above >= margin
      ? above
      : Math.min(window.innerHeight - toolbarRect.height - margin, rect.bottom + 9);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }

  transport.classList.add("rich-composer-transport");
  transport.tabIndex = -1;
  transport.setAttribute("aria-hidden", "true");

  editor.className = "message-editor";
  editor.contentEditable = "true";
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-multiline", "true");
  editor.setAttribute("spellcheck", "true");
  editor.setAttribute("autocapitalize", "sentences");
  editor.setAttribute("enterkeyhint", "enter");
  editor.dataset.richMessageEditor = "";
  transport.insertAdjacentElement("afterend", editor);
  syncReadonly();

  editor.addEventListener("input", syncTransport);
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.stopPropagation();
  });
  editor.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (typeof text !== "string") return;
    event.preventDefault();
    document.execCommand("insertHTML", false, escapeHtml(text).replace(/\n/g, "<br>"));
    syncTransport();
  });

  messageForm.addEventListener("submit", () => {
    submittedHtml = currentHtml();
    syncTransport();
  }, true);

  messageForm.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="cancel-message-mode"]')) {
      clearEditor();
    }
  }, true);

  document.addEventListener("selectionchange", () => requestAnimationFrame(positionToolbar));
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".rich-selection-toolbar") && !event.target.closest("[data-rich-message-editor]")) {
      hideToolbar();
    }
  }, true);

  if (typeof createTransientOutgoingMessage === "function") {
    const previousCreateTransient = createTransientOutgoingMessage;
    createTransientOutgoingMessage = function createRichTransient(chat, payload) {
      const message = previousCreateTransient(chat, payload);
      message.formattedHtml = sanitizeHtml(payload?.formattedHtml || submittedHtml || currentHtml());
      queueMicrotask(() => clearEditor(false));
      return message;
    };
  }

  if (typeof renderMessages === "function") {
    const previousRenderMessages = renderMessages;
    renderMessages = function renderRichMessages() {
      previousRenderMessages();
      enhanceRenderedMessages();
    };
  }

  if (typeof renderAttachmentTray === "function") {
    const previousRenderAttachmentTray = renderAttachmentTray;
    renderAttachmentTray = function renderCleanAttachmentTray() {
      previousRenderAttachmentTray();
      enhancePhotoCards();
    };
  }

  if (typeof renderActiveChat === "function") {
    const previousRenderActiveChat = renderActiveChat;
    renderActiveChat = function renderRichActiveChat() {
      previousRenderActiveChat();
      syncReadonly();
    };
  }

  if (typeof startEditMessage === "function") {
    const previousStartEditMessage = startEditMessage;
    startEditMessage = function startRichEdit(message) {
      previousStartEditMessage(message);
      setEditor(message?.text || "", message?.formattedHtml || "");
      editor.focus({ preventScroll: true });
      moveCaretToEnd();
    };
  }

  const messengerApi = typeof yachatApi !== "undefined" ? yachatApi?.messenger : null;
  if (messengerApi?.send) {
    const originalSend = messengerApi.send.bind(messengerApi);
    messengerApi.send = (payload = {}) => {
      const transient = typeof getMessageById === "function" ? getMessageById(payload.clientMessageId) : null;
      return originalSend({
        ...payload,
        formattedHtml: sanitizeHtml(payload.formattedHtml || transient?.formattedHtml || submittedHtml)
      });
    };
  }
  if (messengerApi?.updateMessage) {
    const originalUpdate = messengerApi.updateMessage.bind(messengerApi);
    messengerApi.updateMessage = async (payload = {}) => {
      const result = await originalUpdate({
        ...payload,
        formattedHtml: sanitizeHtml(payload.formattedHtml || submittedHtml || currentHtml())
      });
      clearEditor(false);
      return result;
    };
  }

  const observer = new MutationObserver(() => {
    syncReadonly();
    enhancePhotoCards();
    enhanceRenderedMessages();
    if (!transport.value && editor.textContent && !document.activeElement?.isSameNode(editor)) {
      clearEditor(false);
    }
  });
  observer.observe(messageForm, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "placeholder", "class"] });

  window.visualViewport?.addEventListener("resize", () => {
    if (toolbar && !toolbar.hidden) positionToolbar();
  });

  requestAnimationFrame(() => {
    enhancePhotoCards();
    enhanceRenderedMessages();
  });
})();