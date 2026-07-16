(() => {
  "use strict";

  const CONTACTS_URL = "/api/contacts";
  const IMPORT_URL = "/api/contacts/import";
  const BATCH_SIZE = 400;
  const cache = { accountId: "", loaded: false, loading: false, requestId: 0 };

  const lang = () => {
    try {
      return state?.language === "en" ? "en" : "ru";
    } catch {
      return "ru";
    }
  };
  const tr = (ru, en) => lang() === "en" ? en : ru;
  const token = () => localStorage.getItem("yachat-http-auth-token") || "";

  function installTranslations() {
    if (typeof I18N !== "object" || !I18N) return;
    Object.assign(I18N.ru || {}, {
      contactsImportTitle: "Контакты из телефонной книги",
      contactsPanelLead: "Импортированные номера хранятся в аккаунте и доступны на всех устройствах.",
      contactsManualTitle: "Добавить номера вручную",
      contactsImportHint: "Сохраняются только новые номера. ЯЧат показывает лишь тех, кто уже зарегистрирован.",
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
      contactsImportHint: "Only new numbers are stored. YaChat shows people who already have an account.",
      requestContacts: "Open phone book",
      checkContacts: "Add numbers",
      contactsFoundTitle: "Contacts on YaChat",
      contactsNoMatches: "None of the stored numbers belongs to a registered user yet.",
      contactsUnavailable: "This browser does not expose the system phone book to websites.",
      contactsPermissionDenied: "Access to the selected contacts was not granted.",
      contactsInputEmpty: "Enter at least one phone number."
    });
  }

  async function request(path, { method = "GET", body } = {}) {
    const auth = token();
    if (!auth) throw new Error(tr("Сначала войдите в аккаунт.", "Sign in first."));
    const response = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      throw new Error(String(payload.detail || tr("Сервер не сохранил контакты.", "The server did not save contacts.")));
    }
    return payload;
  }

  function applySnapshot(payload, message) {
    state.contactMatches = (Array.isArray(payload?.contacts) ? payload.contacts : [])
      .map((user) => normalizeUser(user))
      .filter((user) => user?.id && user.id !== state.account?.id);
    state.contactLookupMessage = message || "";
    cache.accountId = String(state.account?.id || "");
    cache.loaded = true;
  }

  function snapshotMessage(payload) {
    const imported = Math.max(0, Number(payload?.importedCount) || 0);
    const matched = Math.max(0, Number(payload?.matchedCount) || 0);
    if (!imported) return tr("Телефонная книга ещё не импортирована.", "The phone book has not been imported yet.");
    return tr(
      `На сервере сохранено номеров: ${imported}. Найдено в ЯЧате: ${matched}.`,
      `Numbers stored on the server: ${imported}. Found on YaChat: ${matched}.`
    );
  }

  async function loadSaved({ force = false, quiet = false, message = "" } = {}) {
    const accountId = String(state.account?.id || "");
    if (!accountId) return;
    if (cache.accountId !== accountId) {
      cache.accountId = accountId;
      cache.loaded = false;
    }
    if (cache.loading || (cache.loaded && !force)) return;

    const requestId = ++cache.requestId;
    cache.loading = true;
    state.contactLookupLoading = true;
    if (!quiet) state.contactLookupMessage = tr("Загружаем контакты с сервера…", "Loading contacts from the server…");
    if (state.activePanel === "contacts") renderPanel();

    try {
      const payload = await request(CONTACTS_URL);
      if (requestId !== cache.requestId || String(state.account?.id || "") !== accountId) return;
      applySnapshot(payload, message || snapshotMessage(payload));
    } catch (error) {
      if (requestId === cache.requestId) state.contactLookupMessage = message || String(error?.message || error);
    } finally {
      if (requestId === cache.requestId) {
        cache.loading = false;
        state.contactLookupLoading = false;
        if (state.activePanel === "contacts") renderPanel();
      }
    }
  }

  const pickerSupported = () => Boolean(
    window.isSecureContext
    && navigator.contacts
    && typeof navigator.contacts.select === "function"
  );
  const appleMobile = () => /iPhone|iPad|iPod/i.test(navigator.userAgent || "");

  function unsupportedMessage() {
    if (appleMobile()) {
      return tr(
        "iOS Safari не даёт веб-сайтам доступ к системной телефонной книге. Импортируйте номера на поддерживаемом Android-устройстве: после серверного сохранения они появятся здесь и на компьютере.",
        "iOS Safari does not give websites access to the system phone book. Import on a supported Android device; after server storage the contacts will appear here and on desktop."
      );
    }
    return tr(
      "Этот браузер не поддерживает системный выбор контактов. Добавьте номера вручную ниже.",
      "This browser does not support the system contact picker. Add phone numbers manually below."
    );
  }

  function pickedNumbers(records) {
    const phones = [];
    for (const record of Array.isArray(records) ? records : []) {
      for (const value of Array.isArray(record?.tel) ? record.tel : [record?.tel]) {
        const phone = String(value || "").trim();
        if (phone) phones.push({ phones: [phone] });
      }
    }
    return phones;
  }

  async function importBatches(contacts) {
    let addedCount = 0;
    let receivedCount = 0;
    let snapshot = null;
    for (let offset = 0; offset < contacts.length; offset += BATCH_SIZE) {
      snapshot = await request(IMPORT_URL, {
        method: "POST",
        body: { contacts: contacts.slice(offset, offset + BATCH_SIZE) }
      });
      addedCount += Math.max(0, Number(snapshot?.addedCount) || 0);
      receivedCount += Math.max(0, Number(snapshot?.receivedCount) || 0);
    }
    return { ...(snapshot || {}), addedCount, receivedCount };
  }

  function importMessage(payload) {
    const added = Math.max(0, Number(payload?.addedCount) || 0);
    const matched = Math.max(0, Number(payload?.matchedCount) || 0);
    return added
      ? tr(`Добавлено новых номеров: ${added}. Контактов в ЯЧате: ${matched}.`, `New numbers added: ${added}. Contacts on YaChat: ${matched}.`)
      : tr(`Новых номеров нет. Контактов в ЯЧате: ${matched}.`, `No new numbers were found. Contacts on YaChat: ${matched}.`);
  }

  async function saveContacts(contacts, sourceButton) {
    if (!contacts.length) {
      state.contactLookupMessage = tr("Не выбрано ни одного номера.", "No phone numbers were selected.");
      renderPanel();
      return;
    }

    state.contactLookupLoading = true;
    state.contactLookupMessage = tr("Сохраняем новые номера на сервере…", "Saving new numbers to the server…");
    if (sourceButton && typeof setLoading === "function") setLoading(sourceButton, true);
    renderPanel();

    try {
      const payload = await importBatches(contacts);
      applySnapshot(payload, importMessage(payload));
    } catch (error) {
      const failure = String(error?.message || error);
      cache.loaded = false;
      await loadSaved({ force: true, quiet: true, message: failure }).catch(() => {
        state.contactLookupMessage = failure;
      });
    } finally {
      state.contactLookupLoading = false;
      if (sourceButton && typeof setLoading === "function") setLoading(sourceButton, false);
      if (state.activePanel === "contacts") renderPanel();
    }
  }

  async function importFromDevice(sourceButton) {
    if (!pickerSupported()) {
      state.contactLookupMessage = unsupportedMessage();
      renderPanel();
      return;
    }
    try {
      // Must remain the first awaited call after the click to preserve Android user activation.
      const selected = await navigator.contacts.select(["tel"], { multiple: true });
      const contacts = pickedNumbers(selected);
      if (!contacts.length) {
        state.contactLookupMessage = tr("Выбор контактов отменён или номера не выбраны.", "Contact selection was cancelled or no numbers were selected.");
        renderPanel();
        return;
      }
      await saveContacts(contacts, sourceButton);
    } catch (error) {
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      const cancelled = error?.name === "AbortError";
      state.contactLookupMessage = cancelled
        ? tr("Выбор контактов отменён.", "Contact selection was cancelled.")
        : denied
          ? tr("Доступ к выбранным контактам не предоставлен.", "Access to the selected contacts was not granted.")
          : String(error?.message || unsupportedMessage());
      state.contactLookupLoading = false;
      renderPanel();
    }
  }

  async function importManual(sourceButton) {
    const raw = String(panelBody?.querySelector("[data-contact-input]")?.value || "");
    const phones = typeof extractContactPhones === "function" ? extractContactPhones(raw) : [];
    if (!phones.length) {
      state.contactLookupMessage = tr("Введите хотя бы один номер телефона.", "Enter at least one phone number.");
      renderPanel();
      return;
    }
    await saveContacts(phones.map((phone) => ({ phones: [phone] })), sourceButton);
  }

  installTranslations();
  importDeviceContacts = importFromDevice;
  checkManualContacts = importManual;

  const originalOpenPanel = openPanel;
  openPanel = function contactsAwareOpenPanel(type) {
    const result = originalOpenPanel(type);
    if (type === "contacts") queueMicrotask(() => loadSaved());
    return result;
  };

  const observer = new MutationObserver(() => {
    if (state.activePanel === "contacts" && panelBody?.querySelector("[data-contact-status]")) void loadSaved();
  });
  if (panelBody) observer.observe(panelBody, { childList: true, subtree: true });
})();
