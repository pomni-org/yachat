(() => {
  "use strict";

  if (
    typeof createChatModal === "undefined"
    || typeof createChatForm === "undefined"
    || !createChatModal
    || !createChatForm
    || typeof openCreateChat !== "function"
    || typeof closeCreateChat !== "function"
  ) {
    return;
  }

  const flow = {
    prepared: false,
    step: "participants",
    selectedUsers: new Map()
  };

  const originalOpenCreateChat = openCreateChat;
  const originalCloseCreateChat = closeCreateChat;

  const copy = {
    ru: {
      participantsTitle: "Выберите участников",
      participantsSearch: "Найти по имени или нику",
      emptyGroup: "Создать пустую группу",
      continue: "Продолжить",
      detailsTitle: "Новая группа",
      detailsHint: "Добавьте фото, чтобы чат узнавали с первого взгляда",
      groupName: "Название группы",
      createGroup: "Создать группу",
      noPeople: "Подходящих аккаунтов нет.",
      searching: "Ищем людей…",
      selected: "Выбрано: {count}",
      back: "Назад",
      close: "Закрыть"
    },
    en: {
      participantsTitle: "Choose participants",
      participantsSearch: "Search by name or username",
      emptyGroup: "Create empty group",
      continue: "Continue",
      detailsTitle: "New group",
      detailsHint: "Add a photo so the chat is easy to recognize",
      groupName: "Group name",
      createGroup: "Create group",
      noPeople: "No matching accounts.",
      searching: "Searching for people…",
      selected: "Selected: {count}",
      back: "Back",
      close: "Close"
    }
  };

  function language() {
    return state?.language === "en" ? "en" : "ru";
  }

  function tr(key, params = {}) {
    let value = copy[language()][key] || copy.ru[key] || key;
    Object.entries(params).forEach(([name, replacement]) => {
      value = value.replaceAll(`{${name}}`, String(replacement));
    });
    return value;
  }

  function normalizedLetter(value) {
    const letter = String(value || "#").trim().slice(0, 1).toUpperCase();
    return /[A-ZА-ЯЁ]/.test(letter) ? letter : "#";
  }

  function ensureStructure() {
    if (flow.prepared) {
      return;
    }

    const header = createChatForm.querySelector("header");
    const oldBack = header?.querySelector('[data-action="close-create-chat"]');
    const titleField = createChatForm.querySelector('label:has([name="title"])');
    const avatarBlock = createChatForm.querySelector(".create-chat-avatar");
    const descriptionField = createChatForm.querySelector('label:has([name="description"])');
    const peopleField = createChatForm.querySelector('label:has([data-create-people-search])');
    const results = createChatForm.querySelector("[data-create-user-results]");
    const selected = createChatForm.querySelector("[data-create-selected-users]");
    const message = createChatForm.querySelector('[data-message="create-chat"]');
    const submit = createChatForm.querySelector('.main-button[type="submit"]');

    if (!header || !oldBack || !titleField || !avatarBlock || !peopleField || !results || !selected || !message || !submit) {
      return;
    }

    createChatModal.classList.add("group-creation-layer");
    createChatForm.classList.add("group-creation-screen");

    const back = oldBack.cloneNode(true);
    back.removeAttribute("data-action");
    back.dataset.groupFlowBack = "";
    back.className = "group-flow-back";
    back.innerHTML = iconSvg("chevron-left");
    oldBack.replaceWith(back);

    const heading = document.createElement("div");
    heading.className = "group-flow-heading";
    heading.innerHTML = '<h2 data-group-flow-title></h2><p data-group-flow-subtitle></p>';

    const spacer = document.createElement("span");
    spacer.className = "group-flow-header-spacer";
    spacer.setAttribute("aria-hidden", "true");
    header.replaceChildren(back, heading, spacer);
    header.classList.add("group-flow-header");

    const body = document.createElement("div");
    body.className = "group-flow-body";

    const participantsStep = document.createElement("section");
    participantsStep.className = "group-flow-step group-flow-participants";
    participantsStep.dataset.groupFlowStep = "participants";

    const detailsStep = document.createElement("section");
    detailsStep.className = "group-flow-step group-flow-details";
    detailsStep.dataset.groupFlowStep = "details";

    const footer = document.createElement("footer");
    footer.className = "group-flow-footer";

    peopleField.classList.add("group-flow-search");
    results.classList.add("group-flow-user-list");
    selected.classList.add("group-flow-selected-strip");
    titleField.classList.add("group-flow-title-field");
    avatarBlock.classList.add("group-flow-avatar");
    message.classList.add("group-flow-message");
    submit.classList.add("group-flow-submit");

    if (descriptionField) {
      descriptionField.hidden = true;
      descriptionField.classList.add("group-flow-description-disabled");
      const textarea = descriptionField.querySelector("textarea");
      if (textarea) {
        textarea.disabled = true;
        textarea.value = "";
      }
    }

    participantsStep.append(peopleField, selected, results);
    detailsStep.append(avatarBlock, titleField);
    if (descriptionField) {
      detailsStep.append(descriptionField);
    }
    body.append(participantsStep, detailsStep);
    footer.append(message, submit);
    createChatForm.append(body, footer);

    const searchInput = peopleField.querySelector("[data-create-people-search]");
    searchInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
      }
    });

    createChatForm.addEventListener("click", (event) => {
      const addButton = event.target.closest("[data-create-user-id]");
      if (addButton) {
        const user = (state.createChatUsers || []).find((item) => item.id === addButton.dataset.createUserId);
        if (user) {
          flow.selectedUsers.set(user.id, user);
        }
        return;
      }

      const removeButton = event.target.closest("[data-remove-create-user]");
      if (removeButton) {
        flow.selectedUsers.delete(removeButton.dataset.removeCreateUser);
      }
    }, true);

    back.addEventListener("click", () => {
      if (flow.step === "details") {
        flow.step = "participants";
        setMessage("create-chat", "");
        renderCreateChatForm();
        requestAnimationFrame(() => createChatForm.elements.peopleSearch?.focus());
        return;
      }
      closeCreateChat();
    });

    flow.prepared = true;
  }

  function selectedUsers() {
    const selectedIds = new Set(state.createChatSelectedIds || []);
    (state.createChatUsers || []).forEach((user) => {
      if (user?.id && selectedIds.has(user.id)) {
        flow.selectedUsers.set(user.id, user);
      }
    });
    for (const id of [...flow.selectedUsers.keys()]) {
      if (!selectedIds.has(id)) {
        flow.selectedUsers.delete(id);
      }
    }
    return [...selectedIds].map((id) => flow.selectedUsers.get(id)).filter(Boolean);
  }

  function renderSelectedStrip(users) {
    const target = createChatForm.querySelector("[data-create-selected-users]");
    if (!target) {
      return;
    }

    target.hidden = users.length === 0;
    target.setAttribute("aria-label", tr("selected", { count: users.length }));
    target.innerHTML = users.map((user) => `
      <button class="group-flow-selected-person" type="button" data-remove-create-user="${escapeHtml(user.id)}" aria-label="${escapeHtml(user.displayName)}">
        ${renderUserAvatar(user)}
        <span>${escapeHtml(user.displayName)}</span>
        ${iconSvg("x")}
      </button>
    `).join("");
  }

  function renderUserRows() {
    const target = createChatForm.querySelector("[data-create-user-results]");
    if (!target) {
      return;
    }

    if (state.createChatSearchLoading) {
      target.innerHTML = `<p class="group-flow-empty">${escapeHtml(tr("searching"))}</p>`;
      return;
    }

    if (state.createChatSearchError) {
      target.innerHTML = `<p class="group-flow-empty">${escapeHtml(state.createChatSearchError)}</p>`;
      return;
    }

    const selectedIds = new Set(state.createChatSelectedIds || []);
    const users = [...(state.createChatUsers || [])]
      .filter((user) => user?.id && user.id !== state.account?.id)
      .sort((left, right) => String(left.displayName || left.username || "")
        .localeCompare(String(right.displayName || right.username || ""), language() === "en" ? "en" : "ru", { sensitivity: "base" }));

    if (!users.length) {
      target.innerHTML = `<p class="group-flow-empty">${escapeHtml(tr("noPeople"))}</p>`;
      return;
    }

    const groups = new Map();
    users.forEach((user) => {
      const letter = normalizedLetter(user.displayName || user.username);
      if (!groups.has(letter)) {
        groups.set(letter, []);
      }
      groups.get(letter).push(user);
    });

    target.innerHTML = [...groups.entries()].map(([letter, group]) => `
      <section class="group-flow-letter-section">
        <h3>${escapeHtml(letter)}</h3>
        ${group.map((user) => {
          const isSelected = selectedIds.has(user.id);
          const actionAttribute = isSelected
            ? `data-remove-create-user="${escapeHtml(user.id)}"`
            : `data-create-user-id="${escapeHtml(user.id)}"`;
          const subtitle = user.username
            ? `@${user.username}`
            : cleanDisplayText(user.contact, "");
          return `
            <button class="group-flow-user-row${isSelected ? " is-selected" : ""}" type="button" ${actionAttribute} aria-pressed="${isSelected ? "true" : "false"}">
              <span class="group-flow-selection">${isSelected ? iconSvg("check") : ""}</span>
              ${renderUserAvatar(user)}
              <span class="group-flow-user-copy">
                <strong>${escapeHtml(user.displayName)} ${renderVerified(user)}</strong>
                <small>${escapeHtml(subtitle)}</small>
              </span>
            </button>
          `;
        }).join("")}
      </section>
    `).join("");
  }

  function updateHeader() {
    const title = createChatForm.querySelector("[data-group-flow-title]");
    const subtitle = createChatForm.querySelector("[data-group-flow-subtitle]");
    const back = createChatForm.querySelector("[data-group-flow-back]");

    if (title) {
      title.textContent = flow.step === "details" ? tr("detailsTitle") : tr("participantsTitle");
    }
    if (subtitle) {
      subtitle.textContent = flow.step === "details" ? tr("detailsHint") : "";
      subtitle.hidden = flow.step !== "details";
    }
    if (back) {
      back.setAttribute("aria-label", flow.step === "details" ? tr("back") : tr("close"));
    }
  }

  renderCreateChatForm = function renderCreateChatFullScreenFlow() {
    ensureStructure();
    if (!flow.prepared) {
      return;
    }

    state.newChatKind = "group";
    const people = selectedUsers();
    const selectedCount = (state.createChatSelectedIds || []).length;
    const searchInput = createChatForm.elements.peopleSearch;
    const titleInput = createChatForm.elements.title;
    const titleLabel = createChatForm.querySelector("[data-create-title-label]");
    const peopleLabel = createChatForm.querySelector("[data-create-people-label]");
    const avatarTitle = createChatForm.querySelector("[data-create-avatar-title]");
    const avatarAction = createChatForm.querySelector("[data-create-avatar-action]");
    const submit = createChatForm.querySelector('.main-button[type="submit"]');

    createChatModal.dataset.groupFlowStep = flow.step;
    createChatForm.querySelectorAll("[data-group-flow-step]").forEach((section) => {
      section.hidden = section.dataset.groupFlowStep !== flow.step;
    });

    updateHeader();

    if (searchInput) {
      searchInput.placeholder = tr("participantsSearch");
      searchInput.setAttribute("aria-label", tr("participantsSearch"));
    }
    if (peopleLabel) {
      peopleLabel.textContent = tr("participantsSearch");
    }
    if (titleInput) {
      titleInput.required = flow.step === "details";
      titleInput.placeholder = tr("groupName");
      titleInput.setAttribute("aria-label", tr("groupName"));
    }
    if (titleLabel) {
      titleLabel.textContent = tr("groupName");
    }
    if (avatarTitle) {
      avatarTitle.textContent = t("groupAvatar");
    }
    if (avatarAction) {
      avatarAction.textContent = t("chooseGroupAvatar");
    }

    renderSelectedStrip(people);
    renderUserRows();

    if (submit) {
      if (flow.step === "participants") {
        submit.disabled = false;
        submit.innerHTML = selectedCount > 0
          ? `<span>${escapeHtml(tr("continue"))}</span><b class="group-flow-count">${selectedCount}</b>`
          : `<span>${escapeHtml(tr("emptyGroup"))}</span>`;
      } else {
        submit.disabled = !String(titleInput?.value || "").trim();
        submit.innerHTML = `<span>${escapeHtml(tr("createGroup"))}</span>`;
      }
    }

    updateCreateChatAvatarPreview();
  };

  createChatFromForm = async function createChatFromFullScreenFlow(submitButton) {
    if (flow.step === "participants") {
      flow.step = "details";
      setMessage("create-chat", "");
      renderCreateChatForm();
      requestAnimationFrame(() => createChatForm.elements.title?.focus());
      return;
    }

    const title = String(createChatForm.elements.title?.value || "").trim();
    const participantIds = [...new Set(state.createChatSelectedIds || [])];
    if (!title) {
      setMessage("create-chat", t("errGroupName"));
      createChatForm.elements.title?.focus();
      return;
    }

    setLoading(submitButton, true);
    setMessage("create-chat", "");

    try {
      const result = await yachatApi.messenger.createChat({
        kind: "group",
        participantIds,
        title,
        description: "",
        avatarDataUrl: state.pendingCreateChatAvatarDataUrl || ""
      });
      state.chats = result.chats || await yachatApi.messenger.chats();
      state.activeChatId = result.chat?.id || state.activeChatId;
      state.messages = result.messages || await yachatApi.messenger.messages(state.activeChatId);
      closeCreateChat();
      renderChatList();
      renderActiveChat();
      renderMessages();
      setMobileDialogOpen(true);
    } catch (error) {
      setMessage("create-chat", translatedServerMessage(error.message, "errSendMessage"));
    } finally {
      setLoading(submitButton, false);
      if (!createChatModal.hidden) {
        renderCreateChatForm();
      }
    }
  };

  openCreateChat = function openCreateChatFullScreen() {
    ensureStructure();
    flow.step = "participants";
    flow.selectedUsers.clear();
    originalOpenCreateChat();
    document.body.classList.add("group-creation-open");
    createChatModal.dataset.groupFlowStep = flow.step;
    renderCreateChatForm();
  };

  closeCreateChat = function closeCreateChatFullScreen() {
    flow.step = "participants";
    flow.selectedUsers.clear();
    document.body.classList.remove("group-creation-open");
    originalCloseCreateChat();
  };

  const languageObserver = new MutationObserver(() => {
    if (!createChatModal.hidden) {
      renderCreateChatForm();
    }
  });
  languageObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["lang"]
  });
})();
