"""Moderation helpers shared by the YaChat API and Telegram webhook."""

from __future__ import annotations

import html
import json
import os
import re
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.rows import dict_row

from server.database import connect_db


NOVOSIBIRSK = ZoneInfo("Asia/Novosibirsk")
BAN_DURATIONS = {
    "1d": ("1 день", timedelta(days=1)),
    "7d": ("7 дней", timedelta(days=7)),
    "30d": ("30 дней", timedelta(days=30)),
}
TELEGRAM_MESSAGE_LIMIT = 4096
TELEGRAM_TRANSCRIPT_CHUNK = 3300
EVIDENCE_SEPARATOR = "\n\n────────\n\n"


def moderation_chat_id() -> str:
    return os.getenv("YACHAT_MODERATION_CHAT_ID", "5893181200").strip()


def moderator_telegram_ids() -> set[str]:
    configured = {
        value.strip()
        for value in os.getenv("YACHAT_MODERATOR_TELEGRAM_IDS", "").split(",")
        if value.strip()
    }
    if configured:
        return configured
    chat_id = moderation_chat_id()
    return {chat_id} if chat_id else set()


def _telegram_token() -> str:
    return os.getenv("YACHAT_TELEGRAM_BOT_TOKEN", "").strip()


def _contact_keys(value: str) -> list[str]:
    normalized = re.sub(r"[^\d+a-z@._-]+", "", str(value or "").strip().lower())
    digits = re.sub(r"\D+", "", normalized)
    keys = {normalized} if normalized else set()
    if digits:
        keys.update({digits, f"+{digits}"})
        if len(digits) == 11 and digits.startswith("8"):
            keys.update({f"7{digits[1:]}", f"+7{digits[1:]}"})
        if len(digits) == 11 and digits.startswith("7"):
            keys.add(digits[1:])
        if len(digits) == 10:
            keys.update({f"7{digits}", f"+7{digits}"})
    return sorted(key for key in keys if key)


def _telegram_api(method: str, payload: dict[str, Any]) -> dict[str, Any]:
    token = _telegram_token()
    if not token:
        return {}
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read().decode("utf-8"))
            return result if result.get("ok") else {}
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
        return {}


def _person(display_name: Any, username: Any) -> str:
    name = str(display_name or "").strip() or "Без имени"
    handle = str(username or "").strip().lstrip("@")
    return f"{name} (@{handle})" if handle else name


def _report_keyboard(report_id: str) -> dict[str, Any]:
    return {
        "inline_keyboard": [[
            {"text": "Опровергнуть жалобу", "callback_data": f"report:dismiss:{report_id}"},
            {"text": "Выдать бан", "callback_data": f"report:ban:{report_id}"},
        ]]
    }


def _ban_keyboard(report_id: str) -> dict[str, Any]:
    return {
        "inline_keyboard": [
            [
                {"text": "1 день", "callback_data": f"report:banfor:{report_id}:1d"},
                {"text": "7 дней", "callback_data": f"report:banfor:{report_id}:7d"},
                {"text": "30 дней", "callback_data": f"report:banfor:{report_id}:30d"},
            ],
            [{"text": "Вечный бан", "callback_data": f"report:banfor:{report_id}:forever"}],
            [{"text": "Назад", "callback_data": f"report:cancel:{report_id}"}],
        ]
    }


def _report_header(report: dict[str, Any], evidence_text: str = "") -> str:
    created = report.get("created_at")
    if isinstance(created, datetime):
        created_text = created.astimezone(NOVOSIBIRSK).strftime("%d.%m.%Y %H:%M:%S")
    else:
        created_text = str(created or "")
    kind = "на сообщение" if report.get("kind") == "message" else "на переписку"
    reason = str(report.get("reason") or "").strip() or "Причина не указана"
    lines = [
        "🚨 <b>Новая жалоба в ЯЧате</b>",
        "<i>Проверьте контекст и выберите решение кнопками ниже.</i>",
        "",
        f"📌 <b>Тип:</b> {html.escape(kind)}",
        f"🎯 <b>На кого:</b> {html.escape(_person(report.get('reported_display_name'), report.get('reported_username')))}",
        f"👤 <b>Кем подана:</b> {html.escape(_person(report.get('reporter_display_name'), report.get('reporter_username')))}",
        f"🕓 <b>Время:</b> {html.escape(created_text)} (Новосибирск)",
        "",
        "📝 <b>Причина пользователя:</b>",
        f"<blockquote>{html.escape(reason)}</blockquote>",
        f"🔎 <b>ID:</b> <code>{html.escape(str(report.get('id') or ''))}</code>",
    ]
    if report.get("kind") == "chat":
        count = len([part for part in evidence_text.split(EVIDENCE_SEPARATOR) if part.strip()])
        lines.extend([
            "",
            f"💬 <b>История:</b> {count} сообщ.",
            "<i>Включая сообщения, удалённые пользователями. История идёт ответами на эту карточку.</i>",
        ])
    elif evidence_text:
        evidence_block = f"💬 <b>Сообщение:</b>\n<blockquote>{html.escape(evidence_text)}</blockquote>"
        if len("\n".join(lines)) + len(evidence_block) + 2 < TELEGRAM_MESSAGE_LIMIT:
            lines.extend(["", evidence_block])
        else:
            lines.extend(["", "<i>Сообщение идёт ответом на эту карточку.</i>"])
    return "\n".join(lines)


def _split_evidence_entry(entry: str, limit: int = TELEGRAM_TRANSCRIPT_CHUNK) -> list[str]:
    source = str(entry or "").strip() or "💬 Без текста"
    if len(html.escape(source)) <= limit:
        return [source]
    parts: list[str] = []
    remaining = source
    while remaining:
        high = min(len(remaining), limit)
        low = max(1, high // 2)
        while low < high:
            middle = (low + high + 1) // 2
            if len(html.escape(remaining[:middle])) <= limit:
                low = middle
            else:
                high = middle - 1
        cut = low
        newline = remaining.rfind("\n", 0, cut)
        if newline >= max(1, cut // 2):
            cut = newline
        parts.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    return [part for part in parts if part]


def _transcript_chunks(transcript: str) -> list[str]:
    entries = [part.strip() for part in str(transcript or "").split(EVIDENCE_SEPARATOR) if part.strip()]
    if not entries:
        entries = ["💬 Переписка пуста."]
    blocks = [
        f"<blockquote>{html.escape(part)}</blockquote>"
        for entry in entries
        for part in _split_evidence_entry(entry)
    ]
    chunks: list[str] = []
    current: list[str] = []
    current_length = 0
    for block in blocks:
        extra = len(block) + (2 if current else 0)
        if current and current_length + extra > TELEGRAM_TRANSCRIPT_CHUNK:
            chunks.append("\n\n".join(current))
            current = []
            current_length = 0
        current.append(block)
        current_length += len(block) + (2 if current_length else 0)
    if current:
        chunks.append("\n\n".join(current))
    total = len(chunks)
    return [
        f"💬 <b>Материалы жалобы · {index}/{total}</b>\n{chunk}"
        for index, chunk in enumerate(chunks, start=1)
    ]


def send_moderation_report(report: dict[str, Any], transcript: str = "") -> tuple[str, int] | None:
    chat_id = moderation_chat_id()
    if not chat_id:
        return None
    header = _report_header(report, transcript)
    result = _telegram_api(
        "sendMessage",
        {
            "chat_id": chat_id,
            "text": header,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
    )
    message_id = int(result.get("result", {}).get("message_id") or 0)
    if not message_id:
        return None
    transcript_inline = report.get("kind") == "message" and "💬 <b>Сообщение:</b>" in header
    for chunk in [] if transcript_inline else _transcript_chunks(transcript):
        evidence_result = _telegram_api(
            "sendMessage",
            {
                "chat_id": chat_id,
                "reply_to_message_id": message_id,
                "text": chunk,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
        )
        if not int(evidence_result.get("result", {}).get("message_id") or 0):
            _edit_keyboard(chat_id, message_id, None)
            return None
    _edit_keyboard(chat_id, message_id, _report_keyboard(str(report["id"])))
    return chat_id, message_id


def _active_ban(cursor, *, user_id: str = "", contact_key: str = "") -> dict[str, Any] | None:
    contact_keys = _contact_keys(contact_key)
    if contact_keys:
        cursor.execute(
            """
            select contact_key, true as permanent, null::timestamptz as expires_at
            from yachat_banned_contacts
            where contact_key = any(%s)
            limit 1
            """,
            (contact_keys,),
        )
        forbidden = cursor.fetchone()
        if forbidden:
            return dict(forbidden)
    if not user_id and not contact_keys:
        return None
    cursor.execute(
        """
        select *
        from yachat_account_bans
        where (user_id = %s or contact_key = any(%s))
          and (permanent or expires_at > now())
        order by permanent desc, created_at desc
        limit 1
        """,
        (user_id, contact_keys),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def ensure_account_allowed(cursor, *, user_id: str = "", contact_key: str = "") -> None:
    ban = _active_ban(cursor, user_id=user_id, contact_key=contact_key)
    if not ban:
        return
    if bool(ban.get("permanent")):
        raise HTTPException(status_code=403, detail="Этот номер запрещён в ЯЧате.")
    expires_at = ban.get("expires_at")
    if isinstance(expires_at, datetime):
        expires = expires_at.astimezone(NOVOSIBIRSK).strftime("%d.%m.%Y %H:%M")
        raise HTTPException(status_code=403, detail=f"Аккаунт заблокирован до {expires} по Новосибирску.")
    raise HTTPException(status_code=403, detail="Аккаунт заблокирован.")


def _answer_callback(callback_id: str, text: str, *, alert: bool = False) -> None:
    _telegram_api(
        "answerCallbackQuery",
        {"callback_query_id": callback_id, "text": text[:190], "show_alert": alert},
    )


def _edit_keyboard(chat_id: str, message_id: int, keyboard: dict[str, Any] | None) -> None:
    _telegram_api(
        "editMessageReplyMarkup",
        {
            "chat_id": chat_id,
            "message_id": message_id,
            "reply_markup": keyboard or {"inline_keyboard": []},
        },
    )


def _delete_permanently_banned_account(
    cursor,
    *,
    user: dict[str, Any],
    report_id: str,
    moderator_id: str,
) -> None:
    user_id = str(user["id"])
    contact_key = str(user.get("contact_key") or "")
    if not contact_key:
        raise HTTPException(status_code=409, detail="У аккаунта нет номера для вечной блокировки.")
    cursor.execute(
        """
        insert into yachat_banned_contacts(
            contact_key, contact, report_id, reason, banned_at, banned_by_telegram_id
        )
        values (%s, %s, %s, 'permanent moderation ban', now(), %s)
        on conflict(contact_key) do update
        set contact = excluded.contact,
            report_id = excluded.report_id,
            reason = excluded.reason,
            banned_at = now(),
            banned_by_telegram_id = excluded.banned_by_telegram_id
        """,
        (contact_key, str(user.get("contact") or ""), report_id, moderator_id),
    )
    cursor.execute(
        """
        delete from yachat_messages
        where sender_id = %s
           or chat_id in (
                select cm.chat_id
                from yachat_chat_members cm
                join yachat_chats c on c.id = cm.chat_id
                where cm.user_id = %s and c.kind = 'private'
           )
        """,
        (user_id, user_id),
    )
    for table, column in (
        ("yachat_sessions", "user_id"),
        ("yachat_push_subscriptions", "user_id"),
        ("yachat_push_delivery_dedup", "user_id"),
        ("yachat_device_codes", "user_id"),
        ("yachat_user_settings", "user_id"),
        ("yachat_system_messages", "user_id"),
        ("yachat_qr_sessions", "account_id"),
        ("yachat_identity_challenges", "user_id"),
        ("yachat_identity_transactions", "user_id"),
        ("yachat_digital_id_vaults", "user_id"),
        ("yachat_e2ee_devices", "user_id"),
        ("yachat_message_hidden", "user_id"),
    ):
        cursor.execute(f"delete from {table} where {column} = %s", (user_id,))
    cursor.execute(
        """
        update yachat_e2ee_one_time_prekeys
        set claimed_by_user_id = null, claimed_by_device_id = null
        where claimed_by_user_id = %s
        """,
        (user_id,),
    )
    cursor.execute("delete from yachat_telegram_links where contact_key = %s", (contact_key,))
    cursor.execute(
        "delete from yachat_user_blocks where blocker_id = %s or blocked_id = %s",
        (user_id, user_id),
    )
    cursor.execute(
        """
        delete from yachat_chat_members cm
        using yachat_chats c
        where cm.chat_id = c.id and cm.user_id = %s and c.kind <> 'private'
        """,
        (user_id,),
    )
    cursor.execute(
        "update yachat_chats set owner_id = null, updated_at = now() where owner_id = %s",
        (user_id,),
    )
    cursor.execute(
        """
        update public_users
        set contact = '',
            contact_key = %s,
            username = '',
            preview_name = 'Аккаунт удалён',
            display_name = 'Аккаунт удалён',
            bio = '',
            avatar_url = '',
            is_public = false,
            deleted_at = now(),
            deletion_reason = 'permanent_moderation_ban',
            deleted_by_report_id = %s,
            updated_at = now()
        where id = %s
        """,
        (f"deleted:{user_id}", report_id, user_id),
    )
    cursor.execute(
        """
        delete from yachat_chats c
        where not exists (
            select 1 from yachat_chat_members cm where cm.chat_id = c.id
        )
        """
    )


def handle_moderation_callback(update: dict[str, Any]) -> bool:
    callback = update.get("callback_query")
    if not isinstance(callback, dict):
        return False
    data = str(callback.get("data") or "")
    if not data.startswith("report:"):
        return False

    callback_id = str(callback.get("id") or "")
    message = callback.get("message") if isinstance(callback.get("message"), dict) else {}
    chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
    sender = callback.get("from") if isinstance(callback.get("from"), dict) else {}
    chat_id = str(chat.get("id") or "")
    moderator_id = str(sender.get("id") or "")
    message_id = int(message.get("message_id") or 0)

    if chat_id != moderation_chat_id() or moderator_id not in moderator_telegram_ids():
        _answer_callback(callback_id, "Нет прав на модерацию.", alert=True)
        return True

    parts = data.split(":")
    if len(parts) < 3:
        _answer_callback(callback_id, "Некорректная команда.", alert=True)
        return True
    action = parts[1]
    report_id = parts[2]
    try:
        uuid.UUID(report_id)
    except ValueError:
        _answer_callback(callback_id, "Некорректная жалоба.", alert=True)
        return True

    if action == "ban":
        _edit_keyboard(chat_id, message_id, _ban_keyboard(report_id))
        _answer_callback(callback_id, "Выберите срок бана.")
        return True
    if action == "cancel":
        _edit_keyboard(chat_id, message_id, _report_keyboard(report_id))
        _answer_callback(callback_id, "Действие отменено.")
        return True

    with connect_db() as connection:
        with connection.transaction():
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute("select * from yachat_reports where id = %s for update", (report_id,))
                report = cursor.fetchone()
                if not report or str(report.get("status") or "") != "pending":
                    _answer_callback(callback_id, "Жалоба уже обработана.", alert=True)
                    return True

                if action == "dismiss":
                    cursor.execute(
                        """
                        update yachat_reports
                        set status = 'dismissed',
                            resolution = 'dismissed',
                            resolved_at = now(),
                            moderator_telegram_id = %s
                        where id = %s
                        """,
                        (moderator_id, report_id),
                    )
                    _edit_keyboard(chat_id, message_id, None)
                    _answer_callback(callback_id, "Жалоба опровергнута.")
                    return True

                if action != "banfor" or len(parts) != 4:
                    _answer_callback(callback_id, "Некорректная команда.", alert=True)
                    return True
                duration = parts[3]
                permanent = duration == "forever"
                if not permanent and duration not in BAN_DURATIONS:
                    _answer_callback(callback_id, "Некорректный срок бана.", alert=True)
                    return True

                cursor.execute(
                    "select * from public_users where id = %s limit 1",
                    (str(report["reported_user_id"]),),
                )
                user = cursor.fetchone()
                if not user:
                    _answer_callback(callback_id, "Аккаунт уже удалён.", alert=True)
                    return True

                expires_at = None if permanent else datetime.now(timezone.utc) + BAN_DURATIONS[duration][1]
                cursor.execute(
                    """
                    insert into yachat_account_bans(
                        id, user_id, contact_key, permanent, expires_at, report_id,
                        reason, created_at, banned_by_telegram_id
                    )
                    values (%s, %s, %s, %s, %s, %s, 'moderation report', now(), %s)
                    """,
                    (
                        str(uuid.uuid4()),
                        str(user["id"]),
                        str(user.get("contact_key") or ""),
                        permanent,
                        expires_at,
                        report_id,
                        moderator_id,
                    ),
                )
                cursor.execute("delete from yachat_sessions where user_id = %s", (str(user["id"]),))
                if permanent:
                    _delete_permanently_banned_account(
                        cursor,
                        user=dict(user),
                        report_id=report_id,
                        moderator_id=moderator_id,
                    )
                cursor.execute(
                    """
                    update yachat_reports
                    set status = 'banned',
                        resolution = %s,
                        resolved_at = now(),
                        moderator_telegram_id = %s
                    where id = %s
                    """,
                    ("permanent" if permanent else duration, moderator_id, report_id),
                )

    _edit_keyboard(chat_id, message_id, None)
    label = "вечный бан; аккаунт обезличен, а переписки удалены" if permanent else f"бан на {BAN_DURATIONS[duration][0]}"
    _answer_callback(callback_id, f"Выдан {label}.")
    return True
