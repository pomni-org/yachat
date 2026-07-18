import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    chat_summary,
    clean_text,
    configured_cors_origins,
    connect_db,
    deterministic_private_chat_id,
    get_chat_messages,
    list_user_chats,
    read_json_payload,
    require_user,
)

app = FastAPI(title="YaChat chat creation API", version="0.4.0")
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


def participant_ids(payload: dict[str, Any], current_user_id: str) -> list[str]:
    raw = payload.get("participantIds")
    values = raw if isinstance(raw, list) else []
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        user_id = str(value or "").strip()
        if not user_id or user_id == current_user_id or user_id in seen:
            continue
        seen.add(user_id)
        result.append(user_id)
    return result


@app.post("/api/chat")
async def create_chat(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    current_user_id = str(user["id"])
    kind = "group" if payload.get("kind") == "group" else "private"
    selected_ids = participant_ids(payload, current_user_id)
    title = clean_text(payload.get("title"), 60)

    if kind == "private" and len(selected_ids) != 1:
        raise HTTPException(status_code=400, detail="Choose one person.")
    if kind == "group" and not title:
        raise HTTPException(status_code=400, detail="Enter a group name.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if selected_ids:
                cursor.execute("select id from public_users where id = any(%s)", (selected_ids,))
                found_ids = {str(row["id"]) for row in cursor.fetchall()}
                selected_ids = [user_id for user_id in selected_ids if user_id in found_ids]

            if kind == "private" and len(selected_ids) != 1:
                raise HTTPException(status_code=404, detail="User not found.")

            if kind == "private":
                chat_id = deterministic_private_chat_id(current_user_id, selected_ids[0])
                cursor.execute(
                    """
                    insert into yachat_chats(id, kind, title, owner_id, created_at, updated_at)
                    values (%s, 'private', '', %s, now(), now())
                    on conflict (id) do update set updated_at = yachat_chats.updated_at
                    returning *
                    """,
                    (chat_id, current_user_id),
                )
            else:
                chat_id = f"group-{uuid.uuid4()}"
                cursor.execute(
                    """
                    insert into yachat_chats(id, kind, title, description, avatar_url, owner_id, created_at, updated_at)
                    values (%s, 'group', %s, '', %s, %s, now(), now())
                    returning *
                    """,
                    (
                        chat_id,
                        title,
                        clean_text(payload.get("avatarDataUrl"), 3500000),
                        current_user_id,
                    ),
                )

            chat = dict(cursor.fetchone())
            for member_id in [current_user_id, *selected_ids]:
                cursor.execute(
                    """
                    insert into yachat_chat_members(chat_id, user_id, role)
                    values (%s, %s, %s)
                    on conflict (chat_id, user_id) do nothing
                    """,
                    (chat_id, member_id, "owner" if member_id == current_user_id else "member"),
                )

            return {
                "chat": chat_summary(cursor, chat, current_user_id),
                "chats": list_user_chats(current_user_id),
                "messages": get_chat_messages(chat_id, current_user_id),
            }
