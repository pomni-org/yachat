(() => {
  "use strict";

  if (typeof renderPanel !== "function" || typeof renderChatList !== "function") {
    return;
  }

  const FOLDER_STORAGE_KEY = "yachat-chat-folders-v1";
  const ACTIVE_FOLDER_KEY = "yachat-active-chat-folder";
  const RESERVED_FOLDER_NAMES = new Set(["все", "all"]);

  let activeFolderId = "";
  let selectedFolderId = "";

  function readFolders() {
    try {
      const parsed = JSON.parse(localStorage.getItem(FOLDER_STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) {
        return [];
      }

      const seen = new Set();
      return parsed
        .map((folder) => ({
          id: String(folder?.id || "").trim(),
          name: String(folder?.name || "").trim().slice(0, 28),
          chatIds: [...new Set((Array.isArray(folder?.chatIds) ? folder.chatIds : [])
            .map((id) => String(id || "").trim())
            .filter(Boolean))]
        }))
        .filter((folder) => {
          const normalizedName = folder.name.toLocaleLowerCase("ru-RU");
          if (!folder.id || !folder.name || folder.id === "all" || folder.id === "__all__") {
            return false;
          }
          if (RESERVED_FOLDER_NAMES.has(normalizedName) || seen.has(folder.id)) {
            return false;
          }
          seen.add(folder.id);
          return true;
        });
    } catch {
      return [];
    }
  }

  function writeFolders(folders) {
    localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(folders));
  }

  function migrateFolders() {
    const folders = readFolders();
    writeFolders(folders);
    localStorage.removeItem(ACTIVE_FOLDER_KEY);
    activeFolderId = "";
    if (selectedFolderId && !folders.some((folder) => folder.id === selectedFolderId)) {
      selectedFolderId = folders[0]?.id || "";
    }
    return folders;
  }

  function setActiveFolder(id) {
    const folders = readFolders();
    const nextId = folders.some((folder) => folder.id === id) ? id : "";
    if (nextId === activeFolderId) {
      return false;
    }

    activeFolderId = nextId;
    if (nextId) {
      localStorage.setItem(ACTIVE_FOLDER_KEY, nextId);
    } else {
      localStorage.removeItem(ACTIVE_FOLDER_KEY);
    }
    renderFolderBar();
    applyFolderFilter();
    return true;
  }

  function renderFolderBar() {
    const chatPane = document.querySelector(".chat-pane");
    const searchField = chatPane?.querySelector(".search-field");
    if (!chatPane || !searchField) {
      return;
    }

    const folders = readFolders();
    if (activeFolderId && !folders.some((folder) => folder.id === activeFolderId)) {
      activeFolderId = "";
      localStorage.removeItem(ACTIVE_FOLDER_KEY);
    }

    let bar = chatPane.querySelector("[data-chat-folder-bar]");
    if (!bar) {
      bar = document.createElement("nav");
      bar.dataset.chatFolderBar = "";
      searchField.insertAdjacentElement("afterend", bar);
    }

    bar.className = "chat-folder-bar chat-folder-bar-fixed";
    bar.setAttribute("aria-label", "Папки чатов");
    bar.innerHTML = `
      <button class="${activeFolderId ? "" : "is-active"}" type="button" data-chat-folder="" aria-current="${activeFolderId ? "false" : "page"}">Все</button>
      ${folders.map((folder) => `
        <button class="${folder.id === activeFolderId ? "is-active" : ""}" type="button" data-chat-folder="${escapeHtml(folder.id)}" aria-current="${folder.id === activeFolderId ? "page" : "false"}">
          ${escapeHtml(folder.name)}
        </button>
      `).join("")}
    `;
  }

  function applyFolderFilter() {
    const folders = readFolders();
    const folder = folders.find((item) => item.id === activeFolderId) || null;
    const allowedChatIds = folder ? new Set(folder.chatIds) : null;

    document.querySelectorAll(".chat-list [data-chat-id]").forEach((row) => {
      row.hidden = Boolean(allowedChatIds && !allowedChatIds.has(String(row.dataset.chatId || "")));
    });
  }

  function avatarMarkup(chat) {
    const source = chatAvatarSource(chat);
    const modifier = getChatAvatarModifier(chat);
    const fallback = getChatAvatarText(chat) || String(getChatTitle(chat)).trim().slice(0, 1).toUpperCase() || "Я";
    const content = source
      ? `<img src="${escapeHtml(source)}" alt="" loading="lazy" />`
      : chat?.id === "yachat-favorites"
        ? iconSvg("bookmark")
        : `<span>${escapeHtml(fallback)}</span>`;

    return `<span class="folder-manager-avatar${modifier}">${content}</span>`;
  }

  function folderChatRow(chat, folder) {
    const checked = folder.chatIds.includes(chat.id);
    const subtitle = cleanDisplayText(getChatSubtitle(chat), "");
    return `
      <label class="folder-manager-chat-row">
        <input type="checkbox" data-folder-fix-chat="${escapeHtml(chat.id)}" ${checked ? "checked" : ""} />
        <span class="folder-manager-checkbox" aria-hidden="true">${iconSvg("check")}</span>
        ${avatarMarkup(chat)}
        <span class="folder-manager-chat-copy">
          <strong>${escapeHtml(getChatTitle(chat))} ${renderVerified(chat)}</strong>
          ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}
        </span>
      </label>
    `;
  }

  function renderFolderManager() {
    if (state.activePanel !== "settings" || state.settingsPage !== "folders") {
      return;
    }

    const folders = migrateFolders();
    if (!selectedFolderId || !folders.some((folder) => folder.id === selectedFolderId)) {
      selectedFolderId = folders[0]?.id || "";
    }
    const selected = folders.find((folder) => folder.id === selectedFolderId) || null;

    panelBody.innerHTML = `
      <header class="settings-detail-head folder-manager-head">
        <button type="button" data-settings-action="back" aria-label="Назад">${iconSvg("chevron-left")}</button>
        <h2>Папки</h2>
      </header>

      <section class="folder-manager-create-card">
        <form class="folder-manager-create" data-folder-fix-create>
          <input name="folderName" maxlength="28" autocomplete="off" placeholder="Название новой папки" aria-label="Название новой папки" required />
          <button type="submit">${iconSvg("plus")}<span>Создать</span></button>
        </form>
        <p>«Все» является системным разделом и всегда показывает полный список чатов.</p>
      </section>

      ${folders.length ? `
        <nav class="folder-manager-tabs" aria-label="Пользовательские папки">
          ${folders.map((folder) => `
            <button class="${folder.id === selectedFolderId ? "is-active" : ""}" type="button" data-folder-fix-select="${escapeHtml(folder.id)}">
              <span>${escapeHtml(folder.name)}</span>
              <small>${folder.chatIds.length}</small>
            </button>
          `).join("")}
        </nav>

        ${selected ? `
          <section class="folder-manager-card">
            <header class="folder-manager-card-head">
              <div>
                <strong>${escapeHtml(selected.name)}</strong>
                <small>${selected.chatIds.length ? `Выбрано чатов: ${selected.chatIds.length}` : "Выберите чаты для этой папки"}</small>
              </div>
              <button type="button" data-folder-fix-delete="${escapeHtml(selected.id)}" aria-label="Удалить папку ${escapeHtml(selected.name)}">
                ${iconSvg("trash")}
                <span>Удалить</span>
              </button>
            </header>
            <div class="folder-manager-chat-list">
              ${state.chats.length
                ? state.chats.map((chat) => folderChatRow(chat, selected)).join("")
                : `<p class="folder-manager-empty">Чатов пока нет.</p>`}
            </div>
          </section>
        ` : ""}
      ` : `
        <section class="folder-manager-empty-card">
          ${iconSvg("folder")}
          <strong>Пользовательских папок пока нет</strong>
          <p>Создайте папку сверху. Системный раздел «Все» уже работает и удалению не подлежит.</p>
        </section>
      `}
    `;

    hydrateIcons(panelBody);
  }

  const previousRenderPanel = renderPanel;
  renderPanel = function renderPanelWithFolderFix() {
    previousRenderPanel();
    renderFolderManager();
  };

  const previousRenderChatList = renderChatList;
  renderChatList = function renderChatListWithFolderFix() {
    previousRenderChatList();
    renderFolderBar();
    applyFolderFilter();
  };

  document.addEventListener("click", (event) => {
    const folderTab = event.target.closest("[data-chat-folder]");
    if (folderTab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const requestedId = String(folderTab.dataset.chatFolder || "");
      if (requestedId === activeFolderId) {
        return;
      }
      setActiveFolder(requestedId);
      return;
    }

    const selectButton = event.target.closest("[data-folder-fix-select]");
    if (selectButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      selectedFolderId = String(selectButton.dataset.folderFixSelect || "");
      renderFolderManager();
      return;
    }

    const deleteButton = event.target.closest("[data-folder-fix-delete]");
    if (deleteButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = String(deleteButton.dataset.folderFixDelete || "");
      const folders = readFolders();
      const deleted = folders.find((folder) => folder.id === id);
      const nextFolders = folders.filter((folder) => folder.id !== id);
      writeFolders(nextFolders);
      if (activeFolderId === id) {
        activeFolderId = "";
        localStorage.removeItem(ACTIVE_FOLDER_KEY);
      }
      selectedFolderId = nextFolders[0]?.id || "";
      renderFolderManager();
      renderFolderBar();
      applyFolderFilter();
      showActionFeedback(deleted ? `Папка «${deleted.name}» удалена` : "Папка удалена", { icon: "trash" });
    }
  }, true);

  document.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-folder-fix-chat]");
    if (!checkbox) {
      return;
    }

    event.stopImmediatePropagation();
    const folders = readFolders();
    const selected = folders.find((folder) => folder.id === selectedFolderId);
    if (!selected) {
      return;
    }

    const chatId = String(checkbox.dataset.folderFixChat || "");
    const chatIds = new Set(selected.chatIds);
    if (checkbox.checked) {
      chatIds.add(chatId);
    } else {
      chatIds.delete(chatId);
    }
    selected.chatIds = [...chatIds];
    writeFolders(folders);
    renderFolderManager();
    renderFolderBar();
    applyFolderFilter();
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-folder-fix-create]");
    if (!form) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const name = String(new FormData(form).get("folderName") || "").trim().slice(0, 28);
    const normalizedName = name.toLocaleLowerCase("ru-RU");
    const folders = readFolders();

    if (!name) {
      return;
    }
    if (RESERVED_FOLDER_NAMES.has(normalizedName)) {
      showActionFeedback("«Все» уже существует как системный раздел", { tone: "error", icon: "circle-alert" });
      return;
    }
    if (folders.some((folder) => folder.name.toLocaleLowerCase("ru-RU") === normalizedName)) {
      showActionFeedback("Папка с таким названием уже существует", { tone: "error", icon: "circle-alert" });
      return;
    }

    const id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `folder-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    folders.push({ id, name, chatIds: [] });
    writeFolders(folders);
    selectedFolderId = id;
    form.reset();
    renderFolderManager();
    renderFolderBar();
    showActionFeedback(`Папка «${name}» создана`, { icon: "folder" });
  }, true);

  migrateFolders();
  renderFolderBar();
  applyFolderFilter();
})();