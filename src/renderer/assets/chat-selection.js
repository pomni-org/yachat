(() => {
  "use strict";

  if (typeof renderChatList !== "function" || !chatList) {
    return;
  }

  const selectedChatIds = new Set();
  let selectionMode = false;
  let selectionButton = null;
  let chatPane = null;

  function ensureHeaderActions() {
    chatPane = document.querySelector(".chat-pane");
    const header = chatPane?.querySelector(".chat-pane-head");
    const createButton = header?.querySelector('[data-action="new-chat"]');
    if (!header || !createButton) {
      return;
    }

    if (createButton.dataset.centeredPlus !== "true" && typeof iconSvg === "function") {
      createButton.innerHTML = iconSvg("plus");
      createButton.dataset.centeredPlus = "true";
    }

    let actions = header.querySelector("[data-chat-head-actions]");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "chat-pane-actions";
      actions.dataset.chatHeadActions = "";
      createButton.insertAdjacentElement("beforebegin", actions);
      actions.append(createButton);
    }

    selectionButton = actions.querySelector("[data-action='toggle-chat-selection']");
    if (!selectionButton) {
      selectionButton = document.createElement("button");
      selectionButton.className = "chat-selection-toggle";
      selectionButton.type = "button";
      selectionButton.dataset.action = "toggle-chat-selection";
      selectionButton.setAttribute("aria-label", "Выбрать чаты");
      selectionButton.setAttribute("aria-pressed", "false");
      selectionButton.innerHTML = typeof iconSvg === "function"
        ? iconSvg("ellipsis")
        : '<span aria-hidden="true">•••</span>';
      actions.insertBefore(selectionButton, createButton);
    }

    if (typeof hydrateIcons === "function") {
      hydrateIcons(actions);
    }
  }

  function updateSelectionCheckbox(row, chatId) {
    const selected = selectedChatIds.has(chatId);
    let checkbox = row.querySelector(":scope > .chat-select-check");

    if (!selectionMode) {
      checkbox?.remove();
      return;
    }

    if (!checkbox) {
      checkbox = document.createElement("span");
      checkbox.className = "chat-select-check";
      checkbox.setAttribute("aria-hidden", "true");
      checkbox.innerHTML = typeof iconSvg === "function" ? iconSvg("check") : "✓";
      row.prepend(checkbox);
    }

    checkbox.classList.toggle("is-selected", selected);
  }

  function decorateRows() {
    ensureHeaderActions();
    chatPane?.classList.toggle("is-chat-selection-mode", selectionMode);
    selectionButton?.classList.toggle("is-active", selectionMode);
    selectionButton?.setAttribute("aria-pressed", selectionMode ? "true" : "false");
    selectionButton?.setAttribute(
      "aria-label",
      selectionMode
        ? `Завершить выбор. Выбрано: ${selectedChatIds.size}`
        : "Выбрать чаты"
    );

    chatList.querySelectorAll("[data-chat-id]").forEach((row) => {
      const chatId = String(row.dataset.chatId || "");
      const selected = selectedChatIds.has(chatId);
      row.classList.toggle("is-chat-selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      updateSelectionCheckbox(row, chatId);
    });

    if (typeof hydrateIcons === "function") {
      hydrateIcons(chatList);
    }
  }

  function leaveSelectionMode() {
    selectionMode = false;
    selectedChatIds.clear();
    decorateRows();
  }

  const previousRenderChatList = renderChatList;
  renderChatList = function renderChatListWithSelection() {
    previousRenderChatList();
    decorateRows();
  };

  document.addEventListener("click", (event) => {
    const toggle = event.target.closest('[data-action="toggle-chat-selection"]');
    if (toggle) {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectionMode = !selectionMode;
      if (!selectionMode) {
        selectedChatIds.clear();
      }
      decorateRows();
      return;
    }

    if (!selectionMode) {
      return;
    }

    const row = event.target.closest(".chat-list [data-chat-id]");
    if (!row) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const chatId = String(row.dataset.chatId || "");
    if (selectedChatIds.has(chatId)) {
      selectedChatIds.delete(chatId);
    } else {
      selectedChatIds.add(chatId);
    }
    decorateRows();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (selectionMode && event.key === "Escape") {
      event.preventDefault();
      leaveSelectionMode();
    }
  });

  ensureHeaderActions();
  decorateRows();
})();