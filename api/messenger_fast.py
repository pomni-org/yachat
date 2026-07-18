from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    clean_chat_id,
    configured_cors_origins,
    connect_db,
    current_user,
    ensure_saved_chat,
    ensure_schema,
    fetch_user_by_username,
    get_user_settings,
    message_payload,
    normalize_username,
    public_account,
    read_json_payload,
    require_chat_member,
    require_user,
    row_value,
    system_chat_messages,
    system_chat_settings,
    system_chats,
    system_message_payload,
    system_owner_profile,
    verification_fields,
)

app = FastAPI(title="YaChat lightweight messenger API", version="1.0.0")
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


def _attachment_label(kind: str) -> str:
    if kind == "image":
        return "Фото"
    if kind == "video":
        return "Видео"
    if kind:
        return "Файл"
    return ""


def _compact_profile(row: dict[str, Any], include_avatar: bool) -> dict[str, Any]:
    profile = {
        "id": str(row_value(row, "id")),
        "username": str(row_value(row, "username")),
        "displayName": str(row_value(row, "display_name", "preview_name", "username")),
        "previewName": str(row_value(row, "preview_name", "display_name", "username")),
        "avatarAccent": str(row_value(row, "avatar_accent")) or "#471AFF",
        **verification_fields(row),
    }
    if include_avatar:
        profile["avatarDataUrl"] = str(row_value(row, "avatar_url"))
    return profile


def _latest_system_messages(cursor, user_id: str) -> dict[str, dict[str, Any]]:
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
    return {str(row["chat_id"]): dict(row) for row in cursor.fetchall()}


def list_user_chats_fast(user_id: str) -> list[dict[str, Any]]:
    """Return only data required to paint the chat list and basic headers.

    Group participant avatars are deliberately omitted. Previously every chat-list
    refresh repeated every member's base64 avatar, which made small lists weigh
    megabytes. Full message data is fetched separately only for the open chat.
    """

    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                select
                    c.id, c.kind, c.title, c.description, c.avatar_url,
                    c.avatar_accent, c.owner_id, c.locked, c.verified,
                    c.pinned, c.can_send, c.invite_code, c.created_at, c.updated_at
                from yachat_chats c
                join yachat_chat_members cm on cm.chat_id = c.id
                where cm.user_id = %s
                  and c.kind <> 'saved'
                order by c.pinned desc, c.updated_at desc, c.created_at desc
                """,
                (user_id,),
            )
            chat_rows = [dict(row) for row in cursor.fetchall()]
            latest_system = _latest_system_messages(cursor, user_id)
            owner_profile = system_owner_profile(cursor)
            channel_settings = system_chat_settings(cursor, "yachat-channel")

            system = system_chats(
                latest_messages=latest_system,
                owner_profile=owner_profile,
                channel_settings=channel_settings,
            )
            if not chat_rows:
                return system

            chat_ids = [str(row["id"]) for row in chat_rows]
            chat_kind = {str(row["id"]): str(row["kind"]) for row in chat_rows}
            members_by_chat: dict[str, list[dict[str, Any]]] = defaultdict(list)
            cursor.execute(
                """
                select
                    cm.chat_id as member_chat_id,
                    u.id, u.username, u.preview_name, u.display_name,
                    u.bio, u.avatar_url, u.avatar_accent, u.public_key_type
                from yachat_chat_members cm
                join public_users u on u.id = cm.user_id
                where cm.chat_id = any(%s)
                order by cm.chat_id, cm.joined_at asc
                """,
                (chat_ids,),
            )
            for row in cursor.fetchall():
                member = dict(row)
                members_by_chat[str(member.pop("member_chat_id"))].append(member)

            latest_by_chat: dict[str, dict[str, Any]] = {}
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
                      select 1
                      from yachat_message_hidden h
                      where h.message_id = m.id and h.user_id = %s
                  )
                order by m.chat_id, m.created_at desc
                """,
                (chat_ids, user_id),
            )
            for row in cursor.fetchall():
                latest_by_chat[str(row["chat_id"])] = dict(row)

            unread_by_chat: dict[str, int] = {}
            cursor.execute(
                """
                select m.chat_id, count(*) as count
                from yachat_messages m
                join yachat_chat_members cm
                  on cm.chat_id = m.chat_id and cm.user_id = %s
                where m.chat_id = any(%s)
                  and m.deleted_at is null
                  and not exists (
                      select 1
                      from yachat_message_hidden h
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
                unread_by_chat[str(row["chat_id"])] = int(row["count"])

            cursor.execute(
                """
                select blocker_id, blocked_id
                from yachat_user_blocks
                where blocker_id = %s or blocked_id = %s
                """,
                (user_id, user_id),
            )
            block_rows = [dict(row) for row in cursor.fetchall()]
            blocked_by_user_ids = {
                str(row["blocked_id"])
                for row in block_rows
                if str(row["blocker_id"]) == user_id
            }
            blocking_user_ids = {
                str(row["blocker_id"])
                for row in block_rows
                if str(row["blocked_id"]) == user_id
            }

            summaries: list[dict[str, Any]] = []
            for chat in chat_rows:
                chat_id = str(chat["id"])
                kind = chat_kind[chat_id]
                members = members_by_chat.get(chat_id, [])
                other = next(
                    (row for row in members if str(row_value(row, "id")) != user_id),
                    members[0] if members else {},
                )
                last = latest_by_chat.get(chat_id) or {}
                title = str(row_value(chat, "title"))
                subtitle = ""
                avatar = str(row_value(chat, "avatar_url"))
                profile_username = ""
                profile_url = ""
                profile_about = str(row_value(chat, "description"))
                profile_kind_label = "Группа" if kind == "group" else ""
                verified = bool(row_value(chat, "verified"))
                verified_meta: dict[str, Any] = {}
                blocked_by_me = False
                blocked_me = False

                profiles: dict[str, dict[str, Any]] = {}
                if kind == "private" and other:
                    peer_id = str(row_value(other, "id"))
                    blocked_by_me = peer_id in blocked_by_user_ids
                    blocked_me = peer_id in blocking_user_ids
                    title = str(row_value(other, "display_name", "preview_name", "username"))
                    username = str(row_value(other, "username"))
                    subtitle = f"@{username}" if username else "Личный чат"
                    avatar = str(row_value(other, "avatar_url")) or avatar
                    profile_username = username
                    profile_url = f"https://yachat.vercel.app/{username}" if username else ""
                    profile_about = str(row_value(other, "bio"))
                    profile_kind_label = ""
                    verified_meta = verification_fields(other)
                    verified = bool(verified_meta.get("verified"))
                    profiles[peer_id] = _compact_profile(other, include_avatar=True)
                elif kind == "group":
                    subtitle = f"{max(len(members), 1)} участников"
                    profiles = {
                        str(row_value(member, "id")): _compact_profile(member, include_avatar=False)
                        for member in members
                    }

                summaries.append(
                    {
                        "id": chat_id,
                        "kind": kind,
                        "title": title or "ЯЧат",
                        "subtitle": subtitle,
                        "description": str(row_value(chat, "description")),
                        "participantIds": [str(row_value(member, "id")) for member in members],
                        "participantProfiles": profiles,
                        "ownerId": str(row_value(chat, "owner_id")),
                        "locked": bool(row_value(chat, "locked")),
                        "verified": verified,
                        "verifiedTitle": str(verified_meta.get("verifiedTitle") or ""),
                        "verifiedDescription": str(verified_meta.get("verifiedDescription") or ""),
                        "roleLabel": str(verified_meta.get("roleLabel") or ""),
                        "pinned": bool(row_value(chat, "pinned")),
                        "canSend": bool(row_value(chat, "can_send") if "can_send" in chat else True)
                        and not blocked_by_me
                        and not blocked_me,
                        "blockedByMe": blocked_by_me,
                        "blockedMe": blocked_me,
                        "avatar": kind,
                        "avatarDataUrl": avatar,
                        "avatarAccent": str(row_value(chat, "avatar_accent")) or "#471AFF",
                        "profileUsername": profile_username,
                        "profileUrl": profile_url,
                        "profileAbout": profile_about,
                        "profileKindLabel": profile_kind_label,
                        "inviteCode": str(row_value(chat, "invite_code")),
                        "createdAt": row_value(chat, "created_at"),
                        "lastAt": row_value(last, "created_at") or row_value(chat, "updated_at") or row_value(chat, "created_at"),
                        "lastMessage": str(row_value(last, "text"))
                        or _attachment_label(str(row_value(last, "attachment_kind"))),
                        "unread": unread_by_chat.get(chat_id, 0),
                    }
                )

    return [*system, *summaries]


def _parse_after(value: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid message cursor.") from error
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def get_messages_fast(chat_id: str, user_id: str, limit: int = 80, after: str = "") -> list[dict[str, Any]]:
    requested_chat_id = clean_chat_id(chat_id)
    cursor_after = _parse_after(after)
    safe_limit = max(1, min(int(limit or 80), 150))

    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if requested_chat_id.startswith("yachat-") and requested_chat_id != "yachat-favorites":
                parameters: list[Any] = [user_id, requested_chat_id]
                after_clause = ""
                if cursor_after:
                    after_clause = "and created_at > %s"
                    parameters.append(cursor_after)
                parameters.append(safe_limit)
                cursor.execute(
                    f"""
                    select *
                    from yachat_system_messages
                    where user_id = %s
                      and chat_id = %s
                      and (chat_id <> 'yachat-channel' or system_kind = 'channel-post')
                      {after_clause}
                    order by created_at {'asc' if cursor_after else 'desc'}
                    limit %s
                    """,
                    tuple(parameters),
                )
                rows = [dict(row) for row in cursor.fetchall()]
                if not cursor_after:
                    rows.reverse()
                return [
                    *system_chat_messages(requested_chat_id),
                    *[system_message_payload(row, user_id) for row in rows],
                ]

            actual_chat_id = requested_chat_id
            if requested_chat_id == "yachat-favorites":
                actual_chat_id = ensure_saved_chat(cursor, user_id)
            else:
                require_chat_member(cursor, actual_chat_id, user_id)

            parameters = [actual_chat_id, user_id]
            after_clause = ""
            if cursor_after:
                after_clause = "and m.created_at > %s"
                parameters.append(cursor_after)
            parameters.append(safe_limit)
            cursor.execute(
                f"""
                select m.*
                from yachat_messages m
                where m.chat_id = %s
                  and m.deleted_at is null
                  and not exists (
                      select 1
                      from yachat_message_hidden h
                      where h.message_id = m.id and h.user_id = %s
                  )
                  {after_clause}
                order by m.created_at {'asc' if cursor_after else 'desc'}
                limit %s
                """,
                tuple(parameters),
            )
            rows = [dict(row) for row in cursor.fetchall()]
            if not cursor_after:
                rows.reverse()

            cursor.execute(
                """
                select last_read_at
                from yachat_chat_members
                where chat_id = %s and user_id <> %s
                """,
                (actual_chat_id, user_id),
            )
            recipient_read_times = [row["last_read_at"] for row in cursor.fetchall()]
            return [message_payload(row, user_id, recipient_read_times) for row in rows]


def _snapshot(user_id: str, chat_id: str = "", username: str = "", message_limit: int = 60) -> dict[str, Any]:
    chats = list_user_chats_fast(user_id)
    chat_ids = {str(chat["id"]) for chat in chats}
    active_chat_id = clean_chat_id(chat_id, allow_empty=True)
    route_user = fetch_user_by_username(username) if normalize_username(username) else None

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
            active_chat_id = str(route_chat["id"])

    if active_chat_id not in chat_ids:
        active_chat_id = str(chats[0]["id"]) if chats else ""

    return {
        "chats": chats,
        "activeChatId": active_chat_id or None,
        "messages": get_messages_fast(active_chat_id, user_id, message_limit) if active_chat_id else [],
        "routeUser": route_user,
        "optimized": True,
    }


@app.get("/api/bootstrap")
def bootstrap(request: Request, chatId: str = "", username: str = ""):
    user = current_user(request)
    settings = get_user_settings(str(user["id"])) if user else {
        "language": "ru",
        "theme": "dark",
        "themeSource": "system",
        "country": "RU",
        "countryCode": "+7",
    }
    result: dict[str, Any] = {
        "authenticated": bool(user),
        "account": public_account(user) if user else None,
        "settings": settings,
        "chats": [],
        "messages": [],
        "activeChatId": None,
        "routeUser": None,
        "optimized": True,
    }
    if user:
        result.update(_snapshot(str(user["id"]), chatId, username, message_limit=40))
    elif normalize_username(username):
        result["routeUser"] = fetch_user_by_username(username)
    return result


@app.get("/api/messenger")
def messenger(request: Request, chatId: str = "", username: str = ""):
    user = require_user(request)
    return _snapshot(str(user["id"]), chatId, username, message_limit=60)


@app.get("/api/chats")
def chats(request: Request):
    user = require_user(request)
    return list_user_chats_fast(str(user["id"]))


@app.get("/api/messages")
def messages(
    request: Request,
    chatId: str = "",
    limit: int = Query(default=80, ge=1, le=150),
    after: str = "",
):
    user = require_user(request)
    return get_messages_fast(chatId, str(user["id"]), limit=limit, after=after)


@app.post("/api/chat/mark-read")
async def mark_read(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    if not chat_id.startswith("yachat-"):
        with connect_db() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    update yachat_chat_members
                    set last_read_at = now()
                    where chat_id = %s and user_id = %s
                    """,
                    (chat_id, user["id"]),
                )
    return {"ok": True, "chatId": chat_id, "readAt": datetime.now(timezone.utc)}
