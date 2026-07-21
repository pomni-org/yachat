import hashlib
import os
import re
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    can_manage_chat,
    chat_summary,
    clean_chat_id,
    clean_text,
    configured_cors_origins,
    connect_db,
    ensure_schema,
    get_chat_messages,
    is_murochko_profile,
    list_user_chats,
    normalize_username,
    read_json_payload,
    require_chat_member,
    require_user,
    row_value,
    system_chat_settings,
)


MAX_AVATAR_DATA_URL_CHARS = 8_000_000
DEFAULT_CHANNEL_TITLE = "ЯЧат"
DEFAULT_CHANNEL_DESCRIPTION = (
    "ЯЧат запущен. Здесь будут новости приложения, изменения и служебные объявления."
)
IMAGE_DATA_URL_PATTERN = re.compile(r"^data:image/[a-z0-9.+-]+;base64,$", re.IGNORECASE)
RESERVED_GROUP_USERNAMES = {
    "api",
    "help",
    "privacy",
    "policy",
    "terms",
    "agreement",
    "verificationcodes_bot",
    "yachat_channel",
}

app = FastAPI(title="YaChat chat update API", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store, max-age=0")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def clean_avatar_data_url(value: Any) -> str:
    source = str(value or "").replace("\x00", "").strip()
    if not source:
        return ""
    if len(source) > MAX_AVATAR_DATA_URL_CHARS:
        raise HTTPException(status_code=413, detail="Avatar is too large.")
    if source.startswith(("/assets/", "./assets/")):
        return source
    header, separator, encoded = source.partition(",")
    if not separator or not IMAGE_DATA_URL_PATTERN.fullmatch(f"{header},") or not encoded:
        raise HTTPException(status_code=400, detail="Invalid avatar image.")
    return source


def avatar_digest(value: Any) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def fresh_system_chat(chat_id: str) -> dict[str, Any]:
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            return system_chat_settings(cursor, chat_id)


def channel_payload(chat_id: str, user_id: str, stored: dict[str, Any]) -> dict[str, Any]:
    avatar_url = str(row_value(stored, "avatar_url"))
    chats = list_user_chats(user_id)
    chat = next((item for item in chats if item.get("id") == chat_id), None)
    if not chat:
        raise HTTPException(status_code=500, detail="Saved channel is missing from the server response.")
    if str(chat.get("avatarDataUrl") or "") != avatar_url:
        raise HTTPException(status_code=500, detail="Saved channel avatar does not match the database.")
    return {
        "chat": chat,
        "chats": chats,
        "messages": get_chat_messages(chat_id, user_id),
        "avatarDataUrl": avatar_url,
        "avatarSha256": avatar_digest(avatar_url),
        "avatarUpdatedAt": row_value(stored, "updated_at"),
        "persisted": True,
    }


def system_chat_value(payload: dict[str, Any], existing: dict[str, Any], key: str, column: str, fallback: str) -> str:
    if key not in payload:
        return str(row_value(existing, column)) or fallback
    value = clean_text(payload.get(key), 60 if key == "title" else 180)
    return value or fallback


def ensure_group_profile_schema(cursor) -> None:
    if os.getenv("VERCEL") and os.getenv("YACHAT_RUNTIME_SCHEMA_BOOTSTRAP", "").lower() not in {"1", "true", "yes", "on"}:
        return
    cursor.execute("alter table yachat_chats add column if not exists username text default ''")
    cursor.execute(
        """
        create unique index if not exists yachat_chats_username_idx
        on yachat_chats(lower(username))
        where username is not null and username <> ''
        """
    )


def group_profile_payload(chat: dict[str, Any]) -> dict[str, Any]:
    username = str(row_value(chat, "username")).strip().lstrip("@").lower()
    return {
        "chatId": str(row_value(chat, "id")),
        "kind": str(row_value(chat, "kind")),
        "title": str(row_value(chat, "title")),
        "description": str(row_value(chat, "description")),
        "avatarDataUrl": str(row_value(chat, "avatar_url")),
        "profileUsername": username,
        "profileUrl": f"https://yachat.vercel.app/{username}" if username else "",
        "updatedAt": row_value(chat, "updated_at"),
    }


def require_group_member(cursor, chat_id: str, user_id: str) -> dict[str, Any]:
    chat = require_chat_member(cursor, chat_id, user_id)
    if str(row_value(chat, "kind")) != "group":
        raise HTTPException(status_code=400, detail="Only groups can have a group username.")
    return chat


def group_username_taken(cursor, username: str, chat_id: str) -> bool:
    cursor.execute(
        "select 1 from public_users where lower(coalesce(username, '')) = lower(%s) limit 1",
        (username,),
    )
    if cursor.fetchone():
        return True
    cursor.execute(
        """
        select 1
        from yachat_chats
        where lower(coalesce(username, '')) = lower(%s)
          and id <> %s
        limit 1
        """,
        (username, chat_id),
    )
    return bool(cursor.fetchone())


@app.get("/api/group-profile")
def read_group_profile(request: Request, chatId: str = ""):
    user = require_user(request)
    chat_id = clean_chat_id(chatId)
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            ensure_group_profile_schema(cursor)
            chat = require_group_member(cursor, chat_id, str(user["id"]))
            return group_profile_payload(chat)


@app.get("/api/group-profile/by-username")
def read_group_by_username(request: Request, username: str = Query(default="")):
    user = require_user(request)
    normalized = normalize_username(username)
    if not normalized:
        raise HTTPException(status_code=404, detail="Group not found.")

    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            ensure_group_profile_schema(cursor)
            cursor.execute(
                """
                select c.*
                from yachat_chats c
                join yachat_chat_members cm on cm.chat_id = c.id
                where c.kind = 'group'
                  and lower(coalesce(c.username, '')) = lower(%s)
                  and cm.user_id = %s
                limit 1
                """,
                (normalized, user["id"]),
            )
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Group not found.")
            return group_profile_payload(dict(row))


@app.post("/api/group-profile")
async def update_group_profile(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    raw_username = str(payload.get("username") or "").strip().lstrip("@").lower()
    username = normalize_username(raw_username) if raw_username else ""

    if raw_username and not username:
        raise HTTPException(
            status_code=400,
            detail="Username must contain 3-24 Latin letters, digits, or underscores.",
        )
    if username in RESERVED_GROUP_USERNAMES:
        raise HTTPException(status_code=409, detail="This username is reserved.")

    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            ensure_group_profile_schema(cursor)
            chat = require_group_member(cursor, chat_id, str(user["id"]))
            if not can_manage_chat(chat, str(user["id"])):
                raise HTTPException(status_code=403, detail="Only the group owner can edit its username.")
            if username and group_username_taken(cursor, username, chat_id):
                raise HTTPException(status_code=409, detail="Username is already taken.")

            cursor.execute(
                """
                update yachat_chats
                set username = %s, updated_at = now()
                where id = %s
                returning *
                """,
                (username, chat_id),
            )
            updated = cursor.fetchone()
            if not updated:
                raise HTTPException(status_code=404, detail="Group not found.")
            connection.commit()
            return group_profile_payload(dict(updated))


@app.get("/api/chat/update")
def read_chat_update(request: Request, chatId: str = "yachat-channel"):
    user = require_user(request)
    chat_id = clean_chat_id(chatId)
    if chat_id != "yachat-channel":
        raise HTTPException(status_code=400, detail="Only the system channel can be verified here.")
    stored = fresh_system_chat(chat_id)
    if not stored:
        raise HTTPException(status_code=404, detail="Channel settings were not found.")
    return channel_payload(chat_id, str(user["id"]), stored)


@app.post("/api/chat/update")
async def update_chat(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    user_id = str(user["id"])

    if chat_id == "yachat-channel":
        if not is_murochko_profile(user):
            raise HTTPException(status_code=403, detail="Only Murochko can edit the YaChat channel.")

        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                existing = system_chat_settings(cursor, chat_id)
                title = system_chat_value(payload, existing, "title", "title", DEFAULT_CHANNEL_TITLE)
                description = system_chat_value(
                    payload,
                    existing,
                    "description",
                    "description",
                    DEFAULT_CHANNEL_DESCRIPTION,
                )
                avatar_url = (
                    clean_avatar_data_url(payload.get("avatarDataUrl"))
                    if "avatarDataUrl" in payload
                    else str(row_value(existing, "avatar_url"))
                )

                cursor.execute(
                    """
                    insert into yachat_system_chats(id, title, description, avatar_url, updated_at)
                    values ('yachat-channel', %s, %s, %s, now())
                    on conflict (id) do update
                    set title = excluded.title,
                        description = excluded.description,
                        avatar_url = excluded.avatar_url,
                        updated_at = now()
                    returning *
                    """,
                    (title, description, avatar_url),
                )
                written = cursor.fetchone()
                if not written:
                    raise HTTPException(status_code=500, detail="Channel settings were not written.")
                connection.commit()

        stored = fresh_system_chat(chat_id)
        if not stored or str(row_value(stored, "avatar_url")) != avatar_url:
            raise HTTPException(status_code=500, detail="Channel avatar failed the database persistence check.")
        return channel_payload(chat_id, user_id, stored)

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat = require_chat_member(cursor, chat_id, user_id)
            if not can_manage_chat(chat, user_id):
                raise HTTPException(status_code=403, detail="Only the group owner can edit this chat.")

            updates: list[str] = []
            params: list[Any] = []

            if "title" in payload:
                title = clean_text(payload.get("title"), 60)
                if not title:
                    raise HTTPException(status_code=400, detail="Enter a group name.")
                updates.append("title = %s")
                params.append(title)

            if "description" in payload:
                updates.append("description = %s")
                params.append(clean_text(payload.get("description"), 180))

            if "avatarDataUrl" in payload:
                updates.append("avatar_url = %s")
                params.append(clean_avatar_data_url(payload.get("avatarDataUrl")))

            if updates:
                params.append(chat_id)
                cursor.execute(
                    f"""
                    update yachat_chats
                    set {", ".join(updates)}, updated_at = now()
                    where id = %s
                    returning *
                    """,
                    params,
                )
                updated = cursor.fetchone()
                if not updated:
                    raise HTTPException(status_code=404, detail="Chat not found.")
                chat = dict(updated)

            connection.commit()
            return {
                "chat": chat_summary(cursor, chat, user_id),
                "chats": list_user_chats(user_id),
                "messages": get_chat_messages(chat_id, user_id),
            }
