(() => {
  "use strict";

  const panelBody = document.querySelector("[data-panel-body]");
  if (!panelBody) {
    return;
  }

  let wasOpen = false;
  let enhancing = false;

  function closeProfileModal() {
    panelBody
      .querySelector('.profile-edit-modal-layer [data-panel-action="cancel-profile-edit"]')
      ?.click();
  }

  function addModalHeader(section) {
    if (section.querySelector(".profile-edit-modal-header")) {
      return;
    }

    const heading = section.querySelector(":scope > h3");
    if (!heading) {
      return;
    }

    heading.id = "profile-edit-modal-title";

    const header = document.createElement("header");
    header.className = "profile-edit-modal-header";
    heading.before(header);
    header.append(heading);

    const closeButton = document.createElement("button");
    closeButton.className = "icon-button profile-edit-modal-close";
    closeButton.type = "button";
    closeButton.dataset.panelAction = "cancel-profile-edit";
    closeButton.setAttribute("aria-label", "Закрыть");
    closeButton.innerHTML = '<span class="css-icon gg-x"></span>';
    header.append(closeButton);
  }

  function enhanceProfileEditor() {
    if (enhancing) {
      return;
    }

    enhancing = true;
    try {
      const section = panelBody.querySelector(".profile-edit-section");

      if (!section) {
        document.body.classList.remove("profile-edit-modal-open");
        if (wasOpen) {
          wasOpen = false;
          requestAnimationFrame(() => {
            document.querySelector('[data-panel-action="edit-profile"]')?.focus();
          });
        }
        return;
      }

      wasOpen = true;
      document.body.classList.add("profile-edit-modal-open");

      let layer = section.closest(".profile-edit-modal-layer");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "profile-edit-modal-layer";
        layer.setAttribute("role", "presentation");
        section.before(layer);
        layer.append(section);

        layer.addEventListener("pointerdown", (event) => {
          if (event.target !== layer) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          closeProfileModal();
        });
      }

      section.setAttribute("role", "dialog");
      section.setAttribute("aria-modal", "true");
      section.setAttribute("aria-labelledby", "profile-edit-modal-title");
      addModalHeader(section);

      if (typeof hydrateIcons === "function") {
        hydrateIcons(layer);
      }

      requestAnimationFrame(() => {
        layer.classList.add("is-visible");
        section.querySelector("[data-profile-display-name]")?.focus();
      });
    } finally {
      enhancing = false;
    }
  }

  const observer = new MutationObserver(enhanceProfileEditor);
  observer.observe(panelBody, { childList: true, subtree: true });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !panelBody.querySelector(".profile-edit-modal-layer")) {
      return;
    }

    event.preventDefault();
    closeProfileModal();
  });

  enhanceProfileEditor();
})();
