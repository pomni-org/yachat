from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYSTEM = ROOT / "src" / "renderer" / "assets" / "system-upgrade-v29.js"
SETTINGS = ROOT / "src" / "renderer" / "assets" / "settings-redesign.js"
APP = ROOT / "src" / "renderer" / "app.js"
BUILD = ROOT / "scripts" / "build-vercel.cjs"
HELP = ROOT / "src" / "renderer" / "help.html"
SW = ROOT / "src" / "renderer" / "sw.js"


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return source.replace(old, new, 1)


system = SYSTEM.read_text("utf-8")
system = replace_once(
    system,
    '''    const card = panelBody?.querySelector("[data-device-code-card]");
    if (!card) return;
    const code = String(payload.code || "");''',
    '''    const card = panelBody?.querySelector("[data-device-code-card]");
    if (!card) return;
    card.dataset.deviceCodeLoaded = "true";
    const code = String(payload.code || "");''',
    "mark loaded code card",
)
system = replace_once(
    system,
    '''      const corner = hero.querySelector(".settings-profile-corner.is-left");
      if (corner) {
        corner.dataset.settingsAction = "invite-friends";
        corner.setAttribute("aria-label", labels().shareProfile);
        corner.innerHTML = iconSvg?.("share-2") || "";
      }''',
    '''      const corner = hero.querySelector(".settings-profile-corner.is-left");
      if (corner && corner.dataset.deviceCodeShareReady !== "true") {
        corner.dataset.deviceCodeShareReady = "true";
        corner.dataset.settingsAction = "invite-friends";
        corner.setAttribute("aria-label", labels().shareProfile);
        corner.innerHTML = iconSvg?.("share-2") || "";
      }''',
    "guard profile share mutation",
)
system = replace_once(
    system,
    '''      if (!panelBody.querySelector("[data-device-code-card]")) {
        const status = panelBody.querySelector(".settings-security-card");
        status?.insertAdjacentHTML("afterend", codeCardMarkup());
        hydrateIcons?.(panelBody);
      }
      void loadSecurityCode(false);''',
    '''      let card = panelBody.querySelector("[data-device-code-card]");
      if (!card) {
        const status = panelBody.querySelector(".settings-security-card");
        status?.insertAdjacentHTML("afterend", codeCardMarkup());
        hydrateIcons?.(panelBody);
        card = panelBody.querySelector("[data-device-code-card]");
      }
      if (card && !card.dataset.deviceCodeLoaded) {
        card.dataset.deviceCodeLoaded = "loading";
        void loadSecurityCode(false);
      }''',
    "guard security code request",
)
system = replace_once(
    system,
    '''      panelBody.querySelectorAll('[data-panel-action="scan-session"]').forEach((button) => {
        button.dataset.openDeviceCodeSecurity = "";
        delete button.dataset.panelAction;
        button.innerHTML = `${iconSvg?.("key-round") || ""}<span>${escapeHtml(labels().devicesHint)}</span>`;
      });''',
    '''      panelBody.querySelectorAll('[data-panel-action="scan-session"]').forEach((button) => {
        if (button.dataset.deviceCodeButtonReady === "true") return;
        button.dataset.deviceCodeButtonReady = "true";
        button.dataset.openDeviceCodeSecurity = "";
        delete button.dataset.panelAction;
        button.innerHTML = `${iconSvg?.("key-round") || ""}<span>${escapeHtml(labels().devicesHint)}</span>`;
      });''',
    "guard devices mutation",
)
system = replace_once(
    system,
    '''  const observer = new MutationObserver(() => {
    queueSettingsUpgrade();
    decorateVerificationCodes();
  });''',
    '''  const observer = new MutationObserver((records) => {
    const onlyCountdown = records.length > 0 && records.every((record) =>
      record.target instanceof Element
        ? record.target.closest("[data-device-code-expiry]")
        : record.target.parentElement?.closest("[data-device-code-expiry]")
    );
    if (!onlyCountdown) queueSettingsUpgrade();
    decorateVerificationCodes();
  });''',
    "ignore countdown mutations",
)
SYSTEM.write_text(system, "utf-8")

settings = SETTINGS.read_text("utf-8")
settings = replace_once(
    settings,
    '''        <button class="settings-profile-corner is-left" type="button" data-settings-action="profile-qr" aria-label="QR-код профиля">
          ${iconSvg("qr-code")}
        </button>''',
    '''        <button class="settings-profile-corner is-left" type="button" data-settings-action="invite-friends" aria-label="Поделиться профилем">
          ${iconSvg("share-2")}
        </button>''',
    "settings profile share",
)
settings = replace_once(
    settings,
    '''      ${section(`
        <video class="session-camera" data-session-camera hidden muted playsinline></video>
        <input class="visually-hidden" type="file" accept="image/*" capture="environment" data-session-capture />
        <p class="session-message" data-session-message></p>
        <button class="settings-primary" type="button" data-panel-action="scan-session">${iconSvg("scan-line")}<span>Подключить устройство по QR-коду</span></button>
      `)}''',
    '''      ${section(`
        <button class="settings-primary" type="button" data-open-device-code-security>${iconSvg("key-round")}<span>Код для входа находится в разделе «Безопасность»</span></button>
      `)}''',
    "devices code link",
)
settings = replace_once(
    settings,
    '''      ${section(`
        <video class="session-camera" data-session-camera hidden muted playsinline></video>
        <input class="visually-hidden" type="file" accept="image/*" capture="environment" data-session-capture />
        <p class="session-message" data-session-message></p>
        <button class="settings-primary" type="button" data-panel-action="scan-session">${iconSvg("scan-line")}<span>Подтвердить вход по QR-коду</span></button>
        <button class="settings-primary is-secondary" type="button" data-panel-action="logout">${iconSvg("log-out")}<span>Выйти на этом устройстве</span></button>
        <button class="settings-primary is-danger" type="button" data-panel-action="delete-profile">${iconSvg("trash")}<span>Удалить профиль</span></button>
      `)}''',
    '''      ${section(`
        <button class="settings-primary is-secondary" type="button" data-panel-action="logout">${iconSvg("log-out")}<span>Выйти на этом устройстве</span></button>
        <button class="settings-primary is-danger" type="button" data-panel-action="delete-profile">${iconSvg("trash")}<span>Удалить профиль</span></button>
      `)}''',
    "remove security scanner",
)
SETTINGS.write_text(settings, "utf-8")

app = APP.read_text("utf-8")
app = replace_once(
    app,
    '''            <div class="chat-profile-link-actions">
              <button type="button" data-panel-action="share-profile-link" data-profile-link="${escapeHtml(profileUrl)}" aria-label="${escapeHtml(t("chatProfileLinkTitle"))}">
                ${iconSvg("share-2")}
              </button>
              <button type="button" data-panel-action="show-profile-qr" aria-label="${escapeHtml(t("chatProfileQrTitle"))}">
                ${iconSvg("qr-code")}
              </button>
            </div>
            <div class="chat-profile-qr" data-chat-profile-qr hidden>
              ${renderQrSvg(profileUrl)}
            </div>''',
    '''            <div class="chat-profile-link-actions">
              <button type="button" data-panel-action="share-profile-link" data-profile-link="${escapeHtml(profileUrl)}" aria-label="${escapeHtml(t("chatProfileLinkTitle"))}">
                ${iconSvg("share-2")}
              </button>
            </div>''',
    "remove chat profile QR",
)
APP.write_text(app, "utf-8")

build = BUILD.read_text("utf-8")
build = replace_once(build, 'const BRAND_VERSION = "28";', 'const BRAND_VERSION = "29";', "cache version")
build = replace_once(
    build,
    '''      `    <link rel="stylesheet" href="/assets/media-emoji-upgrade.css?v=${BRAND_VERSION}" />`''',
    '''      `    <link rel="stylesheet" href="/assets/media-emoji-upgrade.css?v=${BRAND_VERSION}" />`,
      `    <link rel="stylesheet" href="/assets/system-upgrade-v29.css?v=${BRAND_VERSION}" />`''',
    "inject system css",
)
build = replace_once(
    build,
    '''      `    <script src="/assets/media-emoji-upgrade.js?v=${BRAND_VERSION}"></script>`''',
    '''      `    <script src="/assets/media-emoji-upgrade.js?v=${BRAND_VERSION}"></script>`,
      `    <script src="/assets/system-upgrade-v29.js?v=${BRAND_VERSION}"></script>`''',
    "inject system js",
)
BUILD.write_text(build, "utf-8")

help_text = HELP.read_text("utf-8")
help_text = help_text.replace(
    "<h2>19. QR-сессия</h2><p>QR-сессии работают только в пределах текущих функций сервиса.</p>",
    "<h2>19. Вход на другом устройстве</h2><p>В разделе «Безопасность» создайте шестизначный код. Он действует 10 минут и используется один раз.</p>",
)
HELP.write_text(help_text, "utf-8")

sw = SW.read_text("utf-8").replace("?v=24", "?v=29")
SW.write_text(sw, "utf-8")

for path, markers in {
    SYSTEM: ("deviceCodeShareReady", "onlyCountdown", "deviceCodeLoaded"),
    SETTINGS: ("data-open-device-code-security", "Поделиться профилем"),
    BUILD: ('BRAND_VERSION = "29"', "system-upgrade-v29.js", "system-upgrade-v29.css"),
    HELP: ("шестизначный код",),
}.items():
    value = path.read_text("utf-8")
    for marker in markers:
        if marker not in value:
            raise RuntimeError(f"missing marker {marker} in {path}")
