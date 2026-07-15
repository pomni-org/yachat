(() => {
  "use strict";

  const USERNAME_PATTERN = /^@[^\s@]{2,64}$/u;
  const COPYABLE_CLASS = "is-copyable-username";
  const TOAST_VISIBLE_MS = 1800;
  let toastTimer = null;

  function language() {
    try {
      return state?.language === "en" ? "en" : "ru";
    } catch {
      return "ru";
    }
  }

  function normalizeUsername(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    const username = text.startsWith("@") ? text : `@${text}`;
    return USERNAME_PATTERN.test(username) ? username : "";
  }

  function ownUsername(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    const datasetValue = element.dataset.copyUsername || element.dataset.username || "";
    const datasetUsername = normalizeUsername(datasetValue);
    if (datasetUsername) {
      return datasetUsername;
    }

    const text = String(element.textContent || "").trim();
    if (USERNAME_PATTERN.test(text)) {
      return text;
    }
    return "";
  }

  function isFormControl(element) {
    return element.matches("input, textarea, select, [contenteditable='true']");
  }

  function decorateElement(element) {
    const username = ownUsername(element);
    if (!username || isFormControl(element)) {
      return;
    }

    const hasStandaloneText = element.children.length === 0 || Boolean(element.dataset.copyUsername || element.dataset.username);
    if (!hasStandaloneText) {
      return;
    }

    element.classList.add(COPYABLE_CLASS);
    element.dataset.copyUsernameValue = username;
    element.title ||= language() === "en" ? "Click to copy username" : "Нажмите, чтобы скопировать юзернейм";

    if (!element.matches("button, a, [role='button']")) {
      element.setAttribute("role", "button");
      element.tabIndex = element.tabIndex >= 0 ? element.tabIndex : 0;
    }
  }

  function decorateTree(root) {
    if (!(root instanceof Element || root instanceof Document)) {
      return;
    }

    if (root instanceof Element) {
      decorateElement(root);
    }

    const elements = root.querySelectorAll("[data-username], [data-copy-username], span, strong, p, small, b");
    for (const element of elements) {
      decorateElement(element);
    }
  }

  function usernameFromTarget(target) {
    let element = target instanceof Element ? target : null;
    for (let depth = 0; element && depth < 4; depth += 1, element = element.parentElement) {
      const stored = normalizeUsername(element.dataset.copyUsernameValue || "");
      if (stored) {
        return { element, username: stored };
      }
      const inferred = ownUsername(element);
      if (inferred && !isFormControl(element)) {
        return { element, username: inferred };
      }
    }
    return null;
  }

  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    field.style.pointerEvents = "none";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    if (!copied) {
      throw new Error("Clipboard copy failed");
    }
  }

  function showToast(success) {
    let toast = document.querySelector("[data-username-copy-toast]");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "username-copy-toast";
      toast.dataset.usernameCopyToast = "";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.append(toast);
    }

    toast.textContent = success
      ? (language() === "en" ? "Username copied" : "Юзернейм скопирован")
      : (language() === "en" ? "Could not copy username" : "Не удалось скопировать юзернейм");
    toast.classList.toggle("is-error", !success);
    toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), TOAST_VISIBLE_MS);
  }

  async function copyUsername(match) {
    try {
      await writeClipboard(match.username);
      match.element.classList.add("is-copied");
      window.setTimeout(() => match.element.classList.remove("is-copied"), 520);
      showToast(true);
    } catch {
      showToast(false);
    }
  }

  document.addEventListener("click", (event) => {
    const match = usernameFromTarget(event.target);
    if (!match) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void copyUsername(match);
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const match = usernameFromTarget(event.target);
    if (!match || !match.element.classList.contains(COPYABLE_CLASS)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void copyUsername(match);
  }, true);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          decorateTree(node);
        }
      }
    }
  });

  decorateTree(document);
  observer.observe(document.body, { childList: true, subtree: true });
})();
