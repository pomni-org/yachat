(() => {
  "use strict";

  if (window.__yachatAuthEntryFixInstalled) return;
  window.__yachatAuthEntryFixInstalled = true;

  const countryChoice = document.querySelector("[data-country-choice]");
  const countryList = document.querySelector("[data-country-list]");
  const deviceCodeScreen = document.querySelector('[data-screen="qr"]');
  let directDeviceInputPointerAt = Number.NEGATIVE_INFINITY;
  let countryRepairQueued = false;
  let deviceRepairQueued = false;

  const COUNTRY_FALLBACKS = new Map([
    ["RU", { country: "RU", name: "Россия", code: "+7" }],
    ["BY", { country: "BY", name: "Беларусь", code: "+375" }],
    ["KZ", { country: "KZ", name: "Казахстан", code: "+7" }]
  ]);

  function authUiActive() {
    return !document.body.classList.contains("messenger-mode");
  }

  function deviceCodeInputFrom(target) {
    const input = target?.closest?.("[data-device-code-input]") || null;
    return input && deviceCodeScreen?.contains(input) ? input : null;
  }

  function normalizeDeviceCode(value) {
    const compact = String(value || "")
      .toUpperCase()
      .replaceAll("Ё", "Е")
      .replace(/[‐‑‒–—−_\s]+/g, "-")
      .replace(/[^0-9A-ZА-Я-]/g, "")
      .replace(/-/g, "")
      .slice(0, 6);

    return compact.length > 3
      ? `${compact.slice(0, 3)}-${compact.slice(3)}`
      : compact;
  }

  function deviceCodeIsComplete(value) {
    const compact = normalizeDeviceCode(value).replace("-", "");
    return /^(?:[A-ZА-Я]{2}\d{4}|[A-ZА-Я]{3}\d{3})$/u.test(compact);
  }

  function deviceCodeCopy() {
    const english = typeof state !== "undefined" && state.language === "en";
    return english ? {
      label: "Sign-in code",
      title: "Enter your YaChat code",
      description: "Open Settings → Security on a device where you are already signed in.",
      location: "Enter all 6 characters. The hyphen is added automatically. The code works once and expires after 10 minutes.",
      placeholder: "AB1-234"
    } : {
      label: "Код входа",
      title: "Введите код ЯЧата",
      description: "Откройте Настройки → Безопасность на устройстве, где вы уже вошли.",
      location: "Введите 6 символов. Дефис добавится сам. Код действует 10 минут и используется один раз.",
      placeholder: "АБ1-234"
    };
  }

  function setTextIfChanged(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function prepareDeviceCodeField(input = deviceCodeScreen?.querySelector("[data-device-code-input]")) {
    if (
      !authUiActive()
      || !(input instanceof HTMLInputElement)
      || !deviceCodeScreen?.contains(input)
    ) {
      return null;
    }

    const text = deviceCodeCopy();
    input.disabled = false;
    input.readOnly = false;
    input.removeAttribute("readonly");
    input.removeAttribute("disabled");
    input.tabIndex = 0;
    input.type = "text";
    input.inputMode = "text";
    input.autocomplete = "one-time-code";
    input.autocapitalize = "characters";
    input.spellcheck = false;
    input.maxLength = 7;
    input.setAttribute("aria-label", text.label);
    input.setAttribute("placeholder", text.placeholder);
    input.dataset.authEntryPrepared = "true";

    const shell = input.closest("label");
    if (shell) {
      shell.classList.remove("device-code-input-shell");
      shell.classList.add("device-code-field");
      let label = shell.querySelector("[data-device-code-label]");
      if (!label) {
        label = document.createElement("span");
        label.dataset.deviceCodeLabel = "";
        shell.prepend(label);
      }
      setTextIfChanged(label, text.label);
    }

    const title = deviceCodeScreen?.querySelector(".screen-copy h1");
    const description = deviceCodeScreen?.querySelector(".screen-copy p");
    const location = deviceCodeScreen?.querySelector(".device-code-location");
    setTextIfChanged(title, text.title);
    setTextIfChanged(description, text.description);
    setTextIfChanged(location, text.location);

    return input;
  }

  function syncDeviceCode(input = deviceCodeScreen?.querySelector("[data-device-code-input]")) {
    if (!authUiActive()) {
      return;
    }
    input = prepareDeviceCodeField(input);
    if (!input) {
      return;
    }

    const nextValue = normalizeDeviceCode(input.value);
    if (input.value !== nextValue) {
      const caret = Math.min(input.selectionStart ?? nextValue.length, nextValue.length);
      input.value = nextValue;
      try {
        input.setSelectionRange(caret, caret);
      } catch {
        // Safari may reject selection changes while composing text.
      }
    }

    const valid = deviceCodeIsComplete(nextValue);
    const invalidValue = nextValue && !valid ? "true" : "false";
    if (input.getAttribute("aria-invalid") !== invalidValue) {
      input.setAttribute("aria-invalid", invalidValue);
    }
    const submitButton = input.form?.querySelector('button[type="submit"]');
    if (submitButton && !submitButton.classList.contains("is-loading")) {
      submitButton.disabled = !valid;
    }
  }

  function countryOption(country) {
    const normalized = String(country || "").toUpperCase();
    if (typeof COUNTRY_OPTIONS !== "undefined" && Array.isArray(COUNTRY_OPTIONS)) {
      const option = COUNTRY_OPTIONS.find((item) => item?.country === normalized);
      if (option) return option;
    }
    return COUNTRY_FALLBACKS.get(normalized) || null;
  }

  function countryRowIsStructured(row, option) {
    const parts = [...row.children];
    return parts.length === 3
      && parts[0].matches("span")
      && parts[1].matches("strong")
      && parts[2].matches("small")
      && parts[0].textContent === option.country
      && parts[1].textContent === option.name
      && parts[2].textContent === option.code;
  }

  function rebuildCountryRow(row, option) {
    const country = document.createElement("span");
    const name = document.createElement("strong");
    const code = document.createElement("small");
    country.textContent = option.country;
    name.textContent = option.name;
    code.textContent = option.code;
    row.replaceChildren(country, name, code);
  }

  function repairCountryRows() {
    countryRepairQueued = false;
    if (!authUiActive() || !countryList) {
      return;
    }

    countryList.querySelectorAll(".country-choice-row[data-country]").forEach((row) => {
      const option = countryOption(row.dataset.country);
      if (option && !countryRowIsStructured(row, option)) {
        rebuildCountryRow(row, option);
      }

      row.style.removeProperty("height");
      row.querySelectorAll(":scope > span, :scope > strong, :scope > small").forEach((part) => {
        part.style.removeProperty("position");
        part.style.removeProperty("inset");
        part.style.removeProperty("transform");
      });
    });
  }

  function queueCountryRepair() {
    if (!authUiActive()) {
      countryRepairQueued = false;
      return;
    }
    if (countryRepairQueued) return;
    countryRepairQueued = true;
    queueMicrotask(repairCountryRows);
  }

  function repairDeviceCodeScreen() {
    deviceRepairQueued = false;
    if (!authUiActive()) {
      return;
    }
    const input = prepareDeviceCodeField();
    if (input) syncDeviceCode(input);
  }

  function queueDeviceRepair() {
    if (!authUiActive()) {
      deviceRepairQueued = false;
      return;
    }
    if (deviceRepairQueued) return;
    deviceRepairQueued = true;
    queueMicrotask(repairDeviceCodeScreen);
  }

  function markDirectDeviceInputGesture(event) {
    if (!authUiActive()) return;
    const input = deviceCodeInputFrom(event.target);
    if (!input) return;
    directDeviceInputPointerAt = performance.now();
    prepareDeviceCodeField(input);
  }

  function repairProgrammaticDeviceFocus(event) {
    if (!authUiActive()) return;
    const input = deviceCodeInputFrom(event.target);
    if (!input) return;
    prepareDeviceCodeField(input);

    const focusedAt = performance.now();
    if (focusedAt - directDeviceInputPointerAt <= 700) {
      return;
    }

    window.setTimeout(() => {
      if (
        authUiActive()
        && document.activeElement === input
        && performance.now() - directDeviceInputPointerAt > 700
      ) {
        input.blur();
      }
    }, 0);
  }

  document.addEventListener("pointerdown", markDirectDeviceInputGesture, true);
  document.addEventListener("touchstart", markDirectDeviceInputGesture, { capture: true, passive: true });
  document.addEventListener("focusin", repairProgrammaticDeviceFocus, true);

  document.addEventListener("input", (event) => {
    if (!authUiActive()) return;
    const input = deviceCodeInputFrom(event.target);
    if (input) syncDeviceCode(input);
  }, true);

  document.addEventListener("paste", (event) => {
    if (!authUiActive()) return;
    const input = deviceCodeInputFrom(event.target);
    if (!input) return;
    queueMicrotask(() => syncDeviceCode(input));
  }, true);

  if (countryList) {
    new MutationObserver(queueCountryRepair).observe(countryList, {
      childList: true,
      subtree: true,
      characterData: true
    });
    queueCountryRepair();
  }

  if (countryChoice) {
    new MutationObserver(() => {
      if (authUiActive() && !countryChoice.hidden) queueCountryRepair();
    }).observe(countryChoice, { attributes: true, attributeFilter: ["hidden"] });
  }

  if (deviceCodeScreen) {
    new MutationObserver(queueDeviceRepair).observe(deviceCodeScreen, {
      childList: true,
      subtree: true
    });
    queueDeviceRepair();
  }
})();
