import hashlib
import hmac
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row


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
CHAT_ID_PATTERN = re.compile(r"^(yachat-[a-z0-9-]+|private-[a-f0-9]{32}|group-[a-f0-9-]{36}|saved-[a-f0-9]{32})$")
ONLINE_TTL_SECONDS = 70
TYPING_TTL_SECONDS = 7
_schema_ready = False

app = FastAPI(title="YaChat Presence API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://yachat.vercel.app"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


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


def request_token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


def clean_chat_id(value: Any) -> str:
    chat_id = str(value or "").strip()
    if len(chat_id) > 96 or not CHAT_ID_PATTERN.match(chat_id):
        raise HTTPException(status_code=400, detail="Invalid chat id.")
    return chat_id


def current_user(cursor, request: Request) -> dict[str, Any]:
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


def ensure_presence_schema(cursor) -> None:
    global _schema_ready
    if _schema_ready:
        return
    cursor.execute(
        """
        create table if not exists yachat_presence (
            user_id text primary key references public_users(id) on delete cascade,
            active_chat_id text default '',
            typing_chat_id text default '',
            typing_until timestamptz,
            last_seen_at timestamptz default now(),
            updated_at timestamptz default now()
        )
        """
    )
    cursor.execute("create index if not exists yachat_presence_chat_idx on yachat_presence(active_chat_id, typing_chat_id)")
    _schema_ready = True


def is_system_chat(chat_id: str) -> bool:
    return chat_id in {"yachat-favorites", "yachat-codes", "yachat-channel"}


def require_chat_access(cursor, chat_id: str, user_id: str) -> None:
    if is_system_chat(chat_id):
        return
    cursor.execute(
        "select 1 from yachat_chat_members where chat_id = %s and user_id = %s limit 1",
        (chat_id, user_id),
    )
    if not cursor.fetchone():
        raise HTTPException(status_code=404, detail="Chat not found.")


def touch_presence(cursor, user_id: str, chat_id: str, typing: bool | None = None) -> None:
    typing_chat_id = chat_id if typing else ""
    typing_until = datetime.now(timezone.utc) + timedelta(seconds=TYPING_TTL_SECONDS) if typing else None

    if typing is None:
        cursor.execute(
            """
            insert into yachat_presence(user_id, active_chat_id, last_seen_at, updated_at)
            values (%s, %s, now(), now())
            on conflict (user_id) do update
            set active_chat_id = excluded.active_chat_id,
                last_seen_at = now(),
                updated_at = now()
            """,
            (user_id, chat_id),
        )
        return

    cursor.execute(
        """
        insert into yachat_presence(
            user_id, active_chat_id, typing_chat_id, typing_until, last_seen_at, updated_at
        )
        values (%s, %s, %s, %s, now(), now())
        on conflict (user_id) do update
        set active_chat_id = excluded.active_chat_id,
            typing_chat_id = excluded.typing_chat_id,
            typing_until = excluded.typing_until,
            last_seen_at = now(),
            updated_at = now()
        """,
        (user_id, chat_id, typing_chat_id, typing_until),
    )


def chat_kind(cursor, chat_id: str) -> str:
    if chat_id == "yachat-favorites":
        return "saved"
    if chat_id == "yachat-codes":
        return "bot"
    if chat_id == "yachat-channel":
        return "channel"
    cursor.execute("select kind from yachat_chats where id = %s limit 1", (chat_id,))
    row = cursor.fetchone()
    return str(row["kind"] if row else "private")


def subscriber_count(cursor, chat_id: str, kind: str) -> int:
    if kind == "channel":
        cursor.execute("select count(*) as count from public_users")
        return int(cursor.fetchone()["count"])
    if kind == "group":
        cursor.execute("select count(*) as count from yachat_chat_members where chat_id = %s", (chat_id,))
        return int(cursor.fetchone()["count"])
    return 0


def typing_user(cursor, chat_id: str, user_id: str) -> dict[str, str] | None:
    cursor.execute(
        """
        select u.id, u.display_name, u.preview_name, u.username
        from yachat_presence p
        join public_users u on u.id = p.user_id
        where p.user_id <> %s
          and p.active_chat_id = %s
          and p.typing_chat_id = %s
          and p.typing_until > now()
        order by p.updated_at desc
        limit 1
        """,
        (user_id, chat_id, chat_id),
    )
    row = cursor.fetchone()
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "displayName": str(row["display_name"] or row["preview_name"] or row["username"] or "Пользователь"),
    }


def private_online(cursor, chat_id: str, user_id: str) -> bool:
    cursor.execute(
        """
        select p.last_seen_at
        from yachat_chat_members cm
        left join yachat_presence p on p.user_id = cm.user_id
        where cm.chat_id = %s and cm.user_id <> %s
        order by p.last_seen_at desc nulls last
        limit 1
        """,
        (chat_id, user_id),
    )
    row = cursor.fetchone()
    if not row or not row["last_seen_at"]:
        return False
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=ONLINE_TTL_SECONDS)
    return row["last_seen_at"] >= cutoff


def presence_payload(cursor, chat_id: str, user_id: str) -> dict[str, Any]:
    kind = chat_kind(cursor, chat_id)
    remote_typing = typing_user(cursor, chat_id, user_id) if kind in {"private", "group"} else None
    return {
        "chatId": chat_id,
        "kind": kind,
        "subscriberCount": subscriber_count(cursor, chat_id, kind),
        "online": private_online(cursor, chat_id, user_id) if kind == "private" else False,
        "typingUser": remote_typing,
    }


@app.middleware("http")
async def harden_responses(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


@app.get("/api/presence")
def get_presence(request: Request, chatId: str = ""):
    chat_id = clean_chat_id(chatId)
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                ensure_presence_schema(cursor)
                user = current_user(cursor, request)
                user_id = str(user["id"])
                require_chat_access(cursor, chat_id, user_id)
                touch_presence(cursor, user_id, chat_id)
                return presence_payload(cursor, chat_id, user_id)
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Presence database is unavailable.") from error


@app.post("/api/presence")
async def update_presence(request: Request):
    payload = await request.json()
    chat_id = clean_chat_id(payload.get("chatId"))
    typing = bool(payload.get("typing"))
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                ensure_presence_schema(cursor)
                user = current_user(cursor, request)
                user_id = str(user["id"])
                require_chat_access(cursor, chat_id, user_id)
                touch_presence(cursor, user_id, chat_id, typing)
                return presence_payload(cursor, chat_id, user_id)
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Presence database is unavailable.") from error
