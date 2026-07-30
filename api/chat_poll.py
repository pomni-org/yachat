from __future__ import annotations

import json
from contextlib import nullcontext
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from server.e2ee import attach_e2ee_payload
from server.message_preview import message_preview_text

from api.index import (
    DELETED_ACCOUNT_NOTICE,
    DELETED_ACCOUNT_SUBTITLE,
    DELETED_ACCOUNT_TITLE,
    configured_cors_origins,
    connect_db,
    ensure_schema,
    hash_secret,
    message_payload,
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


_LATEST_FIELDS = (
    "id",
    "chat_id",
    "sender_id",
    "text",
    "formatted_html",
    "attachments",
    "reply_to_message_id",
    "forwarded_from",
    "e2ee_mode",
    "e2ee_version",
    "e2ee_ciphertext",
    "e2ee_iv",
    "e2ee_aad",
    "e2ee_envelopes",
    "e2ee_sender_device_id",
    "e2ee_plaintext_digest",
    "e2ee_epoch_id",
    "e2ee_padding_scheme",
    "e2ee_envelope_digest",
    "e2ee_sender_sign_public",
    "e2ee_signature",
    "created_at",
    "edited_at",
)


def _latest_message_row(chat: dict[str, Any]) -> dict[str, Any]:
    return {
        field: row_value(chat, f"latest_{field}")
        for field in _LATEST_FIELDS
    }


def system_rows(cursor, user_id: str) -> list[dict[str, Any]]:
    cursor.execute(
        """
        select distinct on (chat_id) chat_id, text, attachments, created_at
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
            "lastMessage": message_preview_text(
                row_value(latest.get("yachat-codes"), "text"),
                row_value(latest.get("yachat-codes"), "attachments"),
            ),
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
            "lastMessage": message_preview_text(
                row_value(latest.get("yachat-channel"), "text"),
                row_value(latest.get("yachat-channel"), "attachments"),
            ),
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
                    latest.id as latest_id,
                    latest.chat_id as latest_chat_id,
                    latest.sender_id as latest_sender_id,
                    latest.text as latest_text,
                    latest.formatted_html as latest_formatted_html,
                    latest.attachments as latest_attachments,
                    latest.reply_to_message_id as latest_reply_to_message_id,
                    latest.forwarded_from as latest_forwarded_from,
                    latest.e2ee_mode as latest_e2ee_mode,
                    latest.e2ee_version as latest_e2ee_version,
                    latest.e2ee_ciphertext as latest_e2ee_ciphertext,
                    latest.e2ee_iv as latest_e2ee_iv,
                    latest.e2ee_aad as latest_e2ee_aad,
                    latest.e2ee_envelopes as latest_e2ee_envelopes,
                    latest.e2ee_sender_device_id as latest_e2ee_sender_device_id,
                    latest.e2ee_plaintext_digest as latest_e2ee_plaintext_digest,
                    latest.e2ee_epoch_id as latest_e2ee_epoch_id,
                    latest.e2ee_padding_scheme as latest_e2ee_padding_scheme,
                    latest.e2ee_envelope_digest as latest_e2ee_envelope_digest,
                    latest.e2ee_sender_sign_public as latest_e2ee_sender_sign_public,
                    latest.e2ee_signature as latest_e2ee_signature,
                    latest.created_at as latest_created_at,
                    latest.edited_at as latest_edited_at,
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
                            'display_name', u.display_name,
                            'deleted_at', u.deleted_at
                        )
                        order by cm.joined_at asc
                    ) as members
                    from yachat_chat_members cm
                    join public_users u on u.id = cm.user_id
                    where cm.chat_id = c.id
                ) member_rollup on true
                left join lateral (
                    select
                        m.id,
                        m.chat_id,
                        m.sender_id,
                        m.text,
                        m.formatted_html,
                        coalesce((
                            select jsonb_agg(
                                jsonb_build_object(
                                    'id', attachment.item ->> 'id',
                                    'kind', attachment.item ->> 'kind',
                                    'name', attachment.item ->> 'name',
                                    'mime', attachment.item ->> 'mime',
                                    'size', coalesce(attachment.item ->> 'size', '0')
                                )
                                order by attachment.ordinality
                            )
                            from jsonb_array_elements(
                                coalesce(m.attachments, '[]'::jsonb)
                            ) with ordinality as attachment(item, ordinality)
                        ), '[]'::jsonb) as attachments,
                        m.reply_to_message_id,
                        m.forwarded_from,
                        m.e2ee_mode,
                        m.e2ee_version,
                        m.e2ee_ciphertext,
                        m.e2ee_iv,
                        m.e2ee_aad,
                        m.e2ee_envelopes,
                        m.e2ee_sender_device_id,
                        m.e2ee_plaintext_digest,
                        m.e2ee_epoch_id,
                        m.e2ee_padding_scheme,
                        m.e2ee_envelope_digest,
                        m.e2ee_sender_sign_public,
                        m.e2ee_signature,
                        m.created_at,
                        m.edited_at
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
        latest = _latest_message_row(chat)
        members = _json_list(chat.get("members"))
        participant_ids = [str(row_value(member, "id")) for member in members]
        title = str(row_value(chat, "title"))
        subtitle = ""
        profiles: dict[str, dict[str, Any]] = {}
        deleted_account = False

        if kind == "private":
            peer = next(
                (member for member in members if str(row_value(member, "id")) != user_id),
                members[0] if members else {},
            )
            peer_id = str(row_value(peer, "id"))
            username = str(row_value(peer, "username"))
            deleted_account = bool(row_value(peer, "deleted_at"))
            title = (
                DELETED_ACCOUNT_TITLE
                if deleted_account
                else str(row_value(peer, "display_name", "preview_name", "username")) or title
            )
            subtitle = DELETED_ACCOUNT_SUBTITLE if deleted_account else f"@{username}" if username else "Личный чат"
            if peer_id:
                profiles[peer_id] = {
                    "id": peer_id,
                    "username": "" if deleted_account else username,
                    "displayName": title,
                    "previewName": title,
                    "accountDeleted": deleted_account,
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
                and not bool(row_value(chat, "blocked_me"))
                and not deleted_account,
                "blockedByMe": bool(row_value(chat, "blocked_by_me")),
                "blockedMe": bool(row_value(chat, "blocked_me")),
                "deletedAccount": deleted_account,
                "safetyNotice": DELETED_ACCOUNT_NOTICE if deleted_account else "",
                "createdAt": row_value(chat, "created_at"),
                "lastAt": row_value(chat, "latest_created_at", "updated_at", "created_at"),
                "lastMessage": (
                    DELETED_ACCOUNT_NOTICE
                    if deleted_account
                    else ""
                    if str(row_value(latest, "e2ee_mode")) == "encrypted"
                    else message_preview_text(
                        row_value(latest, "text"),
                        row_value(latest, "attachments"),
                    )
                ),
                "lastMessageData": (
                    None
                    if deleted_account
                    or str(row_value(latest, "e2ee_mode")) != "encrypted"
                    else attach_e2ee_payload(
                        message_payload(latest, user_id),
                        latest,
                    )
                ),
                "unread": 0 if deleted_account else int(row_value(chat, "unread_count") or 0),
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
