(() => {
  "use strict";

  if (typeof state === "undefined" || typeof setTheme !== "function" || typeof renderPanel !== "function") {
    return;
  }

  const nativeSetTheme = setTheme;
  const nativeRenderPanel = renderPanel;
  const systemQuery = window.matchMedia?.("(prefers-color-scheme: dark)") || null;
  let lastPersistedThemeSignature = "";
  let themePersistenceInFlight = null;

  function resolvedSystemTheme() {
    return systemQuery?.matches ? "dark" : "light";
  }

  function currentThemeChoice() {
    return state.themeSource === "system" ? "system" : state.theme === "light" ? "light" : "dark";
  }

  function persistTheme() {
    const payload = {
      theme: state.theme,
      themeSource: state.themeSource
    };
    const signature = JSON.stringify(payload);
    if (signature === lastPersistedThemeSignature) {
      return themePersistenceInFlight || Promise.resolve();
    }

    lastPersistedThemeSignature = signature;
    themePersistenceInFlight = Promise.resolve(yachatApi.settings?.update?.(payload))
      .catch(() => {
        if (lastPersistedThemeSignature === signature) lastPersistedThemeSignature = "";
      })
      .finally(() => {
        themePersistenceInFlight = null;
      });
    return themePersistenceInFlight;
  }

  setTheme = function setThemeWithServerPersistence(theme, persist = false, source = "manual") {
    nativeSetTheme(theme, false, source);
    if (persist) {
      void persistTheme();
    }
  };

  function themeChoiceButton(value, icon, label) {
    const selected = currentThemeChoice() === value;
    return `
      <button class="settings-theme-choice${selected ? " is-active" : ""}" type="button" data-settings-theme-choice="${value}" aria-pressed="${selected ? "true" : "false"}">
        <span>${iconSvg(icon)}</span>
        <strong>${label}</strong>
        ${selected ? iconSvg("check", "settings-theme-choice-check") : ""}
      </button>
    `;
  }

  function decorateAppearanceSettings() {
    if (state.activePanel !== "settings" || state.settingsPage !== "appearance" || !panelBody) {
      return;
    }

    const oldThemeRow = panelBody.querySelector('[data-settings-action="toggle-theme"]');
    if (!oldThemeRow) {
      return;
    }

    const selector = document.createElement("div");
    selector.className = "settings-theme-selector";
    selector.setAttribute("role", "group");
    selector.setAttribute("aria-label", "Тема");
    selector.innerHTML = `
      <div class="settings-theme-selector-head">
        <span>${iconSvg("palette")}</span>
        <div>
          <strong>Тема</strong>
          <small>Системная следует оформлению устройства</small>
        </div>
      </div>
      <div class="settings-theme-choice-grid">
        ${themeChoiceButton("system", "monitor-cog", "Системная")}
        ${themeChoiceButton("light", "sun", "Светлая")}
        ${themeChoiceButton("dark", "moon", "Тёмная")}
      </div>
    `;
    oldThemeRow.replaceWith(selector);
    hydrateIcons(selector);
  }

  renderPanel = function renderPanelWithThemeChoice() {
    nativeRenderPanel();
    decorateAppearanceSettings();
  };

  panelBody?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-settings-theme-choice]");
    if (!button) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    const choice = button.dataset.settingsThemeChoice;
    if (choice === "system") {
      setTheme(resolvedSystemTheme(), true, "system");
    } else {
      setTheme(choice === "light" ? "light" : "dark", true, "manual");
    }
    renderPanel();
  }, true);

  systemQuery?.addEventListener?.("change", () => {
    if (state.themeSource !== "system") {
      return;
    }
    setTheme(resolvedSystemTheme(), true, "system");
    if (state.activePanel === "settings" && state.settingsPage === "appearance") {
      renderPanel();
    }
  });

  if (typeof renderMessages === "function" && typeof getMessageById === "function") {
    const nativeRenderMessages = renderMessages;

    function decorateEditedMessages() {
      document.querySelectorAll(".message-bubble[data-message-id]").forEach((bubble) => {
        const message = getMessageById(bubble.dataset.messageId);
        const edited = Boolean(message?.editedAt);
        bubble.classList.toggle("is-edited", edited);
        const time = bubble.querySelector(":scope > time");
        let label = time?.querySelector(".message-edited-label");

        if (!edited) {
          label?.remove();
          return;
        }

        if (!label && time) {
          label = document.createElement("span");
          label.className = "message-edited-label";
          time.prepend(label);
        }
        if (label) {
          label.textContent = state.language === "en" ? "edit ·" : "ред ·";
        }
      });
    }

    renderMessages = function renderMessagesWithReferenceMeta() {
      nativeRenderMessages();
      decorateEditedMessages();
    };

    decorateEditedMessages();
  }

  decorateAppearanceSettings();
})();