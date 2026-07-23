import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from psycopg.rows import dict_row

app = FastAPI(title="YaChat Presence API", version="0.2.0")

DATABASE_ENV_NAMES = (
    "YACHAT_USERS_DB_URL",
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "POSTGRES_URL_POOLER",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_URL_NO_SSL",
    "NEON_DATABASE_URL",
    "NEON_DATABASE_URL_UNPOOLED",
    "SUPABASE_DB_URL",
)
CHAT_ID_PATTERN = re.compile(
    r"^(yachat-[a-z0-9-]+|private-[a-f0-9]{32}|group-[a-f0-9-]{36}|saved-[a-f0-9]{32})$"
)
ONLINE_WINDOW_SECONDS = 25
RECENT_WINDOW_DAYS = 3
TYPING_TTL_SECONDS = 7
_schema_ready = False


def database_url() -> str:
    for name in DATABASE_ENV_NAMES:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def auth_secret() -> str:
    return os.getenv("YACHAT_AUTH_SECRET") or database_url() or "yachat-dev-secret"


def hash_secret(value: str) -> str:
    return hmac.new(auth_secret().encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def connect_db():
    url = database_url()
    if not url:
        raise HTTPException(status_code=503, detail="Users database is not configured.")
    return psycopg.connect(url, autocommit=True)


def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return

    try:
        with connect_db() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    create table if not exists yachat_user_presence (
                        user_id text primary key references public_users(id) on delete cascade,
                        last_seen_at timestamptz not null default now(),
                        updated_at timestamptz not null default now()
                    )
                    """
                )
                cursor.execute(
                    """
                    create table if not exists yachat_typing (
                        chat_id text not null references yachat_chats(id) on delete cascade,
                        user_id text not null references public_users(id) on delete cascade,
                        updated_at timestamptz not null default now(),
                        expires_at timestamptz not null,
                        primary key(chat_id, user_id)
                    )
                    """
                )
                cursor.execute(
                    "create index if not exists yachat_typing_expiry_idx on yachat_typing(expires_at)"
                )
        _schema_ready = True
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


def request_token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def require_user(request: Request) -> dict[str, Any]:
    token = request_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in first.")

    ensure_schema()
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
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
    except HTTPException:
        raise
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


def clean_chat_id(value: Any) -> str:
    chat_id = str(value or "").strip()
    if len(chat_id) > 96 or not CHAT_ID_PATTERN.match(chat_id):
        raise HTTPException(status_code=400, detail="Invalid chat id.")
    return chat_id


def display_name(row: dict[str, Any]) -> str:
    return str(row.get("display_name") or row.get("preview_name") or row.get("username") or "Пользователь")


def touch_presence(cursor, user_id: str) -> None:
    cursor.execute(
        """
        insert into yachat_user_presence(user_id, last_seen_at, updated_at)
        values (%s, now(), now())
        on conflict (user_id) do update
        set last_seen_at = now(), updated_at = now()
        """,
        (user_id,),
    )


def require_chat_access(cursor, chat_id: str, user_id: str) -> dict[str, Any]:
    if chat_id.startswith("yachat-"):
        return {"id": chat_id, "kind": "channel" if chat_id == "yachat-channel" else "system"}

    cursor.execute(
        """
        select c.*
        from yachat_chats c
        join yachat_chat_members cm on cm.chat_id = c.id
        where c.id = %s and cm.user_id = %s
        limit 1
        """,
        (chat_id, user_id),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return dict(row)


def subscriber_count(cursor, chat_id: str) -> int:
    if chat_id == "yachat-channel":
        cursor.execute("select count(*) as count from public_users")
    elif chat_id.startswith("yachat-"):
        return 0
    else:
        cursor.execute("select count(*) as count from yachat_chat_members where chat_id = %s", (chat_id,))
    row = cursor.fetchone()
    return int(row["count"] if row else 0)


def private_peer_status(cursor, chat_id: str, user_id: str) -> str:
    cursor.execute(
        """
        select p.last_seen_at
        from yachat_chat_members cm
        left join yachat_user_presence p on p.user_id = cm.user_id
        where cm.chat_id = %s and cm.user_id <> %s
        order by cm.joined_at asc
        limit 1
        """,
        (chat_id, user_id),
    )
    row = cursor.fetchone()
    last_seen = row.get("last_seen_at") if row else None
    if not last_seen:
        return "long-ago"

    now = datetime.now(timezone.utc)
    if last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=timezone.utc)

    elapsed = now - last_seen
    if elapsed <= timedelta(seconds=ONLINE_WINDOW_SECONDS):
        return "online"
    if elapsed <= timedelta(days=RECENT_WINDOW_DAYS):
        return "recent"
    return "long-ago"


def typing_users(cursor, chat_id: str, user_id: str) -> list[dict[str, str]]:
    if chat_id.startswith("yachat-"):
        return []

    cursor.execute("delete from yachat_typing where expires_at <= now()")
    cursor.execute(
        """
        select u.id, u.display_name, u.preview_name, u.username
        from yachat_typing t
        join yachat_chat_members cm on cm.chat_id = t.chat_id and cm.user_id = t.user_id
        join public_users u on u.id = t.user_id
        where t.chat_id = %s
          and t.user_id <> %s
          and t.expires_at > now()
        order by t.updated_at desc
        limit 4
        """,
        (chat_id, user_id),
    )
    return [
        {"id": str(row["id"]), "displayName": display_name(dict(row))}
        for row in cursor.fetchall()
    ]


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


@app.get("/api/presence")
def get_presence(request: Request, chatId: str = ""):
    user = require_user(request)
    user_id = str(user["id"])
    chat_id = clean_chat_id(chatId)

    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                touch_presence(cursor, user_id)
                chat = require_chat_access(cursor, chat_id, user_id)
                kind = str(chat.get("kind") or "")
                return {
                    "chatId": chat_id,
                    "kind": kind,
                    "subscriberCount": subscriber_count(cursor, chat_id),
                    "status": private_peer_status(cursor, chat_id, user_id) if kind == "private" else "",
                    "typingUsers": typing_users(cursor, chat_id, user_id),
                }
    except HTTPException:
        raise
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


@app.post("/api/presence")
async def set_presence(request: Request):
    user = require_user(request)
    user_id = str(user["id"])
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    chat_id = clean_chat_id(payload.get("chatId"))
    is_typing = bool(payload.get("typing"))

    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                touch_presence(cursor, user_id)
                chat = require_chat_access(cursor, chat_id, user_id)
                kind = str(chat.get("kind") or "")
                if kind not in {"private", "group"}:
                    return {"ok": True, "typing": False}

                if is_typing:
                    cursor.execute(
                        """
                        insert into yachat_typing(chat_id, user_id, updated_at, expires_at)
                        values (%s, %s, now(), now() + (%s * interval '1 second'))
                        on conflict (chat_id, user_id) do update
                        set updated_at = now(), expires_at = excluded.expires_at
                        """,
                        (chat_id, user_id, TYPING_TTL_SECONDS),
                    )
                else:
                    cursor.execute(
                        "delete from yachat_typing where chat_id = %s and user_id = %s",
                        (chat_id, user_id),
                    )
                return {"ok": True, "typing": is_typing}
    except HTTPException:
        raise
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error
