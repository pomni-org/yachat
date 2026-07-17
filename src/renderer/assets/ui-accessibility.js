(() => {
  "use strict";

  const PREVIEW_SELECTOR = ".chat-row-bottom > span:first-child";
  const SWITCH_SELECTOR = ".settings-toggle-row input[type='checkbox'][data-settings-toggle]";
  let previewFrame = 0;
  let previewSyncing = false;

  function versionAtLeast(match, major, minor) {
    if (!match) return false;
    const currentMajor = Number.parseInt(match[1], 10) || 0;
    const currentMinor = Number.parseInt(match[2], 10) || 0;
    return currentMajor > major || (currentMajor === major && currentMinor >= minor);
  }

  function supportsAppleNativeSwitch() {
    const ua = navigator.userAgent || "";
    const isAppleWebKit = /AppleWebKit/i.test(ua);
    const isIOS = /iPhone|iPad|iPod/i.test(ua)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isDesktopSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR/i.test(ua);
    const iosVersion = ua.match(/(?:CPU (?:iPhone )?OS|iPhone OS) (\d+)[._](\d+)/i);
    const safariVersion = ua.match(/Version\/(\d+)\.(\d+)/i);

    if (!isAppleWebKit) return false;
    if (isIOS) {
      return versionAtLeast(iosVersion || safariVersion, 17, 4);
    }
    return isDesktopSafari && versionAtLeast(safariVersion, 17, 4);
  }

  function syncSwitchAccessibility(input) {
    input.setAttribute("aria-checked", input.checked ? "true" : "false");
  }

  function enhanceSwitches(root = document) {
    const inputs = root.matches?.(SWITCH_SELECTOR)
      ? [root]
      : [...root.querySelectorAll?.(SWITCH_SELECTOR) || []];

    inputs.forEach((input) => {
      input.classList.add("settings-native-switch");
      input.setAttribute("switch", "");
      input.setAttribute("role", "switch");

      if (!input.hasAttribute("aria-label")) {
        const label = input.closest("label")?.querySelector(".settings-row-copy strong")?.textContent?.trim();
        if (label) input.setAttribute("aria-label", label);
      }

      syncSwitchAccessibility(input);
      if (input.dataset.nativeSwitchReady === "true") return;
      input.dataset.nativeSwitchReady = "true";
      input.addEventListener("change", () => syncSwitchAccessibility(input));
    });
  }

  function ensurePreviewStructure(preview) {
    const row = preview.closest(".chat-row-bottom");
    if (!row) return null;

    preview.classList.add("chat-preview-text");
    let marker = row.querySelector(":scope > .chat-preview-ellipsis");
    if (!marker) {
      marker = document.createElement("span");
      marker.className = "chat-preview-ellipsis";
      marker.textContent = "…";
      marker.setAttribute("aria-hidden", "true");
      marker.hidden = true;
      row.append(marker);
    }

    return { row, marker };
  }

  function measurePreviewText(preview) {
    const style = getComputedStyle(preview);
    const clone = document.createElement("span");
    clone.textContent = preview.textContent || "";
    Object.assign(clone.style, {
      position: "fixed",
      inset: "auto auto auto -10000px",
      display: "inline-block",
      width: "max-content",
      minWidth: "0",
      maxWidth: "none",
      margin: "0",
      padding: "0",
      overflow: "visible",
      textOverflow: "clip",
      whiteSpace: "nowrap",
      visibility: "hidden",
      pointerEvents: "none",
      contain: "layout style paint",
      font: style.font,
      fontKerning: style.fontKerning,
      fontFeatureSettings: style.fontFeatureSettings,
      fontVariationSettings: style.fontVariationSettings,
      letterSpacing: style.letterSpacing,
      textTransform: style.textTransform
    });
    document.body.append(clone);
    const width = clone.getBoundingClientRect().width;
    clone.remove();
    return width;
  }

  function updatePreviewOverflow() {
    cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(() => {
      previewSyncing = true;
      try {
        document.querySelectorAll(PREVIEW_SELECTOR).forEach((preview) => {
          const structure = ensurePreviewStructure(preview);
          if (!structure) return;

          const hasText = Boolean(preview.textContent?.trim());
          const availableWidth = structure.row.clientWidth;
          const textWidth = hasText ? measurePreviewText(preview) : 0;
          const isOverflowing = hasText && availableWidth > 0 && textWidth > availableWidth + 0.5;

          if (structure.row.classList.contains("has-spaced-ellipsis") !== isOverflowing) {
            structure.row.classList.toggle("has-spaced-ellipsis", isOverflowing);
          }
          const shouldHide = !isOverflowing;
          if (structure.marker.hidden !== shouldHide) {
            structure.marker.hidden = shouldHide;
          }
        });
      } finally {
        previewSyncing = false;
      }
    });
  }

  document.documentElement.classList.toggle(
    "yachat-apple-native-switches",
    supportsAppleNativeSwitch()
  );

  enhanceSwitches();
  updatePreviewOverflow();

  const observer = new MutationObserver((records) => {
    if (previewSyncing) return;
    let chatListChanged = false;

    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        enhanceSwitches(node);
        if (node.classList.contains("chat-preview-ellipsis")) return;
        if (node.matches(".chat-row, .chat-list") || node.querySelector(".chat-row")) {
          chatListChanged = true;
        }
      });

      if (record.target instanceof Element
        && record.target.closest(".chat-list")
        && !record.target.classList.contains("chat-preview-ellipsis")) {
        chatListChanged = true;
      }
    });

    if (chatListChanged) updatePreviewOverflow();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  const chatList = document.querySelector(".chat-list");
  if (chatList && "ResizeObserver" in window) {
    new ResizeObserver(updatePreviewOverflow).observe(chatList);
  } else {
    window.addEventListener("resize", updatePreviewOverflow, { passive: true });
  }

  document.fonts?.ready?.then(updatePreviewOverflow).catch(() => {});
})();