(() => {
  "use strict";

  if (typeof state === "undefined") return;

  const AUTH_TOKEN_KEY = "yachat-http-auth-token";
  const DEVICE_AUTH_KEY = "yachat-http-device-authorized";
  const CODE_SCREEN = document.querySelector('[data-screen="qr"]');
  let deviceCodeTimer = null;
  let deviceCodeRequest = null;
  let settingsUpgradeQueued = false;

  function labels() {
    const english = state.language === "en";
    return english ? {
      loginLink: "Sign in with a code",
      loginTitle: "Sign in with a code",
      loginHint: "Open YaChat on a device where you are already signed in, then go to Settings → Security.",
      codePlaceholder: "AB1-234",
      loginAction: "Sign in",
      codeLocation: "The code is shown in Settings → Security and is valid for 10 minutes.",
      invalid: "Enter the complete six-character code.",
      expired: "The code is invalid or has expired.",
      securityTitle: "Sign-in code",
      securityHint: "Use this code to sign in on another device. Only the newest code works.",
      create: "Create code",
      refresh: "Create a new code",
      validFor: "Valid for",
      expiredLabel: "Code expired",
      copied: "Code copied",
      phoneCopied: "Phone number copied",
      shareProfile: "Share profile",
      devicesHint: "The sign-in code is available in Security."
    } : {
      loginLink: "Войти по коду",
      loginTitle: "Вход по коду",
      loginHint: "Откройте ЯЧат на устройстве, где уже выполнен вход, затем перейдите в Настройки → Безопасность.",
      codePlaceholder: "АБ1-234",
      loginAction: "Войти",
      codeLocation: "Код находится в Настройках → Безопасность и действует 10 минут.",
      invalid: "Введите код целиком: шесть символов.",
      expired: "Код неверный или уже истёк.",
      securityTitle: "Код для входа",
      securityHint: "Введите этот код на другом устройстве. Работает только самый новый код.",
      create: "Создать код",
      refresh: "Создать новый код",
      validFor: "Действует ещё",
      expiredLabel: "Код истёк",
      copied: "Код скопирован",
      phoneCopied: "Номер скопирован",
      shareProfile: "Поделиться профилем",
      devicesHint: "Код для входа находится в разделе «Безопасность»."
    };
  }

  function normalizeCode(value) {
    return String(value || "")
      .toUpperCase()
      .replaceAll("Ё", "Е")
      .replace(/[^0-9A-ZА-Я]/g, "")
      .slice(0, 6);
  }

  function formatCode(value) {
    const raw = normalizeCode(value);
    return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
  }

  async function apiRequest(path, options = {}) {
    const token = localStorage.getItem(AUTH_TOKEN_KEY) || "";
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.detail || payload?.error || "Request failed");
    return payload;
  }

  async function copyValue(value, successText) {
    const text = String(value || "").trim();
    if (!text) return;
    try {
      if (typeof copyTextToClipboard === "function") await copyTextToClipboard(text);
      else await navigator.clipboard.writeText(text);
      showActionFeedback?.(successText, { icon: "copy" });
    } catch {
      showActionFeedback?.(state.language === "en" ? "Could not copy" : "Не удалось скопировать", {
        tone: "error",
        icon: "circle-alert"
      });
    }
  }

  function renderDeviceLoginScreen() {
    if (!CODE_SCREEN) return;
    const text = labels();
    CODE_SCREEN.classList.add("device-code-login-screen");
    CODE_SCREEN.innerHTML = `
      <button class="back-button" type="button" data-device-code-back>
        ${typeof iconSvg === "function" ? iconSvg("chevron-left") : "‹"}
        <span>${state.language === "en" ? "Back" : "Назад"}</span>
      </button>
      <div class="screen-copy">
        <h1>${escapeHtml(text.loginTitle)}</h1>
        <p>${escapeHtml(text.loginHint)}</p>
      </div>
      <form class="auth-form device-code-login-form" data-device-code-login>
        <label class="device-code-input-shell">
          <input
            type="text"
            inputmode="text"
            enterkeyhint="done"
            autocomplete="one-time-code"
            autocapitalize="characters"
            spellcheck="false"
            maxlength="7"
            placeholder="${escapeHtml(text.codePlaceholder)}"
            data-device-code-input
          />
        </label>
        <div class="form-message" data-device-code-message></div>
        <button class="main-button" type="submit" disabled>${escapeHtml(text.loginAction)}</button>
      </form>
      <p class="device-code-location">${escapeHtml(text.codeLocation)}</p>
    `;
    hydrateIcons?.(CODE_SCREEN);
  }

  function updateLoginLabels() {
    const link = document.querySelector('[data-action="open-qr"]');
    if (link) {
      link.textContent = labels().loginLink;
      link.setAttribute("aria-label", labels().loginLink);
    }
    renderDeviceLoginScreen();
  }

  async function redeemCode(form) {
    const input = form.querySelector("[data-device-code-input]");
    const message = form.querySelector("[data-device-code-message]");
    const button = form.querySelector('button[type="submit"]');
    const raw = normalizeCode(input?.value);
    const valid = /^(?:[A-ZА-Я]{2}\d{4}|[A-ZА-Я]{3}\d{3})$/u.test(raw);
    if (!valid) {
      if (message) message.textContent = labels().invalid;
      return;
    }

    button.disabled = true;
    button.classList.add("is-loading");
    if (message) message.textContent = "";
    try {
      const result = await apiRequest("/api/device-code/redeem", {
        method: "POST",
        body: JSON.stringify({ code: raw })
      });
      const token = result?.sessionToken || result?.account?.sessionToken || "";
      if (!token) throw new Error(labels().expired);
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      localStorage.setItem(DEVICE_AUTH_KEY, "true");
      beginAppBoot?.("bootOpeningAccount");
      window.location.replace("/");
    } catch (error) {
      if (message) message.textContent = labels().expired;
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  }

  function installDeviceLoginHandlers() {
    document.addEventListener("click", (event) => {
      const open = event.target.closest('[data-action="open-qr"]');
      if (open) {
        event.preventDefault();
        event.stopImmediatePropagation();
        renderDeviceLoginScreen();
        setScreen?.("qr");
        requestAnimationFrame(() => CODE_SCREEN?.querySelector("[data-device-code-input]")?.focus());
        return;
      }

      if (event.target.closest("[data-device-code-back]")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setScreen?.("phone", { focusPhone: true });
        return;
      }

      const refresh = event.target.closest("[data-device-code-refresh]");
      if (refresh) {
        event.preventDefault();
        void loadSecurityCode(true);
        return;
      }

      const code = event.target.closest("[data-device-code-copy]");
      if (code) {
        event.preventDefault();
        void copyValue(code.dataset.deviceCodeCopy, labels().copied);
        return;
      }

      const phone = event.target.closest("[data-copy-own-phone]");
      if (phone) {
        event.preventDefault();
        void copyValue(phone.dataset.copyOwnPhone, labels().phoneCopied);
        return;
      }

      const openSecurity = event.target.closest("[data-open-device-code-security]");
      if (openSecurity) {
        event.preventDefault();
        state.settingsPage = "security";
        renderPanel?.();
        return;
      }

      const verificationCode = event.target.closest("[data-copy-verification-code]");
      if (verificationCode) {
        event.preventDefault();
        event.stopPropagation();
        void copyValue(verificationCode.dataset.copyVerificationCode, labels().copied);
      }
    }, true);

    document.addEventListener("input", (event) => {
      const input = event.target.closest("[data-device-code-input]");
      if (!input) return;
      const formatted = formatCode(input.value);
      if (input.value !== formatted) input.value = formatted;
      const form = input.closest("form");
      const button = form?.querySelector('button[type="submit"]');
      const raw = normalizeCode(formatted);
      if (button) button.disabled = !/^(?:[A-ZА-Я]{2}\d{4}|[A-ZА-Я]{3}\d{3})$/u.test(raw);
      const message = form?.querySelector("[data-device-code-message]");
      if (message) message.textContent = "";
    }, true);

    document.addEventListener("submit", (event) => {
      const form = event.target.closest("[data-device-code-login]");
      if (!form) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void redeemCode(form);
    }, true);
  }

  function codeCardMarkup() {
    const text = labels();
    return `
      <section class="settings-card device-code-card" data-device-code-card>
        <div class="device-code-card-copy">
          <span class="settings-row-icon">${iconSvg?.("key-round") || ""}</span>
          <div>
            <strong>${escapeHtml(text.securityTitle)}</strong>
            <small>${escapeHtml(text.securityHint)}</small>
          </div>
        </div>
        <button class="device-code-value" type="button" data-device-code-copy="" aria-label="${escapeHtml(text.securityTitle)}">
          <code data-device-code-value>•••-•••</code>
        </button>
        <p data-device-code-expiry>${escapeHtml(state.language === "en" ? "Loading…" : "Загрузка…")}</p>
        <button class="settings-primary is-secondary" type="button" data-device-code-refresh>
          ${iconSvg?.("refresh-cw") || ""}<span>${escapeHtml(text.refresh)}</span>
        </button>
      </section>
    `;
  }

  function stopDeviceCodeTimer() {
    window.clearInterval(deviceCodeTimer);
    deviceCodeTimer = null;
  }

  function updateDeviceCodeCard(payload = {}) {
    const card = panelBody?.querySelector("[data-device-code-card]");
    if (!card) return;
    card.dataset.deviceCodeLoaded = "true";
    const code = String(payload.code || "");
    const value = card.querySelector("[data-device-code-value]");
    const copy = card.querySelector("[data-device-code-copy]");
    const expiry = card.querySelector("[data-device-code-expiry]");
    const refresh = card.querySelector("[data-device-code-refresh] span");
    if (value) value.textContent = code || "•••-•••";
    if (copy) {
      copy.dataset.deviceCodeCopy = code;
      copy.disabled = !code;
    }
    if (refresh) refresh.textContent = code ? labels().refresh : labels().create;

    stopDeviceCodeTimer();
    const expiresAt = payload.expiresAt ? new Date(payload.expiresAt).valueOf() : 0;
    const tick = () => {
      if (!expiry?.isConnected) {
        stopDeviceCodeTimer();
        return;
      }
      const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      if (!code || !expiresAt || seconds <= 0) {
        expiry.textContent = code ? labels().expiredLabel : "";
        if (copy) copy.disabled = true;
        stopDeviceCodeTimer();
        return;
      }
      const minutes = Math.floor(seconds / 60);
      const rest = String(seconds % 60).padStart(2, "0");
      expiry.textContent = `${labels().validFor}: ${minutes}:${rest}`;
    };
    tick();
    if (code && expiresAt > Date.now()) deviceCodeTimer = window.setInterval(tick, 1000);
  }

  async function loadSecurityCode(force = false) {
    if (deviceCodeRequest) return deviceCodeRequest;
    deviceCodeRequest = (async () => {
      try {
        let payload = force ? null : await apiRequest("/api/device-code");
        if (!payload?.code) {
          payload = await apiRequest("/api/device-code", {
            method: "POST",
            body: JSON.stringify({ language: state.language })
          });
        }
        updateDeviceCodeCard(payload);
      } catch (error) {
        const expiry = panelBody?.querySelector("[data-device-code-expiry]");
        if (expiry) expiry.textContent = state.language === "en" ? "Could not create code" : "Не удалось создать код";
      } finally {
        deviceCodeRequest = null;
      }
    })();
    return deviceCodeRequest;
  }

  function upgradeSettingsPanel() {
    settingsUpgradeQueued = false;
    if (!panelBody?.isConnected) return;

    const hero = panelBody.querySelector(".settings-profile-hero");
    if (hero) {
      const corner = hero.querySelector(".settings-profile-corner.is-left");
      if (corner && corner.dataset.deviceCodeShareReady !== "true") {
        corner.dataset.deviceCodeShareReady = "true";
        corner.dataset.settingsAction = "invite-friends";
        corner.setAttribute("aria-label", labels().shareProfile);
        corner.innerHTML = iconSvg?.("share-2") || "";
      }
      const contact = String(state.account?.contact || "").trim();
      const contactLine = hero.querySelector(":scope > p");
      if (contactLine && contact) {
        contactLine.dataset.copyOwnPhone = contact;
        contactLine.classList.add("settings-copy-phone");
        contactLine.setAttribute("role", "button");
        contactLine.tabIndex = 0;
        contactLine.title = labels().phoneCopied;
      }
    }

    panelBody.querySelectorAll('[data-panel-action="show-profile-qr"], [data-chat-profile-qr]').forEach((element) => element.remove());
    document.querySelectorAll("[data-settings-profile-qr]").forEach((element) => element.remove());

    if (state.settingsPage === "security") {
      panelBody.querySelectorAll("[data-session-camera], [data-session-capture], [data-session-message]").forEach((element) => element.remove());
      panelBody.querySelectorAll('[data-panel-action="scan-session"]').forEach((element) => element.remove());
      let card = panelBody.querySelector("[data-device-code-card]");
      if (!card) {
        const status = panelBody.querySelector(".settings-security-card");
        status?.insertAdjacentHTML("afterend", codeCardMarkup());
        hydrateIcons?.(panelBody);
        card = panelBody.querySelector("[data-device-code-card]");
      }
      if (card && !card.dataset.deviceCodeLoaded) {
        card.dataset.deviceCodeLoaded = "loading";
        void loadSecurityCode(false);
      }
    }

    if (state.settingsPage === "devices") {
      panelBody.querySelectorAll("[data-session-camera], [data-session-capture], [data-session-message]").forEach((element) => element.remove());
      panelBody.querySelectorAll('[data-panel-action="scan-session"]').forEach((button) => {
        if (button.dataset.deviceCodeButtonReady === "true") return;
        button.dataset.deviceCodeButtonReady = "true";
        button.dataset.openDeviceCodeSecurity = "";
        delete button.dataset.panelAction;
        button.innerHTML = `${iconSvg?.("key-round") || ""}<span>${escapeHtml(labels().devicesHint)}</span>`;
      });
      hydrateIcons?.(panelBody);
    }
  }

  function queueSettingsUpgrade() {
    if (settingsUpgradeQueued) return;
    settingsUpgradeQueued = true;
    queueMicrotask(upgradeSettingsPanel);
  }

  function decorateVerificationCodes() {
    if (state.activeChatId !== "yachat-codes") return;
    messageList?.querySelectorAll("code").forEach((code) => {
      const value = String(code.textContent || "").trim();
      if (!value) return;
      code.dataset.copyVerificationCode = value;
      code.classList.add("copyable-verification-code");
      code.setAttribute("role", "button");
      code.tabIndex = 0;
      code.title = labels().copied;
    });
  }

  function installSearchDeduplication() {
    if (typeof renderChatList !== "function") return;
    const originalRender = renderChatList;
    renderChatList = function renderChatListWithoutDuplicatePeople() {
      const originalUsers = Array.isArray(state.chatSearchUsers) ? state.chatSearchUsers : [];
      const existingIds = new Set(
        (state.chats || [])
          .filter((chat) => chat?.kind === "private")
          .map((chat) => typeof getPrivateChatParticipantId === "function" ? getPrivateChatParticipantId(chat) : "")
          .filter(Boolean)
      );
      state.chatSearchUsers = originalUsers.filter((user) => !existingIds.has(String(user?.id || "")));
      try {
        originalRender();
      } finally {
        state.chatSearchUsers = originalUsers;
      }
    };
  }

  function wrapRenderers() {
    if (typeof applyTranslations === "function") {
      const originalTranslations = applyTranslations;
      applyTranslations = function applyTranslationsWithoutQr() {
        originalTranslations();
        updateLoginLabels();
        queueSettingsUpgrade();
      };
    }

    if (typeof renderMessages === "function") {
      const originalMessages = renderMessages;
      renderMessages = function renderMessagesWithCopyableCodes() {
        originalMessages();
        decorateVerificationCodes();
      };
    }
  }

  installSearchDeduplication();
  wrapRenderers();
  renderDeviceLoginScreen();
  updateLoginLabels();
  installDeviceLoginHandlers();


  let pushRefreshPromise = null;

  async function refreshRealPushSubscription() {
    if (pushRefreshPromise) return pushRefreshPromise;
    if (!("Notification" in window) || Notification.permission !== "granted") return null;
    if (!("serviceWorker" in navigator) || typeof enablePushNotifications !== "function") return null;

    pushRefreshPromise = (async () => {
      try {
        await navigator.serviceWorker.ready;
        await enablePushNotifications();
        localStorage.setItem("yachat-push-subscription-ready-v29", String(Date.now()));
      } catch {
        // The next foreground opening will retry without blocking the messenger.
      } finally {
        pushRefreshPromise = null;
      }
    })();
    return pushRefreshPromise;
  }

  window.setTimeout(() => void refreshRealPushSubscription(), 900);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshRealPushSubscription();
  });
  window.addEventListener("online", () => void refreshRealPushSubscription());

  const observer = new MutationObserver((records) => {
    const onlyCountdown = records.length > 0 && records.every((record) =>
      record.target instanceof Element
        ? record.target.closest("[data-device-code-expiry]")
        : record.target.parentElement?.closest("[data-device-code-expiry]")
    );
    if (!onlyCountdown) queueSettingsUpgrade();
    decorateVerificationCodes();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  queueSettingsUpgrade();
  decorateVerificationCodes();
})();