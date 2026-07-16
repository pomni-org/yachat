(() => {
  "use strict";

  const panelBody = document.querySelector("[data-panel-body]");
  const sidePanel = document.querySelector("[data-side-panel]");
  if (!panelBody || !sidePanel) {
    return;
  }

  let activeSection = null;
  let backdrop = null;
  let modalWasOpen = false;
  let backdropRemovalTimer = null;

  function closeProfileModal() {
    panelBody
      .querySelector('.profile-edit-section [data-panel-action="cancel-profile-edit"]')
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

  function ensureBackdrop() {
    window.clearTimeout(backdropRemovalTimer);
    backdropRemovalTimer = null;

    if (!backdrop || !backdrop.isConnected) {
      backdrop = document.createElement("div");
      backdrop.className = "profile-edit-modal-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.addEventListener("pointerdown", (event) => {
        if (event.target !== backdrop) {
          return;
        }
        event.preventDefault();
        closeProfileModal();
      });
      sidePanel.append(backdrop);
    }

    requestAnimationFrame(() => backdrop?.classList.add("is-visible"));
  }

  function removeBackdrop() {
    if (!backdrop) {
      return;
    }

    const currentBackdrop = backdrop;
    backdrop = null;
    currentBackdrop.classList.remove("is-visible");
    backdropRemovalTimer = window.setTimeout(() => {
      currentBackdrop.remove();
      backdropRemovalTimer = null;
    }, 190);
  }

  function openModal(section) {
    const isFirstOpen = !modalWasOpen;
    modalWasOpen = true;
    activeSection = section;

    document.body.classList.add("profile-edit-modal-open");
    section.setAttribute("role", "dialog");
    section.setAttribute("aria-modal", "true");
    section.setAttribute("aria-labelledby", "profile-edit-modal-title");
    addModalHeader(section);
    ensureBackdrop();

    if (typeof hydrateIcons === "function") {
      hydrateIcons(section);
    }

    requestAnimationFrame(() => {
      if (!section.isConnected) {
        return;
      }
      section.classList.add("is-profile-modal-visible");
      if (isFirstOpen) {
        section.querySelector("[data-profile-display-name]")?.focus();
      }
    });
  }

  function closeModalUi() {
    if (!modalWasOpen && !activeSection) {
      return;
    }

    activeSection?.classList.remove("is-profile-modal-visible");
    activeSection = null;
    document.body.classList.remove("profile-edit-modal-open");
    removeBackdrop();

    if (modalWasOpen) {
      modalWasOpen = false;
      requestAnimationFrame(() => {
        document.querySelector('[data-panel-action="edit-profile"]')?.focus();
      });
    }
  }

  function syncProfileModal() {
    const section = panelBody.querySelector(".profile-edit-section");

    if (!section) {
      closeModalUi();
      return;
    }

    if (section === activeSection) {
      return;
    }

    openModal(section);
  }

  const observer = new MutationObserver(syncProfileModal);
  observer.observe(panelBody, { childList: true, subtree: true });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !panelBody.querySelector(".profile-edit-section")) {
      return;
    }
    event.preventDefault();
    closeProfileModal();
  });

  syncProfileModal();
})();
