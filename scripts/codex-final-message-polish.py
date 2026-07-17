from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RICH_PATH = ROOT / "src" / "renderer" / "assets" / "rich-composer.js"
API_PATH = ROOT / "api" / "index.py"
APP_PATH = ROOT / "src" / "renderer" / "app.js"
BUILD_PATH = ROOT / "scripts" / "build-vercel.cjs"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def patch_rich_composer() -> None:
    text = RICH_PATH.read_text(encoding="utf-8")

    text = replace_once(
        text,
        '''  if (typeof createTransientOutgoingMessage === "function") {
    const previousCreateTransient = createTransientOutgoingMessage;
    createTransientOutgoingMessage = function createRichTransient(chat, payload) {
      const message = previousCreateTransient(chat, payload);
      message.formattedHtml = sanitizeHtml(payload?.formattedHtml || submittedHtml || currentHtml());
      queueMicrotask(() => clearEditor(false));
      return message;
    };
  }

  if (typeof renderMessages === "function") {
''',
        '''  if (typeof createTransientOutgoingMessage === "function") {
    const previousCreateTransient = createTransientOutgoingMessage;
    createTransientOutgoingMessage = function createRichTransient(chat, payload) {
      const message = previousCreateTransient(chat, payload);
      message.formattedHtml = sanitizeHtml(payload?.formattedHtml || submittedHtml || currentHtml());
      submittedHtml = "";
      queueMicrotask(() => clearEditor(false));
      return message;
    };
  }

  if (typeof renderAttachment === "function") {
    const previousRenderAttachment = renderAttachment;
    renderAttachment = function renderCleanAttachment(attachment = {}) {
      const dataUrl = attachment.dataUrl || attachment.url || "";
      if (attachment.kind === "image" && dataUrl) {
        const safeSource = escapeHtml(dataUrl);
        return `<figure class="message-attachment is-image" data-photo-view data-avatar-src="${safeSource}" data-avatar-title="Фото" role="button" tabindex="0" aria-label="Открыть фото"><img src="${safeSource}" alt="Фото" /></figure>`;
      }
      return previousRenderAttachment(attachment);
    };
  }

  if (typeof renderMessages === "function") {
''',
        "reset rich payload and clean image renderer",
    )

    text = replace_once(
        text,
        '''      const result = await originalUpdate({
        ...payload,
        formattedHtml: sanitizeHtml(payload.formattedHtml || submittedHtml || currentHtml())
      });
      clearEditor(false);
      return result;
''',
        '''      const result = await originalUpdate({
        ...payload,
        formattedHtml: sanitizeHtml(payload.formattedHtml || submittedHtml || currentHtml())
      });
      submittedHtml = "";
      clearEditor(false);
      return result;
''',
        "reset edited rich payload",
    )

    RICH_PATH.write_text(text, encoding="utf-8")


def patch_code_formatting() -> None:
    api = API_PATH.read_text(encoding="utf-8")
    api = replace_once(api, '            "Код подтверждения ЯЧата",\n', '            "🔐 Код подтверждения ЯЧата",\n', "plain code title")
    api = replace_once(api, '            "Действует 10 минут.",\n', '            "⌛ Действует 10 минут.",\n', "plain code expiry")
    api = replace_once(api, '            "Никому его не сообщайте.",\n', '            "⚠️ Никому его не сообщайте.",\n', "plain code warning")
    api = replace_once(
        api,
        '        "<strong>Код подтверждения ЯЧата</strong><br><br>"\n',
        '        "<strong>🔐 Код подтверждения ЯЧата</strong><br><br>"\n',
        "rich code title",
    )
    api = replace_once(
        api,
        '        "Действует 10 минут.<br>"\n',
        '        "⌛ Действует 10 минут.<br>"\n',
        "rich code expiry",
    )
    api = replace_once(
        api,
        '        "<strong>Никому его не сообщайте.</strong>"\n',
        '        "<strong>⚠️ Никому его не сообщайте.</strong>"\n',
        "rich code warning",
    )
    API_PATH.write_text(api, encoding="utf-8")

    app = APP_PATH.read_text(encoding="utf-8")
    app = replace_once(
        app,
        '`Код подтверждения ЯЧата\\n\\nНомер: ${challenge.contact}\\nКод: ${code}\\n\\nДействует 10 минут.\\nНикому его не сообщайте.`,\n',
        '`🔐 Код подтверждения ЯЧата\\n\\nНомер: ${challenge.contact}\\nКод: ${code}\\n\\n⌛ Действует 10 минут.\\n⚠️ Никому его не сообщайте.`,\n',
        "local plain code",
    )
    app = replace_once(
        app,
        'formattedHtml: `<strong>Код подтверждения ЯЧата</strong><br><br>Номер: <strong>${escapeHtml(challenge.contact)}</strong><br>Код: <strong>${escapeHtml(code)}</strong><br><br>Действует 10 минут.<br><strong>Никому его не сообщайте.</strong>`\n',
        'formattedHtml: `<strong>🔐 Код подтверждения ЯЧата</strong><br><br>Номер: <strong>${escapeHtml(challenge.contact)}</strong><br>Код: <strong>${escapeHtml(code)}</strong><br><br>⌛ Действует 10 минут.<br><strong>⚠️ Никому его не сообщайте.</strong>`\n',
        "local rich code",
    )
    APP_PATH.write_text(app, encoding="utf-8")


def bump_assets() -> None:
    text = BUILD_PATH.read_text(encoding="utf-8")
    text = replace_once(text, 'const BRAND_VERSION = "25";', 'const BRAND_VERSION = "26";', "asset version")
    BUILD_PATH.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    patch_rich_composer()
    patch_code_formatting()
    bump_assets()
