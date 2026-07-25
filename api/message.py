import asyncio
import json
import uuid
from typing import Any

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    clean_attachments,
    clean_chat_id,
    configured_cors_origins,
    connect_db,
    ensure_saved_chat,
    is_murochko_profile,
    message_payload,
    prepare_rich_message,
    read_json_payload,
    require_chat_member,
    require_chat_messaging_allowed,
    require_user,
    resolve_message_chat_id,
    row_value,
    system_message_payload,
)
from server.e2ee import (
    attach_e2ee_payload,
    e2ee_message_columns,
    normalize_device_id,
    parse_device_registration,
    parse_e2ee_message,
)
from server.push_delivery import send_push_to_user

app = FastAPI(title="YaChat message API", version="1.1.0")
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


def attachment_body(attachments: list[dict[str, Any]]) -> str:
    if not attachments:
        return ""
    kind = str(attachments[0].get("kind") or "")
    if kind == "image":
        return "Фото"
    if kind == "video":
        return "Видео"
    return "Файл"


async def deliver_pushes(deliveries: list[tuple[str, str, str, str, str]]) -> None:
    """Deliver pushes concurrently without extending the message response payload."""
    if not deliveries:
        return
    await asyncio.gather(
        *[
            asyncio.to_thread(
                send_push_to_user,
                user_id,
                title,
                body,
                url,
                tag=tag,
            )
            for user_id, title, body, url, tag in deliveries
        ],
        return_exceptions=True,
    )


def deliver_pushes_background(deliveries: list[tuple[str, str, str, str, str]]) -> None:
    """Run after the HTTP response so Web Push cannot hold the composer hostage."""
    if deliveries:
        asyncio.run(deliver_pushes(deliveries))


def message_ids(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("messageIds") if isinstance(payload.get("messageIds"), list) else [payload.get("messageId")]
    result: list[str] = []
    seen: set[str] = set()
    for value in raw:
        message_id = str(value or "").strip()
        if not message_id or message_id in seen:
            continue
        seen.add(message_id)
        result.append(message_id)
        if len(result) >= 100:
            break
    if not result:
        raise HTTPException(status_code=400, detail="Select a message first.")
    return result


@app.post("/api/e2ee/device/register")
async def register_e2ee_device(request: Request):
    user = require_user(request)
    bundle = parse_device_registration(await read_json_payload(request))
    user_id = str(user["id"])
    device_id = bundle["deviceId"]
    signed = bundle["signedPreKey"]

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                "select user_id from yachat_e2ee_devices where device_id = %s limit 1",
                (device_id,),
            )
            existing = cursor.fetchone()
            if existing and str(existing["user_id"]) != user_id:
                raise HTTPException(status_code=409, detail="This E2EE device id belongs to another account.")

            cursor.execute(
                """
                insert into yachat_e2ee_devices(
                    device_id, user_id, algorithm, identity_dh_public,
                    identity_sign_public, signed_prekey_id, signed_prekey_public,
                    signed_prekey_signature, created_at, updated_at, last_seen_at, revoked_at
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, now(), now(), now(), null)
                on conflict(device_id) do update
                set algorithm = excluded.algorithm,
                    identity_dh_public = excluded.identity_dh_public,
                    identity_sign_public = excluded.identity_sign_public,
                    signed_prekey_id = excluded.signed_prekey_id,
                    signed_prekey_public = excluded.signed_prekey_public,
                    signed_prekey_signature = excluded.signed_prekey_signature,
                    updated_at = now(),
                    last_seen_at = now(),
                    revoked_at = null
                """,
                (
                    device_id,
                    user_id,
                    bundle["algorithm"],
                    bundle["identityDhPublic"],
                    bundle["identitySignPublic"],
                    signed["id"],
                    signed["publicKey"],
                    signed["signature"],
                ),
            )

            for prekey in bundle["oneTimePreKeys"]:
                cursor.execute(
                    """
                    insert into yachat_e2ee_one_time_prekeys(device_id, prekey_id, public_key, created_at)
                    values (%s, %s, %s, now())
                    on conflict(device_id, prekey_id) do update
                    set public_key = case
                        when yachat_e2ee_one_time_prekeys.claimed_at is null then excluded.public_key
                        else yachat_e2ee_one_time_prekeys.public_key
                    end
                    """,
                    (device_id, prekey["id"], prekey["publicKey"]),
                )

            cursor.execute(
                """
                select count(*) as count
                from yachat_e2ee_one_time_prekeys
                where device_id = %s and claimed_at is null
                """,
                (device_id,),
            )
            available = int(cursor.fetchone()["count"])

    return {
        "ok": True,
        "algorithm": bundle["algorithm"],
        "deviceId": device_id,
        "availableOneTimePreKeys": available,
        "needsOneTimePreKeys": available < 12,
        "rolloutPhase": "shadow",
    }


@app.post("/api/e2ee/device/revoke")
async def revoke_e2ee_device(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    device_id = normalize_device_id(payload.get("deviceId"))
    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                update yachat_e2ee_devices
                set revoked_at = now(), updated_at = now()
                where device_id = %s and user_id = %s and revoked_at is null
                """,
                (device_id, str(user["id"])),
            )
            revoked = cursor.rowcount > 0
    return {"ok": True, "deviceId": device_id, "revoked": revoked}


@app.post("/api/e2ee/bundles/claim")
async def claim_e2ee_bundles(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    sender_device_id = normalize_device_id(payload.get("senderDeviceId"))
    user_id = str(user["id"])

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat = require_chat_member(cursor, chat_id, user_id)
            if str(row_value(chat, "kind")) != "private":
                raise HTTPException(status_code=400, detail="E2EE prekey bundles are currently available for private chats only.")

            cursor.execute(
                """
                select 1
                from yachat_e2ee_devices
                where device_id = %s and user_id = %s and revoked_at is null
                limit 1
                """,
                (sender_device_id, user_id),
            )
            if not cursor.fetchone():
                raise HTTPException(status_code=409, detail="Register this E2EE device first.")

            cursor.execute(
                """
                select
                    d.device_id, d.user_id, d.algorithm, d.identity_dh_public,
                    d.identity_sign_public, d.signed_prekey_id,
                    d.signed_prekey_public, d.signed_prekey_signature
                from yachat_e2ee_devices d
                join yachat_chat_members cm on cm.user_id = d.user_id
                where cm.chat_id = %s and d.revoked_at is null
                order by d.user_id, d.created_at
                """,
                (chat_id,),
            )
            devices = [dict(row) for row in cursor.fetchall()]
            bundles: list[dict[str, Any]] = []

            for device in devices:
                device_id = str(device["device_id"])
                prekey = None
                if device_id != sender_device_id:
                    cursor.execute(
                        """
                        select prekey_id, public_key
                        from yachat_e2ee_one_time_prekeys
                        where device_id = %s and claimed_at is null
                        order by created_at, prekey_id
                        for update skip locked
                        limit 1
                        """,
                        (device_id,),
                    )
                    row = cursor.fetchone()
                    if row:
                        prekey = {"id": str(row["prekey_id"]), "publicKey": str(row["public_key"])}
                        cursor.execute(
                            """
                            update yachat_e2ee_one_time_prekeys
                            set claimed_at = now(), claimed_by_user_id = %s, claimed_by_device_id = %s
                            where device_id = %s and prekey_id = %s and claimed_at is null
                            """,
                            (user_id, sender_device_id, device_id, prekey["id"]),
                        )

                bundles.append({
                    "deviceId": device_id,
                    "userId": str(device["user_id"]),
                    "algorithm": str(device["algorithm"]),
                    "identityDhPublic": str(device["identity_dh_public"]),
                    "identitySignPublic": str(device["identity_sign_public"]),
                    "signedPreKey": {
                        "id": str(device["signed_prekey_id"]),
                        "publicKey": str(device["signed_prekey_public"]),
                        "signature": str(device["signed_prekey_signature"]),
                    },
                    "oneTimePreKey": prekey,
                })

    return {
        "ok": True,
        "chatId": chat_id,
        "algorithm": "yachat-x3dh-v1",
        "rolloutPhase": "shadow",
        "bundles": bundles,
    }


@app.post("/api/message")
async def send_message(request: Request, background_tasks: BackgroundTasks):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    formatted_html, text = prepare_rich_message(payload)
    attachments = clean_attachments(payload.get("attachments"))
    if not text and not attachments:
        raise HTTPException(status_code=400, detail="Enter a message.")

    user_id = str(user["id"])
    is_saved_chat = chat_id == "yachat-favorites"
    is_channel_post = chat_id == "yachat-channel"
    body = text or attachment_body(attachments) or "Новое сообщение"

    if is_channel_post:
        if not is_murochko_profile(user):
            raise HTTPException(status_code=403, detail="Only Murochko can post to the YaChat channel.")

        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute("select id from public_users")
                user_ids = [str(row["id"]) for row in cursor.fetchall()] or [user_id]
                sender_message_id = str(uuid.uuid4())
                rows = [
                    (
                        sender_message_id if target_user_id == user_id else str(uuid.uuid4()),
                        target_user_id,
                        user["id"],
                        text,
                        formatted_html,
                        json.dumps(attachments[:8]),
                    )
                    for target_user_id in user_ids
                ]
                cursor.executemany(
                    """
                    insert into yachat_system_messages(
                        id, user_id, chat_id, author_id, text, formatted_html,
                        attachments, system_kind, created_at
                    )
                    values (%s, %s, 'yachat-channel', %s, %s, %s, %s::jsonb, 'channel-post', now())
                    """,
                    rows,
                )
                cursor.execute(
                    "select * from yachat_system_messages where id = %s and user_id = %s",
                    (sender_message_id, user_id),
                )
                sender_row = cursor.fetchone()

        deliveries = [
            (
                target_user_id,
                "ЯЧат • Анонсы",
                body[:240],
                "/yachat_channel",
                f"channel-message:{sender_message_id}:{target_user_id}",
            )
            for target_user_id in user_ids
            if target_user_id != user_id
        ]
        background_tasks.add_task(deliver_pushes_background, deliveries)
        return {
            "ok": True,
            "message": system_message_payload(dict(sender_row), user_id) if sender_row else None,
            "inserted": True,
            "pushQueued": len(deliveries),
        }

    if chat_id.startswith("yachat-") and not is_saved_chat:
        raise HTTPException(status_code=400, detail="System chats are local only.")

    client_message_id = str(payload.get("clientMessageId") or "").strip()
    try:
        message_id = str(uuid.UUID(client_message_id)) if client_message_id else str(uuid.uuid4())
    except (ValueError, AttributeError, TypeError):
        message_id = str(uuid.uuid4())

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if is_saved_chat:
                chat_id = ensure_saved_chat(cursor, user_id)
            chat = require_chat_member(cursor, chat_id, user_id)
            if not bool(row_value(chat, "can_send") if "can_send" in chat else True):
                raise HTTPException(status_code=403, detail="This chat is read-only.")
            require_chat_messaging_allowed(cursor, chat, user_id)

            encrypted = parse_e2ee_message(payload.get("e2ee"), chat_id=chat_id, message_id=message_id)
            if encrypted["mode"] == "encrypted":
                raise HTTPException(
                    status_code=409,
                    detail="Server-blind E2EE is not enabled for this chat yet. Update every device first.",
                )
            if encrypted["mode"] == "shadow" and str(row_value(chat, "kind")) != "private":
                raise HTTPException(status_code=400, detail="E2EE shadow messages are currently limited to private chats.")
            if encrypted["mode"] == "shadow":
                envelope_devices = {str(item["deviceId"]) for item in encrypted["envelopes"]}
                cursor.execute(
                    """
                    select d.device_id
                    from yachat_e2ee_devices d
                    join yachat_chat_members cm on cm.user_id = d.user_id
                    where cm.chat_id = %s and d.revoked_at is null
                    """,
                    (chat_id,),
                )
                allowed_devices = {str(row["device_id"]) for row in cursor.fetchall()}
                if not envelope_devices or not envelope_devices.issubset(allowed_devices):
                    raise HTTPException(status_code=400, detail="E2EE envelopes contain an unknown chat device.")

            cursor.execute(
                """
                insert into yachat_messages(
                    id, chat_id, sender_id, text, formatted_html,
                    attachments, reply_to_message_id,
                    e2ee_version, e2ee_mode, e2ee_ciphertext, e2ee_iv,
                    e2ee_aad, e2ee_envelopes, e2ee_sender_device_id,
                    e2ee_plaintext_digest, created_at
                )
                values (
                    %s, %s, %s, %s, %s, %s::jsonb, %s,
                    %s, %s, %s, %s, %s, %s::jsonb, %s, %s, now()
                )
                on conflict(id) do nothing
                returning *
                """,
                (
                    message_id,
                    chat_id,
                    user["id"],
                    text,
                    formatted_html,
                    json.dumps(attachments[:8]),
                    payload.get("replyToMessageId") or None,
                    *e2ee_message_columns(encrypted),
                ),
            )
            inserted_row = cursor.fetchone()
            inserted = inserted_row is not None
            if inserted:
                message = dict(inserted_row)
            else:
                cursor.execute(
                    """
                    select *
                    from yachat_messages
                    where id = %s and chat_id = %s and sender_id = %s and deleted_at is null
                    limit 1
                    """,
                    (message_id, chat_id, user["id"]),
                )
                existing_row = cursor.fetchone()
                if not existing_row:
                    raise HTTPException(status_code=409, detail="Message id conflict.")
                message = dict(existing_row)

            cursor.execute(
                """
                with touched_chat as (
                    update yachat_chats
                    set updated_at = now()
                    where id = %s
                    returning id
                ),
                touched_sender as (
                    update yachat_chat_members
                    set last_read_at = now()
                    where chat_id = %s and user_id = %s
                    returning user_id
                )
                select user_id
                from yachat_chat_members
                where chat_id = %s and user_id <> %s
                """,
                (chat_id, chat_id, user["id"], chat_id, user["id"]),
            )
            recipients = [] if is_saved_chat else [str(row["user_id"]) for row in cursor.fetchall()]

    sender_name = str(row_value(user, "display_name", "preview_name", "username")) or "ЯЧат"
    sender_username = str(row_value(user, "username"))
    chat_kind = str(row_value(chat, "kind"))
    chat_title = str(row_value(chat, "title"))
    push_target = f"/{sender_username}" if chat_kind == "private" and sender_username else f"/?chat={chat_id}"
    push_title = sender_name if chat_kind == "private" else chat_title or sender_name
    push_body = body if chat_kind == "private" else f"{sender_name}: {body}"
    deliveries = [
        (
            recipient_id,
            push_title,
            push_body[:240],
            push_target,
            f"message:{message_id}:{recipient_id}",
        )
        for recipient_id in recipients
    ]
    background_tasks.add_task(deliver_pushes_background, deliveries)

    rendered_message = attach_e2ee_payload(message_payload(message, user_id), message)
    return {
        "ok": True,
        "message": rendered_message,
        "inserted": inserted,
        "pushQueued": len(deliveries),
        "e2eeRolloutPhase": "shadow" if encrypted["mode"] == "shadow" else "legacy",
    }


@app.post("/api/message/delete")
async def delete_message(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    requested_chat_id = clean_chat_id(payload.get("chatId"))
    scope = str(payload.get("scope") or "self").strip().lower()
    if scope not in {"self", "everyone"}:
        raise HTTPException(status_code=400, detail="Choose how to delete the message.")

    ids = message_ids(payload)
    user_id = str(user["id"])

    if requested_chat_id.startswith("yachat-") and requested_chat_id != "yachat-favorites":
        raise HTTPException(status_code=403, detail="This message cannot be deleted.")

    physically_deleted: list[str] = []
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat_id = resolve_message_chat_id(cursor, requested_chat_id, user_id)
            require_chat_member(cursor, chat_id, user_id)
            cursor.execute(
                """
                select id, sender_id
                from yachat_messages
                where chat_id = %s
                  and id::text = any(%s)
                  and deleted_at is null
                """,
                (chat_id, ids),
            )
            rows = [dict(row) for row in cursor.fetchall()]
            rows_by_id = {str(row["id"]): row for row in rows}
            if any(message_id not in rows_by_id for message_id in ids):
                raise HTTPException(status_code=404, detail="Message not found.")

            if scope == "everyone":
                if any(str(row_value(rows_by_id[message_id], "sender_id")) != user_id for message_id in ids):
                    raise HTTPException(status_code=403, detail="You can delete only your own messages for everyone.")
                cursor.execute(
                    "update yachat_messages set reply_to_message_id = null where reply_to_message_id = any(%s)",
                    (ids,),
                )
                cursor.execute(
                    """
                    delete from yachat_messages
                    where chat_id = %s
                      and sender_id = %s
                      and id::text = any(%s)
                    returning id
                    """,
                    (chat_id, user_id, ids),
                )
                physically_deleted = [str(row["id"]) for row in cursor.fetchall()]
            else:
                cursor.execute(
                    """
                    insert into yachat_message_hidden(message_id, user_id, hidden_at)
                    select id, %s, now()
                    from yachat_messages
                    where chat_id = %s
                      and id::text = any(%s)
                    on conflict(message_id, user_id) do nothing
                    """,
                    (user_id, chat_id, ids),
                )
                cursor.execute(
                    """
                    select m.id
                    from yachat_messages m
                    where m.chat_id = %s
                      and m.id::text = any(%s)
                      and (
                          select count(*)
                          from yachat_message_hidden h
                          where h.message_id = m.id
                      ) >= (
                          select count(*)
                          from yachat_chat_members cm
                          where cm.chat_id = m.chat_id
                      )
                    """,
                    (chat_id, ids),
                )
                garbage_ids = [str(row["id"]) for row in cursor.fetchall()]
                if garbage_ids:
                    cursor.execute(
                        "update yachat_messages set reply_to_message_id = null where reply_to_message_id = any(%s)",
                        (garbage_ids,),
                    )
                    cursor.execute(
                        "delete from yachat_messages where id::text = any(%s) returning id",
                        (garbage_ids,),
                    )
                    physically_deleted = [str(row["id"]) for row in cursor.fetchall()]

    return {
        "ok": True,
        "chatId": requested_chat_id,
        "deletedIds": ids,
        "physicallyDeletedIds": physically_deleted,
        "scope": scope,
    }
