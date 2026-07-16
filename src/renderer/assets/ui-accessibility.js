(() => {
  "use strict";

  const PREVIEW_SELECTOR = ".chat-row-bottom > span";
  const SWITCH_SELECTOR = ".settings-toggle-row input[type='checkbox'][data-settings-toggle]";
  let previewFrame = 0;

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

  function updatePreviewOverflow() {
    cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(() => {
      const previews = [...document.querySelectorAll(PREVIEW_SELECTOR)];

      previews.forEach((preview) => preview.classList.remove("has-spaced-ellipsis"));

      requestAnimationFrame(() => {
        previews.forEach((preview) => {
          const hasText = Boolean(preview.textContent?.trim());
          const isOverflowing = hasText && preview.scrollWidth > preview.clientWidth + 1;
          preview.classList.toggle("has-spaced-ellipsis", isOverflowing);
        });
      });
    });
  }

  document.documentElement.classList.toggle(
    "yachat-apple-native-switches",
    supportsAppleNativeSwitch()
  );

  enhanceSwitches();
  updatePreviewOverflow();

  const observer = new MutationObserver((records) => {
    let chatListChanged = false;

    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        enhanceSwitches(node);
        if (node.matches(".chat-row, .chat-list") || node.querySelector(".chat-row")) {
          chatListChanged = true;
        }
      });

      if (record.target instanceof Element && record.target.closest(".chat-list")) {
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