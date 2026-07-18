(() => {
  "use strict";

  if (typeof state === "undefined") {
    return;
  }

  const exact = new Map(Object.entries({
    "Настройки": "Settings",
    "Поделиться профилем": "Share profile",
    "Редактировать профиль": "Edit profile",
    "Пригласить друзей": "Invite friends",
    "Уведомления и звук": "Notifications and sound",
    "Устройства": "Devices",
    "Сообщения": "Messages",
    "Избранное": "Saved Messages",
    "Папки": "Folders",
    "Экономия батареи и сети": "Battery and data saving",
    "Память": "Storage",
    "Оформление": "Appearance",
    "Язык приложения": "App language",
    "Русский": "Russian",
    "Английский": "English",
    "Политика конфиденциальности": "Privacy Policy",
    "Пользовательское соглашение": "User Agreement",
    "Безопасность": "Security",
    "Помощь": "Help",
    "О приложении": "About",
    "Назад": "Back",
    "Разрешены": "Allowed",
    "Запрещены в браузере": "Blocked by browser",
    "Не запрошены": "Not requested",
    "Не поддерживаются": "Not supported",
    "Разрешение браузера": "Browser permission",
    "Звук уведомлений": "Notification sound",
    "Проигрывать звук при новых входящих сообщениях": "Play a sound for new incoming messages",
    "Проверить звук": "Test sound",
    "Текущее устройство": "Current device",
    "Защищённое подключение": "Secure connection",
    "Локальное подключение": "Local connection",
    "Защищённое подключение · сейчас активно": "Secure connection · active now",
    "Локальное подключение · сейчас активно": "Local connection · active now",
    "Это устройство": "This device",
    "Код для входа находится в разделе «Безопасность»": "The sign-in code is available under Security",
    "Компактные сообщения": "Compact messages",
    "Уменьшить вертикальные интервалы в переписке": "Reduce vertical spacing in conversations",
    "Подписи к вложениям": "Attachment captions",
    "Показывать имя файла под фото и видео": "Show the file name below photos and videos",
    "Название новой папки": "New folder name",
    "Создать": "Create",
    "Удалить": "Delete",
    "Чатов пока нет.": "No chats yet.",
    "Создайте папку и добавьте в неё нужные чаты.": "Create a folder and add the chats you need.",
    "Объём вычисляется": "Calculating storage usage",
    "Браузер не сообщил доступный объём": "The browser did not report available storage",
    "Обновить расчёт": "Refresh estimate",
    "Очистить временный кэш": "Clear temporary cache",
    "Экономия трафика": "Data saver",
    "Реже обновлять фоновые данные и не предзагружать видео": "Refresh background data less often and do not preload videos",
    "Сократить анимации": "Reduce motion",
    "Уменьшить нагрузку на батарею": "Reduce battery usage",
    "Тема": "Theme",
    "Тёмная": "Dark",
    "Светлая": "Light",
    "Компактный интерфейс": "Compact interface",
    "Уменьшить отступы в списках и карточках": "Reduce spacing in lists and cards",
    "Сделать переходы спокойнее и экономнее": "Use calmer, more efficient transitions",
    "Соединение защищено": "Connection is secure",
    "Локальный режим": "Local mode",
    "Данные передаются по HTTPS": "Data is transferred over HTTPS",
    "Защищённый контекст браузера недоступен": "A secure browser context is unavailable",
    "Выйти на этом устройстве": "Log out on this device",
    "Удалить профиль": "Delete profile",
    "Установленное веб-приложение": "Installed web app",
    "Веб-версия": "Web version",
    "Режим": "Mode",
    "Соединение": "Connection",
    "Язык": "Language",
    "Все": "All",
    "Закрыть": "Close",
    "Ссылка на профиль скопирована": "Profile link copied",
    "Проверочный звук воспроизведён": "Test sound played",
    "Временный кэш очищен": "Temporary cache cleared",
    "Новое сообщение": "New message"
  }));

  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();
  let applying = false;

  function isEnglish() {
    return state.language === "en" || document.documentElement.lang.toLowerCase().startsWith("en");
  }

  function translateUnits(value) {
    return value
      .replace(/\bГБ\b/g, "GB")
      .replace(/\bМБ\b/g, "MB")
      .replace(/\bКБ\b/g, "KB")
      .replace(/\bБ\b/g, "B");
  }

  function dynamic(value) {
    const trimmed = value.trim();
    if (exact.has(trimmed)) {
      return exact.get(trimmed);
    }
    if (/^Версия\s+/.test(trimmed)) {
      return trimmed.replace(/^Версия\s+/, "Version ");
    }
    if (/\sзанято$/.test(trimmed)) {
      return `${translateUnits(trimmed.replace(/\sзанято$/, ""))} used`;
    }
    if (/^Доступно до\s+/.test(trimmed)) {
      return `Up to ${translateUnits(trimmed.replace(/^Доступно до\s+/, ""))} available`;
    }
    return translateUnits(trimmed);
  }

  function shouldSkip(node) {
    const parent = node.parentElement;
    if (!parent) {
      return true;
    }
    return Boolean(parent.closest([
      "script",
      "style",
      "[data-settings-folder-select]",
      ".settings-profile-hero h2",
      ".settings-profile-hero p",
      ".settings-folder-editor-head > strong",
      ".settings-folder-chat strong",
      "[data-settings-qr-name]",
      "[data-settings-qr-link]"
    ].join(",")));
  }

  function translateTextNode(node) {
    if (shouldSkip(node)) {
      return;
    }

    if (!originalText.has(node)) {
      originalText.set(node, node.nodeValue);
    }
    const source = originalText.get(node) || "";
    if (!isEnglish()) {
      if (node.nodeValue !== source) {
        node.nodeValue = source;
      }
      return;
    }

    const match = source.match(/^(\s*)(.*?)(\s*)$/s);
    if (!match || !match[2].trim()) {
      return;
    }
    const translated = dynamic(match[2]);
    if (translated !== match[2].trim()) {
      node.nodeValue = `${match[1]}${translated}${match[3]}`;
    }
  }

  function translateAttribute(element, name) {
    const value = element.getAttribute(name);
    if (!value) {
      return;
    }
    let stored = originalAttributes.get(element);
    if (!stored) {
      stored = new Map();
      originalAttributes.set(element, stored);
    }
    if (!stored.has(name)) {
      stored.set(name, value);
    }
    const source = stored.get(name);
    element.setAttribute(name, isEnglish() ? dynamic(source) : source);
  }

  function apply(root = document) {
    if (applying || !root) {
      return;
    }
    applying = true;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        translateTextNode(node);
        node = walker.nextNode();
      }

      const elements = root.nodeType === Node.ELEMENT_NODE
        ? [root, ...root.querySelectorAll("[aria-label], [placeholder], [title]")]
        : [...root.querySelectorAll("[aria-label], [placeholder], [title]")];
      elements.forEach((element) => {
        ["aria-label", "placeholder", "title"].forEach((name) => {
          if (element.hasAttribute(name)) {
            translateAttribute(element, name);
          }
        });
      });
    } finally {
      applying = false;
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (applying) {
      return;
    }
    mutations.forEach((mutation) => {
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            translateTextNode(node);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            apply(node);
          }
        });
      } else if (mutation.type === "characterData") {
        translateTextNode(mutation.target);
      }
    });
  });

  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true
  });

  const htmlObserver = new MutationObserver(() => apply(document.body));
  htmlObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["lang", "data-language"]
  });

  if (typeof showActionFeedback === "function") {
    const originalShowActionFeedback = showActionFeedback;
    showActionFeedback = function showTranslatedActionFeedback(message, options = {}) {
      const translated = isEnglish() ? dynamic(String(message || "")) : message;
      return originalShowActionFeedback(translated, options);
    };
  }

  apply(document.body);
})();
