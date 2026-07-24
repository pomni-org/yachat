(() => {
  "use strict";

  if (window.__yachatComposerReliabilityInstalled) return;
  window.__yachatComposerReliabilityInstalled = true;

  const isIos = /iPad|iPhone|iPod/i.test(navigator.userAgent || "")
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
    || (/Macintosh/i.test(navigator.userAgent || "") && navigator.maxTouchPoints > 1);

  const allowedTags = new Set(["STRONG", "EM", "U", "S", "CODE", "A", "BR"]);
  const aliases = new Map([["B", "STRONG"], ["I", "EM"], ["DEL", "S"]]);
  const inFlight = new Set();
  const sendChains = new Map();
  const resolvedPendingChats = new Map();
  const resolvingPendingChats = new Map();
  const outboxChats = new Map();

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

  function sanitizeRichHtml(value) {
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
        if (parent.childNodes.length && parent.lastChild?.nodeName !== "BR") parent.append(document.createElement("br"));
        [...node.childNodes].forEach((child) => appendNode(child, parent));
        if (parent.lastChild?.nodeName !== "BR") parent.append(document.createElement("br"));
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

  function installLayoutEngine() {
    if (!isIos || document.querySelector("style[data-yachat-composer-engine-v3]")) return;
    const style = document.createElement("style");
    style.dataset.yachatComposerEngineV3 = "";
    style.textContent = `
      .composer.is-native-ios-composer {
        display: grid !important;
        grid-template-columns: 42px 42px minmax(0, 1fr) 42px 50px !important;
        grid-auto-rows: auto !important;
        align-items: end !important;
        justify-self: center !important;
        width: min(704px, calc(100% - 16px)) !important;
        max-width: calc(100% - 16px) !important;
        min-height: 58px !important;
        max-height: none !important;
        margin: 6px auto max(6px, env(safe-area-inset-bottom)) !important;
        padding: 6px 8px !important;
        column-gap: 5px !important;
        row-gap: 7px !important;
      }
      .composer.is-native-ios-composer > .composer-context,
      .composer.is-native-ios-composer > .attachment-policy-note,
      .composer.is-native-ios-composer > .attachment-tray,
      .composer.is-native-ios-composer > .message-mention-strip { grid-column: 1 / -1 !important; }
      .composer.is-native-ios-composer > [data-action="attach-file"] { grid-column: 1 !important; }
      .composer.is-native-ios-composer > [data-action="attach-document"] { grid-column: 2 !important; }
      .composer.is-native-ios-composer > [data-action="open-stickers"] { grid-column: 4 !important; }
      .composer.is-native-ios-composer > .send-button { grid-column: 5 !important; }

      .composer.is-native-ios-composer .ios-rich-message-field {
        position: relative !important;
        display: block !important;
        grid-column: 3 !important;
        align-self: end !important;
        justify-self: stretch !important;
        width: 100% !important;
        min-width: 0 !important;
        min-height: 42px !important;
        max-height: 132px !important;
        overflow: hidden !important;
      }
      .composer.is-native-ios-composer .ios-rich-message-field > .ios-rich-message-preview,
      .composer.is-native-ios-composer .ios-rich-message-field > .ios-native-message-input {
        box-sizing: border-box !important;
        width: 100% !important;
        min-width: 0 !important;
        min-height: 42px !important;
        max-height: 132px !important;
        margin: 0 !important;
        padding: 10px 4px !important;
        border: 0 !important;
        outline: 0 !important;
        background: transparent !important;
        font: inherit !important;
        font-size: 16px !important;
        line-height: 22px !important;
        text-align: start !important;
        direction: inherit !important;
        white-space: pre-wrap !important;
        overflow-wrap: anywhere !important;
      }
      .composer.is-native-ios-composer .ios-rich-message-field > .ios-rich-message-preview {
        position: absolute !important;
        z-index: 0 !important;
        inset: 0 !important;
        display: block !important;
        grid-column: auto !important;
        grid-row: auto !important;
        overflow: hidden !important;
        color: var(--text) !important;
        pointer-events: none !important;
        user-select: none !important;
      }
      .composer.is-native-ios-composer .ios-rich-message-field > .ios-native-message-input {
        position: relative !important;
        z-index: 1 !important;
        display: block !important;
        grid-column: auto !important;
        grid-row: auto !important;
        overflow-x: hidden !important;
        overflow-y: auto !important;
        resize: none !important;
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        caret-color: var(--accent) !important;
        -webkit-user-select: text !important;
        user-select: text !important;
        pointer-events: auto !important;
        opacity: 1 !important;
      }
      .composer.is-native-ios-composer .composer-tool,
      .composer.is-native-ios-composer .send-button { align-self: end !important; margin-bottom: 1px !important; }

      @media (max-width: 640px) {
        .composer.is-native-ios-composer {
          grid-template-columns: 38px 38px minmax(0, 1fr) 38px 48px !important;
          width: calc(100% - 12px) !important;
          max-width: calc(100% - 12px) !important;
          margin-left: 6px !important;
          margin-right: 6px !important;
          padding-inline: 6px !important;
          column-gap: 3px !important;
        }
      }
    `;
    document.head.append(style);
  }

  function resizeNativeComposer(form = document.querySelector('[data-form="message"]')) {
    const textarea = form?.querySelector("[data-ios-message-input]");
    const field = textarea?.closest(".ios-rich-message-field");
    const preview = field?.querySelector(".ios-rich-message-preview");
    if (!textarea || !field) return;

    textarea.style.height = "auto";
    const next = Math.min(132, Math.max(42, textarea.scrollHeight || 42));
    textarea.style.height = `${next}px`;
    field.style.height = `${next}px`;
    if (preview) preview.style.height = `${next}px`;
  }

  function transientMessage(clientMessageId) {
    if (!clientMessageId || typeof getMessageById !== "function") return null;
    try { return getMessageById(clientMessageId); } catch { return null; }
  }

  function installFormattedPayloadRepair() {
    if (typeof yachatApi === "undefined" || !yachatApi?.messenger?.send) return false;
    if (yachatApi.messenger.send.__yachatKeepsFormattedHtml) return true;
    const currentSend = yachatApi.messenger.send.bind(yachatApi.messenger);
    const wrapped = function sendWithFormattedHtml(payload = {}) {
      const transient = transientMessage(payload.clientMessageId);
      const formattedHtml = sanitizeRichHtml(payload.formattedHtml || transient?.formattedHtml || "");
      return currentSend(formattedHtml ? { ...payload, formattedHtml } : { ...payload });
    };
    Object.defineProperty(wrapped, "__yachatKeepsFormattedHtml", { value: true });
    yachatApi.messenger.send = wrapped;
    return true;
  }

  function dispatchTransportInput(transport) {
    transport.dispatchEvent(typeof InputEvent === "function"
      ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: null })
      : new Event("input", { bubbles: true }));
  }

  function renderOptimistic(chat, message) {
    outboxChats.set(message.id, chat);
    message.deliveryStatus = "sending";
    setTransientMessage(chat.id, message);
    if (state.activeChatId === chat.id) renderMessages();
    renderChatList();
  }

  function markCreateChatFailed(chat, message, error) {
    outboxChats.set(message.id, chat);
    message.deliveryStatus = "failed";
    setTransientMessage(chat.id, message);
    if (state.activeChatId === chat.id) renderMessages();
    renderChatList();
    showActionFeedback(translatedServerMessage(error?.message, "feedbackSendFailed"), {
      tone: "error",
      icon: "circle-alert",
      duration: 3200
    });
  }

  async function resolveTargetChat(chat) {
    if (!chat?.pendingSearchUserId) return chat;
    const key = String(chat.pendingSearchUserId);
    if (resolvedPendingChats.has(key)) return resolvedPendingChats.get(key);
    if (!resolvingPendingChats.has(key)) {
      resolvingPendingChats.set(key, Promise.resolve(ensureRealChatForMessage(chat))
        .then((target) => {
          if (!target) throw new Error("Chat creation failed");
          resolvedPendingChats.set(key, target);
          return target;
        })
        .finally(() => resolvingPendingChats.delete(key)));
    }
    return resolvingPendingChats.get(key);
  }

  function moveTransient(sourceChat, targetChat, message) {
    if (sourceChat.id === targetChat.id) return;
    removeTransientMessage(sourceChat.id, message.id);
    message.chatId = targetChat.id;
    outboxChats.set(message.id, targetChat);
    setTransientMessage(targetChat.id, message);
    renderChatList();
    renderActiveChat();
    renderMessages();
  }

  async function sendQueuedMessage(sourceChat, message) {
    if (inFlight.has(message.id)) return;
    inFlight.add(message.id);
    try {
      const targetChat = await resolveTargetChat(sourceChat);
      moveTransient(sourceChat, targetChat, message);
      const delivered = await deliverTransientMessage(targetChat, message);
      if (delivered) outboxChats.delete(message.id);
    } catch (error) {
      markCreateChatFailed(sourceChat, message, error);
    } finally {
      inFlight.delete(message.id);
    }
  }

  function enqueueMessage(chat, message) {
    const key = chat.pendingSearchUserId ? `pending:${chat.pendingSearchUserId}` : `chat:${chat.id}`;
    const previous = sendChains.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(() => sendQueuedMessage(chat, message));
    sendChains.set(key, queued);
    queued.finally(() => {
      if (sendChains.get(key) === queued) sendChains.delete(key);
    });
  }

  function clearComposer(form, transport, textarea, send) {
    transport.value = "";
    if (textarea) {
      textarea.value = "";
      textarea.scrollTop = 0;
    }
    state.pendingAttachments = [];
    state.replyToMessage = null;
    renderAttachmentTray();
    renderComposerContext();
    send.disabled = true;
    const editor = form.querySelector("[data-rich-message-editor]");
    if (editor && !isIos) editor.replaceChildren();
    requestAnimationFrame(() => resizeNativeComposer(form));
  }

  function installOptimisticSubmit() {
    const form = document.querySelector('[data-form="message"]');
    const send = form?.querySelector(".send-button");
    const transport = form?.querySelector("[data-message-input]");
    const textarea = form?.querySelector("[data-ios-message-input]");
    if (!form || !send || !transport || form.dataset.yachatOptimisticSubmit) return false;

    form.dataset.yachatOptimisticSubmit = "true";
    form.classList.add("is-composer-reliable");

    if (textarea && !textarea.dataset.yachatTransportSync) {
      textarea.dataset.yachatTransportSync = "true";
      const sync = () => {
        if (transport.value !== textarea.value) {
          transport.value = textarea.value;
          dispatchTransportInput(transport);
        }
        resizeNativeComposer(form);
      };
      textarea.addEventListener("input", () => requestAnimationFrame(sync));
      textarea.addEventListener("change", sync);
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter") event.stopPropagation();
      }, true);
    }

    send.addEventListener("pointerdown", () => {
      if (textarea && transport.value !== textarea.value) {
        transport.value = textarea.value;
        dispatchTransportInput(transport);
      }
    }, true);

    form.addEventListener("submit", (event) => {
      if (state.editingMessageId) return;
      const chat = getActiveChat();
      const text = String(transport.value || "").trim();
      const attachments = Array.isArray(state.pendingAttachments) ? [...state.pendingAttachments] : [];
      if (!chat || !canSendToChat(chat) || (!text && attachments.length === 0)) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const outgoing = createTransientOutgoingMessage(chat, {
        text,
        attachments,
        replyToMessageId: state.replyToMessage?.messageId || null,
        replyTo: state.replyToMessage ? { ...state.replyToMessage } : null
      });

      renderOptimistic(chat, outgoing);
      clearComposer(form, transport, textarea, send);

      requestAnimationFrame(() => {
        window.setTimeout(() => enqueueMessage(chat, outgoing), 0);
      });
    }, true);

    requestAnimationFrame(() => resizeNativeComposer(form));
    return true;
  }

  function installReconnectRetry() {
    window.addEventListener("online", () => {
      if (!(state.transientMessagesByChat instanceof Map)) return;
      for (const messages of state.transientMessagesByChat.values()) {
        for (const message of messages.values()) {
          if (message?.deliveryStatus !== "failed" || inFlight.has(message.id)) continue;
          const chat = outboxChats.get(message.id)
            || state.chats.find((item) => item.id === message.chatId)
            || (state.pendingSearchChat?.id === message.chatId ? state.pendingSearchChat : null);
          if (chat) enqueueMessage(chat, message);
        }
      }
    });
  }

  function installAll() {
    installLayoutEngine();
    installFormattedPayloadRepair();
    installOptimisticSubmit();
  }

  installAll();
  installReconnectRetry();
  window.addEventListener("resize", () => requestAnimationFrame(() => resizeNativeComposer()));
  window.visualViewport?.addEventListener("resize", () => requestAnimationFrame(() => resizeNativeComposer()));

  const observer = new MutationObserver(() => installAll());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
