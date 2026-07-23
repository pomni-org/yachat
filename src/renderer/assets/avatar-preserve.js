(() => {
  "use strict";

  const SYSTEM_AVATAR_SELECTOR = ".digital-id-identity-card > img, .kotoslugi-row > img";
  const LOW_RES_BRAND_PATTERN = /\/assets\/yachat-brand-(?:64|180)\.png$/;
  const HIGH_RES_BRAND_SOURCE = "/assets/yachat-brand-512.png?v=82";

  function sourcePath(image) {
    const source = String(image?.getAttribute("src") || "").trim();
    if (!source) {
      return "";
    }

    try {
      return new URL(source, window.location.href).pathname;
    } catch {
      return source.split(/[?#]/, 1)[0];
    }
  }

  function normalizeSystemAvatar(image) {
    if (!(image instanceof HTMLImageElement)) {
      return;
    }

    if (LOW_RES_BRAND_PATTERN.test(sourcePath(image))) {
      image.src = HIGH_RES_BRAND_SOURCE;
    }

    image.decoding = "async";
    image.draggable = false;
    image.dataset.yachatAvatarResolution = "full";
  }

  function scan(root = document) {
    if (root instanceof Element && root.matches(SYSTEM_AVATAR_SELECTOR)) {
      normalizeSystemAvatar(root);
    }

    root.querySelectorAll?.(SYSTEM_AVATAR_SELECTOR).forEach(normalizeSystemAvatar);
  }

  scan();

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) {
          scan(node);
        }
      });

      if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
        normalizeSystemAvatar(record.target);
      }
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"]
  });
})();
