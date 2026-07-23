(() => {
  const input = document.querySelector("[data-device-code-input]");
  const form = document.querySelector("[data-device-code-login]");
  const countryChoice = document.querySelector("[data-country-choice]");
  const countryList = document.querySelector("[data-country-list]");

  function normalizeDeviceCode(value) {
    const compact = String(value || "")
      .toUpperCase()
      .replace(/[‐‑‒–—−_\s]+/g, "-")
      .replace(/[^0-9A-ZА-ЯЁ-]/g, "")
      .replace(/-/g, "")
      .slice(0, 6);

    return compact.length > 3
      ? `${compact.slice(0, 3)}-${compact.slice(3)}`
      : compact;
  }

  function prepareDeviceCodeField() {
    if (!input || !form) {
      return;
    }

    const shell = input.closest("label");
    if (shell) {
      shell.classList.remove("device-code-input-shell");
      shell.classList.add("device-code-field");
      if (!shell.querySelector("[data-device-code-label]")) {
        const label = document.createElement("span");
        label.dataset.deviceCodeLabel = "";
        label.textContent = "Код входа";
        shell.prepend(label);
      }
    }

    const screen = form.closest('[data-screen="qr"]');
    const title = screen?.querySelector(".screen-copy h1");
    const description = screen?.querySelector(".screen-copy p");
    const location = screen?.querySelector(".device-code-location");
    if (title) {
      title.textContent = "Введите код ЯЧата";
    }
    if (description) {
      description.textContent = "Откройте Настройки → Безопасность на устройстве, где вы уже вошли.";
    }
    if (location) {
      location.textContent = "Введите 6 символов. Дефис добавится сам. Код действует 10 минут и используется один раз.";
    }

    input.setAttribute("aria-label", "Код входа ЯЧата");
    input.setAttribute("placeholder", "АБ1-234");
  }

  function syncDeviceCode() {
    if (!input || !form) {
      return;
    }

    const nextValue = normalizeDeviceCode(input.value);
    if (input.value !== nextValue) {
      input.value = nextValue;
    }

    const valid = /^[0-9A-ZА-ЯЁ]{3}-[0-9A-ZА-ЯЁ]{3}$/.test(nextValue);
    input.setAttribute("aria-invalid", nextValue && !valid ? "true" : "false");

    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton && !submitButton.classList.contains("is-loading")) {
      submitButton.disabled = !valid;
    }
  }

  if (input && form) {
    prepareDeviceCodeField();
    input.addEventListener("input", syncDeviceCode);
    input.addEventListener("change", syncDeviceCode);
    input.addEventListener("blur", syncDeviceCode);
    input.addEventListener("paste", () => queueMicrotask(syncDeviceCode));
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      syncDeviceCode();
      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton && !submitButton.disabled) {
        form.requestSubmit(submitButton);
      }
    });
    syncDeviceCode();
  }

  function repairCountryRows() {
    if (!countryList) {
      return;
    }

    countryList.querySelectorAll(".country-choice-row").forEach((row) => {
      row.style.removeProperty("height");
      row.querySelectorAll(":scope > span, :scope > strong, :scope > small").forEach((part) => {
        part.style.removeProperty("position");
        part.style.removeProperty("inset");
        part.style.removeProperty("transform");
      });
    });
  }

  if (countryList) {
    new MutationObserver(repairCountryRows).observe(countryList, {
      childList: true,
      subtree: true
    });
    repairCountryRows();
  }

  if (countryChoice) {
    const observer = new MutationObserver(() => {
      if (!countryChoice.hidden) {
        repairCountryRows();
      }
    });
    observer.observe(countryChoice, { attributes: true, attributeFilter: ["hidden"] });
  }
})();
