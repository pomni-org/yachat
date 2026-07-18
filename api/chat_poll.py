from __future__ import annotations

from collections import defaultdict
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    configured_cors_origins,
    connect_db,
    ensure_schema,
    require_user,
    row_value,
    system_chat_settings,
)

app = FastAPI(title="YaChat chat polling API", version="1.0.0")
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


def poll_chats(user_id: str) -> list[dict[str, Any]]:
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                select
                    c.id, c.kind, c.title, c.owner_id, c.locked,
                    c.pinned, c.can_send, c.created_at, c.updated_at
                from yachat_chats c
                join yachat_chat_members own on own.chat_id = c.id
                where own.user_id = %s and c.kind <> 'saved'
                order by c.pinned desc, c.updated_at desc, c.created_at desc
                """,
                (user_id,),
            )
            chats = [dict(row) for row in cursor.fetchall()]
            systems = system_rows(cursor, user_id)
            if not chats:
                return systems

            chat_ids = [str(chat["id"]) for chat in chats]
            members: dict[str, list[dict[str, Any]]] = defaultdict(list)
            cursor.execute(
                """
                select
                    cm.chat_id,
                    u.id,
                    u.username,
                    u.preview_name,
                    u.display_name
                from yachat_chat_members cm
                join public_users u on u.id = cm.user_id
                where cm.chat_id = any(%s)
                order by cm.chat_id, cm.joined_at asc
                """,
                (chat_ids,),
            )
            for row in cursor.fetchall():
                members[str(row["chat_id"])].append(dict(row))

            latest: dict[str, dict[str, Any]] = {}
            cursor.execute(
                """
                select distinct on (m.chat_id)
                    m.chat_id,
                    m.text,
                    m.created_at,
                    coalesce(m.attachments -> 0 ->> 'kind', '') as attachment_kind
                from yachat_messages m
                where m.chat_id = any(%s)
                  and m.deleted_at is null
                  and not exists (
                      select 1 from yachat_message_hidden h
                      where h.message_id = m.id and h.user_id = %s
                  )
                order by m.chat_id, m.created_at desc
                """,
                (chat_ids, user_id),
            )
            for row in cursor.fetchall():
                latest[str(row["chat_id"])] = dict(row)

            unread: dict[str, int] = {}
            cursor.execute(
                """
                select m.chat_id, count(*) as count
                from yachat_messages m
                join yachat_chat_members cm
                  on cm.chat_id = m.chat_id and cm.user_id = %s
                where m.chat_id = any(%s)
                  and m.deleted_at is null
                  and not exists (
                      select 1 from yachat_message_hidden h
                      where h.message_id = m.id and h.user_id = %s
                  )
                  and coalesce(m.sender_id, '') <> %s
                  and m.created_at > coalesce(
                      cm.last_read_at,
                      '1970-01-01T00:00:00Z'::timestamptz
                  )
                group by m.chat_id
                """,
                (user_id, chat_ids, user_id, user_id),
            )
            for row in cursor.fetchall():
                unread[str(row["chat_id"])] = int(row["count"])

            cursor.execute(
                """
                select blocker_id, blocked_id
                from yachat_user_blocks
                where blocker_id = %s or blocked_id = %s
                """,
                (user_id, user_id),
            )
            blocks = [dict(row) for row in cursor.fetchall()]
            blocked_by_me = {
                str(row["blocked_id"])
                for row in blocks
                if str(row["blocker_id"]) == user_id
            }
            blocking_me = {
                str(row["blocker_id"])
                for row in blocks
                if str(row["blocked_id"]) == user_id
            }

            rows: list[dict[str, Any]] = []
            for chat in chats:
                chat_id = str(chat["id"])
                kind = str(chat["kind"])
                chat_members = members.get(chat_id, [])
                participant_ids = [str(row["id"]) for row in chat_members]
                title = str(row_value(chat, "title"))
                subtitle = ""
                profiles: dict[str, dict[str, Any]] = {}
                blocked_by_user = False
                blocked_user_me = False

                if kind == "private":
                    peer = next(
                        (row for row in chat_members if str(row["id"]) != user_id),
                        chat_members[0] if chat_members else {},
                    )
                    peer_id = str(row_value(peer, "id"))
                    username = str(row_value(peer, "username"))
                    title = str(row_value(peer, "display_name", "preview_name", "username")) or title
                    subtitle = f"@{username}" if username else "Личный чат"
                    blocked_by_user = peer_id in blocked_by_me
                    blocked_user_me = peer_id in blocking_me
                    if peer_id:
                        profiles[peer_id] = {
                            "id": peer_id,
                            "username": username,
                            "displayName": title,
                            "previewName": title,
                        }
                elif kind == "group":
                    subtitle = f"{max(len(chat_members), 1)} участников"

                last = latest.get(chat_id) or {}
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
                        and not blocked_by_user
                        and not blocked_user_me,
                        "blockedByMe": blocked_by_user,
                        "blockedMe": blocked_user_me,
                        "createdAt": row_value(chat, "created_at"),
                        "lastAt": row_value(last, "created_at") or row_value(chat, "updated_at") or row_value(chat, "created_at"),
                        "lastMessage": str(row_value(last, "text"))
                        or attachment_label(str(row_value(last, "attachment_kind"))),
                        "unread": unread.get(chat_id, 0),
                    }
                )

    return [*systems, *rows]


@app.get("/api/chats/poll")
def chats_poll(request: Request):
    user = require_user(request)
    return poll_chats(str(user["id"]))
