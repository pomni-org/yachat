(() => {
  const sharedPageData = {
    revisionNote: "Редакция от 05.07.2026 для текущей версии ЯЧата.",
    contacts: {
      telegram: "@murochko_com",
      whatsapp: "@murochko"
    }
  };

  function telegramUrl(handle) {
    return `https://t.me/${String(handle).replace(/^@/, "")}`;
  }

  function fillText(selector, value) {
    document.querySelectorAll(selector).forEach((element) => {
      element.textContent = value;
    });
  }

  function fillContacts() {
    Object.entries(sharedPageData.contacts).forEach(([name, value]) => {
      document.querySelectorAll(`[data-shared-contact="${name}"]`).forEach((element) => {
        element.textContent = value;

        if (element.tagName === "A" && name === "telegram") {
          element.href = telegramUrl(value);
        }
      });
    });
  }

  window.YACHAT_PAGE_DATA = sharedPageData;

  document.addEventListener("DOMContentLoaded", () => {
    fillText("[data-shared='revisionNote']", sharedPageData.revisionNote);
    fillContacts();
  });
})();
