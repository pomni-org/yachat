(() => {
  "use strict";

  const CONTACT_SELECTOR = "[data-contact-user-id]";
  let openingUserId = "";

  function contactById(userId) {
    const targetId = String(userId || "").trim();
    if (!targetId) return null;

    return (Array.isArray(state?.contactMatches) ? state.contactMatches : [])
      .find((item) => String(item?.id ?? "").trim() === targetId) || null;
  }

  async function openContactChat(userId, sourceButton = null) {
    const targetId = String(userId || "").trim();
    const user = contactById(targetId);

    if (!user) {
      throw new Error(state?.language === "en" ? "Contact was not found" : "Контакт не найден");
    }

    if (sourceButton && typeof setLoading === "function") {
      setLoading(sourceButton, true);
    }

    try {
      if (typeof openPendingPrivateChat !== "function") {
        throw new Error("Private chat opener is unavailable");
      }

      await openPendingPrivateChat(user, { closePanelOnOpen: true });
    } finally {
      if (sourceButton?.isConnected && typeof setLoading === "function") {
        setLoading(sourceButton, false);
      }
    }
  }

  // Replace the old implementation too. It compared a server id with a DOM string
  // using strict equality and then swallowed the resulting error inside the panel.
  try {
    openPrivateChatWithContact = openContactChat;
  } catch {
    // The capture handler below still provides the same fixed path.
  }

  async function openContactRow(row) {
    const userId = String(row?.dataset?.contactUserId || "").trim();
    if (!userId || openingUserId) return;

    openingUserId = userId;
    row.disabled = true;
    row.setAttribute("aria-busy", "true");

    try {
      await openContactChat(userId, row);
    } catch (error) {
      const fallback = state?.language === "en" ? "Could not open chat" : "Не удалось открыть чат";
      const message = typeof translatedServerMessage === "function"
        ? translatedServerMessage(error?.message, "errSendMessage")
        : fallback;

      if (typeof showActionFeedback === "function") {
        showActionFeedback(message || fallback, {
          tone: "error",
          icon: "circle-alert",
          duration: 3200
        });
      }
    } finally {
      openingUserId = "";
      if (row?.isConnected) {
        row.disabled = false;
        row.removeAttribute("aria-busy");
      }
    }
  }

  document.addEventListener("click", (event) => {
    const row = event.target.closest(CONTACT_SELECTOR);
    if (!row) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void openContactRow(row);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(CONTACT_SELECTOR);
    if (!row) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void openContactRow(row);
  }, true);
})();