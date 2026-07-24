from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    clean_chat_id,
    configured_cors_origins,
    connect_db,
    ensure_schema,
    fetch_user_by_username,
    hash_secret,
    normalize_username,
    public_account,
    request_token,
    settings_from_row,
)
from api.messenger_fast import list_user_chats_fast


app = FastAPI(title="YaChat quick bootstrap API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "private, no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def _session_user(cursor, request: Request) -> dict[str, Any] | None:
    token = request_token(request)
    if not token:
        return None

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
    return dict(row) if row else None


def _default_settings() -> dict[str, str]:
    return {
        "language": "ru",
        "theme": "dark",
        "themeSource": "system",
        "country": "RU",
        "countryCode": "+7",
    }


@app.get("/api/bootstrap_quick")
def bootstrap_quick(request: Request, chatId: str = "", username: str = ""):
    """Validate the session and return the chat shell without blocking on messages.

    The active chat messages are deliberately fetched by the browser immediately after
    the shell is painted. This keeps account validation server-side while removing the
    second database query from the critical rendering path.
    """

    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            user = _session_user(cursor, request)
            if user:
                cursor.execute(
                    "select * from yachat_user_settings where user_id = %s limit 1",
                    (user["id"],),
                )
                settings_row = cursor.fetchone()
                settings = settings_from_row(dict(settings_row) if settings_row else None)
            else:
                settings = _default_settings()

        result: dict[str, Any] = {
            "authenticated": bool(user),
            "account": public_account(user) if user else None,
            "settings": settings,
            "chats": [],
            "messages": [],
            "activeChatId": None,
            "routeUser": None,
            "optimized": True,
            "deferredMessages": True,
        }

        normalized_route = normalize_username(username)
        route_user = fetch_user_by_username(normalized_route) if normalized_route else None
        result["routeUser"] = route_user

        if not user:
            return result

        user_id = str(user["id"])
        chats = list_user_chats_fast(user_id, connection=connection)
        chat_ids = {str(chat.get("id") or "") for chat in chats}
        active_chat_id = clean_chat_id(chatId, allow_empty=True)

        if route_user:
            route_user_id = str(route_user.get("id") or "")
            route_chat = next(
                (
                    chat
                    for chat in chats
                    if chat.get("kind") == "private"
                    and route_user_id in {str(item) for item in chat.get("participantIds", [])}
                ),
                None,
            )
            if route_chat:
                active_chat_id = str(route_chat.get("id") or "")

        if active_chat_id not in chat_ids:
            active_chat_id = str(chats[0].get("id") or "") if chats else ""

        result.update({
            "chats": chats,
            "activeChatId": active_chat_id or None,
        })
        return result
