"""Database-backed presence and typing endpoint for YaChat.

Only short-lived activity timestamps are stored. Message text and chat contents are
never written to the presence tables.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    clean_chat_id,
    configured_cors_origins,
    connect_db,
    ensure_schema,
    hash_secret,
    read_json_payload,
    request_token,
    require_chat_member,
    row_value,
)


TYPING_TTL_SECONDS = 3
ONLINE_TTL_SECONDS = 20
RECENT_TTL_DAYS = 7

app = FastAPI(title="YaChat presence API", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "private, no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def _session_user(cursor, request: Request) -> dict[str, Any]:
    token = request_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in first.")

    cursor.execute(
        """
        select u.*
        from yachat_sessions s
        join public_users u on u.id = s.user_id
        where s.token_hash = %s and s.expires_at > now()
        limit 1
        """,
        (hash_secret(token),),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Sign in first.")
    return dict(row)


def _touch_presence(cursor, user_id: str) -> None:
    cursor.execute(
        """
        insert into yachat_user_presence(user_id, last_seen_at, updated_at)
        values (%s, now(), now())
        on conflict(user_id) do update
        set last_seen_at = excluded.last_seen_at,
            updated_at = excluded.updated_at
        """,
        (user_id,),
    )


def _chat_context(cursor, chat_id: str, user_id: str) -> dict[str, Any]:
    if chat_id.startswith("yachat-"):
        return {"id": chat_id, "kind": "system"}
    return require_chat_member(cursor, chat_id, user_id)


def _typing_users(cursor, chat_id: str, user_id: str) -> list[dict[str, str]]:
    if chat_id.startswith("yachat-"):
        return []

    cursor.execute(
        """
        select u.id, u.username, u.display_name, u.preview_name
        from yachat_typing t
        join yachat_chat_members cm
          on cm.chat_id = t.chat_id and cm.user_id = t.user_id
        join public_users u on u.id = t.user_id
        where t.chat_id = %s
          and t.user_id <> %s
          and t.expires_at > now()
        order by t.updated_at desc
        limit 8
        """,
        (chat_id, user_id),
    )
    return [
        {
            "id": str(row_value(row, "id")),
            "username": str(row_value(row, "username")),
            "displayName": str(row_value(row, "display_name", "preview_name", "username")),
        }
        for row in cursor.fetchall()
    ]


def _subscriber_count(cursor, chat_id: str) -> int:
    if chat_id == "yachat-channel":
        cursor.execute("select count(*) as count from public_users where coalesce(is_public, true)")
        return int(row_value(cursor.fetchone(), "count") or 0)
    if chat_id.startswith("yachat-"):
        return 1

    cursor.execute("select count(*) as count from yachat_chat_members where chat_id = %s", (chat_id,))
    return int(row_value(cursor.fetchone(), "count") or 0)


def _private_status(cursor, chat: dict[str, Any], user_id: str) -> str:
    if str(row_value(chat, "kind")) != "private":
        return "recent"

    cursor.execute(
        """
        select p.last_seen_at
        from yachat_chat_members cm
        left join yachat_user_presence p on p.user_id = cm.user_id
        where cm.chat_id = %s and cm.user_id <> %s
        order by cm.joined_at asc
        limit 1
        """,
        (row_value(chat, "id"), user_id),
    )
    row = cursor.fetchone()
    last_seen = row_value(row, "last_seen_at")
    if not last_seen:
        return "long_ago"

    now = datetime.now(timezone.utc)
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)
    age = now - last_seen
    if age <= timedelta(seconds=ONLINE_TTL_SECONDS):
        return "online"
    if age <= timedelta(days=RECENT_TTL_DAYS):
        return "recent"
    return "long_ago"


@app.get("/api/presence")
def get_presence(request: Request, chatId: str = ""):
    chat_id = clean_chat_id(chatId)
    ensure_schema()

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            user = _session_user(cursor, request)
            user_id = str(user["id"])
            chat = _chat_context(cursor, chat_id, user_id)
            _touch_presence(cursor, user_id)
            cursor.execute("delete from yachat_typing where expires_at <= now()")
            typing_users = _typing_users(cursor, chat_id, user_id)
            status = _private_status(cursor, chat, user_id)
            subscriber_count = _subscriber_count(cursor, chat_id)

    return {
        "chatId": chat_id,
        "status": status,
        "typingUsers": typing_users,
        "subscriberCount": subscriber_count,
        "serverTime": datetime.now(timezone.utc),
    }


@app.post("/api/presence")
async def set_typing(request: Request):
    payload = await read_json_payload(request, limit=4096)
    chat_id = clean_chat_id(payload.get("chatId"))
    typing = bool(payload.get("typing"))
    ensure_schema()

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            user = _session_user(cursor, request)
            user_id = str(user["id"])
            chat = _chat_context(cursor, chat_id, user_id)
            _touch_presence(cursor, user_id)

            kind = str(row_value(chat, "kind"))
            can_type = not chat_id.startswith("yachat-") and kind in {"private", "group"}
            if typing and can_type:
                cursor.execute(
                    """
                    insert into yachat_typing(chat_id, user_id, updated_at, expires_at)
                    values (%s, %s, now(), now() + (%s * interval '1 second'))
                    on conflict(chat_id, user_id) do update
                    set updated_at = excluded.updated_at,
                        expires_at = excluded.expires_at
                    """,
                    (chat_id, user_id, TYPING_TTL_SECONDS),
                )
            else:
                cursor.execute(
                    "delete from yachat_typing where chat_id = %s and user_id = %s",
                    (chat_id, user_id),
                )

    return {"ok": True, "chatId": chat_id, "typing": bool(typing and can_type)}
