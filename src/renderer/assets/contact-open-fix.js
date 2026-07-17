(() => {
  "use strict";

  const CONTACT_SELECTOR = "[data-contact-user-id]";
  let openingUserId = "";

  async function openContactRow(row) {
    const userId = String(row?.dataset?.contactUserId || "").trim();
    if (!userId || openingUserId) return;

    openingUserId = userId;
    row.disabled = true;
    row.setAttribute("aria-busy", "true");

    try {
      if (typeof openPrivateChatWithContact !== "function") {
        throw new Error("Contact chat handler is unavailable");
      }
      await openPrivateChatWithContact(userId, row);
    } catch (error) {
      if (typeof showActionFeedback === "function") {
        showActionFeedback(
          typeof translatedServerMessage === "function"
            ? translatedServerMessage(error?.message, "errSendMessage")
            : (state?.language === "en" ? "Could not open chat" : "Не удалось открыть чат"),
          { tone: "error", icon: "circle-alert", duration: 3200 }
        );
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
