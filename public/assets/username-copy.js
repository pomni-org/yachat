(() => {
  "use strict";

  const HANDLE_SELECTOR = ".chat-profile-view .chat-profile-handle";
  const USERNAME_PATTERN = /^@[^\s@]{2,64}$/u;

  function language() {
    try {
      return state?.language === "en" ? "en" : "ru";
    } catch {
      return "ru";
    }
  }

  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.style.position = "fixed";
    field.style.opacity = "0";
    field.style.pointerEvents = "none";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("Clipboard copy failed");
  }

  function decorateHandle(element) {
    if (!(element instanceof HTMLElement) || !element.matches(HANDLE_SELECTOR)) return;
    const value = String(element.textContent || "").trim();
    if (!USERNAME_PATTERN.test(value)) return;
    element.classList.add("is-copyable-username");
    element.dataset.copyUsernameValue = value;
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.title = language() === "en" ? "Copy username" : "Скопировать юзернейм";
  }

  function decorate(root = document) {
    if (root instanceof Element && root.matches(HANDLE_SELECTOR)) decorateHandle(root);
    root.querySelectorAll?.(HANDLE_SELECTOR).forEach(decorateHandle);
  }

  async function copyHandle(element) {
    const value = String(element.dataset.copyUsernameValue || element.textContent || "").trim();
    if (!USERNAME_PATTERN.test(value)) return;
    try {
      await writeClipboard(value);
      element.classList.add("is-copied");
      window.setTimeout(() => element.classList.remove("is-copied"), 520);
      window.yachatFeedback?.show?.(
        language() === "en" ? "Username copied" : "Юзернейм скопирован",
        { icon: "copy" }
      );
    } catch {
      window.yachatFeedback?.show?.(
        language() === "en" ? "Could not copy username" : "Не удалось скопировать юзернейм",
        { icon: "circle-alert", tone: "error" }
      );
    }
  }

  document.addEventListener("click", (event) => {
    const handle = event.target.closest(HANDLE_SELECTOR);
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    void copyHandle(handle);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const handle = event.target.closest(HANDLE_SELECTOR);
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    void copyHandle(handle);
  }, true);

  const observer = new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node instanceof Element) decorate(node);
    }));
  });

  decorate(document);
  observer.observe(document.body, { childList: true, subtree: true });
})();