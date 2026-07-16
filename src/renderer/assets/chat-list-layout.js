(() => {
  "use strict";

  function ensureChatHeaderActions() {
    const chatPane = document.querySelector(".chat-pane");
    const head = chatPane?.querySelector(".chat-pane-head");
    const createButton = head?.querySelector('[data-action="new-chat"]');
    if (!chatPane || !head || !createButton) {
      return;
    }

    chatPane.classList.add("has-chat-folder-bar");

    let actions = head.querySelector(".chat-pane-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "chat-pane-actions";
      createButton.insertAdjacentElement("beforebegin", actions);
      actions.append(createButton);
    }

    let selectButton = actions.querySelector("[data-chat-select-placeholder]");
    if (!selectButton) {
      selectButton = document.createElement("button");
      selectButton.className = "chat-select-action";
      selectButton.type = "button";
      selectButton.dataset.chatSelectPlaceholder = "";
      selectButton.setAttribute("aria-label", "Выбрать чаты");
      selectButton.setAttribute("title", "Выбрать чаты");
      selectButton.innerHTML = '<span aria-hidden="true">•••</span>';
      actions.insertBefore(selectButton, createButton);
    }
  }

  function ensureFolderLayout() {
    const chatPane = document.querySelector(".chat-pane");
    const folderBar = chatPane?.querySelector("[data-chat-folder-bar]");
    if (!chatPane) {
      return;
    }

    chatPane.classList.toggle("has-chat-folder-bar", Boolean(folderBar));
    folderBar?.classList.add("chat-folder-bar-fixed");
    ensureChatHeaderActions();
  }

  document.addEventListener("click", (event) => {
    const placeholder = event.target.closest("[data-chat-select-placeholder]");
    if (!placeholder) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const chatPane = document.querySelector(".chat-pane");
  if (chatPane) {
    const observer = new MutationObserver(ensureFolderLayout);
    observer.observe(chatPane, { childList: true, subtree: false });
  }

  ensureFolderLayout();
  requestAnimationFrame(ensureFolderLayout);
})();