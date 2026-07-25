(() => {
  "use strict";

  function isGroupLikeChat(chat) {
    return ["group", "channel"].includes(String(chat?.kind || "").toLowerCase());
  }

  function messageSenderName(message) {
    return String(
      message?.authorName
      || message?.authorDisplayName
      || message?.senderName
      || message?.senderDisplayName
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

  decorateGroupMessageAuthors();
})();
