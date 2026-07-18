from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    can_manage_chat,
    clean_chat_id,
    configured_cors_origins,
    connect_db,
    ensure_schema,
    normalize_username,
    read_json_payload,
    require_chat_member,
    require_user,
    row_value,
)


app = FastAPI(title="YaChat group profile API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

RESERVED_USERNAMES = {
    "api",
    "help",
    "privacy",
    "policy",
    "terms",
    "agreement",
    "verificationcodes_bot",
    "yachat_channel",
}


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "private, no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def ensure_group_profile_schema(cursor) -> None:
    cursor.execute("alter table yachat_chats add column if not exists username text default ''")
    cursor.execute(
        """
        create unique index if not exists yachat_chats_username_idx
        on yachat_chats(lower(username))
        where username is not null and username <> ''
        """
    )


def profile_payload(chat: dict[str, Any]) -> dict[str, Any]:
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
            return profile_payload(chat)


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
            return profile_payload(dict(row))


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
    if username in RESERVED_USERNAMES:
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
            return profile_payload(dict(updated))
