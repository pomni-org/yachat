(() => {
  "use strict";

  const CONTACTS_ENDPOINT = "/api/contacts";
  const IMPORT_ENDPOINT = "/api/contacts/import";
  const IMPORT_BATCH_SIZE = 400;
  const syncState = {
    accountId: "",
    loaded: false,
    loading: false,
    requestId: 0
  };

  function language() {
    try {
      return state?.language === "en" ? "en" : "ru";
    } catch {
      return "ru";
    }
  }

  function text(ru, en) {
    return language() === "en" ? en : ru;
  }

  function installTranslations() {
    if (typeof I18N !== "object" || !I18N) {
      return;
    }

    Object.assign(I18N.ru || {}, {
      contactsImportTitle: "Контакты из телефонной книги",
      contactsPanelLead: "Импортированные номера сохраняются в аккаунте и доступны на всех устройствах.",
      contactsManualTitle: "Добавить номера вручную",
      contactsImportHint: "ЯЧат сохранит только новые номера и покажет контакты, которые уже зарегистрированы в сервисе.",
      requestContacts: "Открыть телефонную книгу",
      checkContacts: "Добавить номера",
      contactsFoundTitle: "Контакты в ЯЧате",
      contactsNoMatches: "Среди сохранённых номеров пока нет зарегистрированных пользователей.",
      contactsUnavailable: "Этот браузер не предоставляет веб-сайтам системный доступ к телефонной книге.",
      contactsPermissionDenied: "Доступ к выбранным контактам не предоставлен.",
      contactsInputEmpty: "Введите хотя бы один номер телефона."
    });

    Object.assign(I18N.en || {}, {
      contactsImportTitle: "Phone book contacts",
      contactsPanelLead: "Imported numbers are stored in your account and remain available on every device.",
      contactsManualTitle: "Add numbers manually",
      contactsImportHint: "YaChat stores only new numbers and shows contacts who already have an account.",
      requestContacts: "Open phone book",
      checkContacts: "Add numbers",
      contactsFoundTitle: "Contacts on YaChat",
      contactsNoMatches: "None of the stored numbers belongs to a registered user yet.",
      contactsUnavailable: "This browser does not expose the system phone book to websites.",
      contactsPermissionDenied: "Access to the selected contacts was not granted.",
      contactsInputEmpty: "Enter at least one phone number."
    });
  }

  function authToken() {
    return localStorage.getItem("yachat-http-auth-token") || "";
  }

  async function apiRequest(path, options = {}) {
    const token = authToken();
    if (!token) {
      throw new Error(text("Сначала войдите в аккаунт.", "Sign in first."));
    }

    const response = await fetch(path, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      throw new Error(String(payload.detail || text("Сервер не сохранил контакты.", "The server did not save contacts.")));
    }
    return payload;
  }

  function applySnapshot(payload, message = "") {
    const contacts = Array.isArray(payload?.contacts) ? payload.contacts : [];
    state.contactMatches = contacts
      .map((user) => normalizeUser(user))
      .filter((user) => user && user.id !== state.account?.id);
    state.contactLookupMessage = message;
    syncState.loaded = true;
    syncState.accountId = String(state.account?.id || "");
  }

  function serverSummary(payload) {
    const imported = Math.max(0, Number(payload?.importedCount) || 0);
    const matched = Math.max(0, Number(payload?.matchedCount) || 0);
    if (imported === 0) {
      return text(
        "Телефонная книга ещё не импортирована.",
        "The phone book has not been imported yet."
      );
    }
    return text(
      `На сервере сохранено номеров: ${imported}. Найдено в ЯЧате: ${matched}.`,
      `Numbers stored on the server: ${imported}. Found on YaChat: ${matched}.`
    );
  }

  async function loadServerContacts({ force = false } = {}) {
    const accountId = String(state.account?.id || "");
    if (!accountId) {
      return;
    }
    if (syncState.accountId !== accountId) {
      syncState.accountId = accountId;
      syncState.loaded = false;
    }
    if (syncState.loading || (syncState.loaded && !force)) {
      return;
    }

    const requestId = ++syncState.requestId;
    syncState.loading = true;
    state.contactLookupLoading = true;
    state.contactLookupMessage = text("Загружаем контакты с сервера…", "Loading contacts from the server…");
    renderPanel();

    try {
      const payload = await apiRequest(CONTACTS_ENDPOINT);
      if (requestId !== syncState.requestId || String(state.account?.id || "") !== accountId) {
        return;
      }
      applySnapshot(payload, serverSummary(payload));
    } catch (error) {
      if (requestId === syncState.requestId) {
        state.contactLookupMessage = String(error.message || error);
      }
    } finally {
      if (requestId === syncState.requestId) {
        syncState.loading = false;
        state.contactLookupLoading = false;
        if (state.activePanel === "contacts") {
          renderPanel();
        }
      }
    }
  }

  function contactPickerSupported() {
    return Boolean(window.isSecureContext && navigator.contacts && typeof navigator.contacts.select === "function");
  }

  function isAppleMobileBrowser() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  }

  function pickerUnsupportedMessage() {
    if (isAppleMobileBrowser()) {
      return text(
        "iOS Safari не предоставляет веб-сайтам прямой доступ к системной телефонной книге. Импортируйте контакты на поддерживаемом Android-устройстве: после сохранения они появятся здесь и на компьютере.",
        "iOS Safari does not expose the system phone book directly to websites. Import on a supported Android device; the saved contacts will then appear here and on desktop."
      );
    }
    return text(
      "Этот браузер не поддерживает системный выбор контактов. Можно добавить номера вручную ниже.",
      "This browser does not support the system contact picker. You can add phone numbers manually below."
    );
  }

  function normalizePickedContacts(records) {
    const result = [];
    for (const record of Array.isArray(records) ? records : []) {
      const names = Array.isArray(record?.name) ? record.name : [record?.name];
      const phones = (Array.isArray(record?.tel) ? record.tel : [record?.tel])
        .map((phone) => String(phone || "").trim())
        .filter(Boolean);
      if (phones.length === 0) {
        continue;
      }
      result.push({
        name: String(names.find((name) => String(name || "").trim()) || "").trim(),
        phones
      });
    }
    return result;
  }

  async function importBatches(contacts) {
    let addedCount = 0;
    let receivedCount = 0;
    let lastSnapshot = null;

    for (let offset = 0; offset < contacts.length; offset += IMPORT_BATCH_SIZE) {
      const batch = contacts.slice(offset, offset + IMPORT_BATCH_SIZE);
      lastSnapshot = await apiRequest(IMPORT_ENDPOINT, {
        method: "POST",
        body: { contacts: batch }
      });
      addedCount += Math.max(0, Number(lastSnapshot.addedCount) || 0);
      receivedCount += Math.max(0, Number(lastSnapshot.receivedCount) || 0);
    }

    return { ...(lastSnapshot || {}), addedCount, receivedCount };
  }

  function importResultMessage(payload) {
    const added = Math.max(0, Number(payload?.addedCount) || 0);
    const matched = Math.max(0, Number(payload?.matchedCount) || 0);
    if (added === 0) {
      return text(
        `Новых номеров нет. Контактов в ЯЧате: ${matched}.`,
        `No new numbers were found. Contacts on YaChat: ${matched}.`
      );
    }
    return text(
      `Добавлено новых номеров: ${added}. Контактов в ЯЧате: ${matched}.`,
      `New numbers added: ${added}. Contacts on YaChat: ${matched}.`
    );
  }

  async function runImport(contacts, sourceButton = null) {
    if (!Array.isArray(contacts) || contacts.length === 0) {
      state.contactLookupMessage = text("Не выбрано ни одного номера.", "No phone numbers were selected.");
      renderPanel();
      return;
    }

    state.contactLookupLoading = true;
    state.contactLookupMessage = text("Сохраняем новые номера на сервере…", "Saving new numbers to the server…");
    if (sourceButton && typeof setLoading === "function") {
      setLoading(sourceButton, true);
    }
    renderPanel();

    try {
      const payload = await importBatches(contacts);
      applySnapshot(payload, importResultMessage(payload));
    } catch (error) {
      state.contactLookupMessage = String(error.message || error);
      await loadServerContacts({ force: true }).catch(() => {});
    } finally {
      state.contactLookupLoading = false;
      if (sourceButton && typeof setLoading === "function") {
        setLoading(sourceButton, false);
      }
      if (state.activePanel === "contacts") {
        renderPanel();
      }
    }
  }

  async function importFromDevice(sourceButton) {
    if (!contactPickerSupported()) {
      state.contactLookupMessage = pickerUnsupportedMessage();
      renderPanel();
      return;
    }

    try {
      // select() stays directly inside the click task so Android keeps the required user activation.
      const selected = await navigator.contacts.select(["name", "tel"], { multiple: true });
      const contacts = normalizePickedContacts(selected);
      if (contacts.length === 0) {
        state.contactLookupMessage = text("Выбор контактов отменён или у выбранных записей нет номеров.", "Contact selection was cancelled or the selected entries have no phone numbers.");
        renderPanel();
        return;
      }
      await runImport(contacts, sourceButton);
    } catch (error) {
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      const cancelled = error?.name === "AbortError";
      state.contactLookupMessage = cancelled
        ? text("Выбор контактов отменён.", "Contact selection was cancelled.")
        : denied
          ? text("Доступ к выбранным контактам не предоставлен.", "Access to the selected contacts was not granted.")
          : String(error?.message || pickerUnsupportedMessage());
      state.contactLookupLoading = false;
      renderPanel();
    }
  }

  async function importManualNumbers(sourceButton) {
    const raw = String(panelBody?.querySelector("[data-contact-input]")?.value || "");
    const phones = typeof extractContactPhones === "function" ? extractContactPhones(raw) : [];
    if (phones.length === 0) {
      state.contactLookupMessage = text("Введите хотя бы один номер телефона.", "Enter at least one phone number.");
      renderPanel();
      return;
    }
    await runImport(phones.map((phone) => ({ name: "", phones: [phone] })), sourceButton);
  }

  installTranslations();

  try {
    importDeviceContacts = importFromDevice;
    checkManualContacts = importManualNumbers;
  } catch (error) {
    console.error("Contacts sync could not replace the old handlers.", error);
  }

  try {
    const originalOpenPanel = openPanel;
    openPanel = function enhancedOpenPanel(type) {
      const result = originalOpenPanel(type);
      if (type === "contacts") {
        queueMicrotask(() => loadServerContacts());
      }
      return result;
    };
  } catch (error) {
    console.error("Contacts sync could not hook the contacts panel.", error);
  }

  const panelObserver = new MutationObserver(() => {
    if (state.activePanel === "contacts" && panelBody?.querySelector("[data-contact-status]")) {
      void loadServerContacts();
    }
  });
  if (panelBody) {
    panelObserver.observe(panelBody, { childList: true, subtree: true });
  }
})();
