(() => {
  "use strict";

  if (
    typeof panelBody === "undefined"
    || !panelBody
    || typeof state === "undefined"
    || typeof setTheme !== "function"
  ) {
    return;
  }

  function languageCopy() {
    return state.language === "en"
      ? {
          system: "System",
          systemHint: "Follow the device appearance",
          dark: "Dark",
          darkHint: "Always use the dark theme",
          light: "Light",
          lightHint: "Always use the light theme"
        }
      : {
          system: "Системная",
          systemHint: "Повторять оформление устройства",
          dark: "Тёмная",
          darkHint: "Всегда использовать тёмную тему",
          light: "Светлая",
          lightHint: "Всегда использовать светлую тему"
        };
  }

  function selectedMode() {
    return state.themeSource === "system" ? "system" : state.theme;
  }

  function themeOption(mode, icon, title, subtitle) {
    const selected = selectedMode() === mode;
    return `
      <button
        class="settings-theme-option${selected ? " is-active" : ""}"
        type="button"
        data-yachat-theme-mode="${mode}"
        aria-pressed="${selected ? "true" : "false"}"
      >
        <span class="settings-theme-option-icon">${iconSvg(icon)}</span>
        <span class="settings-theme-option-copy">
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(subtitle)}</small>
        </span>
        <span class="settings-theme-option-check">${selected ? iconSvg("check") : ""}</span>
      </button>
    `;
  }

  function patchAppearancePanel() {
    const legacyRow = panelBody.querySelector('[data-settings-action="toggle-theme"]');
    if (!legacyRow || legacyRow.dataset.systemThemeUpgraded === "true") return;

    const copy = languageCopy();
    const picker = document.createElement("div");
    picker.className = "settings-theme-picker";
    picker.dataset.systemThemeUpgraded = "true";
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", state.language === "en" ? "Theme" : "Тема");
    picker.innerHTML = [
      themeOption("system", "monitor-smartphone", copy.system, copy.systemHint),
      themeOption("dark", "moon", copy.dark, copy.darkHint),
      themeOption("light", "sun", copy.light, copy.lightHint)
    ].join("");
    legacyRow.replaceWith(picker);
    try { hydrateIcons(picker); } catch {}
  }

  async function applyThemeMode(mode) {
    const source = mode === "system" ? "system" : "manual";
    const resolvedTheme = source === "system" ? systemTheme() : mode;
    setTheme(resolvedTheme, true, source);

    try {
      await yachatApi.settings?.update?.({
        theme: state.theme,
        themeSource: source
      });
    } catch {
      // Local preference remains usable during a temporary network failure.
    }

    patchAppearancePanel();
  }

  panelBody.addEventListener("click", (event) => {
    const button = event.target.closest("[data-yachat-theme-mode]");
    if (!button) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void applyThemeMode(button.dataset.yachatThemeMode);
  }, true);

  const observer = new MutationObserver(patchAppearancePanel);
  observer.observe(panelBody, { childList: true, subtree: true });
  patchAppearancePanel();
})();