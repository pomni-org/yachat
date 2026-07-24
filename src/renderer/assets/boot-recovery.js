(() => {
  "use strict";

  const FAILURE_CLASS = "boot-recovery-failed";
  const BOOT_TIMEOUT_MS = 8000;
  let failureShown = false;
  let timeoutId = 0;
  let observer = null;

  function bodyIsBooting() {
    return Boolean(document.body?.classList.contains("app-booting"));
  }

  function stopWatching() {
    window.clearTimeout(timeoutId);
    timeoutId = 0;
    observer?.disconnect();
    observer = null;
  }

  function markReadyIfFinished() {
    if (!bodyIsBooting()) {
      stopWatching();
      return true;
    }
    return false;
  }

  function showFailure(detail = "Интерфейс не запустился.") {
    if (failureShown || markReadyIfFinished()) {
      return;
    }

    failureShown = true;
    document.body?.classList.add(FAILURE_CLASS);
    const status = document.querySelector("[data-boot-recovery-status]");
    const actions = document.querySelector("[data-boot-recovery-actions]");
    if (status) {
      status.textContent = `${detail} Перезагрузите страницу без старого кэша.`;
    }
    if (actions) {
      actions.hidden = false;
    }
    console.error("[yachat-boot]", detail);
  }

  async function clearRuntimeCaches() {
    try {
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }
    } catch (error) {
      console.warn("[yachat-boot] cache cleanup failed", error);
    }

    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
    } catch (error) {
      console.warn("[yachat-boot] service worker cleanup failed", error);
    }
  }

  function reloadWithFreshUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("_yachat_recover", String(Date.now()));
    window.location.replace(url.href);
  }

  function prepareRecoveryUi() {
    const logo = document.querySelector("[data-boot-recovery-logo]");
    logo?.addEventListener("error", () => {
      logo.hidden = true;
      logo.closest(".boot-mark")?.classList.add("is-logo-fallback");
    }, { once: true });

    document.querySelector("[data-boot-retry]")?.addEventListener("click", () => {
      window.location.reload();
    });

    document.querySelector("[data-boot-refresh]")?.addEventListener("click", async () => {
      const button = document.querySelector("[data-boot-refresh]");
      if (button) {
        button.disabled = true;
        button.textContent = "Очищаем кэш…";
      }
      await clearRuntimeCaches();
      reloadWithFreshUrl();
    });

    if (markReadyIfFinished()) {
      return;
    }

    observer = new MutationObserver(markReadyIfFinished);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    timeoutId = window.setTimeout(() => {
      showFailure("ЯЧат слишком долго остаётся на экране загрузки.");
    }, BOOT_TIMEOUT_MS);
  }

  window.addEventListener("error", (event) => {
    if (!bodyIsBooting()) {
      return;
    }
    const message = event?.error?.message || event?.message || "Ошибка запуска JavaScript.";
    window.setTimeout(() => showFailure(`Ошибка запуска: ${message}`), 250);
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    if (!bodyIsBooting()) {
      return;
    }
    const reason = event?.reason;
    const message = reason?.message || String(reason || "Необработанная ошибка запуска.");
    window.setTimeout(() => showFailure(`Ошибка запуска: ${message}`), 250);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", prepareRecoveryUi, { once: true });
  } else {
    prepareRecoveryUi();
  }

  window.__YACHAT_BOOT_RECOVERY__ = Object.freeze({
    fail: showFailure,
    clearRuntimeCaches
  });
})();
