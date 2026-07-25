(() => {
  "use strict";

  const RETRY_COOLDOWN_MS = 15_000;
  let contactRetryBlockedUntil = 0;

  function isGroupLikeChat(chat) {
    return ["group", "channel"].includes(String(chat?.kind || "").toLowerCase());
  }

  function messageSenderName(message) {
    return String(
      message?.authorName
      || message?.senderName
      || message?.displayName
      || message?.sender?.displayName
      || message?.sender?.name
      || message?.sender?.username
      || message?.username
      || ""
    ).trim();
  }

  function decorateGroupMessageAuthors() {
    if (typeof getActiveChat !== "function" || typeof displayedMessages !== "function") return;
    const chat = getActiveChat();
    if (!isGroupLikeChat(chat)) return;

    const messages = new Map(displayedMessages().map((message) => [String(message.id), message]));
    document.querySelectorAll("[data-message-id]").forEach((bubble) => {
      const message = messages.get(String(bubble.dataset.messageId || ""));
      if (!message || message.author === "user" || bubble.querySelector(":scope > .message-author")) return;
      const name = messageSenderName(message);
      if (!name) return;

      const author = document.createElement("div");
      author.className = "message-author";
      author.textContent = name;
      const firstContent = bubble.querySelector(":scope > .message-forwarded, :scope > .message-reference, :scope > p, :scope > .message-attachment");
      bubble.insertBefore(author, firstContent || bubble.firstChild);
    });
  }

  if (typeof renderMessages === "function") {
    const originalRenderMessages = renderMessages;
    renderMessages = function renderMessagesWithAuthors(...args) {
      const result = originalRenderMessages.apply(this, args);
      decorateGroupMessageAuthors();
      return result;
    };
  }

  function fixLanguageButtons() {
    document.documentElement.removeAttribute("data-language");
    document.querySelectorAll("[data-language]").forEach((element) => {
      if (!(element instanceof HTMLButtonElement)) {
        element.removeAttribute("data-language");
      }
    });
  }

  fixLanguageButtons();
  const languageObserver = new MutationObserver(fixLanguageButtons);
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-language"] });

  function installContactsCircuitBreaker() {
    if (typeof loadSaved !== "function") return;
    const originalLoadSaved = loadSaved;
    loadSaved = async function loadSavedWithCircuitBreaker(options = {}) {
      const force = Boolean(options?.force);
      if (!force && Date.now() < contactRetryBlockedUntil) return;
      try {
        return await originalLoadSaved.call(this, options);
      } catch (error) {
        contactRetryBlockedUntil = Date.now() + RETRY_COOLDOWN_MS;
        throw error;
      }
    };
  }

  installContactsCircuitBreaker();

  const panelObserver = new MutationObserver(() => {
    if (typeof state === "undefined" || state.activePanel !== "contacts") return;
    const status = document.querySelector("[data-contact-status]");
    const text = String(status?.textContent || "").trim();
    if (/ошиб|error|failed|недоступ/i.test(text)) {
      contactRetryBlockedUntil = Math.max(contactRetryBlockedUntil, Date.now() + RETRY_COOLDOWN_MS);
    }
  });
  const panelBodyElement = document.querySelector("[data-panel-body]");
  if (panelBodyElement) panelObserver.observe(panelBodyElement, { childList: true, subtree: true });

  decorateGroupMessageAuthors();
})();
