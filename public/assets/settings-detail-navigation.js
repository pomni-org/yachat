(() => {
  "use strict";

  if (
    typeof renderPanel !== "function"
    || typeof state !== "object"
    || !sidePanel
    || !panelBody
  ) {
    return;
  }

  const originalRenderPanel = renderPanel;
  const originalClosePanel = typeof closePanel === "function" ? closePanel : null;

  function syncSettingsDetailState() {
    const isSettingsDetail = state.activePanel === "settings"
      && Boolean(String(state.settingsPage || "").trim());

    document.body.classList.toggle("settings-detail-open", isSettingsDetail);
    sidePanel.classList.toggle("is-settings-detail", isSettingsDetail);
    panelBody.classList.toggle("is-settings-detail-body", isSettingsDetail);
  }

  renderPanel = function renderPanelWithSettingsDetailState(...args) {
    const result = originalRenderPanel.apply(this, args);
    syncSettingsDetailState();
    return result;
  };

  if (originalClosePanel) {
    closePanel = function closePanelWithSettingsDetailCleanup(...args) {
      const result = originalClosePanel.apply(this, args);
      syncSettingsDetailState();
      return result;
    };
  }

  syncSettingsDetailState();
})();
