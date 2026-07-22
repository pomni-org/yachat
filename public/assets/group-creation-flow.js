(() => {
  "use strict";

  if (
    typeof createChatModal === "undefined"
    || typeof createChatForm === "undefined"
    || !createChatModal
    || !createChatForm
  ) {
    return;
  }

  const copy = {
    ru: {
      participantsTitle: "Выберите участников",
      search: "Найти по имени",
      emptyGroup: "Создать пустую группу",
      continue: "Продолжить",
      detailsTitle: "Новая группа",
      detailsHint: "Добавьте фото, чтобы чат узнавали с первого взгляда",
      groupName: "Название группы",
      createGroup: "Создать группу",
      noPeople: "Подходящих контактов нет",
      loading: "Загружаем контакты…",
      back: "Назад",
      addPhoto: "Добавить фото группы",
      createFailed: "Не удалось создать группу"
    },
    en: {
      participantsTitle: "Choose participants",
      search: "Search by name",
      emptyGroup: "Create empty group",
      continue: "Continue",
      detailsTitle: "New group",
      detailsHint: "Add a photo so the chat is easy to recognize",
      groupName: "Group name",
      createGroup: "Create group",
      noPeople: "No matching contacts",
      loading: "Loading contacts…",
      back: "Back",
      addPhoto: "Add group photo",
      createFailed: "Could not create the group"
    }
  };

  const alphabet = {
    ru: ["А", "Б", "В", "Г", "Д", "Е", "Ж", "З", "И", "К", "Л", "М", "Н", "О", "П", "Р", "С", "Т", "У", "Ф", "Х", "Ц", "Ч", "Ш", "Щ", "Э", "Ю", "Я", "#"],
    en: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"]
  };

  const flow = {
    ready: false,
    step: "participants",
    title: "",
    query: "",
    creating: false,
    directoryUsers: [],
    selectedUsers: new Map(),
    searchTimer: null,
    requestId: 0,
    restoreSearchFocus: false,
    searchCaret: 0
  };

  function language() {
    return state?.language === "en" ? "en" : "ru";
  }

  function tr(key) {
    return copy[language()][key] || copy.ru[key] || key;
  }

  function escape(value) {
    return typeof escapeHtml === "function" ? escapeHtml(String(value ?? "")) : String(value ?? "");
  }

  function normalizeLetter(value) {
    const letter = String(value || "#").trim().slice(0, 1).toUpperCase();
    return /[A-ZА-ЯЁ]/u.test(letter) ? letter.replace("Ё", "Е") : "#";
  }

  function selectedIds() {
    return [...new Set(state.createChatSelectedIds || [])];
  }

  function selectedCount() {
    return selectedIds().length;
  }

  function rememberUsers(users) {
    (users || []).forEach((user) => {
      if (user?.id && selectedIds().includes(user.id)) {
        flow.selectedUsers.set(user.id, user);
      }
    });
    for (const id of [...flow.selectedUsers.keys()]) {
      if (!selectedIds().includes(id)) {
        flow.selectedUsers.delete(id);
      }
    }
  }

  function allVisibleUsers() {
    const query = flow.query.trim().toLocaleLowerCase(language() === "en" ? "en" : "ru");
    const source = mergeUsers(
      [...flow.selectedUsers.values()],
      flow.directoryUsers,
      typeof historicalChatUsers === "function" ? historicalChatUsers(flow.query) : []
    );
    return source
      .filter((user) => user?.id && user.id !== state.account?.id)
      .filter((user) => {
        if (!query) return true;
        const haystack = [user.displayName, user.previewName, user.username, user.contact]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase(language() === "en" ? "en" : "ru");
        return haystack.includes(query);
      })
      .sort((left, right) => String(left.displayName || left.username || "")
        .localeCompare(String(right.displayName || right.username || ""), language() === "en" ? "en" : "ru", { sensitivity: "base" }));
  }

  function userSubtitle(user) {
    return cleanDisplayText(
      user.statusText || user.lastSeenText || user.subtitle || (user.username ? `@${user.username}` : user.contact),
      ""
    );
  }

  function cameraMarkup() {
    return `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M20 20l4-6h16l4 6h6a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6h6Z" fill="currentColor" opacity=".9"/>
        <circle cx="32" cy="37" r="10" fill="none" stroke="var(--page)" stroke-width="5"/>
        <path d="M49 43v14M42 50h14" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>
      </svg>
    `;
  }

  function backMarkup() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function checkMarkup() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12 4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function headerMarkup() {
    const details = flow.step === "details";
    return `
      <header class="group-flow-header">
        <button class="group-flow-back" type="button" data-group-back aria-label="${escape(tr("back"))}">${backMarkup()}</button>
        <div class="group-flow-heading">
          <h1>${escape(details ? tr("detailsTitle") : tr("participantsTitle"))}</h1>
          ${details ? `<p>${escape(tr("detailsHint"))}</p>` : ""}
        </div>
        <span class="group-flow-header-spacer" aria-hidden="true"></span>
      </header>
    `;
  }

  function participantRowsMarkup() {
    if (state.createChatSearchLoading && !flow.directoryUsers.length) {
      return `<p class="group-flow-empty">${escape(tr("loading"))}</p>`;
    }

    if (state.createChatSearchError) {
      return `<p class="group-flow-empty">${escape(state.createChatSearchError)}</p>`;
    }

    const users = allVisibleUsers();
    if (!users.length) {
      return `<p class="group-flow-empty">${escape(tr("noPeople"))}</p>`;
    }

    const groups = new Map();
    users.forEach((user) => {
      const letter = normalizeLetter(user.displayName || user.username);
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(user);
    });

    return [...groups.entries()].map(([letter, items]) => `
      <section class="group-flow-letter-section" id="group-letter-${encodeURIComponent(letter)}" data-group-letter-section="${escape(letter)}">
        <h2>${escape(letter)}</h2>
        ${items.map((user) => {
          const checked = selectedIds().includes(user.id);
          return `
            <button class="group-flow-user-row${checked ? " is-selected" : ""}" type="button" data-group-user="${escape(user.id)}" aria-pressed="${checked}">
              <span class="group-flow-selection" aria-hidden="true">${checked ? checkMarkup() : ""}</span>
              ${renderUserAvatar(user)}
              <span class="group-flow-user-copy">
                <strong>${escape(user.displayName)} ${renderVerified(user)}</strong>
                <small>${escape(userSubtitle(user))}</small>
              </span>
            </button>
          `;
        }).join("")}
      </section>
    `).join("");
  }

  function alphabetMarkup() {
    const present = new Set(allVisibleUsers().map((user) => normalizeLetter(user.displayName || user.username)));
    return `
      <nav class="group-flow-alphabet" aria-label="${escape(tr("participantsTitle"))}">
        ${alphabet[language()].map((letter) => `
          <button type="button" data-group-jump="${escape(letter)}" ${present.has(letter) ? "" : "disabled"}>${escape(letter)}</button>
        `).join("")}
      </nav>
    `;
  }

  function participantStepMarkup() {
    const count = selectedCount();
    return `
      ${headerMarkup()}
      <main class="group-flow-main group-flow-participants-main">
        <label class="group-flow-search">
          <span>${escape(tr("search"))}</span>
          <input name="peopleSearch" type="search" autocomplete="off" value="${escape(flow.query)}" placeholder="${escape(tr("search"))}" data-group-search />
        </label>
        <div class="group-flow-contact-list" data-group-contact-list>${participantRowsMarkup()}</div>
        ${alphabetMarkup()}
      </main>
      <footer class="group-flow-footer">
        <p class="group-flow-message" data-message="create-chat"></p>
        <button class="group-flow-primary" type="submit" ${flow.creating ? "disabled" : ""}>
          <span>${escape(count ? tr("continue") : tr("emptyGroup"))}</span>
          ${count ? `<b class="group-flow-count">${count}</b>` : ""}
        </button>
      </footer>
    `;
  }

  function detailStepMarkup() {
    const avatar = state.pendingCreateChatAvatarDataUrl || "";
    return `
      ${headerMarkup()}
      <main class="group-flow-main group-flow-details-main">
        <button class="group-details-avatar" type="button" data-group-avatar aria-label="${escape(tr("addPhoto"))}">
          ${avatar ? `<img src="${escape(avatar)}" alt="" />` : cameraMarkup()}
        </button>
        <input class="group-details-name" name="title" type="text" maxlength="60" autocomplete="off" value="${escape(flow.title)}" placeholder="${escape(tr("groupName"))}" aria-label="${escape(tr("groupName"))}" data-group-title />
        <input class="visually-hidden" type="file" accept="image/*" data-group-avatar-input />
      </main>
      <footer class="group-flow-footer">
        <p class="group-flow-message" data-message="create-chat"></p>
        <button class="group-flow-primary" type="submit" ${!flow.title.trim() || flow.creating ? "disabled" : ""}>
          <span>${escape(tr("createGroup"))}</span>
        </button>
      </footer>
    `;
  }

  function render() {
    if (!flow.ready) return;
    createChatModal.dataset.groupFlowStep = flow.step;
    createChatForm.innerHTML = flow.step === "details" ? detailStepMarkup() : participantStepMarkup();

    if (flow.step === "participants" && flow.restoreSearchFocus) {
      const input = createChatForm.querySelector("[data-group-search]");
      requestAnimationFrame(() => {
        input?.focus({ preventScroll: true });
        input?.setSelectionRange(flow.searchCaret, flow.searchCaret);
      });
      flow.restoreSearchFocus = false;
    }
  }

  function preserveSearchFocus() {
    if (flow.step !== "participants") return;
    flow.restoreSearchFocus = true;
    flow.searchCaret = flow.query.length;
  }

  async function fetchDirectory(query = "") {
    const requestId = ++flow.requestId;
    state.createChatSearchLoading = true;
    state.createChatSearchError = "";
    preserveSearchFocus();
    render();

    try {
      const users = yachatApi.users?.search
        ? await yachatApi.users.search(query)
        : await yachatApi.users.list();
      if (requestId !== flow.requestId) return;
      const normalized = (users || []).map((user) => typeof normalizeUser === "function" ? normalizeUser(user) : user);
      flow.directoryUsers = mergeUsers(flow.directoryUsers, normalized);
      rememberUsers(normalized);
    } catch (error) {
      if (requestId !== flow.requestId) return;
      state.createChatSearchError = translatedServerMessage(error.message, "contactsUnavailable");
    } finally {
      if (requestId === flow.requestId) {
        state.createChatSearchLoading = false;
        preserveSearchFocus();
        render();
      }
    }
  }

  function scheduleDirectorySearch() {
    window.clearTimeout(flow.searchTimer);
    const query = flow.query.trim();
    if (query.length < 2) {
      state.createChatSearchLoading = false;
      state.createChatSearchError = "";
      render();
      return;
    }
    flow.searchTimer = window.setTimeout(() => void fetchDirectory(query), 180);
  }

  function resetFlow() {
    window.clearTimeout(flow.searchTimer);
    flow.step = "participants";
    flow.title = "";
    flow.query = "";
    flow.creating = false;
    flow.directoryUsers = [];
    flow.selectedUsers.clear();
    flow.requestId += 1;
    flow.restoreSearchFocus = false;
    state.newChatKind = "group";
    state.createChatSelectedIds = [];
    state.pendingCreateChatAvatarDataUrl = "";
    state.createChatSearchError = "";
    state.createChatSearchLoading = false;
    state.createChatSearchRequestId += 1;
  }

  function openFlow() {
    resetFlow();
    createChatModal.hidden = false;
    document.body.classList.add("group-creation-open");
    render();
    requestAnimationFrame(() => createChatForm.querySelector("[data-group-search]")?.focus());
    void fetchDirectory("");
  }

  function closeFlow() {
    window.clearTimeout(flow.searchTimer);
    flow.requestId += 1;
    createChatModal.hidden = true;
    document.body.classList.remove("group-creation-open");
    resetFlow();
  }

  function toggleUser(userId) {
    const user = allVisibleUsers().find((item) => item.id === userId)
      || flow.directoryUsers.find((item) => item.id === userId)
      || flow.selectedUsers.get(userId);
    const ids = new Set(selectedIds());
    if (ids.has(userId)) {
      ids.delete(userId);
      flow.selectedUsers.delete(userId);
    } else {
      ids.add(userId);
      if (user) flow.selectedUsers.set(userId, user);
    }
    state.createChatSelectedIds = [...ids];
    render();
  }

  async function createGroup() {
    if (flow.creating || !flow.title.trim()) return;
    flow.creating = true;
    render();

    try {
      const result = await yachatApi.messenger.createChat({
        kind: "group",
        participantIds: selectedIds(),
        title: flow.title.trim(),
        description: "",
        avatarDataUrl: state.pendingCreateChatAvatarDataUrl || ""
      });

      state.chats = result.chats || await yachatApi.messenger.chats();
      state.activeChatId = result.chat?.id || state.activeChatId;
      state.messages = result.messages || [];

      closeFlow();

      try { renderChatList(); } catch {}
      try { renderActiveChat(); } catch {}
      try { renderMessages(); } catch {}
      try { setMobileDialogOpen(true); } catch {}
    } catch (error) {
      flow.creating = false;
      render();
      const message = createChatForm.querySelector('[data-message="create-chat"]');
      if (message) {
        message.textContent = translatedServerMessage(error.message, "errSendMessage") || tr("createFailed");
      }
    }
  }

  function prepare() {
    if (flow.ready) return;
    flow.ready = true;
    createChatModal.className = "group-flow-layer";
    createChatForm.className = "group-flow-screen";
    createChatForm.setAttribute("novalidate", "");

    createChatForm.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (flow.step === "participants") {
        flow.step = "details";
        render();
        requestAnimationFrame(() => createChatForm.querySelector("[data-group-title]")?.focus());
        return;
      }
      void createGroup();
    }, true);

    createChatForm.addEventListener("input", (event) => {
      const search = event.target.closest("[data-group-search]");
      if (search) {
        event.stopImmediatePropagation();
        flow.query = search.value;
        flow.restoreSearchFocus = true;
        flow.searchCaret = search.selectionStart ?? search.value.length;
        scheduleDirectorySearch();
        return;
      }

      const title = event.target.closest("[data-group-title]");
      if (title) {
        event.stopImmediatePropagation();
        flow.title = title.value;
        const submit = createChatForm.querySelector('.group-flow-primary[type="submit"]');
        if (submit) submit.disabled = !flow.title.trim() || flow.creating;
      }
    }, true);

    createChatForm.addEventListener("click", (event) => {
      const back = event.target.closest("[data-group-back]");
      if (back) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (flow.step === "details") {
          flow.step = "participants";
          render();
          return;
        }
        closeFlow();
        return;
      }

      const user = event.target.closest("[data-group-user]");
      if (user) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toggleUser(user.dataset.groupUser);
        return;
      }

      const jump = event.target.closest("[data-group-jump]");
      if (jump && !jump.disabled) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const target = createChatForm.querySelector(`[data-group-letter-section="${CSS.escape(jump.dataset.groupJump)}"]`);
        target?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }

      const avatar = event.target.closest("[data-group-avatar]");
      if (avatar) {
        event.preventDefault();
        event.stopImmediatePropagation();
        createChatForm.querySelector("[data-group-avatar-input]")?.click();
      }
    }, true);

    createChatForm.addEventListener("change", async (event) => {
      const input = event.target.closest("[data-group-avatar-input]");
      if (!input) return;
      event.stopImmediatePropagation();
      const file = input.files?.[0];
      if (!file) return;
      try {
        state.pendingCreateChatAvatarDataUrl = await readAvatarFile(file);
        render();
      } catch (error) {
        if (!error?.cancelled) {
          const message = createChatForm.querySelector('[data-message="create-chat"]');
          if (message) message.textContent = translatedServerMessage(error.message, "errAvatar");
        }
      }
    }, true);

    createChatModal.addEventListener("click", (event) => {
      if (event.target === createChatModal) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  prepare();
  openCreateChat = openFlow;
  closeCreateChat = closeFlow;
  renderCreateChatForm = render;
  createChatFromForm = () => {};

  const languageObserver = new MutationObserver(() => {
    if (!createChatModal.hidden) render();
  });
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
})();