(() => {
  "use strict";

  const SYSTEM_AVATAR_SELECTOR = ".digital-id-identity-card > img, .kotoslugi-row > img";
  const AVATAR_IMAGE_SELECTOR = `
    img[data-avatar-modal-image],
    [data-avatar-view] > img,
    [data-avatar-view] img,
    [data-avatar-modal-image] > img,
    [data-avatar-modal-image] img,
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
  const MAX_AVATAR_STORAGE_LENGTH = 3_200_000;
  const MAX_AVATAR_CANVAS_SIDE = 4096;
  const AVATAR_QUALITY_STEPS = [0.96, 0.92, 0.88, 0.82, 0.74, 0.64];
  const LATIN_DIGITAL_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const CYRILLIC_DIGITAL_ID_ALPHABET = "АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ";
  const LATIN_DIGITAL_ID = /^(?:[ABCDEFGHJKLMNPQRSTUVWXYZ]{2}[0-9]{4}|[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}[0-9]{3})$/;
  const CYRILLIC_DIGITAL_ID = /^(?:[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{2}[0-9]{4}|[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{3}[0-9]{3})$/;

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

  function restoreAvatarPosition(source, parsed) {
    return parsed.positioned ? encodeAvatarPosition(source, parsed) : source;
  }

  function loadAvatarSource(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Не удалось подготовить изображение профиля."));
      image.src = source;
    });
  }

  async function prepareAvatarForStorage(value) {
    const parsed = splitAvatarSource(value);
    if (!parsed.source || parsed.source.length <= MAX_AVATAR_STORAGE_LENGTH) return String(value || "");
    if (!parsed.source.startsWith("data:image/")) {
      throw new Error("Изображение профиля слишком большое для сохранения.");
    }

    const image = await loadAvatarSource(parsed.source);
    const naturalWidth = Math.max(1, Number(image.naturalWidth) || 1);
    const naturalHeight = Math.max(1, Number(image.naturalHeight) || 1);
    let scale = Math.min(1, MAX_AVATAR_CANVAS_SIDE / Math.max(naturalWidth, naturalHeight));
    let smallest = "";

    for (let pass = 0; pass < 8; pass += 1) {
      const width = Math.max(1, Math.round(naturalWidth * scale));
      const height = Math.max(1, Math.round(naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("Не удалось подготовить изображение профиля.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, width, height);

      for (const quality of AVATAR_QUALITY_STEPS) {
        const candidate = canvas.toDataURL("image/webp", quality);
        if (!candidate || candidate === "data:,") continue;
        if (!smallest || candidate.length < smallest.length) smallest = candidate;
        if (candidate.length <= MAX_AVATAR_STORAGE_LENGTH) {
          document.documentElement.dataset.yachatAvatarStorage = "safe-full-frame-v1";
          return restoreAvatarPosition(candidate, parsed);
        }
      }

      scale *= 0.78;
    }

    if (smallest && smallest.length <= MAX_AVATAR_STORAGE_LENGTH) {
      document.documentElement.dataset.yachatAvatarStorage = "safe-full-frame-v1";
      return restoreAvatarPosition(smallest, parsed);
    }
    throw new Error("Изображение профиля слишком большое для сохранения.");
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
    if (LOW_RES_BRAND_PATTERN.test(sourcePath(current))) image.src = HIGH_RES_BRAND_SOURCE;
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
      if (typeof cropToDataUrl === "function") {
        cropToDataUrl = function preserveAvatarSource(source, crop = {}) {
          return encodeAvatarPosition(source, crop);
        };
      }
      if (typeof readAvatarFile === "function" && !readAvatarFile.__yachatSafeStorage) {
        const originalReadAvatarFile = readAvatarFile;
        const wrappedReadAvatarFile = async function readAvatarFileForSafeStorage() {
          const positionedSource = await originalReadAvatarFile.apply(this, arguments);
          return prepareAvatarForStorage(positionedSource);
        };
        Object.defineProperty(wrappedReadAvatarFile, "__yachatSafeStorage", { value: true });
        readAvatarFile = wrappedReadAvatarFile;
      }
      document.documentElement.dataset.yachatAvatarUpload = "positioned-original-v2";
      window.yachatAvatarPosition = Object.freeze({
        split: splitAvatarSource,
        encode: encodeAvatarPosition,
        prepare: prepareAvatarForStorage,
        maxStorageLength: MAX_AVATAR_STORAGE_LENGTH
      });
    } catch {
      // Standalone shells without the main cropper keep their own reader.
    }
  }

  function digitalIdScript(value) {
    const compact = String(value || "").replace(/[\s—–-]+/g, "").toUpperCase();
    if (LATIN_DIGITAL_ID.test(compact)) return "latin";
    if (CYRILLIC_DIGITAL_ID.test(compact)) return "cyrillic";
    return "";
  }

  function generateSingleScriptDigitalId(script = "") {
    const chosen = script === "latin" || script === "cyrillic"
      ? script
      : (() => {
          try { return state?.language === "ru" ? "cyrillic" : "latin"; } catch { return "latin"; }
        })();
    const alphabet = chosen === "cyrillic" ? CYRILLIC_DIGITAL_ID_ALPHABET : LATIN_DIGITAL_ID_ALPHABET;
    const letterCount = Math.random() < 0.5 ? 2 : 3;
    let value = "";
    for (let index = 0; index < letterCount; index += 1) {
      value += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    while (value.length < 6) value += Math.floor(Math.random() * 10);
    return value;
  }

  function formatSingleScriptDigitalId(value) {
    const compact = String(value || "").replace(/[\s—–-]+/g, "").toUpperCase();
    if (!digitalIdScript(compact)) return "";
    return `${compact.slice(0, 3)} — ${compact.slice(3)}`;
  }

  function installDigitalIdGuard() {
    try {
      if (typeof createLocalDigitalId === "function") createLocalDigitalId = generateSingleScriptDigitalId;
      if (typeof formatLocalDigitalId === "function") formatLocalDigitalId = formatSingleScriptDigitalId;
      window.yachatDigitalId = Object.freeze({
        generate: generateSingleScriptDigitalId,
        format: formatSingleScriptDigitalId,
        script: digitalIdScript
      });
      document.documentElement.dataset.yachatDigitalId = "single-script-v1";
    } catch {
      // Static pages do not expose the account helpers.
    }
  }

  installNonDestructivePositioner();
  installDigitalIdGuard();
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