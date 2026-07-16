(() => {
  "use strict";

  const ACTIVE_SELECTOR = ".is-chat-profile";
  const BADGE_SELECTOR = "[data-verified-info], [data-verified-decoration]";

  function isProfileBadge(element) {
    return Boolean(element?.closest?.(ACTIVE_SELECTOR));
  }

  function makeInteractive(element) {
    element.removeAttribute("data-verified-decoration");
    element.setAttribute("data-verified-info", "");
    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.removeAttribute("aria-hidden");

    const label = element.getAttribute("data-verified-title") || element.getAttribute("title") || "Верификация";
    element.setAttribute("aria-label", label);
  }

  function makeDecorative(element) {
    element.removeAttribute("data-verified-info");
    element.setAttribute("data-verified-decoration", "");
    element.setAttribute("role", "img");
    element.removeAttribute("tabindex");
    element.removeAttribute("aria-label");
    element.setAttribute("aria-hidden", "true");
  }

  function syncBadge(element) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    if (isProfileBadge(element)) {
      makeInteractive(element);
    } else {
      makeDecorative(element);
    }
  }

  function syncTree(root = document) {
    if (root instanceof HTMLElement && root.matches(BADGE_SELECTOR)) {
      syncBadge(root);
    }

    root.querySelectorAll?.(BADGE_SELECTOR).forEach(syncBadge);
  }

  function blockDecorativeActivation(event) {
    const badge = event.target instanceof Element ? event.target.closest(BADGE_SELECTOR) : null;
    if (!badge || isProfileBadge(badge)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  document.addEventListener("click", blockDecorativeActivation, true);
  document.addEventListener("pointerdown", blockDecorativeActivation, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      blockDecorativeActivation(event);
    }
  }, true);

  const observer = new MutationObserver((records) => {
    let rescanDocument = false;

    for (const record of records) {
      if (record.type === "attributes") {
        rescanDocument = true;
        continue;
      }

      for (const node of record.addedNodes) {
        if (node instanceof HTMLElement) {
          syncTree(node);
        }
      }
    }

    if (rescanDocument) {
      syncTree(document);
    }
  });

  syncTree(document);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });
})();
