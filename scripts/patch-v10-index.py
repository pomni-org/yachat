from pathlib import Path


def swap(path, old, new):
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"anchor missing: {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


index = Path("src/renderer/index.html")
build = Path("scripts/build-vercel.cjs")
api = Path("api/index.py")

swap(index, '''        <aside class="messenger-rail" aria-label="Навигация">
          <button class="rail-button is-active" type="button" data-rail="all" aria-label="Все чаты">
            <span class="rail-badge" data-total-unread hidden>0</span>
            <span class="css-icon gg-chat"></span>
            <strong>Все</strong>
          </button>
          <button class="rail-button" type="button" data-rail="contacts" aria-label="Контакты">
            <span class="css-icon gg-contacts"></span>
            <strong>Контакты</strong>
          </button>
          <button class="rail-button" type="button" data-rail="calls" aria-label="Звонки">
            <span class="css-icon gg-call"></span>
            <strong>Звонки</strong>
          </button>
          <button class="rail-button rail-bottom" type="button" data-rail="settings" aria-label="Настройки">
            <span class="css-icon gg-settings"></span>
            <strong>Настройки</strong>
          </button>
        </aside>''', '''        <aside class="messenger-rail" aria-label="Навигация">
          <button class="rail-button" type="button" data-rail="contacts" aria-label="Контакты">
            <span class="css-icon gg-contacts"></span>
            <strong>Контакты</strong>
          </button>
          <button class="rail-button" type="button" data-rail="calls" aria-label="Звонки">
            <span class="css-icon gg-call"></span>
            <strong>Звонки</strong>
          </button>
          <button class="rail-button is-active" type="button" data-rail="all" aria-label="Чаты">
            <span class="rail-badge" data-total-unread hidden>0</span>
            <span class="css-icon gg-chat"></span>
            <strong>Чаты</strong>
          </button>
          <button class="rail-button rail-bottom" type="button" data-rail="settings" aria-label="Настройки">
            <span class="css-icon gg-settings"></span>
            <strong>Настройки</strong>
          </button>
        </aside>''')

swap(index, '''          <form class="composer" data-form="message">
            <div class="composer-context" data-composer-context hidden></div>
            <button class="composer-tool" type="button" data-action="attach-file" aria-label="Вложения">
              <span class="css-icon gg-paperclip"></span>
            </button>
            <input class="visually-hidden" type="file" multiple data-attachment-input />
            <input name="message" autocomplete="off" placeholder="Сообщение" data-message-input />
            <button class="composer-tool" type="button" data-action="open-stickers" aria-label="Стикеры">
              <span class="css-icon gg-sticker"></span>
            </button>
            <button class="send-button" type="submit" aria-label="Отправить" disabled>
              <span class="css-icon gg-send"></span>
            </button>
            <div class="attachment-tray" data-attachment-tray hidden></div>
          </form>''', '''          <form class="composer" data-form="message">
            <div class="composer-context" data-composer-context hidden></div>
            <p class="attachment-policy-note" data-attachment-policy hidden></p>
            <div class="attachment-tray" data-attachment-tray hidden></div>
            <button class="composer-tool" type="button" data-action="attach-file" aria-label="Добавить фото или видео"><span class="css-icon gg-paperclip"></span></button>
            <input class="visually-hidden" type="file" accept="image/*,video/*" multiple data-attachment-input />
            <button class="composer-tool composer-document-tool" type="button" data-action="attach-document" aria-label="Отправить как документ без потерь"><span class="css-icon gg-file"></span></button>
            <input class="visually-hidden" type="file" multiple data-document-input />
            <input name="message" autocomplete="off" placeholder="Сообщение" data-message-input />
            <button class="composer-tool" type="button" data-action="open-stickers" aria-label="Стикеры"><span class="css-icon gg-sticker"></span></button>
            <button class="send-button" type="submit" aria-label="Отправить" disabled><span class="css-icon gg-send"></span></button>
          </form>''')

swap(build, 'const BRAND_VERSION = "9";', 'const BRAND_VERSION = "10";')
swap(build, '      `    <link rel="stylesheet" href="/assets/verification-scope.css?v=${BRAND_VERSION}" />`', '      `    <link rel="stylesheet" href="/assets/verification-scope.css?v=${BRAND_VERSION}" />`,\n      `    <link rel="stylesheet" href="/assets/composer-upgrade.css?v=${BRAND_VERSION}" />`')
swap(api, 'MAX_JSON_BODY_BYTES = int(os.getenv("YACHAT_MAX_JSON_BODY_BYTES", "6000000"))\nMAX_ATTACHMENT_DATA_URL_BYTES = int(os.getenv("YACHAT_MAX_ATTACHMENT_DATA_URL_BYTES", "1200000"))', 'MAX_JSON_BODY_BYTES = int(os.getenv("YACHAT_MAX_JSON_BODY_BYTES", "12000000"))\nMAX_ATTACHMENT_DATA_URL_BYTES = int(os.getenv("YACHAT_MAX_ATTACHMENT_DATA_URL_BYTES", "9000000"))')
