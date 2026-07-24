(() => {
  "use strict";

  if (window.__yachatComposerDeliveryStableInstalled) return;
  window.__yachatComposerDeliveryStableInstalled = true;

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

  function transientMessage(clientMessageId) {
    if (!clientMessageId || typeof getMessageById !== "function") return null;
    try { return getMessageById(clientMessageId); } catch { return null; }
  }

  function installFormattedPayloadRepair() {
    if (typeof yachatApi === "undefined" || !yachatApi?.messenger?.send) return;
    if (yachatApi.messenger.send.__yachatKeepsFormattedHtml) return;
    const currentSend = yachatApi.messenger.send.bind(yachatApi.messenger);
    const wrapped = function sendWithFormattedHtml(payload = {}) {
      const transient = transientMessage(payload.clientMessageId);
      const formattedHtml = sanitizeRichHtml(payload.formattedHtml || transient?.formattedHtml || "");
      return currentSend(formattedHtml ? { ...payload, formattedHtml } : { ...payload });
    };
    Object.defineProperty(wrapped, "__yachatKeepsFormattedHtml", { value: true });
    yachatApi.messenger.send = wrapped;
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
    if (inFlight.has(message.id)) return false;
    inFlight.add(message.id);
    try {
      const targetChat = await resolveTargetChat(sourceChat);
      moveTransient(sourceChat, targetChat, message);
      const delivered = await deliverTransientMessage(targetChat, message);
      if (delivered) outboxChats.delete(message.id);
      return Boolean(delivered);
    } catch (error) {
      markCreateChatFailed(sourceChat, message, error);
      return false;
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
    return queued;
  }

  function scheduleMessageDelivery(chat, message) {
    // DOM updates above are synchronous; starting fetch immediately does not
    // block the next paint. The old rAF + timer chain made the first attempt
    // dependent on WebKit scheduling and occasionally left it in limbo.
    void enqueueMessage(chat, message);
  }

  function clearComposer(form, transport, send) {
    transport.value = "";
    const nativeTextarea = form.querySelector("[data-native-ios-message-input]");
    if (nativeTextarea) {
      nativeTextarea.value = "";
      nativeTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      form.querySelector("[data-rich-message-editor]")?.replaceChildren();
    }
    state.pendingAttachments = [];
    state.replyToMessage = null;
    renderAttachmentTray();
    renderComposerContext();
    send.setAttribute("aria-disabled", "true");
    send.classList.add("is-disabled");
  }

  function installOptimisticSubmit() {
    const form = document.querySelector('[data-form="message"]');
    const send = form?.querySelector(".send-button");
    const transport = form?.querySelector("[data-message-input]");
    if (!form || !send || !transport || form.dataset.yachatOptimisticSubmit) return;

    form.dataset.yachatOptimisticSubmit = "immediate-v2";
    form.classList.add("is-composer-reliable");

    send.addEventListener("pointerdown", () => {
      try { form.__yachatSyncRichEditor?.({ dispatch: false }); } catch {}
    }, true);

    form.addEventListener("submit", (event) => {
      if (state.editingMessageId) return;
      try { form.__yachatSyncRichEditor?.({ dispatch: false }); } catch {}
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
      clearComposer(form, transport, send);
      scheduleMessageDelivery(chat, outgoing);
    }, true);
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
          if (chat) void enqueueMessage(chat, message);
        }
      }
    });
  }

  installFormattedPayloadRepair();
  installOptimisticSubmit();
  installReconnectRetry();
})();
