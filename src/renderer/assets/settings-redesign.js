(() => {
  "use strict";

  if (typeof renderPanel !== "function" || !panelBody || !sidePanel) {
    return;
  }

  const SETTINGS_STORAGE_KEY = "yachat-settings-redesign-v1";
  const FOLDER_STORAGE_KEY = "yachat-chat-folders-v1";
  const ACTIVE_FOLDER_KEY = "yachat-active-chat-folder";
  const APP_VERSION = "0.1.0";

  const DEFAULT_PREFERENCES = Object.freeze({
    notificationSound: true,
    compactMessages: false,
    attachmentCaptions: true,
    compactInterface: false,
    reduceMotion: false,
    dataSaver: false
  });

  let preferences = readJson(SETTINGS_STORAGE_KEY, DEFAULT_PREFERENCES);
  let folders = normalizeFolders(readJson(FOLDER_STORAGE_KEY, []));
  let activeFolderId = localStorage.getItem(ACTIVE_FOLDER_KEY) || "";
  let storageEstimate = null;
  let notificationPatchInstalled = false;

  const originalRenderPanel = renderPanel;
  const originalOpenPanel = openPanel;
  const originalRenderChatList = renderChatList;
  const originalRefreshMessenger = typeof refreshMessengerFromServer === "function"
    ? refreshMessengerFromServer
    : null;
  const originalMessengerPollDelay = typeof messengerPollDelay === "function"
    ? messengerPollDelay
    : null;

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "null");
      if (parsed && typeof parsed === "object") {
        return Array.isArray(fallback)
          ? (Array.isArray(parsed) ? parsed : fallback)
          : { ...fallback, ...parsed };
      }
    } catch {
      // Invalid local data is replaced with safe defaults.
    }
    return Array.isArray(fallback) ? [...fallback] : { ...fallback };
  }

  function normalizeFolders(items) {
    return (Array.isArray(items) ? items : [])
      .map((item) => ({
        id: String(item?.id || "").trim(),
        name: String(item?.name || "").trim().slice(0, 28),
        chatIds: [...new Set((Array.isArray(item?.chatIds) ? item.chatIds : [])
          .map((id) => String(id || "").trim())
          .filter(Boolean))]
      }))
      .filter((item) => item.id && item.name);
  }

  function savePreferences(patch = {}) {
    preferences = { ...preferences, ...patch };
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(preferences));
    applyPreferences();
    yachatApi.settings?.update?.({ uiPreferences: preferences }).catch(() => {});
  }

  function saveFolders(nextFolders = folders) {
    folders = normalizeFolders(nextFolders);
    localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(folders));
    if (activeFolderId && !folders.some((folder) => folder.id === activeFolderId)) {
      activeFolderId = "";
      localStorage.removeItem(ACTIVE_FOLDER_KEY);
    }
    ensureFolderBar();
    applyChatFolderFilter();
  }

  function applyPreferences() {
    document.documentElement.dataset.yachatCompact = preferences.compactInterface ? "true" : "false";
    document.documentElement.dataset.yachatReduceMotion = preferences.reduceMotion ? "true" : "false";
    document.documentElement.dataset.yachatDataSaver = preferences.dataSaver ? "true" : "false";
    document.documentElement.dataset.yachatCompactMessages = preferences.compactMessages ? "true" : "false";
    document.documentElement.dataset.yachatAttachmentCaptions = preferences.attachmentCaptions ? "true" : "false";

    document.querySelectorAll("video").forEach((video) => {
      video.preload = preferences.dataSaver ? "none" : "metadata";
    });
  }

  function profileUrl() {
    const username = normalizeUsername(state.account?.username || "");
    return username
      ? new URL(`/${encodeURIComponent(username)}`, window.location.origin).href
      : window.location.origin;
  }

  function profileAvatarMarkup() {
    const account = state.account || {};
    const source = account.avatarDataUrl || "";
    const initial = String(cleanDisplayText(account.displayName, account.username || "Я"))
      .trim()
      .slice(0, 1)
      .toUpperCase() || "Я";
    return source
      ? `<img src="${escapeHtml(source)}" alt="" />`
      : `<span>${escapeHtml(initial)}</span>`;
  }

  function row(action, icon, label, options = {}) {
    const subtitle = options.subtitle
      ? `<small>${escapeHtml(options.subtitle)}</small>`
      : "";
    const value = options.value
      ? `<em>${escapeHtml(options.value)}</em>`
      : "";
    const chevron = options.chevron === false ? "" : iconSvg("chevron-right", "settings-row-chevron");
    const data = options.panelAction
      ? `data-panel-action="${escapeHtml(options.panelAction)}"`
      : `data-settings-action="${escapeHtml(action)}"`;
    return `
      <button class="settings-row${options.className ? ` ${options.className}` : ""}" type="button" ${data}>
        <span class="settings-row-icon">${iconSvg(icon)}</span>
        <span class="settings-row-copy">
          <strong>${escapeHtml(label)}</strong>
          ${subtitle}
        </span>
        ${value}
        ${chevron}
      </button>
    `;
  }

  function toggleRow(key, icon, label, subtitle = "") {
    const checked = Boolean(preferences[key]);
    return `
      <label class="settings-row settings-toggle-row">
        <span class="settings-row-icon">${iconSvg(icon)}</span>
        <span class="settings-row-copy">
          <strong>${escapeHtml(label)}</strong>
          ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}
        </span>
        <input type="checkbox" data-settings-toggle="${escapeHtml(key)}" ${checked ? "checked" : ""} />
        <span class="settings-switch" aria-hidden="true"></span>
      </label>
    `;
  }

  function section(content, className = "") {
    return `<section class="settings-card${className ? ` ${className}` : ""}">${content}</section>`;
  }

  function renderSettingsHome() {
    const account = state.account || {};
    panelTitle.textContent = t("settings");
    panelKicker.hidden = true;
    sidePanel.classList.add("is-settings-redesign");
    panelBody.classList.add("is-settings-redesign-body");
    document.body.classList.add("settings-redesign-open");

    panelBody.innerHTML = `
      <div class="settings-profile-hero">
        <button class="settings-profile-corner is-left" type="button" data-settings-action="profile-qr" aria-label="QR-код профиля">
          ${iconSvg("qr-code")}
        </button>
        <button class="settings-profile-corner is-right" type="button" data-panel-action="edit-profile" aria-label="Редактировать профиль">
          ${iconSvg("pencil")}
        </button>
        <button class="settings-profile-avatar" type="button" data-avatar-view data-avatar-src="${escapeHtml(account.avatarDataUrl || "")}" data-avatar-text="${escapeHtml(cleanDisplayText(account.displayName, "Я"))}" data-avatar-title="${escapeHtml(cleanDisplayText(account.displayName, account.username || "Я"))}">
          ${profileAvatarMarkup()}
        </button>
        <h2>${escapeHtml(cleanDisplayText(account.displayName, account.username || "ЯЧат"))} ${renderVerified(account)}</h2>
        <p>${escapeHtml(cleanDisplayText(account.contact, `@${cleanDisplayText(account.username, "user")}`))}</p>
      </div>

      ${renderProfileEditor(account)}

      <button class="settings-invite" type="button" data-settings-action="invite-friends">
        ${iconSvg("link-2")}
        <span>Пригласить друзей</span>
      </button>

      ${section([
        row("notifications", "bell", "Уведомления и звук"),
        row("devices", "monitor-smartphone", "Устройства"),
        row("messages", "message-square", "Сообщения"),
        row("favorites", "bookmark", "Избранное"),
        row("folders", "folder", "Папки")
      ].join(""))}

      ${section([
        row("network", "battery-charging", "Экономия батареи и сети"),
        row("storage", "database", "Память")
      ].join(""))}

      ${section([
        row("appearance", "wand-sparkles", "Оформление"),
        row("language", "globe-2", "Язык приложения", { value: state.language === "en" ? "English" : "Русский" })
      ].join(""))}

      ${section([
        row("", "shield-check", "Политика конфиденциальности", {
          panelAction: "open-policy",
          className: "is-document-row"
        }),
        row("", "file-text", "Пользовательское соглашение", {
          panelAction: "open-terms",
          className: "is-document-row"
        })
      ].join(""), "settings-documents-card")}

      ${section(row("security", "lock-keyhole", "Безопасность"))}

      ${section([
        row("", "circle-help", "Помощь", { panelAction: "open-help-redesign" }),
        row("about", "info", "О приложении")
      ].join(""))}
    `;

    hydrateIcons(panelBody);
  }

  function detailHeader(title) {
    return `
      <header class="settings-detail-head">
        <button type="button" data-settings-action="back" aria-label="Назад">${iconSvg("chevron-left")}</button>
        <h2>${escapeHtml(title)}</h2>
      </header>
    `;
  }

  function renderNotifications() {
    const permission = "Notification" in window ? Notification.permission : "unsupported";
    const permissionText = {
      granted: "Разрешены",
      denied: "Запрещены в браузере",
      default: "Не запрошены",
      unsupported: "Не поддерживаются"
    }[permission] || permission;

    panelBody.innerHTML = `
      ${detailHeader("Уведомления и звук")}
      ${section([
        row("enable-notifications", "bell-ring", "Разрешение браузера", {
          value: permissionText,
          chevron: permission !== "granted"
        }),
        toggleRow("notificationSound", "volume-2", "Звук уведомлений", "Проигрывать звук при новых входящих сообщениях"),
        row("test-notification", "play", "Проверить звук", { chevron: false })
      ].join(""))}
    `;
  }

  function currentDeviceLabel() {
    const ua = navigator.userAgent || "";
    if (/iphone/i.test(ua)) return "iPhone";
    if (/ipad/i.test(ua)) return "iPad";
    if (/android/i.test(ua)) return "Android";
    if (/macintosh|mac os/i.test(ua)) return "Mac";
    if (/windows/i.test(ua)) return "Windows";
    if (/linux/i.test(ua)) return "Linux";
    return navigator.platform || "Текущее устройство";
  }

  function renderDevices() {
    panelBody.innerHTML = `
      ${detailHeader("Устройства")}
      ${section(`
        <div class="settings-device">
          <span>${iconSvg("monitor-smartphone")}</span>
          <div>
            <strong>${escapeHtml(currentDeviceLabel())}</strong>
            <small>${window.isSecureContext ? "Защищённое подключение" : "Локальное подключение"} · сейчас активно</small>
          </div>
          <b>Это устройство</b>
        </div>
      `)}
      ${section(`
        <video class="session-camera" data-session-camera hidden muted playsinline></video>
        <input class="visually-hidden" type="file" accept="image/*" capture="environment" data-session-capture />
        <p class="session-message" data-session-message></p>
        <button class="settings-primary" type="button" data-panel-action="scan-session">${iconSvg("scan-line")}<span>Подключить устройство по QR-коду</span></button>
      `)}
    `;
  }

  function renderMessagesSettings() {
    panelBody.innerHTML = `
      ${detailHeader("Сообщения")}
      ${section([
        toggleRow("compactMessages", "align-justify", "Компактные сообщения", "Уменьшить вертикальные интервалы в переписке"),
        toggleRow("attachmentCaptions", "captions", "Подписи к вложениям", "Показывать имя файла под фото и видео")
      ].join(""))}
    `;
  }

  function renderFolders() {
    const selectedId = String(state.settingsFolderId || folders[0]?.id || "");
    const selected = folders.find((folder) => folder.id === selectedId) || null;
    const chatOptions = selected
      ? state.chats.map((chat) => {
          const checked = selected.chatIds.includes(chat.id);
          return `
            <label class="settings-folder-chat">
              <input type="checkbox" data-folder-chat-id="${escapeHtml(chat.id)}" ${checked ? "checked" : ""} />
              <span>${renderChatAvatar(chat, "settings-folder-avatar")}</span>
              <strong>${escapeHtml(getChatTitle(chat))}</strong>
            </label>
          `;
        }).join("")
      : "";

    panelBody.innerHTML = `
      ${detailHeader("Папки")}
      ${section(`
        <form class="settings-folder-create" data-settings-folder-create>
          <input name="folderName" maxlength="28" placeholder="Название новой папки" required />
          <button type="submit">${iconSvg("plus")}<span>Создать</span></button>
        </form>
      `)}
      ${folders.length ? section(`
        <div class="settings-folder-tabs">
          ${folders.map((folder) => `
            <button class="${folder.id === selectedId ? "is-active" : ""}" type="button" data-settings-folder-select="${escapeHtml(folder.id)}">
              ${escapeHtml(folder.name)}
            </button>
          `).join("")}
        </div>
        ${selected ? `
          <div class="settings-folder-editor">
            <div class="settings-folder-editor-head">
              <strong>${escapeHtml(selected.name)}</strong>
              <button type="button" data-settings-folder-delete="${escapeHtml(selected.id)}">${iconSvg("trash")}<span>Удалить</span></button>
            </div>
            <div class="settings-folder-chat-list">${chatOptions || "<p>Чатов пока нет.</p>"}</div>
          </div>
        ` : ""}
      `) : section(`<p class="settings-empty">Создайте папку и добавьте в неё нужные чаты.</p>`)}
    `;
    hydrateIcons(panelBody);
  }

  async function updateStorageEstimate() {
    if (!navigator.storage?.estimate) {
      storageEstimate = null;
      return;
    }
    try {
      storageEstimate = await navigator.storage.estimate();
    } catch {
      storageEstimate = null;
    }
  }

  function bytesLabel(bytes = 0) {
    const value = Number(bytes) || 0;
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} МБ`;
    if (value >= 1024) return `${Math.ceil(value / 1024)} КБ`;
    return `${value} Б`;
  }

  function renderStorage() {
    const used = storageEstimate?.usage;
    const quota = storageEstimate?.quota;
    panelBody.innerHTML = `
      ${detailHeader("Память")}
      ${section(`
        <div class="settings-storage-meter">
          <span>${iconSvg("database")}</span>
          <div>
            <strong>${used == null ? "Объём вычисляется" : `${bytesLabel(used)} занято`}</strong>
            <small>${quota == null ? "Браузер не сообщил доступный объём" : `Доступно до ${bytesLabel(quota)}`}</small>
          </div>
        </div>
        <button class="settings-primary is-secondary" type="button" data-settings-action="refresh-storage">${iconSvg("refresh-cw")}<span>Обновить расчёт</span></button>
        <button class="settings-primary is-danger" type="button" data-settings-action="clear-cache">${iconSvg("trash-2")}<span>Очистить временный кэш</span></button>
      `)}
    `;
  }

  function renderNetwork() {
    panelBody.innerHTML = `
      ${detailHeader("Экономия батареи и сети")}
      ${section([
        toggleRow("dataSaver", "battery-charging", "Экономия трафика", "Реже обновлять фоновые данные и не предзагружать видео"),
        toggleRow("reduceMotion", "gauge", "Сократить анимации", "Уменьшить нагрузку на батарею")
      ].join(""))}
    `;
  }

  function renderAppearance() {
    panelBody.innerHTML = `
      ${detailHeader("Оформление")}
      ${section([
        row("toggle-theme", themeIconName(), "Тема", {
          value: state.theme === "dark" ? "Тёмная" : "Светлая",
          chevron: false
        }),
        toggleRow("compactInterface", "panel-top", "Компактный интерфейс", "Уменьшить отступы в списках и карточках"),
        toggleRow("reduceMotion", "sparkles", "Сократить анимации", "Сделать переходы спокойнее и экономнее")
      ].join(""))}
    `;
  }

  function renderLanguageSettings() {
    panelBody.innerHTML = `
      ${detailHeader("Язык приложения")}
      ${section(`
        <button class="settings-language ${state.language === "ru" ? "is-active" : ""}" type="button" data-settings-language="ru">
          <span>RU</span><strong>Русский</strong>${state.language === "ru" ? iconSvg("check") : ""}
        </button>
        <button class="settings-language ${state.language === "en" ? "is-active" : ""}" type="button" data-settings-language="en">
          <span>EN</span><strong>English</strong>${state.language === "en" ? iconSvg("check") : ""}
        </button>
      `)}
    `;
  }

  function renderSecurity() {
    panelBody.innerHTML = `
      ${detailHeader("Безопасность")}
      ${section(`
        <div class="settings-security-status">
          <span>${iconSvg("shield-check")}</span>
          <div>
            <strong>${window.isSecureContext ? "Соединение защищено" : "Локальный режим"}</strong>
            <small>${window.isSecureContext ? "Данные передаются по HTTPS" : "Защищённый контекст браузера недоступен"}</small>
          </div>
        </div>
      `, "settings-security-card")}
      ${section(`
        <video class="session-camera" data-session-camera hidden muted playsinline></video>
        <input class="visually-hidden" type="file" accept="image/*" capture="environment" data-session-capture />
        <p class="session-message" data-session-message></p>
        <button class="settings-primary" type="button" data-panel-action="scan-session">${iconSvg("scan-line")}<span>Подтвердить вход по QR-коду</span></button>
        <button class="settings-primary is-secondary" type="button" data-panel-action="logout">${iconSvg("log-out")}<span>Выйти на этом устройстве</span></button>
        <button class="settings-primary is-danger" type="button" data-panel-action="delete-profile">${iconSvg("trash")}<span>Удалить профиль</span></button>
      `)}
    `;
  }

  function renderAbout() {
    const installMode = window.matchMedia?.("(display-mode: standalone)")?.matches
      ? "Установленное веб-приложение"
      : "Веб-версия";
    panelBody.innerHTML = `
      ${detailHeader("О приложении")}
      ${section(`
        <div class="settings-about-brand">
          <img src="/assets/yachat-brand-180.png" alt="" />
          <div><strong>ЯЧат</strong><small>Версия ${APP_VERSION}</small></div>
        </div>
        <dl class="settings-about-list">
          <div><dt>Режим</dt><dd>${escapeHtml(installMode)}</dd></div>
          <div><dt>Соединение</dt><dd>${window.isSecureContext ? "HTTPS" : location.protocol.replace(":", "").toUpperCase()}</dd></div>
          <div><dt>Язык</dt><dd>${state.language === "en" ? "English" : "Русский"}</dd></div>
        </dl>
      `)}
    `;
  }

  function renderSettingsDetail(page) {
    sidePanel.classList.add("is-settings-redesign");
    panelBody.classList.add("is-settings-redesign-body");
    document.body.classList.add("settings-redesign-open");

    const renderers = {
      notifications: renderNotifications,
      devices: renderDevices,
      messages: renderMessagesSettings,
      folders: renderFolders,
      network: renderNetwork,
      storage: renderStorage,
      appearance: renderAppearance,
      language: renderLanguageSettings,
      security: renderSecurity,
      about: renderAbout
    };
    (renderers[page] || renderSettingsHome)();
    hydrateIcons(panelBody);
  }

  function renderModernSettings() {
    if (state.settingsPage) {
      renderSettingsDetail(state.settingsPage);
    } else {
      renderSettingsHome();
    }
  }

  renderPanel = function renderPanelWithSettingsRedesign() {
    if (state.activePanel === "settings") {
      renderModernSettings();
      return;
    }

    sidePanel.classList.remove("is-settings-redesign");
    panelBody.classList.remove("is-settings-redesign-body");
    document.body.classList.remove("settings-redesign-open");
    originalRenderPanel();
  };

  openPanel = function openPanelWithSettingsReset(type) {
    if ((type || "settings") === "settings") {
      state.settingsPage = "";
      state.settingsFolderId = "";
    }
    originalOpenPanel(type);
  };

  function folderForId(id) {
    return folders.find((folder) => folder.id === id) || null;
  }

  function ensureFolderBar() {
    const chatPane = document.querySelector(".chat-pane");
    const searchField = chatPane?.querySelector(".search-field");
    if (!chatPane || !searchField) return;

    let bar = chatPane.querySelector("[data-chat-folder-bar]");
    if (!folders.length) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("nav");
      bar.className = "chat-folder-bar";
      bar.dataset.chatFolderBar = "";
      searchField.insertAdjacentElement("afterend", bar);
    }
    bar.innerHTML = `
      <button class="${activeFolderId ? "" : "is-active"}" type="button" data-chat-folder="">Все</button>
      ${folders.map((folder) => `
        <button class="${folder.id === activeFolderId ? "is-active" : ""}" type="button" data-chat-folder="${escapeHtml(folder.id)}">
          ${escapeHtml(folder.name)}
        </button>
      `).join("")}
    `;
  }

  function applyChatFolderFilter() {
    ensureFolderBar();
    const folder = folderForId(activeFolderId);
    const allowed = folder ? new Set(folder.chatIds) : null;
    document.querySelectorAll(".chat-list [data-chat-id]").forEach((rowElement) => {
      rowElement.hidden = Boolean(allowed && !allowed.has(rowElement.dataset.chatId));
    });
  }

  renderChatList = function renderChatListWithFolders() {
    originalRenderChatList();
    applyChatFolderFilter();
  };

  document.addEventListener("click", (event) => {
    const folderButton = event.target.closest("[data-chat-folder]");
    if (!folderButton) return;
    activeFolderId = folderButton.dataset.chatFolder || "";
    if (activeFolderId) localStorage.setItem(ACTIVE_FOLDER_KEY, activeFolderId);
    else localStorage.removeItem(ACTIVE_FOLDER_KEY);
    applyChatFolderFilter();
  });

  function playNotificationTone() {
    if (!preferences.notificationSound) return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.setValueAtTime(660, context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
      oscillator.addEventListener("ended", () => context.close().catch(() => {}), { once: true });
    } catch {
      // Sound is optional and must never break messaging.
    }
  }

  function installIncomingNotificationPatch() {
    if (notificationPatchInstalled || !originalRefreshMessenger) return;
    notificationPatchInstalled = true;

    refreshMessengerFromServer = async function refreshMessengerWithLocalNotification() {
      const before = new Set((state.messages || []).map((message) => message.id));
      const result = await originalRefreshMessenger();
      const incoming = (state.messages || []).filter((message) => (
        !before.has(message.id) && message.author !== "user"
      ));
      if (incoming.length) {
        playNotificationTone();
        const latest = incoming[incoming.length - 1];
        if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
          const notification = new Notification(getChatTitle(getActiveChat()), {
            body: messagePreviewText(latest) || "Новое сообщение",
            icon: "/assets/yachat-brand-180.png"
          });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        }
      }
      return result;
    };
  }

  if (originalMessengerPollDelay) {
    messengerPollDelay = function messengerPollDelayWithSaver() {
      const delay = originalMessengerPollDelay();
      return preferences.dataSaver ? Math.max(delay, 6000) : delay;
    };
  }

  panelBody.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-settings-action]");
    if (!actionButton) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const action = actionButton.dataset.settingsAction;

    if (action === "back") {
      state.settingsPage = "";
      renderPanel();
      return;
    }

    if (["notifications", "devices", "messages", "folders", "network", "appearance", "language", "security", "about"].includes(action)) {
      state.settingsPage = action;
      renderPanel();
      return;
    }

    if (action === "storage") {
      state.settingsPage = "storage";
      await updateStorageEstimate();
      renderPanel();
      return;
    }

    if (action === "favorites") {
      closePanel();
      await selectChat("yachat-favorites");
      return;
    }

    if (action === "profile-qr") {
      showProfileQr();
      return;
    }

    if (action === "invite-friends") {
      await shareProfile();
      return;
    }

    if (action === "enable-notifications") {
      if ("Notification" in window && Notification.permission !== "granted") {
        await Notification.requestPermission();
      }
      await enablePushNotifications().catch(() => {});
      renderPanel();
      return;
    }

    if (action === "test-notification") {
      playNotificationTone();
      showActionFeedback("Проверочный звук воспроизведён", { icon: "volume-2" });
      return;
    }

    if (action === "toggle-theme") {
      setTheme(nextTheme(state.theme));
      renderPanel();
      return;
    }

    if (action === "refresh-storage") {
      await updateStorageEstimate();
      renderPanel();
      return;
    }

    if (action === "clear-cache") {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      state.pendingAttachments = [];
      state.transientMessagesByChat.clear();
      renderAttachmentTray();
      showActionFeedback("Временный кэш очищен", { icon: "trash-2" });
      await updateStorageEstimate();
      renderPanel();
    }
  }, true);

  panelBody.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-settings-toggle]");
    if (toggle) {
      const key = toggle.dataset.settingsToggle;
      savePreferences({ [key]: Boolean(toggle.checked) });
      if (key === "notificationSound" && toggle.checked) playNotificationTone();
      return;
    }

    const folderChat = event.target.closest("[data-folder-chat-id]");
    if (folderChat) {
      const folder = folderForId(state.settingsFolderId || folders[0]?.id);
      if (!folder) return;
      const ids = new Set(folder.chatIds);
      if (folderChat.checked) ids.add(folderChat.dataset.folderChatId);
      else ids.delete(folderChat.dataset.folderChatId);
      folder.chatIds = [...ids];
      saveFolders(folders);
    }
  }, true);

  panelBody.addEventListener("click", (event) => {
    const language = event.target.closest("[data-settings-language]");
    if (language) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setLanguage(language.dataset.settingsLanguage);
      renderPanel();
      return;
    }

    const selectFolder = event.target.closest("[data-settings-folder-select]");
    if (selectFolder) {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.settingsFolderId = selectFolder.dataset.settingsFolderSelect;
      renderPanel();
      return;
    }

    const deleteFolder = event.target.closest("[data-settings-folder-delete]");
    if (deleteFolder) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const id = deleteFolder.dataset.settingsFolderDelete;
      saveFolders(folders.filter((folder) => folder.id !== id));
      state.settingsFolderId = folders[0]?.id || "";
      renderPanel();
    }
  }, true);

  panelBody.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-settings-folder-create]");
    if (!form) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const name = String(new FormData(form).get("folderName") || "").trim();
    if (!name) return;
    const id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `folder-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    folders.push({ id, name, chatIds: [] });
    saveFolders(folders);
    state.settingsFolderId = id;
    renderPanel();
  }, true);

  panelBody.addEventListener("click", (event) => {
    const help = event.target.closest('[data-panel-action="open-help-redesign"]');
    if (!help) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openStandalonePage("help");
  }, true);

  function ensureProfileQrLayer() {
    let layer = document.querySelector("[data-settings-profile-qr]");
    if (layer) return layer;
    layer = document.createElement("div");
    layer.className = "settings-qr-layer";
    layer.dataset.settingsProfileQr = "";
    layer.hidden = true;
    layer.innerHTML = `
      <div class="settings-qr-card" role="dialog" aria-modal="true">
        <button type="button" data-settings-qr-close aria-label="Закрыть">${iconSvg("x")}</button>
        <div data-settings-qr-code></div>
        <strong data-settings-qr-name></strong>
        <small data-settings-qr-link></small>
        <button class="settings-primary" type="button" data-settings-qr-share>${iconSvg("share-2")}<span>Поделиться профилем</span></button>
      </div>
    `;
    document.body.append(layer);
    hydrateIcons(layer);
    layer.addEventListener("click", (event) => {
      if (event.target === layer || event.target.closest("[data-settings-qr-close]")) {
        layer.hidden = true;
      }
      if (event.target.closest("[data-settings-qr-share]")) {
        shareProfile();
      }
    });
    return layer;
  }

  function showProfileQr() {
    const layer = ensureProfileQrLayer();
    const url = profileUrl();
    layer.querySelector("[data-settings-qr-code]").innerHTML = renderQrSvg(url);
    layer.querySelector("[data-settings-qr-name]").textContent = cleanDisplayText(state.account?.displayName, "ЯЧат");
    layer.querySelector("[data-settings-qr-link]").textContent = url;
    layer.hidden = false;
  }

  async function shareProfile() {
    const url = profileUrl();
    const title = cleanDisplayText(state.account?.displayName, "ЯЧат");
    if (navigator.share) {
      try {
        await navigator.share({ title, text: `Профиль ${title} в ЯЧате`, url });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    await copyTextToClipboard(url);
    showActionFeedback("Ссылка на профиль скопирована", { icon: "copy" });
  }

  yachatApi.settings?.get?.().then((settings) => {
    if (settings?.uiPreferences && typeof settings.uiPreferences === "object") {
      preferences = { ...DEFAULT_PREFERENCES, ...settings.uiPreferences, ...preferences };
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(preferences));
      applyPreferences();
      if (state.activePanel === "settings") renderPanel();
    }
  }).catch(() => {});

  applyPreferences();
  installIncomingNotificationPatch();
  ensureFolderBar();
  applyChatFolderFilter();
})();