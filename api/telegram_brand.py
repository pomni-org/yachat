import html
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any

ORBITVPN_EMOJI_SET = "ORBITVPN"
EMOJI_CACHE_TTL_SECONDS = 60 * 60

_ROLE_CANDIDATES = {
    "lock": ("🔐", "🔒", "🛡️", "🔑"),
    "time": ("⏳", "⌛", "🕒", "⏱️"),
    "warning": ("⚠️", "❗", "🚨", "‼️"),
    "phone": ("📱", "☎️", "📞", "📲"),
    "unlink": ("🧹", "🗑️", "❌", "🚫"),
    "success": ("✅", "☑️", "👍", "💚"),
    "hello": ("👋", "🙋", "✨", "💬"),
}
_ROLE_ORDER = tuple(_ROLE_CANDIDATES)
_custom_emoji_cache: dict[str, tuple[str, str]] = {}
_custom_emoji_cache_expires_at = 0.0


def telegram_bot_token() -> str:
    return os.getenv("YACHAT_TELEGRAM_BOT_TOKEN", "").strip()


def telegram_custom_emoji_set() -> str:
    return os.getenv("YACHAT_TELEGRAM_EMOJI_SET", ORBITVPN_EMOJI_SET).strip() or ORBITVPN_EMOJI_SET


def _telegram_api(method: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    token = telegram_bot_token()
    if not token:
        return None

    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = json.loads(response.read().decode("utf-8"))
            return body if isinstance(body, dict) else None
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
        return None


def _normalize_emoji(value: Any) -> str:
    return str(value or "").replace("\ufe0f", "").strip()


def _load_custom_emoji_roles() -> dict[str, tuple[str, str]]:
    global _custom_emoji_cache, _custom_emoji_cache_expires_at

    now = time.monotonic()
    if _custom_emoji_cache and now < _custom_emoji_cache_expires_at:
        return _custom_emoji_cache

    response = _telegram_api("getStickerSet", {"name": telegram_custom_emoji_set()})
    result = response.get("result") if response and response.get("ok") else None
    stickers = result.get("stickers") if isinstance(result, dict) else None
    available: list[tuple[str, str]] = []

    for sticker in stickers if isinstance(stickers, list) else []:
        if not isinstance(sticker, dict):
            continue
        custom_emoji_id = str(sticker.get("custom_emoji_id") or "").strip()
        emoji = str(sticker.get("emoji") or "").strip()
        if custom_emoji_id and emoji:
            available.append((emoji, custom_emoji_id))

    roles: dict[str, tuple[str, str]] = {}
    unused = list(available)
    for index, role in enumerate(_ROLE_ORDER):
        match = next(
            (
                item
                for candidate in _ROLE_CANDIDATES[role]
                for item in unused
                if _normalize_emoji(item[0]) == _normalize_emoji(candidate)
            ),
            None,
        )
        if match is None and unused:
            match = unused[index % len(unused)]
        if match is not None:
            roles[role] = match
            if match in unused:
                unused.remove(match)

    _custom_emoji_cache = roles
    _custom_emoji_cache_expires_at = now + EMOJI_CACHE_TTL_SECONDS
    return roles


def custom_emoji_id(role: str) -> str:
    item = _load_custom_emoji_roles().get(role)
    return item[1] if item else ""


def custom_emoji_html(role: str) -> str:
    item = _load_custom_emoji_roles().get(role)
    if not item:
        return ""
    emoji, emoji_id = item
    return f'<tg-emoji emoji-id="{html.escape(emoji_id, quote=True)}">{html.escape(emoji)}</tg-emoji>'


def branded_heading(role: str, title: str) -> str:
    icon = custom_emoji_html(role)
    prefix = f"{icon} " if icon else ""
    return f"{prefix}<b>{html.escape(title)}</b>"


def telegram_contact_keyboard() -> dict[str, Any]:
    button: dict[str, Any] = {"text": "Поделиться номером", "request_contact": True}
    icon_id = custom_emoji_id("phone")
    if icon_id:
        button["icon_custom_emoji_id"] = icon_id
    return {
        "keyboard": [[button]],
        "resize_keyboard": True,
        "one_time_keyboard": True,
    }


def telegram_remove_keyboard() -> dict[str, Any]:
    return {"remove_keyboard": True}


_CUSTOM_EMOJI_TAG = re.compile(r'<tg-emoji\b[^>]*>.*?</tg-emoji>', re.IGNORECASE | re.DOTALL)


def _without_custom_emoji(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_custom_emoji(item)
            for key, item in value.items()
            if key != "icon_custom_emoji_id"
        }
    if isinstance(value, list):
        return [_without_custom_emoji(item) for item in value]
    if isinstance(value, str):
        return _CUSTOM_EMOJI_TAG.sub("", value)
    return value


def send_telegram_html_message(
    chat_id: str,
    text: str,
    reply_markup: dict[str, Any] | None = None,
) -> bool:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup

    response = _telegram_api("sendMessage", payload)
    if response and response.get("ok"):
        return True

    # Telegram permits custom emoji for bot messages only when the bot owner
    # has Premium (or the bot owns an additional Fragment username). Keep the
    # bot functional without falling back to ordinary emoji if that condition
    # is not met or the pack is temporarily unavailable.
    fallback_payload = _without_custom_emoji(payload)
    response = _telegram_api("sendMessage", fallback_payload)
    return bool(response and response.get("ok"))


def verification_code_html(contact: str, code: str) -> str:
    return "\n".join(
        [
            branded_heading("lock", "Код подтверждения ЯЧата"),
            "",
            f"Номер: <code>{html.escape(contact)}</code>",
            f"Код: <code>{html.escape(code)}</code>",
            "",
            f"{custom_emoji_html('time')} Действует 10 минут.".strip(),
            f"{custom_emoji_html('warning')} <b>Никому его не сообщайте.</b>".strip(),
        ]
    )


def send_telegram_verification_code(links: list[dict[str, Any]], contact: str, code: str) -> int:
    text = verification_code_html(contact, code)
    sent = 0
    for link in links:
        chat_id = str(link.get("chat_id") or "").strip()
        if chat_id and send_telegram_html_message(chat_id, text):
            sent += 1
    return sent
