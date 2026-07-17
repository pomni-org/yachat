(() => {
  "use strict";

  const TRIGGER_SELECTOR = "[data-avatar-view], [data-photo-view]";
  let layer = null;
  let image = null;
  let previousBodyOverflow = "";
  let previousHtmlOverflow = "";
  let lastTrigger = null;

  function parseBackgroundImage(value) {
    const match = String(value || "").match(/^url\(["']?(.*?)["']?\)$/i);
    return match?.[1] || "";
  }

  function imageSource(trigger) {
    const explicit = String(trigger?.dataset?.avatarSrc || trigger?.dataset?.photoSrc || "").trim();
    if (explicit) return explicit;

    const nestedImage = trigger?.matches?.("img") ? trigger : trigger?.querySelector?.("img");
    const source = nestedImage?.currentSrc || nestedImage?.src || "";
    if (source) return source;

    const candidates = [trigger, trigger?.firstElementChild].filter(Boolean);
    for (const candidate of candidates) {
      const background = parseBackgroundImage(getComputedStyle(candidate).backgroundImage);
      if (background) return background;
    }

    return "";
  }

  function syncVisualViewport() {
    if (!layer) return;
    const height = Math.max(1, Math.round(window.visualViewport?.height || window.innerHeight || 1));
    const width = Math.max(1, Math.round(window.visualViewport?.width || window.innerWidth || 1));
    layer.style.setProperty("--yachat-viewer-height", `${height}px`);
    layer.style.setProperty("--yachat-viewer-width", `${width}px`);
  }

  function ensureViewer() {
    if (layer?.isConnected) return layer;

    layer = document.createElement("section");
    layer.className = "avatar-fullscreen-viewer";
    layer.dataset.avatarFullscreen = "";
    layer.hidden = true;
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("aria-label", "Просмотр изображения");
    layer.innerHTML = `
      <header class="avatar-fullscreen-head">
        <button class="avatar-fullscreen-close" type="button" data-avatar-fullscreen-close aria-label="Закрыть">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
        <strong class="avatar-fullscreen-count">1/1</strong>
        <span class="avatar-fullscreen-head-spacer" aria-hidden="true"></span>
      </header>
      <div class="avatar-fullscreen-stage">
        <img class="avatar-fullscreen-image" alt="" draggable="false" />
      </div>
    `;

    image = layer.querySelector(".avatar-fullscreen-image");
    document.body.append(layer);

    layer.addEventListener("click", (event) => {
      if (event.target.closest("[data-avatar-fullscreen-close]")) {
        event.preventDefault();
        closeViewer();
      }
    });

    image.addEventListener("load", () => layer?.classList.add("is-image-ready"));
    image.addEventListener("error", closeViewer);
    return layer;
  }

  function hideLegacyViewer() {
    try {
      if (typeof closeAvatarViewer === "function") closeAvatarViewer();
    } catch {
      // Старый просмотрщик не должен проступать под полноэкранным слоем.
    }

    document.querySelectorAll("[data-avatar-modal]").forEach((legacyLayer) => {
      legacyLayer.hidden = true;
      legacyLayer.setAttribute("aria-hidden", "true");
    });
  }

  function openViewer(trigger) {
    const source = imageSource(trigger);
    if (!source) return false;

    hideLegacyViewer();
    ensureViewer();
    syncVisualViewport();
    lastTrigger = trigger;
    previousBodyOverflow = document.body.style.overflow;
    previousHtmlOverflow = document.documentElement.style.overflow;

    layer.classList.remove("is-visible", "is-image-ready", "is-message-photo");
    layer.classList.toggle("is-message-photo", trigger.hasAttribute("data-photo-view"));
    layer.hidden = false;
    layer.removeAttribute("aria-hidden");
    image.alt = String(
      trigger.dataset.avatarTitle ||
      trigger.dataset.photoTitle ||
      trigger.dataset.avatarText ||
      "Изображение"
    );
    image.src = source;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.classList.add("avatar-fullscreen-open");
    document.documentElement.classList.add("avatar-fullscreen-open");

    requestAnimationFrame(() => {
      syncVisualViewport();
      layer?.classList.add("is-visible");
      layer?.querySelector("[data-avatar-fullscreen-close]")?.focus({ preventScroll: true });
    });
    return true;
  }

  function closeViewer() {
    if (!layer || layer.hidden) return;

    layer.classList.remove("is-visible", "is-image-ready", "is-message-photo");
    document.body.classList.remove("avatar-fullscreen-open");
    document.documentElement.classList.remove("avatar-fullscreen-open");
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;

    const trigger = lastTrigger;
    lastTrigger = null;
    window.setTimeout(() => {
      if (!layer) return;
      layer.hidden = true;
      layer.setAttribute("aria-hidden", "true");
      layer.style.removeProperty("--yachat-viewer-height");
      layer.style.removeProperty("--yachat-viewer-width");
      if (image) {
        image.removeAttribute("src");
        image.alt = "";
      }
      trigger?.focus?.({ preventScroll: true });
    }, 150);
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest(TRIGGER_SELECTOR);
    if (!trigger || event.target.closest("[data-avatar-fullscreen-close]")) return;

    if (openViewer(trigger)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && layer && !layer.hidden) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeViewer();
      return;
    }

    if ((event.key === "Enter" || event.key === " ") && event.target.closest(TRIGGER_SELECTOR)) {
      if (openViewer(event.target.closest(TRIGGER_SELECTOR))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
  }, true);

  window.visualViewport?.addEventListener("resize", syncVisualViewport, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncVisualViewport, { passive: true });
  window.addEventListener("orientationchange", syncVisualViewport, { passive: true });
})();