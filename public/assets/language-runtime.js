(() => {
  "use strict";

  const LANGUAGE_KEY = "yachat-language";
  const SOURCE_KEY = "yachat-language-source";
  const MIGRATION_KEY = "yachat-language-autodetect-v43";
  const SUPPORTED_LANGUAGES = new Set(["ru", "en"]);

  function normalizeLanguage(value) {
    const language = String(value || "").trim().toLowerCase().split(/[-_]/, 1)[0];
    return SUPPORTED_LANGUAGES.has(language) ? language : "";
  }

  function phoneLanguage() {
    return normalizeLanguage(navigator.language) === "ru" ? "ru" : "en";
  }

  function languageSource() {
    return localStorage.getItem(SOURCE_KEY) === "manual" ? "manual" : "system";
  }

  function selectedLanguage() {
    if (languageSource() === "manual") {
      return normalizeLanguage(localStorage.getItem(LANGUAGE_KEY)) || phoneLanguage();
    }

    return phoneLanguage();
  }

  function primeLanguage() {
    const language = selectedLanguage();
    localStorage.setItem(LANGUAGE_KEY, language);
    localStorage.setItem(SOURCE_KEY, languageSource());
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
    document.documentElement.dataset.languageSource = languageSource();
    return language;
  }

  if (!localStorage.getItem(MIGRATION_KEY)) {
    if (localStorage.getItem(SOURCE_KEY) !== "manual") {
      localStorage.setItem(SOURCE_KEY, "system");
      localStorage.setItem(LANGUAGE_KEY, phoneLanguage());
    }
    localStorage.setItem(MIGRATION_KEY, "1");
  }

  primeLanguage();

  let syncing = false;

  function visibleLanguage() {
    const marker = document.querySelector("[data-language-current]");
    return normalizeLanguage(marker?.textContent) || normalizeLanguage(document.documentElement.lang);
  }

  function synchronizeLanguage(persist = true) {
    if (syncing) {
      return;
    }

    const language = primeLanguage();
    if (typeof window.setLanguage !== "function" || visibleLanguage() === language) {
      return;
    }

    syncing = true;
    try {
      window.setLanguage(language, persist);
    } finally {
      syncing = false;
    }
  }

  function chooseManualLanguage(language) {
    const normalized = normalizeLanguage(language);
    if (!normalized) {
      return;
    }

    localStorage.setItem(SOURCE_KEY, "manual");
    localStorage.setItem(LANGUAGE_KEY, normalized);
    document.documentElement.dataset.languageSource = "manual";
  }

  document.addEventListener("click", (event) => {
    const choice = event.target.closest?.("[data-language]");
    if (!choice) {
      return;
    }

    chooseManualLanguage(choice.dataset.language);
  }, true);

  window.addEventListener("languagechange", () => {
    if (languageSource() !== "system") {
      return;
    }

    primeLanguage();
    queueMicrotask(() => synchronizeLanguage(true));
  });

  window.addEventListener("storage", (event) => {
    if (![LANGUAGE_KEY, SOURCE_KEY].includes(event.key)) {
      return;
    }

    queueMicrotask(() => synchronizeLanguage(false));
  });

  function watchForServerOverrides() {
    const check = () => {
      if (languageSource() === "system" && visibleLanguage() !== phoneLanguage()) {
        synchronizeLanguage(true);
      }
    };

    const htmlObserver = new MutationObserver(check);
    htmlObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"]
    });

    const marker = document.querySelector("[data-language-current]");
    if (marker) {
      const markerObserver = new MutationObserver(check);
      markerObserver.observe(marker, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }

    [0, 150, 500, 1200, 2500, 5000, 10000].forEach((delay) => {
      window.setTimeout(() => synchronizeLanguage(true), delay);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchForServerOverrides, { once: true });
  } else {
    watchForServerOverrides();
  }

  window.yachatLanguage = Object.freeze({
    get: selectedLanguage,
    getPhoneLanguage: phoneLanguage,
    getSource: languageSource,
    useSystem() {
      localStorage.setItem(SOURCE_KEY, "system");
      primeLanguage();
      synchronizeLanguage(true);
    },
    set(language) {
      chooseManualLanguage(language);
      synchronizeLanguage(true);
    }
  });
})();
