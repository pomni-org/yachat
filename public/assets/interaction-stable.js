(() => {
  "use strict";

  if (window.__yachatInteractionStableInstalled) return;
  window.__yachatInteractionStableInstalled = true;

  const RELEASE_VERSION = "68";
  const FULL_QUALITY_CHAT_LOGO = `/assets/yachat-brand-1024.png?v=${RELEASE_VERSION}`;
  const LATIN_DIGITAL_ID = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{2,3}[0-9]{3,4}$/;
  const CYRILLIC_DIGITAL_ID = /^[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ]{2,3}[0-9]{3,4}$/;

  function normalizeDigitalId(value) {
    const normalized = String(value || "")
      .toUpperCase()
      .replaceAll("Ё", "Е")
      .replace(/[^A-ZА-Я0-9]+/g, "")
      .slice(0, 6);
    return normalized.length === 6 && (LATIN_DIGITAL_ID.test(normalized) || CYRILLIC_DIGITAL_ID.test(normalized))
      ? normalized
      : "";
  }

  function installMessageTransportFix() {
    if (typeof yachatApi === "undefined" || !yachatApi?.messenger) return;
    yachatApi.messenger.send = async function sendMessageThroughPushRoute(payload = {}) {
      const authToken = localStorage.getItem("yachat-http-auth-token") || "";
      const response = await fetch("/api/message", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) {
        throw new Error(result?.detail || result?.error || `Message request failed: HTTP ${response.status}`);
      }
      return result;
    };
  }

  function installDirectorySearchFix() {
    if (typeof yachatApi === "undefined" || !yachatApi?.users) return;
    yachatApi.users.search = async function searchUsersIncludingDigitalId(query = "") {
      const source = String(query || "").trim();
      const digitalId = normalizeDigitalId(source);
      const authToken = localStorage.getItem("yachat-http-auth-token") || "";
      const params = new URLSearchParams({ query: digitalId || source });
      const response = await fetch(`/api/users/search?${params}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result) {
        throw new Error(result?.detail || result?.error || `User search failed: HTTP ${response.status}`);
      }
      return Array.isArray(result) ? result : Array.isArray(result.users) ? result.users : [];
    };
  }

  function installDigitalIdSearchRules() {
    if (typeof shouldSearchUserDirectory === "function" && !shouldSearchUserDirectory.__yachatCyrillicDigitalId) {
      const previous = shouldSearchUserDirectory;
      const wrapped = function shouldSearchCyrillicDigitalId(query) {
        return Boolean(normalizeDigitalId(query)) || previous(query);
      };
      Object.defineProperty(wrapped, "__yachatCyrillicDigitalId", { value: true });
      shouldSearchUserDirectory = wrapped;
    }
  }

  function repairChannelLogoImages(root = document) {
    root.querySelectorAll?.(".is-channel img").forEach((image) => {
      if (!image.src.includes("yachat-brand-1024.png")) image.src = FULL_QUALITY_CHAT_LOGO;
      image.removeAttribute("srcset");
      image.decoding = "async";
      image.style.objectFit = "contain";
      image.style.imageRendering = "auto";
      image.style.transform = "none";
    });
  }

  function installBrandQualityFix() {
    if (!document.querySelector("style[data-yachat-brand-quality]")) {
      const style = document.createElement("style");
      style.dataset.yachatBrandQuality = "";
      style.textContent = `
        .chat-avatar.is-channel img,
        .dialog-avatar.is-channel img,
        .dialog-intro-avatar.is-channel img,
        .chat-profile-avatar.is-channel img,
        .avatar-modal-image.is-channel img {
          width: 100% !important;
          height: 100% !important;
          max-width: none !important;
          max-height: none !important;
          object-fit: contain !important;
          object-position: center !important;
          image-rendering: auto !important;
          transform: none !important;
          filter: none !important;
        }
      `;
      document.head.append(style);
    }
    if (typeof chatAvatarSource === "function" && !window.__yachatFullQualityLogoSourceInstalled) {
      window.__yachatFullQualityLogoSourceInstalled = true;
      const originalChatAvatarSource = chatAvatarSource;
      chatAvatarSource = function fullQualityChatAvatarSource(chat) {
        return chat?.id === "yachat-channel" ? FULL_QUALITY_CHAT_LOGO : originalChatAvatarSource(chat);
      };
    }
    repairChannelLogoImages();
  }

  function installIosPickerFix() {
    const pickerForButton = (button) => button?.matches?.('[data-action="attach-file"]')
      ? document.querySelector("[data-attachment-input]")
      : button?.matches?.('[data-action="attach-document"]')
        ? document.querySelector("[data-document-input]")
        : null;

    function preparePicker(input) {
      if (!input) return;
      input.style.setProperty("display", "block", "important");
      input.style.setProperty("position", "fixed", "important");
      input.style.setProperty("left", "-10000px", "important");
      input.style.setProperty("top", "0", "important");
      input.style.setProperty("width", "1px", "important");
      input.style.setProperty("height", "1px", "important");
      input.style.setProperty("opacity", "0", "important");
      input.style.setProperty("pointer-events", "none", "important");
    }

    document.querySelectorAll("[data-attachment-input], [data-document-input]").forEach(preparePicker);
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.('[data-action="attach-file"], [data-action="attach-document"]');
      const input = pickerForButton(button);
      if (!button || !input) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        if (typeof getActiveChat === "function" && typeof canSendToChat === "function" && !canSendToChat(getActiveChat())) return;
      } catch {
        return;
      }
      preparePicker(input);
      if (input.disabled) input.disabled = false;
      input.value = "";
      if (typeof input.showPicker === "function") {
        try {
          input.showPicker();
          return;
        } catch {}
      }
      input.click();
    }, true);
  }

  function installIosSettingsSwitchFix() {
    if (!document.querySelector("style[data-yachat-ios-switches]")) {
      const style = document.createElement("style");
      style.dataset.yachatIosSwitches = "";
      style.textContent = `
        .settings-toggle-row { cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; user-select: none; }
        .settings-toggle-row .settings-switch { flex: 0 0 46px; pointer-events: none; transform: translateZ(0); }
        .settings-toggle-row .settings-switch::after { will-change: transform; transform: translate3d(0, 0, 0); }
        .settings-toggle-row input:checked + .settings-switch::after { transform: translate3d(18px, 0, 0); }
      `;
      document.head.append(style);
    }

    function toggleRow(row) {
      const input = row?.querySelector?.("input[data-settings-toggle]");
      if (!input || input.disabled) return;
      input.checked = !input.checked;
      row.setAttribute("role", "switch");
      row.setAttribute("aria-checked", input.checked ? "true" : "false");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    document.addEventListener("click", (event) => {
      const row = event.target.closest?.(".settings-toggle-row");
      if (!row) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(row);
    }, true);
    document.addEventListener("keydown", (event) => {
      const row = event.target.closest?.(".settings-toggle-row");
      if (!row || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleRow(row);
    }, true);
  }

  function repairMoreLayer() {
    const panel = document.querySelector("[data-side-panel]");
    const backdrop = document.querySelector("[data-chat-more-backdrop]");
    if (!panel || !backdrop || backdrop.parentElement === panel) return;
    panel.append(backdrop);
  }

  installMessageTransportFix();
  installDirectorySearchFix();
  installDigitalIdSearchRules();
  installBrandQualityFix();
  installIosPickerFix();
  installIosSettingsSwitchFix();
  repairMoreLayer();

  const layerObserver = new MutationObserver((records) => {
    const relevant = records.some((record) => [...record.addedNodes].some((node) => (
      node instanceof Element
      && (node.matches("[data-chat-more-backdrop], .is-channel") || node.querySelector("[data-chat-more-backdrop], .is-channel"))
    )));
    if (!relevant) return;
    repairMoreLayer();
    repairChannelLogoImages();
  });
  layerObserver.observe(document.body, { childList: true, subtree: true });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-panel-action='chat-profile-more']")) return;
    queueMicrotask(repairMoreLayer);
    requestAnimationFrame(repairMoreLayer);
  }, true);
})();
