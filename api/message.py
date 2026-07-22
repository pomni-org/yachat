import asyncio
import json
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    clean_attachments,
    clean_chat_id,
    configured_cors_origins,
    connect_db,
    ensure_saved_chat,
    get_chat_messages,
    is_murochko_profile,
    list_user_chats,
    message_payload,
    prepare_rich_message,
    read_json_payload,
    require_chat_member,
    require_chat_messaging_allowed,
    require_user,
    resolve_message_chat_id,
    row_value,
)
from server.push_delivery import send_push_to_user

app = FastAPI(title="YaChat message API", version="0.5.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def attachment_body(attachments: list[dict[str, Any]]) -> str:
    if not attachments:
        return ""
    kind = str(attachments[0].get("kind") or "")
    if kind == "image":
        return "Фото"
    if kind == "video":
        return "Видео"
    return "Файл"


def aggregate_push(results: list[dict[str, Any]]) -> dict[str, int]:
    return {
        key: sum(int(result.get(key, 0) or 0) for result in results)
        for key in ("subscriptions", "sent", "failed", "removed")
    }


async def deliver_pushes(deliveries: list[tuple[str, str, str, str, str]]) -> list[dict[str, Any]]:
    """Run per-recipient delivery concurrently so database response work cannot starve Web Push."""
    if not deliveries:
        return []
    return await asyncio.gather(
        *[
            asyncio.to_thread(
                send_push_to_user,
                user_id,
                title,
                body,
                url,
                tag=tag,
            )
            for user_id, title, body, url, tag in deliveries
        ]
    )


def message_ids(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("messageIds") if isinstance(payload.get("messageIds"), list) else [payload.get("messageId")]
    result: list[str] = []
    seen: set[str] = set()
    for value in raw:
        message_id = str(value or "").strip()
        if not message_id or message_id in seen:
            continue
        seen.add(message_id)
        result.append(message_id)
        if len(result) >= 100:
            break
    if not result:
        raise HTTPException(status_code=400, detail="Select a message first.")
    return result


@app.post("/api/message")
async def send_message(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    formatted_html, text = prepare_rich_message(payload)
    attachments = clean_attachments(payload.get("attachments"))
    if not text and not attachments:
        raise HTTPException(status_code=400, detail="Enter a message.")

    user_id = str(user["id"])
    is_saved_chat = chat_id == "yachat-favorites"
    is_channel_post = chat_id == "yachat-channel"
    body = text or attachment_body(attachments) or "Новое сообщение"

    if is_channel_post:
        if not is_murochko_profile(user):
            raise HTTPException(status_code=403, detail="Only Murochko can post to the YaChat channel.")

        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute("select id from public_users")
                user_ids = [str(row["id"]) for row in cursor.fetchall()]
                if not user_ids:
                    user_ids = [user_id]
                message_id = str(uuid.uuid4())
                for target_user_id in user_ids:
                    cursor.execute(
                        """
                        insert into yachat_system_messages(
                            id, user_id, chat_id, author_id, text, formatted_html,
                            attachments, system_kind, created_at
                        )
                        values (%s, %s, 'yachat-channel', %s, %s, %s, %s::jsonb, 'channel-post', now())
                        """,
                        (
                            message_id if target_user_id == user_id else str(uuid.uuid4()),
                            target_user_id,
                            user["id"],
                            text,
                            formatted_html,
                            json.dumps(attachments[:8]),
                        ),
                    )

        push_results = await deliver_pushes([
            (
                target_user_id,
                "ЯЧат • Анонсы",
                body[:240],
                "/yachat_channel",
                f"channel-message:{message_id}:{target_user_id}",
            )
            for target_user_id in user_ids
            if target_user_id != user_id
        ])
        return {
            "chats": list_user_chats(user_id),
            "messages": get_chat_messages("yachat-channel", user_id),
            "push": aggregate_push(push_results),
        }

    if chat_id.startswith("yachat-") and not is_saved_chat:
        raise HTTPException(status_code=400, detail="System chats are local only.")

    client_message_id = str(payload.get("clientMessageId") or "").strip()
    try:
        message_id = str(uuid.UUID(client_message_id)) if client_message_id else str(uuid.uuid4())
    except (ValueError, AttributeError, TypeError):
        message_id = str(uuid.uuid4())

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if is_saved_chat:
                chat_id = ensure_saved_chat(cursor, user_id)
            chat = require_chat_member(cursor, chat_id, user_id)
            if not bool(row_value(chat, "can_send") if "can_send" in chat else True):
                raise HTTPException(status_code=403, detail="This chat is read-only.")
            require_chat_messaging_allowed(cursor, chat, user_id)

            cursor.execute(
                """
                insert into yachat_messages(
                    id, chat_id, sender_id, text, formatted_html,
                    attachments, reply_to_message_id, created_at
                )
                values (%s, %s, %s, %s, %s, %s::jsonb, %s, now())
                on conflict(id) do nothing
                returning *
                """,
                (
                    message_id,
                    chat_id,
                    user["id"],
                    text,
                    formatted_html,
                    json.dumps(attachments[:8]),
                    payload.get("replyToMessageId") or None,
                ),
            )
            inserted_row = cursor.fetchone()
            inserted = inserted_row is not None
            if inserted:
                message = dict(inserted_row)
            else:
                cursor.execute(
                    """
                    select *
                    from yachat_messages
                    where id = %s and chat_id = %s and sender_id = %s and deleted_at is null
                    limit 1
                    """,
                    (message_id, chat_id, user["id"]),
                )
                existing_row = cursor.fetchone()
                if not existing_row:
                    raise HTTPException(status_code=409, detail="Message id conflict.")
                message = dict(existing_row)

            cursor.execute("update yachat_chats set updated_at = now() where id = %s", (chat_id,))
            cursor.execute(
                "update yachat_chat_members set last_read_at = now() where chat_id = %s and user_id = %s",
                (chat_id, user["id"]),
            )
            cursor.execute(
                """
                select user_id
                from yachat_chat_members
                where chat_id = %s and user_id <> %s
                """,
                (chat_id, user["id"]),
            )
            recipients = [] if is_saved_chat else [str(row["user_id"]) for row in cursor.fetchall()]

    sender_name = str(row_value(user, "display_name", "preview_name", "username")) or "ЯЧат"
    sender_username = str(row_value(user, "username"))
    chat_kind = str(row_value(chat, "kind"))
    chat_title = str(row_value(chat, "title"))
    push_target = f"/{sender_username}" if chat_kind == "private" and sender_username else f"/?chat={chat_id}"
    push_title = sender_name if chat_kind == "private" else chat_title or sender_name
    push_body = body if chat_kind == "private" else f"{sender_name}: {body}"
    push_results = await deliver_pushes([
        (
            recipient_id,
            push_title,
            push_body[:240],
            push_target,
            f"message:{message_id}:{recipient_id}",
        )
        for recipient_id in recipients
    ])

    return {
        "chats": list_user_chats(user_id),
        "messages": get_chat_messages(chat_id, user_id),
        "message": message_payload(message, user_id),
        "inserted": inserted,
        "push": aggregate_push(push_results),
    }


@app.post("/api/message/delete")
async def delete_message(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    requested_chat_id = clean_chat_id(payload.get("chatId"))
    scope = str(payload.get("scope") or "self").strip().lower()
    if scope not in {"self", "everyone"}:
        raise HTTPException(status_code=400, detail="Choose how to delete the message.")

    ids = message_ids(payload)
    user_id = str(user["id"])

    if requested_chat_id.startswith("yachat-") and requested_chat_id != "yachat-favorites":
        raise HTTPException(status_code=403, detail="This message cannot be deleted.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat_id = resolve_message_chat_id(cursor, requested_chat_id, user_id)
            require_chat_member(cursor, chat_id, user_id)
            cursor.execute(
                """
                select id, sender_id
                from yachat_messages
                where chat_id = %s
                  and id::text = any(%s)
                  and deleted_at is null
                """,
                (chat_id, ids),
            )
            rows = [dict(row) for row in cursor.fetchall()]
            rows_by_id = {str(row["id"]): row for row in rows}
            if any(message_id not in rows_by_id for message_id in ids):
                raise HTTPException(status_code=404, detail="Message not found.")

            if scope == "everyone":
                if any(str(row_value(rows_by_id[message_id], "sender_id")) != user_id for message_id in ids):
                    raise HTTPException(status_code=403, detail="You can delete only your own messages for everyone.")
                cursor.execute(
                    """
                    update yachat_messages
                    set deleted_at = now()
                    where chat_id = %s
                      and sender_id = %s
                      and id::text = any(%s)
                      and deleted_at is null
                    """,
                    (chat_id, user_id, ids),
                )
            else:
                cursor.execute(
                    """
                    insert into yachat_message_hidden(message_id, user_id, hidden_at)
                    select id, %s, now()
                    from yachat_messages
                    where chat_id = %s
                      and id::text = any(%s)
                      and deleted_at is null
                    on conflict(message_id, user_id) do nothing
                    """,
                    (user_id, chat_id, ids),
                )

    return {
        "chats": list_user_chats(user_id),
        "messages": get_chat_messages(requested_chat_id, user_id),
    }
