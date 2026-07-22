from __future__ import annotations

import json
from contextlib import nullcontext
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    configured_cors_origins,
    connect_db,
    ensure_schema,
    hash_secret,
    request_token,
    row_value,
    system_chat_settings,
)

app = FastAPI(title="YaChat chat polling API", version="1.1.0")
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
    return response


def attachment_label(kind: str) -> str:
    if kind == "image":
        return "Фото"
    if kind == "video":
        return "Видео"
    return "Файл" if kind else ""


def system_rows(cursor, user_id: str) -> list[dict[str, Any]]:
    cursor.execute(
        """
        select distinct on (chat_id) chat_id, text, created_at
        from yachat_system_messages
        where user_id = %s
          and (chat_id <> 'yachat-channel' or system_kind = 'channel-post')
        order by chat_id, created_at desc
        """,
        (user_id,),
    )
    latest = {str(row["chat_id"]): dict(row) for row in cursor.fetchall()}
    channel_settings = system_chat_settings(cursor, "yachat-channel")
    channel_title = str(row_value(channel_settings, "title")) or "ЯЧат"
    return [
        {
            "id": "yachat-favorites",
            "kind": "saved",
            "title": "Избранное",
            "subtitle": "Сообщения для себя",
            "pinned": True,
            "canSend": True,
            "lastAt": None,
            "lastMessage": "",
            "unread": 0,
        },
        {
            "id": "yachat-codes",
            "kind": "bot",
            "title": "Коды подтверждения",
            "subtitle": "Ваши одноразовые коды",
            "pinned": True,
            "canSend": False,
            "lastAt": row_value(latest.get("yachat-codes"), "created_at"),
            "lastMessage": str(row_value(latest.get("yachat-codes"), "text")),
            "unread": 0,
        },
        {
            "id": "yachat-channel",
            "kind": "channel",
            "title": channel_title,
            "subtitle": "Системный канал",
            "pinned": True,
            "canSend": False,
            "lastAt": row_value(latest.get("yachat-channel"), "created_at"),
            "lastMessage": str(row_value(latest.get("yachat-channel"), "text")),
            "unread": 0,
        },
    ]


def _json_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [dict(item) for item in value if isinstance(item, dict)]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return [dict(item) for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []
    return []


def poll_chats(user_id: str, connection=None) -> list[dict[str, Any]]:
    """Return compact chat rows using one database round-trip for user chats.

    System chat metadata remains a tiny independent query. Regular chat members,
    preview, unread count, and block state are aggregated by PostgreSQL together.
    """

    ensure_schema()
    with (connect_db() if connection is None else nullcontext(connection)) as active_connection:
        with active_connection.cursor(row_factory=dict_row) as cursor:
            systems = system_rows(cursor, user_id)
            cursor.execute(
                """
                select
                    c.id,
                    c.kind,
                    c.title,
                    c.owner_id,
                    c.locked,
                    c.pinned,
                    c.can_send,
                    c.created_at,
                    c.updated_at,
                    coalesce(member_rollup.members, '[]'::jsonb) as members,
                    latest.text as latest_text,
                    latest.created_at as latest_created_at,
                    latest.attachment_kind,
                    coalesce(unread.unread_count, 0) as unread_count,
                    exists (
                        select 1
                        from yachat_user_blocks b
                        join yachat_chat_members peer
                          on peer.chat_id = c.id
                         and peer.user_id = b.blocked_id
                        where b.blocker_id = %s
                          and peer.user_id <> %s
                    ) as blocked_by_me,
                    exists (
                        select 1
                        from yachat_user_blocks b
                        join yachat_chat_members peer
                          on peer.chat_id = c.id
                         and peer.user_id = b.blocker_id
                        where b.blocked_id = %s
                          and peer.user_id <> %s
                    ) as blocked_me
                from yachat_chats c
                join yachat_chat_members own
                  on own.chat_id = c.id
                 and own.user_id = %s
                left join lateral (
                    select jsonb_agg(
                        jsonb_build_object(
                            'id', u.id,
                            'username', u.username,
                            'preview_name', u.preview_name,
                            'display_name', u.display_name
                        )
                        order by cm.joined_at asc
                    ) as members
                    from yachat_chat_members cm
                    join public_users u on u.id = cm.user_id
                    where cm.chat_id = c.id
                ) member_rollup on true
                left join lateral (
                    select
                        m.text,
                        m.created_at,
                        coalesce(m.attachments -> 0 ->> 'kind', '') as attachment_kind
                    from yachat_messages m
                    where m.chat_id = c.id
                      and m.deleted_at is null
                      and not exists (
                          select 1
                          from yachat_message_hidden h
                          where h.message_id = m.id
                            and h.user_id = %s
                      )
                    order by m.created_at desc
                    limit 1
                ) latest on true
                left join lateral (
                    select count(*)::integer as unread_count
                    from yachat_messages m
                    where m.chat_id = c.id
                      and m.deleted_at is null
                      and coalesce(m.sender_id, '') <> %s
                      and m.created_at > coalesce(
                          own.last_read_at,
                          '1970-01-01T00:00:00Z'::timestamptz
                      )
                      and not exists (
                          select 1
                          from yachat_message_hidden h
                          where h.message_id = m.id
                            and h.user_id = %s
                      )
                ) unread on true
                where c.kind <> 'saved'
                order by c.pinned desc, c.updated_at desc, c.created_at desc
                """,
                (
                    user_id,
                    user_id,
                    user_id,
                    user_id,
                    user_id,
                    user_id,
                    user_id,
                    user_id,
                ),
            )
            chat_rows = [dict(row) for row in cursor.fetchall()]

    rows: list[dict[str, Any]] = []
    for chat in chat_rows:
        chat_id = str(chat["id"])
        kind = str(chat["kind"])
        members = _json_list(chat.get("members"))
        participant_ids = [str(row_value(member, "id")) for member in members]
        title = str(row_value(chat, "title"))
        subtitle = ""
        profiles: dict[str, dict[str, Any]] = {}

        if kind == "private":
            peer = next(
                (member for member in members if str(row_value(member, "id")) != user_id),
                members[0] if members else {},
            )
            peer_id = str(row_value(peer, "id"))
            username = str(row_value(peer, "username"))
            title = str(row_value(peer, "display_name", "preview_name", "username")) or title
            subtitle = f"@{username}" if username else "Личный чат"
            if peer_id:
                profiles[peer_id] = {
                    "id": peer_id,
                    "username": username,
                    "displayName": title,
                    "previewName": title,
                }
        elif kind == "group":
            subtitle = f"{max(len(members), 1)} участников"

        rows.append(
            {
                "id": chat_id,
                "kind": kind,
                "title": title or "ЯЧат",
                "subtitle": subtitle,
                "participantIds": participant_ids,
                "participantProfiles": profiles,
                "ownerId": str(row_value(chat, "owner_id")),
                "locked": bool(row_value(chat, "locked")),
                "pinned": bool(row_value(chat, "pinned")),
                "canSend": bool(row_value(chat, "can_send") if "can_send" in chat else True)
                and not bool(row_value(chat, "blocked_by_me"))
                and not bool(row_value(chat, "blocked_me")),
                "blockedByMe": bool(row_value(chat, "blocked_by_me")),
                "blockedMe": bool(row_value(chat, "blocked_me")),
                "createdAt": row_value(chat, "created_at"),
                "lastAt": row_value(chat, "latest_created_at", "updated_at", "created_at"),
                "lastMessage": str(row_value(chat, "latest_text"))
                or attachment_label(str(row_value(chat, "attachment_kind"))),
                "unread": int(row_value(chat, "unread_count") or 0),
            }
        )

    return [*systems, *rows]


@app.get("/api/chats/poll")
def chats_poll(request: Request):
    token = request_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in first.")
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                select u.id
                from yachat_sessions s
                join public_users u on u.id = s.user_id
                where s.token_hash = %s and s.expires_at > now()
                limit 1
                """,
                (hash_secret(token),),
            )
            user = cursor.fetchone()
            if not user:
                raise HTTPException(status_code=401, detail="Sign in first.")
        return poll_chats(str(user["id"]), connection=connection)
