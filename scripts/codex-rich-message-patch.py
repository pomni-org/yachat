from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API_PATH = ROOT / "api" / "index.py"
APP_PATH = ROOT / "src" / "renderer" / "app.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected one regex occurrence, found {count}")
    return updated


def patch_api() -> None:
    text = API_PATH.read_text(encoding="utf-8")

    if "import html\n" not in text:
        text = replace_once(text, "import hmac\n", "import hmac\nimport html\n", "html import")
    if "import urllib.parse\n" not in text:
        text = replace_once(text, "import urllib.error\n", "import urllib.error\nimport urllib.parse\n", "urllib.parse import")
    if "from html.parser import HTMLParser\n" not in text:
        text = replace_once(
            text,
            "from datetime import datetime, timedelta, timezone\n",
            "from datetime import datetime, timedelta, timezone\nfrom html.parser import HTMLParser\n",
            "HTMLParser import",
        )

    rich_helpers = r'''
RICH_TAG_ALIASES = {"b": "strong", "i": "em", "del": "s"}
RICH_FORMAT_TAGS = {"strong", "em", "u", "s", "code"}
RICH_LINK_SCHEMES = {"http", "https", "mailto", "tel"}


class RichMessageSanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = RICH_TAG_ALIASES.get(tag.lower(), tag.lower())
        if normalized == "br":
            self.parts.append("<br>")
            return
        if normalized in RICH_FORMAT_TAGS:
            self.parts.append(f"<{normalized}>")
            self.stack.append(normalized)
            return
        if normalized != "a":
            return

        href = next((value for name, value in attrs if name.lower() == "href"), "") or ""
        safe = safe_rich_url(href)
        if not safe:
            return
        self.parts.append(
            f'<a href="{html.escape(safe, quote=True)}" target="_blank" rel="noopener noreferrer">'
        )
        self.stack.append("a")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        normalized = RICH_TAG_ALIASES.get(tag.lower(), tag.lower())
        if normalized != "br":
            self.handle_endtag(normalized)

    def handle_endtag(self, tag: str) -> None:
        normalized = RICH_TAG_ALIASES.get(tag.lower(), tag.lower())
        if normalized not in self.stack:
            return
        while self.stack:
            current = self.stack.pop()
            self.parts.append(f"</{current}>")
            if current == normalized:
                break

    def handle_data(self, data: str) -> None:
        self.parts.append(html.escape(data, quote=False))

    def result(self) -> str:
        while self.stack:
            self.parts.append(f"</{self.stack.pop()}>")
        return "".join(self.parts)


def safe_rich_url(value: object) -> str:
    source = str(value or "").strip()
    if not source:
        return ""
    prepared = source if re.match(r"^[a-z][a-z0-9+.-]*:", source, re.I) else f"https://{source}"
    try:
        parsed = urllib.parse.urlparse(prepared)
    except ValueError:
        return ""
    if parsed.scheme.lower() not in RICH_LINK_SCHEMES:
        return ""
    if parsed.scheme.lower() in {"http", "https"} and not parsed.netloc:
        return ""
    return prepared


def clean_rich_html(value: object) -> str:
    source = str(value or "")[:24000]
    if not source:
        return ""
    sanitizer = RichMessageSanitizer()
    try:
        sanitizer.feed(source)
        sanitizer.close()
    except (ValueError, TypeError):
        return ""
    result = sanitizer.result()
    result = re.sub(r"(?:<br>\s*){3,}", "<br><br>", result, flags=re.I)
    return result.strip()


def rich_html_plain_text(value: str) -> str:
    source = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    source = re.sub(r"</?(?:strong|em|u|s|code|a)(?:\s[^>]*)?>", "", source, flags=re.I)
    return html.unescape(source).replace("\r", "")


def prepare_rich_message(payload: dict[str, object]) -> tuple[str, str]:
    formatted_html = clean_rich_html(payload.get("formattedHtml"))
    text = str(payload.get("text") or "").replace("\x00", "").strip()
    if formatted_html:
        formatted_text = rich_html_plain_text(formatted_html).strip()
        if formatted_text:
            text = formatted_text
        else:
            formatted_html = ""
    if len(text) > 4000:
        raise HTTPException(status_code=400, detail="Message is too long.")
    return formatted_html, text


'''
    if "class RichMessageSanitizer" not in text:
        text = replace_once(
            text,
            "def identity_text(value: Any) -> str:\n",
            rich_helpers + "def identity_text(value: Any) -> str:\n",
            "rich helpers",
        )

    text = replace_once(
        text,
        '        "alter table yachat_system_messages add column if not exists attachments jsonb default \'[]\'::jsonb",\n',
        '        "alter table yachat_system_messages add column if not exists attachments jsonb default \'[]\'::jsonb",\n'
        '        "alter table yachat_system_messages add column if not exists formatted_html text default \'\'",\n',
        "system formatted_html schema",
    )
    text = replace_once(
        text,
        '        "create index if not exists yachat_messages_chat_created_idx on yachat_messages(chat_id, created_at)",\n',
        '        "alter table yachat_messages add column if not exists formatted_html text default \'\'",\n'
        '        "create index if not exists yachat_messages_chat_created_idx on yachat_messages(chat_id, created_at)",\n',
        "message formatted_html schema",
    )

    text = replace_once(
        text,
        'def verification_code_text(contact: str, code: str) -> str:\n    return f"Код подтверждения ЯЧата для {contact}: {code}. Он действует 10 минут. Никому его не сообщайте."\n',
        '''def verification_code_text(contact: str, code: str) -> str:
    return "\\n".join(
        [
            "Код подтверждения ЯЧата",
            "",
            f"Номер: {contact}",
            f"Код: {code}",
            "",
            "Действует 10 минут.",
            "Никому его не сообщайте.",
        ]
    )


def verification_code_html(contact: str, code: str) -> str:
    return (
        "<strong>Код подтверждения ЯЧата</strong><br><br>"
        f"Номер: <strong>{html.escape(contact)}</strong><br>"
        f"Код: <strong>{html.escape(code)}</strong><br><br>"
        "Действует 10 минут.<br>"
        "<strong>Никому его не сообщайте.</strong>"
    )
''',
        "verification formatting",
    )

    text = replace_once(
        text,
        '''def add_system_delivery_message(cursor, user_id: str, chat_id: str, text: str, expires_at: datetime | None = None) -> None:
    cursor.execute(
        """
        insert into yachat_system_messages(id, user_id, chat_id, text, system_kind, expires_at)
        values (%s, %s, %s, %s, 'verification-code', %s)
        """,
        (str(uuid.uuid4()), user_id, chat_id, text, expires_at),
    )
''',
        '''def add_system_delivery_message(
    cursor,
    user_id: str,
    chat_id: str,
    text: str,
    expires_at: datetime | None = None,
    formatted_html: str = "",
) -> None:
    cursor.execute(
        """
        insert into yachat_system_messages(
            id, user_id, chat_id, text, formatted_html, system_kind, expires_at
        )
        values (%s, %s, %s, %s, %s, 'verification-code', %s)
        """,
        (str(uuid.uuid4()), user_id, chat_id, text, clean_rich_html(formatted_html), expires_at),
    )
''',
        "system delivery insert",
    )

    text = replace_once(
        text,
        '''                add_system_delivery_message(
                    cursor,
                    str(existing_user["id"]),
                    "yachat-codes",
                    verification_code_text(contact, code),
                    expires_at,
                )
''',
        '''                add_system_delivery_message(
                    cursor,
                    str(existing_user["id"]),
                    "yachat-codes",
                    verification_code_text(contact, code),
                    expires_at,
                    verification_code_html(contact, code),
                )
''',
        "challenge rich code",
    )

    text = replace_once(
        text,
        '        "text": str(row_value(row, "text")),\n        "attachments": row_value(row, "attachments") if isinstance(row_value(row, "attachments"), list) else [],\n',
        '        "text": str(row_value(row, "text")),\n        "formattedHtml": clean_rich_html(row_value(row, "formatted_html")),\n        "attachments": row_value(row, "attachments") if isinstance(row_value(row, "attachments"), list) else [],\n',
        "message payload rich html",
    )
    text = replace_once(
        text,
        '        "text": str(row_value(row, "text")),\n        "attachments": attachments if isinstance(attachments, list) else [],\n',
        '        "text": str(row_value(row, "text")),\n        "formattedHtml": clean_rich_html(row_value(row, "formatted_html")),\n        "attachments": attachments if isinstance(attachments, list) else [],\n',
        "system payload rich html",
    )
    text = replace_once(
        text,
        '            "text": text,\n            "attachments": [],\n',
        '            "text": text,\n            "formattedHtml": "",\n            "attachments": [],\n',
        "intro formatted html",
    )

    text = regex_once(
        text,
        r'def system_chat_messages\(chat_id: str\) -> list\[dict\[str, Any\]\]:\n.*?\n\n\ndef system_message_payload',
        '''def system_chat_messages(chat_id: str) -> list[dict[str, Any]]:
    if chat_id != "yachat-codes":
        return []
    return [
        {
            "id": "yachat-codes-intro",
            "chatId": "yachat-codes",
            "author": "bot",
            "authorId": "yachat",
            "text": "Здесь будут появляться одноразовые коды подтверждения для входа, банков, магазинов и сервисов.",
            "formattedHtml": "",
            "attachments": [],
            "replyToMessageId": None,
            "forwardedFrom": "",
            "createdAt": utc_now(),
            "editedAt": None,
        }
    ]


def system_message_payload''',
        "system intro removal",
        flags=re.S,
    )

    text = replace_once(
        text,
        '''        where user_id = %s
        order by chat_id, created_at desc
''',
        '''        where user_id = %s
          and (chat_id <> 'yachat-channel' or system_kind = 'channel-post')
        order by chat_id, created_at desc
''',
        "latest manual channel messages",
    )
    text = replace_once(
        text,
        '''        where user_id = %s
          and chat_id = %s
        order by created_at asc
''',
        '''        where user_id = %s
          and chat_id = %s
          and (chat_id <> 'yachat-channel' or system_kind = 'channel-post')
        order by created_at asc
''',
        "manual channel message list",
    )

    text = replace_once(
        text,
        '''    text = clean_text(payload.get("text"), 4000)
    attachments = clean_attachments(payload.get("attachments"))
''',
        '''    formatted_html, text = prepare_rich_message(payload)
    attachments = clean_attachments(payload.get("attachments"))
''',
        "send rich parse",
    )
    text = replace_once(
        text,
        '''                        insert into yachat_system_messages(id, user_id, chat_id, author_id, text, attachments, system_kind, created_at)
                        values (%s, %s, 'yachat-channel', %s, %s, %s::jsonb, 'channel-post', now())
''',
        '''                        insert into yachat_system_messages(
                            id, user_id, chat_id, author_id, text, formatted_html,
                            attachments, system_kind, created_at
                        )
                        values (%s, %s, 'yachat-channel', %s, %s, %s, %s::jsonb, 'channel-post', now())
''',
        "channel rich insert SQL",
    )
    text = replace_once(
        text,
        '''                            user["id"],
                            text,
                            json.dumps(attachments[:8]),
''',
        '''                            user["id"],
                            text,
                            formatted_html,
                            json.dumps(attachments[:8]),
''',
        "channel rich insert params",
    )
    text = replace_once(
        text,
        '''                insert into yachat_messages(id, chat_id, sender_id, text, attachments, reply_to_message_id, created_at)
                values (%s, %s, %s, %s, %s::jsonb, %s, now())
''',
        '''                insert into yachat_messages(
                    id, chat_id, sender_id, text, formatted_html,
                    attachments, reply_to_message_id, created_at
                )
                values (%s, %s, %s, %s, %s, %s::jsonb, %s, now())
''',
        "message rich insert SQL",
    )
    text = replace_once(
        text,
        '''                    user["id"],
                    text,
                    json.dumps(attachments[:8]),
                    payload.get("replyToMessageId") or None,
''',
        '''                    user["id"],
                    text,
                    formatted_html,
                    json.dumps(attachments[:8]),
                    payload.get("replyToMessageId") or None,
''',
        "message rich insert params",
    )

    text = replace_once(
        text,
        '''    text = clean_text(payload.get("text"), 4000)
    if not text:
''',
        '''    formatted_html, text = prepare_rich_message(payload)
    if not text:
''',
        "update rich parse",
    )
    text = replace_once(
        text,
        '''                update yachat_messages
                set text = %s, edited_at = now()
                where id = %s and chat_id = %s and sender_id = %s and deleted_at is null
                """,
                (text, message_id, chat_id, user["id"]),
''',
        '''                update yachat_messages
                set text = %s, formatted_html = %s, edited_at = now()
                where id = %s and chat_id = %s and sender_id = %s and deleted_at is null
                """,
                (text, formatted_html, message_id, chat_id, user["id"]),
''',
        "update rich SQL",
    )

    text = replace_once(
        text,
        '''                insert into yachat_messages(id, chat_id, sender_id, text, attachments, forwarded_from, created_at)
                values (%s, %s, %s, %s, %s::jsonb, %s, now())
''',
        '''                insert into yachat_messages(
                    id, chat_id, sender_id, text, formatted_html,
                    attachments, forwarded_from, created_at
                )
                values (%s, %s, %s, %s, %s, %s::jsonb, %s, now())
''',
        "forward rich SQL",
    )
    text = replace_once(
        text,
        '''                    user["id"],
                    source["text"],
                    json.dumps(source["attachments"] or []),
                    from_chat_id,
''',
        '''                    user["id"],
                    source["text"],
                    clean_rich_html(row_value(source, "formatted_html")),
                    json.dumps(source["attachments"] or []),
                    from_chat_id,
''',
        "forward rich params",
    )

    API_PATH.write_text(text, encoding="utf-8")


def patch_app() -> None:
    text = APP_PATH.read_text(encoding="utf-8")

    text = replace_once(
        text,
        '''        "yachat-channel": [
          createLocalMessage("yachat-channel", "ЯЧат запущен. Здесь будут новости приложения, изменения и служебные объявления.", "channel")
        ]
''',
        '''        "yachat-channel": []
''',
        "local channel intro",
    )

    old_cleanup = '''        messages[chatId] = list
          .filter((message) => !REMOVED_TEST_MESSAGE_TEXTS.has(String(message?.text || "").trim()))
          .map((message) => {
            if (chatId === "yachat-channel" && String(message?.text || "").includes("Канал ЯЧата")) {
              return {
                ...message,
                text: String(message.text || "").replaceAll("Канал ЯЧата", "ЯЧат").replaceAll("канал встроен", "системный канал встроен")
              };
            }
            return message;
          });
'''
    new_cleanup = '''        messages[chatId] = list.filter((message) => {
          const messageText = String(message?.text || "").trim();
          if (REMOVED_TEST_MESSAGE_TEXTS.has(messageText)) return false;
          if (chatId !== "yachat-channel") return true;
          return !(
            messageText === "ЯЧат запущен. Здесь будут новости приложения, изменения и служебные объявления." ||
            messageText.includes("Канал ЯЧата готов") ||
            messageText.includes("канал встроен")
          );
        });
'''
    text = replace_once(text, old_cleanup, new_cleanup, "local channel cleanup")

    text = replace_once(
        text,
        '''          createLocalMessage("yachat-codes", `Код подтверждения ЯЧата для ${challenge.contact}: ${code}. Он действует 10 минут. Никому его не сообщайте.`, "bot")
''',
        '''          createLocalMessage(
            "yachat-codes",
            `Код подтверждения ЯЧата\\n\\nНомер: ${challenge.contact}\\nКод: ${code}\\n\\nДействует 10 минут.\\nНикому его не сообщайте.`,
            "bot",
            {
              formattedHtml: `<strong>Код подтверждения ЯЧата</strong><br><br>Номер: <strong>${escapeHtml(challenge.contact)}</strong><br>Код: <strong>${escapeHtml(code)}</strong><br><br>Действует 10 минут.<br><strong>Никому его не сообщайте.</strong>`
            }
          )
''',
        "local code formatting",
    )

    text = replace_once(
        text,
        '''            senderId: account?.id || "",
            attachments,
''',
        '''            senderId: account?.id || "",
            formattedHtml: String(payload?.formattedHtml || ""),
            attachments,
''',
        "local send formatted html",
    )
    text = replace_once(
        text,
        '''        message.text = text;
        message.editedAt = new Date().toISOString();
''',
        '''        message.text = text;
        message.formattedHtml = String(payload?.formattedHtml || "");
        message.editedAt = new Date().toISOString();
''',
        "local edit formatted html",
    )
    text = replace_once(
        text,
        '''            senderId: account?.id || "",
            attachments: Array.isArray(source.attachments) ? source.attachments : [],
            forwardedFrom: fromChat.title || ""
''',
        '''            senderId: account?.id || "",
            formattedHtml: String(source.formattedHtml || ""),
            attachments: Array.isArray(source.attachments) ? source.attachments : [],
            forwardedFrom: fromChat.title || ""
''',
        "local forward formatted html",
    )

    APP_PATH.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    patch_api()
    patch_app()
