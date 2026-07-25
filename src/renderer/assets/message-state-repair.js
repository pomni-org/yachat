(() => {
  "use strict";

  if (window.__yachatMessageStateRepairInstalled) return;
  window.__yachatMessageStateRepairInstalled = true;

  let replyHighlightTimer = null;

  function ensureReplyStyles() {
    if (document.querySelector('[data-yachat-message-replies-style]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/message-replies.css?v=90";
    link.dataset.yachatMessageRepliesStyle = "";
    document.head.append(link);
  }

  function activeMessageCount() {
    try {
      return typeof displayedMessages === "function" ? displayedMessages().length : 0;
    } catch {
      const persisted = Array.isArray(state?.messages) ? state.messages.length : 0;
      const transient = typeof transientMessagesForChat === "function"
        ? transientMessagesForChat().length
        : 0;
      return persisted + transient;
    }
  }

  function syncDialogIntro() {
    const intro = document.querySelector("[data-dialog-intro]");
    if (!intro) return;
    intro.hidden = activeMessageCount() > 0;
  }

  function isOwnMessage(message) {
    if (!message) return false;
    const accountId = String(state?.account?.id || "");
    const explicitAuthorId = String(message.authorId || message.senderId || "");
    if (explicitAuthorId) return Boolean(accountId) && explicitAuthorId === accountId;
    return message.author === "user";
  }

  function replyAuthorName(message) {
    if (!message) return "";
    const explicit = cleanDisplayText(
      message.authorName || message.senderName || message.displayName || "",
      ""
    );
    if (explicit) return explicit;

    const accountId = String(state?.account?.id || "");
    const authorId = String(message.authorId || message.senderId || "");
    if (message.author === "user" || (authorId && authorId === accountId)) {
      return cleanDisplayText(state?.account?.displayName, state?.account?.username || "Вы");
    }

    const chat = typeof getActiveChat === "function" ? getActiveChat() : null;
    const profile = authorId && chat?.participantProfiles
      ? chat.participantProfiles[authorId]
      : null;
    const profileName = cleanDisplayText(
      profile?.displayName || profile?.previewName || profile?.username || "",
      ""
    );
    if (profileName) return profileName;

    if (message.author === "system") return "ЯЧат";
    return cleanDisplayText(
      typeof getChatTitle === "function" ? getChatTitle(chat) : chat?.title,
      "Собеседник"
    );
  }

  function compactReplyAttachments(message) {
    return (Array.isArray(message?.attachments) ? message.attachments : []).slice(0, 1).map((item) => ({
      kind: String(item?.kind || "file"),
      name: String(item?.name || ""),
      mime: String(item?.mime || "")
    }));
  }

  function replyReferenceFromMessage(message) {
    if (!message?.id) return null;
    return {
      messageId: String(message.id),
      author: message.author || "contact",
      authorId: String(message.authorId || message.senderId || ""),
      authorName: replyAuthorName(message),
      text: String(messagePreviewText(message) || "").slice(0, 500),
      attachments: compactReplyAttachments(message)
    };
  }

  function currentVisibleMessages() {
    try {
      return typeof displayedMessages === "function"
        ? displayedMessages()
        : Array.isArray(state?.messages) ? state.messages : [];
    } catch {
      return Array.isArray(state?.messages) ? state.messages : [];
    }
  }

  function normalizeReplyState() {
    const messages = currentVisibleMessages();
    const byId = new Map(
      messages
        .filter((message) => message?.id)
        .map((message) => [String(message.id), message])
    );

    messages.forEach((message) => {
      if (!message) return;
      const replyId = String(message.replyToMessageId || message.replyTo?.messageId || "").trim();
      if (!replyId) {
        message.replyToMessageId = null;
        if (message.replyTo) delete message.replyTo;
        return;
      }

      const source = byId.get(replyId);
      if (!source || source === message) {
        message.replyToMessageId = null;
        if (message.replyTo) delete message.replyTo;
        return;
      }

      message.replyToMessageId = replyId;
      message.replyTo = replyReferenceFromMessage(source);
    });

    const composerReplyId = String(state?.replyToMessage?.messageId || "").trim();
    if (composerReplyId) {
      const source = byId.get(composerReplyId);
      state.replyToMessage = source ? replyReferenceFromMessage(source) : null;
    }
  }

  function installReplyRenderer() {
    if (typeof renderMessageReference !== "function" || renderMessageReference.__yachatStrictReplyRenderer) {
      return;
    }

    const strictRenderer = function renderStrictMessageReference(message, className = "message-reference") {
      if (!message) return "";
      const text = cleanDisplayText(message.text, "") || t("messagePlaceholder");
      const author = replyAuthorName(message);
      const targetId = String(message.messageId || "").trim();
      const targetAttribute = targetId ? ` data-reply-target="${escapeHtml(targetId)}"` : "";
      return `
        <button class="${className}" type="button"${targetAttribute} aria-label="${escapeHtml(`Ответ на сообщение от ${author}`)}">
          <strong>${escapeHtml(author)}</strong>
          <span>${escapeHtml(text)}</span>
        </button>
      `;
    };

    Object.defineProperty(strictRenderer, "__yachatStrictReplyRenderer", { value: true });
    renderMessageReference = strictRenderer;
  }

  function installReplyComposer() {
    if (typeof startReplyMessage !== "function" || startReplyMessage.__yachatStrictReplyComposer) {
      return;
    }

    const strictStartReplyMessage = function startStrictReplyMessage(message) {
      const reference = replyReferenceFromMessage(message);
      if (!reference) return;
      state.replyToMessage = reference;
      state.editingMessageId = null;
      renderComposerContext();
      messageInput?.focus();
    };

    Object.defineProperty(strictStartReplyMessage, "__yachatStrictReplyComposer", { value: true });
    startReplyMessage = strictStartReplyMessage;
  }

  function installRenderHooks() {
    if (typeof renderMessages === "function" && !renderMessages.__yachatSyncsIntro) {
      const originalRenderMessages = renderMessages;
      const wrappedRenderMessages = function renderMessagesAndSyncIntro(...args) {
        normalizeReplyState();
        const result = originalRenderMessages.apply(this, args);
        syncDialogIntro();
        return result;
      };
      Object.defineProperty(wrappedRenderMessages, "__yachatSyncsIntro", { value: true });
      renderMessages = wrappedRenderMessages;
    }

    if (typeof renderActiveChat === "function" && !renderActiveChat.__yachatSyncsIntro) {
      const originalRenderActiveChat = renderActiveChat;
      const wrappedRenderActiveChat = function renderActiveChatAndSyncIntro(...args) {
        const result = originalRenderActiveChat.apply(this, args);
        syncDialogIntro();
        return result;
      };
      Object.defineProperty(wrappedRenderActiveChat, "__yachatSyncsIntro", { value: true });
      renderActiveChat = wrappedRenderActiveChat;
    }
  }

  function installDeleteMenuRules() {
    if (typeof openMessageDeleteMenu !== "function" || openMessageDeleteMenu.__yachatCorrectDeleteRules) {
      return;
    }

    const correctedOpenMessageDeleteMenu = function correctedOpenMessageDeleteMenu(messageId, messageIds) {
      const message = getMessageById(messageId);
      const ids = [...new Set(messageIds)].filter(Boolean);
      const messages = ids.map(getMessageById).filter(Boolean);
      if (!message || messages.length !== ids.length) {
        closeMessageMenu();
        return;
      }

      const currentMenu = state.messageMenu || {};
      const canDeleteForEveryone = messages.every((item) => (
        isOwnMessage(item)
        && !["sending", "failed"].includes(messageDeliveryStatus(item))
      ));
      const menu = ensureMessageMenu();
      state.messageMenu = {
        messageId,
        deleteIds: ids,
        x: currentMenu.x,
        y: currentMenu.y
      };
      menu.innerHTML = `
        <div class="message-context-heading">${escapeHtml(t(ids.length > 1 ? "deleteMessagesTitle" : "deleteMessageTitle"))}</div>
        <button type="button" role="menuitem" data-message-action="delete-self">
          <span>${escapeHtml(t("deleteForMe"))}</span>
          ${iconSvg("trash")}
        </button>
        ${canDeleteForEveryone ? `
          <button class="is-danger" type="button" role="menuitem" data-message-action="delete-everyone">
            <span>${escapeHtml(t("deleteForEveryone"))}</span>
            ${iconSvg("users")}
          </button>
        ` : ""}
        <button class="is-separated" type="button" role="menuitem" data-message-action="delete-cancel">
          <span>${escapeHtml(t("cancel"))}</span>
          ${iconSvg("x")}
        </button>
      `;
      positionMessageMenu(menu, message, messageId, currentMenu.x, currentMenu.y);
    };

    Object.defineProperty(correctedOpenMessageDeleteMenu, "__yachatCorrectDeleteRules", { value: true });
    openMessageDeleteMenu = correctedOpenMessageDeleteMenu;
  }

  function escapeSelectorValue(value) {
    if (window.CSS?.escape) return CSS.escape(String(value || ""));
    return String(value || "").replace(/["\\]/g, "\\$&");
  }

  function focusReplyTarget(messageId) {
    const target = messageList?.querySelector(`[data-message-id="${escapeSelectorValue(messageId)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    document.querySelectorAll(".is-reply-target-highlight").forEach((element) => {
      element.classList.remove("is-reply-target-highlight");
    });
    target.classList.add("is-reply-target-highlight");
    window.clearTimeout(replyHighlightTimer);
    replyHighlightTimer = window.setTimeout(() => {
      target.classList.remove("is-reply-target-highlight");
    }, 1400);
  }

  function installReplyNavigation() {
    if (window.__yachatReplyNavigationInstalled) return;
    window.__yachatReplyNavigationInstalled = true;
    document.addEventListener("click", (event) => {
      const reference = event.target.closest("[data-reply-target]");
      if (!reference) return;
      event.preventDefault();
      event.stopPropagation();
      focusReplyTarget(reference.dataset.replyTarget);
    }, true);
  }

  function installAll() {
    ensureReplyStyles();
    installReplyRenderer();
    installReplyComposer();
    installRenderHooks();
    installDeleteMenuRules();
    installReplyNavigation();
    normalizeReplyState();
    syncDialogIntro();
  }

  installAll();
  try { renderMessages?.(); } catch {}

  const observer = new MutationObserver(() => {
    installAll();
    syncDialogIntro();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
