(() => {
  "use strict";

  const AUTH_TOKEN_KEY = "yachat-http-auth-token";
  const PENDING_PROFILE_KEY = "yachat-pending-personal-profile-v1";
  const COMPLETE_FIELDS = ["familyName", "givenName", "patronymic", "birthDate"];
  let registrationDecision = "save";
  let allowRegistrationSubmitOnce = false;
  let warningResolve = null;

  function htmlEscape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function injectStyles() {
    if (document.querySelector("[data-personal-identity-styles]")) return;
    const style = document.createElement("style");
    style.dataset.personalIdentityStyles = "true";
    style.textContent = `
      .personal-identity-block{display:grid;gap:12px;margin-top:8px;padding-top:18px;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}
      .personal-identity-head{display:grid;gap:4px}.personal-identity-head strong{font-size:15px}.personal-identity-head span{font-size:12px;opacity:.68;line-height:1.45}
      .personal-identity-status{font-size:12px;line-height:1.45;opacity:.78;margin:0}
      .personal-identity-status[data-state="complete"]{opacity:1}
      .personal-identity-warning{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.55);backdrop-filter:blur(8px)}
      .personal-identity-warning[hidden]{display:none}
      .personal-identity-warning-card{width:min(420px,100%);display:grid;gap:14px;padding:22px;border-radius:22px;background:var(--surface,#17171b);color:var(--text,#fff);box-shadow:0 24px 80px rgba(0,0,0,.45)}
      .personal-identity-warning-card h2,.personal-identity-warning-card p{margin:0}.personal-identity-warning-card p{font-size:14px;line-height:1.55;opacity:.8}
      .personal-identity-warning-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}.personal-identity-warning-actions button{min-width:130px}
      .personal-identity-settings{display:grid;gap:12px;margin-top:18px;padding-top:18px;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent)}
      .personal-identity-settings h3,.personal-identity-settings p{margin:0}.personal-identity-settings>p{font-size:12px;line-height:1.45;opacity:.7}
      .personal-identity-settings .modal-field{display:grid;gap:6px}
      .personal-identity-settings-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    `;
    document.head.appendChild(style);
  }

  function ensureWarningModal() {
    let modal = document.querySelector("[data-personal-identity-warning]");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "personal-identity-warning";
    modal.dataset.personalIdentityWarning = "true";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="personal-identity-warning-card" role="dialog" aria-modal="true" aria-labelledby="personal-identity-warning-title">
        <h2 id="personal-identity-warning-title">Персональные данные не заполнены</h2>
        <p>Без фамилии, имени, отчества и даты рождения сервисы Бара, ЯЧата и Котослуг, которые используют цифровой ID, работать не будут.</p>
        <div class="personal-identity-warning-actions">
          <button class="panel-primary is-secondary" type="button" data-personal-warning-edit>Изменить данные</button>
          <button class="panel-primary" type="button" data-personal-warning-continue>Продолжить</button>
        </div>
      </div>
    `;
    modal.querySelector("[data-personal-warning-edit]").addEventListener("click", () => closeWarning(false));
    modal.querySelector("[data-personal-warning-continue]").addEventListener("click", () => closeWarning(true));
    document.body.appendChild(modal);
    return modal;
  }

  function closeWarning(continueWithoutData) {
    const modal = ensureWarningModal();
    modal.hidden = true;
    const resolve = warningResolve;
    warningResolve = null;
    resolve?.(Boolean(continueWithoutData));
  }

  function confirmMissingPersonalData() {
    const modal = ensureWarningModal();
    modal.hidden = false;
    modal.querySelector("[data-personal-warning-edit]")?.focus();
    return new Promise((resolve) => {
      warningResolve = resolve;
    });
  }

  async function api(path, { method = "GET", body = null, registrationToken = "" } = {}) {
    const token = localStorage.getItem(AUTH_TOKEN_KEY) || "";
    const payload = body ? { ...body } : null;
    if (payload && registrationToken && !payload.registrationToken) {
      payload.registrationToken = registrationToken;
    }
    const response = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(String(data?.detail || data?.message || "Не удалось сохранить персональные данные."));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function valuesFrom(container) {
    const result = {};
    COMPLETE_FIELDS.forEach((name) => {
      const input = container.querySelector(`[name="${name}"]`);
      result[name] = String(input?.value || "").trim();
    });
    return result;
  }

  function hasCompleteValues(values) {
    return COMPLETE_FIELDS.every((name) => Boolean(String(values?.[name] || "").trim()));
  }

  function firstMissingInput(container, values) {
    const missing = COMPLETE_FIELDS.find((name) => !String(values?.[name] || "").trim());
    return missing ? container.querySelector(`[name="${missing}"]`) : null;
  }

  function setProfileStatus(node, data) {
    if (!node) return;
    const state = String(data?.identityState || "required");
    node.dataset.state = state;
    if (state === "complete") {
      node.textContent = "Персональные данные заполнены. Сервисы цифрового ID доступны.";
    } else if (state === "declined") {
      node.textContent = "Вы продолжили без персональных данных. Сервисы цифрового ID недоступны.";
    } else {
      node.textContent = "Заполните все четыре поля, чтобы сервисы могли использовать цифровой ID.";
    }
  }

  function personalFieldsMarkup(fieldClass = "text-field") {
    return `
      <label class="${fieldClass}"><span>Фамилия</span><input name="familyName" type="text" autocomplete="family-name" maxlength="80" placeholder="Ароян" /></label>
      <label class="${fieldClass}"><span>Имя</span><input name="givenName" type="text" autocomplete="given-name" maxlength="80" placeholder="Имя по документам" /></label>
      <label class="${fieldClass}"><span>Отчество</span><input name="patronymic" type="text" autocomplete="additional-name" maxlength="80" placeholder="Отчество" /></label>
      <label class="${fieldClass}"><span>Дата рождения</span><input name="birthDate" type="date" autocomplete="bday" min="1900-01-01" /></label>
    `;
  }

  function installRegistrationFields() {
    const form = document.querySelector('[data-form="profile"]');
    if (!form || form.dataset.personalIdentityReady === "true") return;
    form.dataset.personalIdentityReady = "true";

    const display = form.querySelector('[name="displayName"]');
    const displayLabel = display?.closest("label");
    if (displayLabel?.querySelector("span")) displayLabel.querySelector("span").textContent = "Псевдоним";
    if (display) display.placeholder = "Имя, которое увидят в ЯЧате";

    const username = form.querySelector('[name="username"]');
    const usernameLabel = username?.closest("label");
    if (usernameLabel?.querySelector("span")) usernameLabel.querySelector("span").textContent = "Ник-нейм";

    const block = document.createElement("div");
    block.className = "personal-identity-block";
    block.dataset.personalIdentityRegistration = "true";
    block.innerHTML = `
      <div class="personal-identity-head">
        <strong>Персональные данные</strong>
        <span>Они хранятся на сервере и используются подключёнными сервисами только через цифровой ID.</span>
      </div>
      ${personalFieldsMarkup("text-field")}
      <p class="personal-identity-status" data-registration-personal-status>Все четыре поля нужны для сервисов цифрового ID.</p>
    `;
    const message = form.querySelector('[data-message="profile"]');
    form.insertBefore(block, message || form.lastElementChild);

    form.addEventListener("submit", async (event) => {
      if (allowRegistrationSubmitOnce) {
        allowRegistrationSubmitOnce = false;
        return;
      }
      const values = valuesFrom(block);
      if (hasCompleteValues(values)) {
        registrationDecision = "save";
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const proceed = await confirmMissingPersonalData();
      if (!proceed) {
        firstMissingInput(block, values)?.focus();
        return;
      }
      registrationDecision = "decline";
      allowRegistrationSubmitOnce = true;
      form.requestSubmit();
    }, true);

    try {
      if (typeof yachatApi !== "undefined" && yachatApi?.account?.create && !yachatApi.account.create.__personalIdentityWrapped) {
        const originalCreate = yachatApi.account.create.bind(yachatApi.account);
        const wrappedCreate = async (payload) => {
          const draft = valuesFrom(block);
          const decision = hasCompleteValues(draft) ? "save" : registrationDecision;
          const account = await originalCreate(payload);
          const personalPayload = { ...draft, decision };
          let saved = false;
          for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
            try {
              await api("/api/personal-profile", {
                method: "PUT",
                body: personalPayload,
                registrationToken: String(payload?.registrationToken || "")
              });
              saved = true;
              localStorage.removeItem(PENDING_PROFILE_KEY);
            } catch {
              if (attempt === 1) {
                localStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(personalPayload));
              }
            }
          }
          return account;
        };
        wrappedCreate.__personalIdentityWrapped = true;
        yachatApi.account.create = wrappedCreate;
      }
    } catch {
      // The web runtime can still finish registration; a pending profile is retried after login.
    }
  }

  function renameProfileEditorFields(root = document) {
    root.querySelectorAll('input[name="displayName"]').forEach((input) => {
      const label = input.closest("label");
      const caption = label?.querySelector("span");
      if (caption) caption.textContent = "Псевдоним";
    });
    root.querySelectorAll('input[name="username"]').forEach((input) => {
      if (input.closest('[data-form="profile"]')) return;
      const label = input.closest("label");
      const caption = label?.querySelector("span");
      if (caption) caption.textContent = "Ник-нейм";
    });
  }

  async function populateSettingsForm(section) {
    if (!section || section.dataset.loaded === "true") return;
    section.dataset.loaded = "true";
    const status = section.querySelector("[data-personal-settings-status]");
    try {
      const data = await api("/api/personal-profile");
      COMPLETE_FIELDS.forEach((name) => {
        const input = section.querySelector(`[name="${name}"]`);
        if (input) input.value = String(data?.[name] || "");
      });
      setProfileStatus(status, data);
    } catch (error) {
      status.textContent = error.status === 401
        ? "Войдите в аккаунт, чтобы изменить персональные данные."
        : "Не удалось загрузить персональные данные.";
    }
  }

  function installSettingsSection() {
    const panel = document.querySelector("[data-side-panel]");
    const body = document.querySelector("[data-panel-body]");
    const title = document.querySelector("[data-panel-title]");
    if (!panel || panel.hidden || !body || !title) return;
    renameProfileEditorFields(body);
    if (!/настрой/i.test(title.textContent || "")) return;
    if (body.querySelector("[data-personal-identity-settings]")) return;

    const section = document.createElement("form");
    section.className = "personal-identity-settings";
    section.dataset.personalIdentitySettings = "true";
    section.innerHTML = `
      <h3>Персональные данные</h3>
      <p>ФИО и дата рождения не показываются другим пользователям. Их получают только сервисы после подтверждения цифрового ID.</p>
      ${personalFieldsMarkup("modal-field")}
      <p class="personal-identity-status" data-personal-settings-status>Загрузка…</p>
      <div class="personal-identity-settings-actions">
        <button class="panel-primary" type="submit">Сохранить</button>
      </div>
    `;
    body.appendChild(section);
    populateSettingsForm(section);

    section.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = section.querySelector('button[type="submit"]');
      const status = section.querySelector("[data-personal-settings-status]");
      const values = valuesFrom(section);
      let decision = "save";
      if (!hasCompleteValues(values)) {
        const proceed = await confirmMissingPersonalData();
        if (!proceed) {
          firstMissingInput(section, values)?.focus();
          return;
        }
        decision = "decline";
      }
      button.disabled = true;
      try {
        const data = await api("/api/personal-profile", {
          method: "PUT",
          body: { ...values, decision }
        });
        if (decision === "decline") {
          COMPLETE_FIELDS.forEach((name) => {
            const input = section.querySelector(`[name="${name}"]`);
            if (input) input.value = "";
          });
        }
        setProfileStatus(status, data);
      } catch (error) {
        status.textContent = String(error.message || "Не удалось сохранить персональные данные.");
      } finally {
        button.disabled = false;
      }
    });
  }

  async function retryPendingProfile() {
    const token = localStorage.getItem(AUTH_TOKEN_KEY) || "";
    const raw = localStorage.getItem(PENDING_PROFILE_KEY);
    if (!token || !raw) return;
    try {
      const pending = JSON.parse(raw);
      await api("/api/personal-profile", { method: "PUT", body: pending });
      localStorage.removeItem(PENDING_PROFILE_KEY);
    } catch {
      // Keep the local retry payload until the server becomes available again.
    }
  }

  function boot() {
    injectStyles();
    ensureWarningModal();
    installRegistrationFields();
    renameProfileEditorFields();
    installSettingsSection();
    retryPendingProfile();

    const observer = new MutationObserver(() => {
      installRegistrationFields();
      renameProfileEditorFields();
      installSettingsSection();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
