(() => {
  "use strict";

  let layer = null;
  let image = null;
  let previousBodyOverflow = "";
  let previousHtmlOverflow = "";
  let lastTrigger = null;

  function parseBackgroundImage(value) {
    const match = String(value || "").match(/^url\(["']?(.*?)["']?\)$/i);
    return match?.[1] || "";
  }

  function avatarSource(trigger) {
    const explicit = String(trigger?.dataset?.avatarSrc || "").trim();
    if (explicit) return explicit;

    const nestedImage = trigger?.matches?.("img") ? trigger : trigger?.querySelector?.("img");
    const imageSource = nestedImage?.currentSrc || nestedImage?.src || "";
    if (imageSource) return imageSource;

    const candidates = [trigger, trigger?.firstElementChild].filter(Boolean);
    for (const candidate of candidates) {
      const source = parseBackgroundImage(getComputedStyle(candidate).backgroundImage);
      if (source) return source;
    }

    return "";
  }

  function ensureViewer() {
    if (layer?.isConnected) return layer;

    layer = document.createElement("section");
    layer.className = "avatar-fullscreen-viewer";
    layer.dataset.avatarFullscreen = "";
    layer.hidden = true;
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("aria-label", "Просмотр фотографии профиля");
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

    image.addEventListener("load", () => {
      layer?.classList.add("is-image-ready");
    });

    image.addEventListener("error", closeViewer);
    return layer;
  }

  function hideLegacyViewer() {
    try {
      if (typeof closeAvatarViewer === "function") closeAvatarViewer();
    } catch {
      // Старый просмотрщик не должен мешать новому, но и ломать страницу тоже.
    }

    document.querySelectorAll("[data-avatar-modal]").forEach((legacyLayer) => {
      legacyLayer.hidden = true;
      legacyLayer.setAttribute("aria-hidden", "true");
    });
  }

  function openViewer(trigger) {
    const source = avatarSource(trigger);
    if (!source) return false;

    hideLegacyViewer();
    ensureViewer();
    lastTrigger = trigger;
    previousBodyOverflow = document.body.style.overflow;
    previousHtmlOverflow = document.documentElement.style.overflow;

    layer.classList.remove("is-visible", "is-image-ready");
    layer.hidden = false;
    layer.removeAttribute("aria-hidden");
    image.alt = String(trigger.dataset.avatarTitle || trigger.dataset.avatarText || "Фотография профиля");
    image.src = source;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.classList.add("avatar-fullscreen-open");

    requestAnimationFrame(() => {
      layer?.classList.add("is-visible");
      layer?.querySelector("[data-avatar-fullscreen-close]")?.focus({ preventScroll: true });
    });
    return true;
  }

  function closeViewer() {
    if (!layer || layer.hidden) return;

    layer.classList.remove("is-visible", "is-image-ready");
    document.body.classList.remove("avatar-fullscreen-open");
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousHtmlOverflow;

    const trigger = lastTrigger;
    lastTrigger = null;
    window.setTimeout(() => {
      if (!layer) return;
      layer.hidden = true;
      layer.setAttribute("aria-hidden", "true");
      if (image) {
        image.removeAttribute("src");
        image.alt = "";
      }
      trigger?.focus?.({ preventScroll: true });
    }, 150);
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-avatar-view]");
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

    if ((event.key === "Enter" || event.key === " ") && event.target.closest("[data-avatar-view]")) {
      if (openViewer(event.target.closest("[data-avatar-view]"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
  }, true);
})();