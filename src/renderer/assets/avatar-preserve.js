(() => {
  "use strict";

  const SYSTEM_AVATAR_SELECTOR = ".digital-id-identity-card > img, .kotoslugi-row > img";
  const AVATAR_IMAGE_SELECTOR = `
    [data-avatar-view] > img,
    .avatar-preview > img,
    .done-mark > img,
    .chat-avatar > img,
    .dialog-avatar > img,
    .dialog-intro-avatar > img,
    .panel-avatar > img,
    .panel-row-avatar > img,
    .profile-edit-avatar-preview > img,
    .create-chat-avatar-preview > img,
    .settings-profile-avatar > img,
    .settings-folder-avatar > img,
    .chat-profile-avatar > img,
    .group-member-avatar > img,
    .mention-avatar > img,
    .message-author-avatar > img
  `;
  const LOW_RES_BRAND_PATTERN = /\/assets\/yachat-brand-(?:64|180)\.png$/;
  const HIGH_RES_BRAND_SOURCE = "/assets/yachat-brand-512.png?v=83";
  const POSITION_MARKER = "#yachat-avatar-position=";

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(Number(value) || 0, minimum), maximum);
  }

  function splitAvatarSource(value) {
    const source = String(value || "").trim();
    const markerIndex = source.lastIndexOf(POSITION_MARKER);
    if (markerIndex < 0) return { source, positioned: false, x: 0, y: 0, zoom: 1 };

    const raw = source.slice(markerIndex + POSITION_MARKER.length).split(",");
    if (raw.length !== 3 || raw.some((item) => !Number.isFinite(Number(item)))) {
      return { source: source.slice(0, markerIndex), positioned: false, x: 0, y: 0, zoom: 1 };
    }

    return {
      source: source.slice(0, markerIndex),
      positioned: true,
      x: clamp(raw[0], -1, 1),
      y: clamp(raw[1], -1, 1),
      zoom: clamp(raw[2], 1, 3)
    };
  }

  function encodeAvatarPosition(source, crop = {}) {
    const base = splitAvatarSource(source).source;
    if (!base) return "";
    const x = clamp(crop.x, -1, 1).toFixed(4);
    const y = clamp(crop.y, -1, 1).toFixed(4);
    const zoom = clamp(crop.zoom || 1, 1, 3).toFixed(4);
    return `${base}${POSITION_MARKER}${x},${y},${zoom}`;
  }

  function sourcePath(value) {
    const source = splitAvatarSource(value).source;
    if (!source) return "";
    try {
      return new URL(source, window.location.href).pathname;
    } catch {
      return source.split(/[?#]/, 1)[0];
    }
  }

  function normalizeSystemAvatar(image) {
    if (!(image instanceof HTMLImageElement)) return;
    const current = String(image.getAttribute("src") || "").trim();
    if (LOW_RES_BRAND_PATTERN.test(sourcePath(current))) {
      image.src = HIGH_RES_BRAND_SOURCE;
    }
    image.decoding = "async";
    image.draggable = false;
    image.dataset.yachatAvatarResolution = "full";
  }

  function normalizeAvatarImage(image) {
    if (!(image instanceof HTMLImageElement) || image.matches(SYSTEM_AVATAR_SELECTOR)) return;

    const attributeSource = String(image.getAttribute("src") || "").trim();
    const rememberedSource = String(image.dataset.yachatPositionedSource || "");
    let encodedSource = attributeSource;

    if (rememberedSource) {
      const remembered = splitAvatarSource(rememberedSource);
      if (attributeSource === remembered.source) {
        encodedSource = rememberedSource;
      } else if (!attributeSource.includes(POSITION_MARKER)) {
        delete image.dataset.yachatPositionedSource;
      }
    }

    const parsed = splitAvatarSource(encodedSource);
    image.decoding = "async";
    image.draggable = false;

    if (!parsed.positioned) {
      image.classList.remove("is-yachat-positioned-avatar");
      image.style.removeProperty("--yachat-avatar-position-x");
      image.style.removeProperty("--yachat-avatar-position-y");
      image.style.removeProperty("--yachat-avatar-zoom");
      return;
    }

    image.dataset.yachatPositionedSource = encodedSource;
    image.classList.add("is-yachat-positioned-avatar");
    image.style.setProperty("--yachat-avatar-position-x", `${50 + parsed.x * 50}%`);
    image.style.setProperty("--yachat-avatar-position-y", `${50 + parsed.y * 50}%`);
    image.style.setProperty("--yachat-avatar-zoom", String(parsed.zoom));
    if (attributeSource !== parsed.source) image.setAttribute("src", parsed.source);
  }

  function scan(root = document) {
    if (root instanceof HTMLImageElement) {
      if (root.matches(SYSTEM_AVATAR_SELECTOR)) normalizeSystemAvatar(root);
      if (root.matches(AVATAR_IMAGE_SELECTOR)) normalizeAvatarImage(root);
    }
    root.querySelectorAll?.(SYSTEM_AVATAR_SELECTOR).forEach(normalizeSystemAvatar);
    root.querySelectorAll?.(AVATAR_IMAGE_SELECTOR).forEach(normalizeAvatarImage);
  }

  function installNonDestructivePositioner() {
    try {
      if (typeof cropToDataUrl !== "function") return;
      cropToDataUrl = function preserveAvatarSource(source, crop = {}) {
        return encodeAvatarPosition(source, crop);
      };
      document.documentElement.dataset.yachatAvatarUpload = "positioned-original-v2";
      window.yachatAvatarPosition = Object.freeze({ split: splitAvatarSource, encode: encodeAvatarPosition });
    } catch {
      // Standalone shells without the main cropper keep their own reader.
    }
  }

  installNonDestructivePositioner();
  scan();

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node instanceof Element) scan(node);
      });
      if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
        if (record.target.matches(SYSTEM_AVATAR_SELECTOR)) normalizeSystemAvatar(record.target);
        if (record.target.matches(AVATAR_IMAGE_SELECTOR)) normalizeAvatarImage(record.target);
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