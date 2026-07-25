(() => {
  "use strict";

  if (window.__yachatMessageStateRepairInstalled) return;
  window.__yachatMessageStateRepairInstalled = true;

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

  function installRenderHooks() {
    if (typeof renderMessages === "function" && !renderMessages.__yachatSyncsIntro) {
      const originalRenderMessages = renderMessages;
      const wrappedRenderMessages = function renderMessagesAndSyncIntro(...args) {
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

  function installAll() {
    installRenderHooks();
    installDeleteMenuRules();
    syncDialogIntro();
  }

  installAll();

  const observer = new MutationObserver(() => {
    installAll();
    syncDialogIntro();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();