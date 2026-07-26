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
    hash_secret,
    is_murochko_profile,
    message_payload,
    prepare_rich_message,
    read_json_payload,
    request_token,
    require_chat_member,
    require_chat_messaging_allowed,
    require_user,
    resolve_message_chat_id,
    row_value,
    system_message_payload,
)
from server.e2ee import (
    attach_e2ee_payload,
    canonical_roster,
    e2ee_message_columns,
    message_signature_input,
    normalize_device_id,
    parse_device_registration,
    parse_e2ee_message,
    push_preview_signature_input,
    roster_digest,
    verify_ed25519,
)
from server.push_delivery import send_push_to_user

app = FastAPI(title="YaChat message API", version="2.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

_PHASE2_VERSION = 2
_PHASE2_CAPABILITY = "server-blind-text-v1"
_PHASE3_VERSION = 3
_PHASE3_ATTACHMENT_CAPABILITY = "encrypted-attachments-v1"
_PHASE4_VERSION = 4
_PHASE4_PUSH_CAPABILITY = "encrypted-push-preview-v1"
_PHASE5_VERSION = 5
_PHASE5_REQUIRED_CAPABILITIES = {
    "mandatory-e2ee-v1",
    "signed-messages-v1",
    "padded-content-v1",
    "sealed-push-descriptor-v1",
    "encrypted-digital-id-v1",
}
_ENCRYPTED_ATTACHMENT_MIME = "application/vnd.yachat.e2ee"
_RECENT_SESSION_DAYS = 7
_DEVICE_RETENTION_DAYS = 90


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


def validate_encrypted_attachment_transport(
    attachments: list[dict[str, Any]],
    encrypted: dict[str, Any],
) -> None:
    attachment_mode = str(encrypted.get("attachmentMode") or "plaintext")
    if attachment_mode != "encrypted":
        return
    if int(encrypted.get("version") or 0) < _PHASE3_VERSION:
        raise HTTPException(status_code=400, detail="Encrypted attachments require E2EE protocol version 3.")
    if not attachments:
        if int(encrypted.get("version") or 0) >= _PHASE5_VERSION:
            return
        raise HTTPException(status_code=400, detail="The encrypted-attachment payload is empty.")

    seen_ids: set[str] = set()
    expected_prefix = f"data:{_ENCRYPTED_ATTACHMENT_MIME};base64,"
    for attachment in attachments:
        attachment_id = str(attachment.get("id") or "")
        if not attachment_id or attachment_id in seen_ids:
            raise HTTPException(status_code=400, detail="Encrypted attachment ids must be unique.")
        seen_ids.add(attachment_id)
        if (
            str(attachment.get("name") or "") != "encrypted"
            or str(attachment.get("mime") or "") != _ENCRYPTED_ATTACHMENT_MIME
            or str(attachment.get("kind") or "") != "file"
            or not str(attachment.get("dataUrl") or "").startswith(expected_prefix)
        ):
            raise HTTPException(status_code=400, detail="Encrypted attachment transport is malformed.")


async def deliver_pushes(
    deliveries: list[tuple[str, str, str, str, str, dict[str, dict[str, Any]]]],
) -> None:
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
                encrypted_previews=encrypted_previews,
            )
            for user_id, title, body, url, tag, encrypted_previews in deliveries
        ],
        return_exceptions=True,
    )


def deliver_pushes_background(
    deliveries: list[tuple[str, str, str, str, str, dict[str, dict[str, Any]]]],
) -> None:
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


def device_capabilities(value: Any) -> list[str]:
    source = value
    if isinstance(source, str):
        try:
            source = json.loads(source)
        except json.JSONDecodeError:
            source = []
    if not isinstance(source, list):
        return []
    return [str(item) for item in source if isinstance(item, str)]


def encrypted_previews_for_user(encrypted: dict[str, Any], user_id: str) -> dict[str, dict[str, Any]]:
    return {
        str(item["deviceId"]): {
            key: value for key, value in item.items() if not str(key).startswith("_")
        }
        for item in encrypted.get("pushPreviews", [])
        if str(item.get("_recipientUserId") or item.get("userId") or "") == user_id
    }


def authenticated_session_hash(request: Request) -> str:
    token = request_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in first.")
    return hash_secret(token)


def bind_current_session(
    cursor,
    request: Request,
    *,
    user_id: str,
    device_id: str,
    protocol_version: int,
    phase2_ready: bool,
) -> None:
    cursor.execute(
        """
        update yachat_sessions
        set device_id = %s,
            last_seen_at = now(),
            e2ee_version = %s,
            e2ee_capable_at = case when %s then coalesce(e2ee_capable_at, now()) else null end,
            user_agent = %s
        where token_hash = %s and user_id = %s and expires_at > now()
        """,
        (
            device_id,
            protocol_version,
            phase2_ready,
            str(request.headers.get("user-agent") or "")[:500],
            authenticated_session_hash(request),
            user_id,
        ),
    )
    if cursor.rowcount != 1:
        raise HTTPException(status_code=401, detail="The current session is no longer active.")


def require_bound_sender_device(cursor, request: Request, user_id: str, device_id: str) -> dict[str, Any]:
    cursor.execute(
        """
        select d.*
        from yachat_sessions s
        join yachat_e2ee_devices d
          on d.device_id = s.device_id and d.user_id = s.user_id
        where s.token_hash = %s
          and s.user_id = %s
          and s.device_id = %s
          and s.expires_at > now()
          and s.e2ee_capable_at is not null
          and s.e2ee_version >= %s
          and d.revoked_at is null
          and d.ready_at is not null
          and d.protocol_version >= %s
        limit 1
        """,
        (authenticated_session_hash(request), user_id, device_id, _PHASE2_VERSION, _PHASE2_VERSION),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=409, detail="Register this E2EE device for the current session first.")
    cursor.execute(
        """
        update yachat_sessions
        set last_seen_at = now()
        where token_hash = %s and user_id = %s
        """,
        (authenticated_session_hash(request), user_id),
    )
    cursor.execute(
        "update yachat_e2ee_devices set last_seen_at = now() where device_id = %s",
        (device_id,),
    )
    return dict(row)


def chat_member_ids(cursor, chat_id: str) -> list[str]:
    cursor.execute(
        "select user_id from yachat_chat_members where chat_id = %s order by joined_at, user_id",
        (chat_id,),
    )
    return [str(row["user_id"]) for row in cursor.fetchall()]


def eligible_phase2_devices(cursor, member_ids: list[str]) -> list[dict[str, Any]]:
    if not member_ids:
        return []
    cursor.execute(
        f"""
        select *
        from yachat_e2ee_devices
        where user_id = any(%s)
          and revoked_at is null
          and ready_at is not null
          and protocol_version >= %s
          and capabilities ? %s
          and last_seen_at > now() - interval '{_DEVICE_RETENTION_DAYS} days'
        order by user_id, device_id
        """,
        (member_ids, _PHASE2_VERSION, _PHASE2_CAPABILITY),
    )
    return [dict(row) for row in cursor.fetchall()]


def eligible_phase3_devices(cursor, member_ids: list[str]) -> list[dict[str, Any]]:
    if not member_ids:
        return []
    cursor.execute(
        f"""
        select *
        from yachat_e2ee_devices
        where user_id = any(%s)
          and revoked_at is null
          and ready_at is not null
          and protocol_version >= %s
          and capabilities ? %s
          and capabilities ? %s
          and last_seen_at > now() - interval '{_DEVICE_RETENTION_DAYS} days'
        order by user_id, device_id
        """,
        (
            member_ids,
            _PHASE3_VERSION,
            _PHASE2_CAPABILITY,
            _PHASE3_ATTACHMENT_CAPABILITY,
        ),
    )
    return [dict(row) for row in cursor.fetchall()]


def eligible_phase5_devices(cursor, member_ids: list[str]) -> list[dict[str, Any]]:
    if not member_ids:
        return []
    cursor.execute(
        f"""
        select *
        from yachat_e2ee_devices
        where user_id = any(%s)
          and revoked_at is null
          and ready_at is not null
          and protocol_version >= %s
          and capabilities ?& %s
          and last_seen_at > now() - interval '{_DEVICE_RETENTION_DAYS} days'
        order by user_id, device_id
        """,
        (member_ids, _PHASE5_VERSION, sorted(_PHASE5_REQUIRED_CAPABILITIES)),
    )
    return [dict(row) for row in cursor.fetchall()]


def shadow_devices(cursor, member_ids: list[str]) -> list[dict[str, Any]]:
    if not member_ids:
        return []
    cursor.execute(
        f"""
        select *
        from yachat_e2ee_devices
        where user_id = any(%s)
          and revoked_at is null
          and last_seen_at > now() - interval '{_DEVICE_RETENTION_DAYS} days'
        order by user_id, device_id
        """,
        (member_ids,),
    )
    return [dict(row) for row in cursor.fetchall()]


def recent_unready_session_users(
    cursor,
    member_ids: list[str],
    eligible_device_ids: set[str],
    *,
    minimum_version: int = _PHASE2_VERSION,
) -> list[str]:
    if not member_ids:
        return []
    cursor.execute(
        f"""
        select user_id, device_id, e2ee_version, e2ee_capable_at
        from yachat_sessions
        where user_id = any(%s)
          and expires_at > now()
          and last_seen_at > now() - interval '{_RECENT_SESSION_DAYS} days'
        """,
        (member_ids,),
    )
    blocked: set[str] = set()
    for row in cursor.fetchall():
        device_id = str(row.get("device_id") or "")
        if (
            not device_id
            or device_id not in eligible_device_ids
            or int(row.get("e2ee_version") or 0) < minimum_version
            or row.get("e2ee_capable_at") is None
        ):
            blocked.add(str(row["user_id"]))
    return sorted(blocked)


def create_or_refresh_epoch(
    cursor,
    *,
    chat_id: str,
    roster: list[dict[str, str]],
) -> dict[str, Any]:
    digest = roster_digest(roster)
    cursor.execute(
        """
        select *
        from yachat_e2ee_chat_epochs
        where chat_id = %s and retired_at is null
        limit 1
        """,
        (chat_id,),
    )
    active = cursor.fetchone()
    if active and str(active["roster_hash"]) == digest:
        return dict(active)

    cursor.execute(
        "update yachat_e2ee_chat_epochs set retired_at = now() where chat_id = %s and retired_at is null",
        (chat_id,),
    )
    cursor.execute(
        "select coalesce(max(version), 0) + 1 as version from yachat_e2ee_chat_epochs where chat_id = %s",
        (chat_id,),
    )
    version = int(cursor.fetchone()["version"])
    epoch_id = f"epoch-{uuid.uuid4()}"
    cursor.execute(
        """
        insert into yachat_e2ee_chat_epochs(id, chat_id, version, roster, roster_hash, created_at)
        values (%s, %s, %s, %s::jsonb, %s, now())
        returning *
        """,
        (epoch_id, chat_id, version, json.dumps(roster, ensure_ascii=False), digest),
    )
    return dict(cursor.fetchone())


def resolve_chat_rollout(cursor, chat_id: str, user_id: str) -> dict[str, Any]:
    require_chat_member(cursor, chat_id, user_id)
    cursor.execute("select * from yachat_chats where id = %s for update", (chat_id,))
    chat = cursor.fetchone()
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found.")
    if str(row_value(chat, "kind")) != "private":
        raise HTTPException(status_code=400, detail="E2EE phase 2 is currently available for private chats only.")

    member_ids = chat_member_ids(cursor, chat_id)
    if len(member_ids) != 2:
        raise HTTPException(status_code=409, detail="Private chat membership is invalid.")

    minimum_protocol_version = max(
        _PHASE2_VERSION,
        min(int(row_value(chat, "e2ee_min_protocol") or _PHASE2_VERSION), _PHASE5_VERSION),
    )
    devices = (
        eligible_phase5_devices(cursor, member_ids)
        if minimum_protocol_version >= _PHASE5_VERSION
        else eligible_phase2_devices(cursor, member_ids)
    )
    device_ids = {str(row["device_id"]) for row in devices}
    users_with_devices = {str(row["user_id"]) for row in devices}
    missing_device_users = sorted(set(member_ids) - users_with_devices)
    unready_session_users = recent_unready_session_users(
        cursor,
        member_ids,
        device_ids,
        minimum_version=minimum_protocol_version,
    )
    phase3_devices = eligible_phase3_devices(cursor, member_ids)
    phase3_device_ids = {str(row["device_id"]) for row in phase3_devices}
    phase3_users_with_devices = {str(row["user_id"]) for row in phase3_devices}
    phase3_missing_users = sorted(set(member_ids) - phase3_users_with_devices)
    phase3_unready_session_users = recent_unready_session_users(
        cursor,
        member_ids,
        phase3_device_ids,
        minimum_version=_PHASE3_VERSION,
    )
    attachment_encryption_ready = (
        bool(device_ids)
        and (
            minimum_protocol_version >= _PHASE5_VERSION
            or (
                not phase3_missing_users
                and not phase3_unready_session_users
                and device_ids == phase3_device_ids
            )
        )
    )
    current_policy = str(row_value(chat, "e2ee_policy")) or "shadow"

    can_activate = not missing_device_users and not unready_session_users
    if current_policy != "text_encrypted" and can_activate:
        current_policy = "text_encrypted"
        cursor.execute(
            """
            update yachat_chats
            set e2ee_policy = 'text_encrypted', e2ee_enabled_at = coalesce(e2ee_enabled_at, now())
            where id = %s
            """,
            (chat_id,),
        )

    if current_policy == "text_encrypted":
        if missing_device_users or (
            minimum_protocol_version >= _PHASE5_VERSION and unready_session_users
        ):
            return {
                "phase": "blocked",
                "chat": dict(chat),
                "memberIds": member_ids,
                "devices": [],
                "epoch": None,
                "missingDeviceUserIds": missing_device_users,
                "unreadySessionUserIds": unready_session_users,
                "attachmentEncryptionReady": False,
                "phase3MissingDeviceUserIds": phase3_missing_users,
                "phase3UnreadySessionUserIds": phase3_unready_session_users,
                "minimumProtocolVersion": minimum_protocol_version,
            }
        roster = canonical_roster(devices)
        epoch = create_or_refresh_epoch(cursor, chat_id=chat_id, roster=roster)
        cursor.execute(
            """
            update yachat_chats
            set e2ee_policy = 'text_encrypted', e2ee_epoch_id = %s,
                e2ee_enabled_at = coalesce(e2ee_enabled_at, now())
            where id = %s
            """,
            (epoch["id"], chat_id),
        )
        return {
            "phase": "encrypted",
            "chat": {**dict(chat), "e2ee_policy": "text_encrypted", "e2ee_epoch_id": epoch["id"]},
            "memberIds": member_ids,
            "devices": devices,
            "epoch": epoch,
            "missingDeviceUserIds": [],
            "unreadySessionUserIds": unready_session_users,
            "attachmentEncryptionReady": attachment_encryption_ready,
            "phase3MissingDeviceUserIds": phase3_missing_users,
            "phase3UnreadySessionUserIds": phase3_unready_session_users,
            "minimumProtocolVersion": minimum_protocol_version,
        }

    return {
        "phase": "shadow",
        "chat": dict(chat),
        "memberIds": member_ids,
        "devices": shadow_devices(cursor, member_ids),
        "epoch": None,
        "missingDeviceUserIds": missing_device_users,
        "unreadySessionUserIds": unready_session_users,
        "attachmentEncryptionReady": False,
        "phase3MissingDeviceUserIds": phase3_missing_users,
        "phase3UnreadySessionUserIds": phase3_unready_session_users,
        "minimumProtocolVersion": minimum_protocol_version,
    }


def claim_bundle_prekeys(
    cursor,
    *,
    devices: list[dict[str, Any]],
    sender_user_id: str,
    sender_device_id: str,
) -> list[dict[str, Any]]:
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
                    (sender_user_id, sender_device_id, device_id, prekey["id"]),
                )

        bundles.append({
            "deviceId": device_id,
            "userId": str(device["user_id"]),
            "algorithm": str(device["algorithm"]),
            "protocolVersion": int(device.get("protocol_version") or 1),
            "capabilities": device_capabilities(device.get("capabilities")),
            "pushPreview": (
                {
                    "version": 1,
                    "algorithm": "P-256-HKDF-SHA256-AESGCM",
                    "publicKey": str(device.get("push_preview_public") or ""),
                    "signature": str(device.get("push_preview_signature") or ""),
                }
                if device.get("push_preview_public") and device.get("push_preview_signature")
                else None
            ),
            "identityDhPublic": str(device["identity_dh_public"]),
            "identitySignPublic": str(device["identity_sign_public"]),
            "signedPreKey": {
                "id": str(device["signed_prekey_id"]),
                "publicKey": str(device["signed_prekey_public"]),
                "signature": str(device["signed_prekey_signature"]),
            },
            "oneTimePreKey": prekey,
        })
    return bundles


def validate_encrypted_message(
    cursor,
    request: Request,
    *,
    user_id: str,
    chat: dict[str, Any],
    encrypted: dict[str, Any],
) -> None:
    if str(row_value(chat, "kind")) != "private":
        raise HTTPException(status_code=400, detail="Server-blind E2EE is currently limited to private chats.")
    if str(row_value(chat, "e2ee_policy")) != "text_encrypted":
        raise HTTPException(status_code=409, detail="This chat has not completed E2EE phase 2 readiness yet.")
    minimum_protocol_version = max(
        _PHASE2_VERSION,
        min(int(row_value(chat, "e2ee_min_protocol") or _PHASE2_VERSION), _PHASE5_VERSION),
    )
    if int(encrypted.get("version") or 0) < minimum_protocol_version:
        raise HTTPException(
            status_code=426,
            detail=f"This chat requires E2EE protocol version {minimum_protocol_version}.",
        )
    epoch_id = str(row_value(chat, "e2ee_epoch_id"))
    if not epoch_id or encrypted["epochId"] != epoch_id:
        raise HTTPException(status_code=409, detail="The E2EE device roster changed. Refresh the chat and send again.")

    sender_device = require_bound_sender_device(cursor, request, user_id, encrypted["senderDeviceId"])
    cursor.execute(
        "select roster from yachat_e2ee_chat_epochs where id = %s and chat_id = %s and retired_at is null limit 1",
        (epoch_id, str(row_value(chat, "id"))),
    )
    epoch = cursor.fetchone()
    if not epoch:
        raise HTTPException(status_code=409, detail="The E2EE chat epoch is no longer active.")
    roster = epoch["roster"] if isinstance(epoch["roster"], list) else []
    roster_map = {str(item.get("deviceId") or ""): str(item.get("userId") or "") for item in roster}
    envelope_map = {str(item["deviceId"]): item for item in encrypted["envelopes"]}
    if set(envelope_map) != set(roster_map):
        raise HTTPException(status_code=409, detail="E2EE envelopes do not exactly cover the active device roster.")

    cursor.execute(
        "select * from yachat_e2ee_devices where device_id = any(%s) and revoked_at is null",
        (list(roster_map.keys()),),
    )
    device_rows = {str(row["device_id"]): dict(row) for row in cursor.fetchall()}
    if set(device_rows) != set(roster_map):
        raise HTTPException(status_code=409, detail="An E2EE recipient device is no longer active.")

    if encrypted.get("attachmentMode") == "encrypted":
        for device in device_rows.values():
            capabilities = device_capabilities(device.get("capabilities"))
            if (
                int(device.get("protocol_version") or 0) < _PHASE3_VERSION
                or _PHASE3_ATTACHMENT_CAPABILITY not in capabilities
            ):
                raise HTTPException(
                    status_code=409,
                    detail="Every active chat device must support encrypted attachments.",
                )

    sender_identity = str(sender_device["identity_dh_public"])
    sender_signing_identity = str(sender_device["identity_sign_public"])
    sender_capabilities = device_capabilities(sender_device.get("capabilities"))
    if minimum_protocol_version >= _PHASE5_VERSION:
        if (
            int(sender_device.get("protocol_version") or 0) < _PHASE5_VERSION
            or not _PHASE5_REQUIRED_CAPABILITIES.issubset(set(sender_capabilities))
            or int(encrypted.get("version") or 0) < _PHASE5_VERSION
            or str(encrypted.get("senderIdentitySignPublic") or "") != sender_signing_identity
        ):
            raise HTTPException(status_code=426, detail="The sender device has not completed E2EE phase 5.")
        verify_ed25519(
            sender_signing_identity,
            str(encrypted.get("signature") or ""),
            message_signature_input(encrypted),
            field="message",
        )
        if any(int(preview.get("version") or 0) < 2 for preview in encrypted.get("pushPreviews", [])):
            raise HTTPException(status_code=400, detail="Phase 5 requires sealed push descriptors.")
    sender_supports_push_previews = (
        int(sender_device.get("protocol_version") or 0) >= _PHASE4_VERSION
        and _PHASE4_PUSH_CAPABILITY in sender_capabilities
    )
    preview_device_ids = {
        str(preview["deviceId"])
        for preview in encrypted.get("pushPreviews", [])
    }
    if sender_supports_push_previews:
        expected_preview_device_ids = {
            device_id
            for device_id, device in device_rows.items()
            if (
                int(device.get("protocol_version") or 0) >= _PHASE4_VERSION
                and _PHASE4_PUSH_CAPABILITY in device_capabilities(device.get("capabilities"))
                and bool(device.get("push_preview_public"))
                and bool(device.get("push_preview_signature"))
            )
        }
        if preview_device_ids != expected_preview_device_ids:
            raise HTTPException(
                status_code=409,
                detail="E2EE push previews do not cover every phase 4 device.",
            )

    for preview in encrypted.get("pushPreviews", []):
        device_id = str(preview["deviceId"])
        expected_user_id = roster_map.get(device_id)
        device = device_rows.get(device_id)
        if not expected_user_id or not device:
            raise HTTPException(status_code=400, detail="E2EE push preview targets an unknown device.")
        capabilities = device_capabilities(device.get("capabilities"))
        if (
            str(preview["senderDeviceId"]) != encrypted["senderDeviceId"]
            or str(preview["senderIdentitySignPublic"]) != sender_signing_identity
            or (
                int(preview.get("version") or 0) == 1
                and (
                    str(preview["userId"]) != expected_user_id
                    or str(preview["senderUserId"]) != user_id
                )
            )
        ):
            raise HTTPException(status_code=400, detail="E2EE push-preview ownership does not match the chat roster.")
        preview["_recipientUserId"] = expected_user_id
        if (
            int(device.get("protocol_version") or 0) < _PHASE4_VERSION
            or _PHASE4_PUSH_CAPABILITY not in capabilities
            or not str(device.get("push_preview_public") or "")
            or str(preview["recipientPushPreviewPublic"]) != str(device.get("push_preview_public") or "")
        ):
            raise HTTPException(status_code=409, detail="The push-preview key for a recipient device changed.")
        if int(encrypted.get("version") or 0) >= _PHASE5_VERSION:
            verify_ed25519(
                sender_signing_identity,
                str(preview.get("signature") or ""),
                push_preview_signature_input(preview),
                field="push descriptor",
            )

    for device_id, expected_user_id in roster_map.items():
        envelope = envelope_map[device_id]
        device = device_rows[device_id]
        if str(device["user_id"]) != expected_user_id or str(envelope["userId"]) != expected_user_id:
            raise HTTPException(status_code=400, detail="E2EE envelope ownership does not match the chat roster.")
        if str(envelope["signedPreKeyId"]) != str(device["signed_prekey_id"]):
            raise HTTPException(status_code=409, detail="An E2EE signed prekey rotated. Refresh the chat and send again.")
        if str(envelope["senderIdentityKey"]) != sender_identity:
            raise HTTPException(status_code=400, detail="E2EE sender identity does not match the registered device.")

        one_time_id = str(envelope.get("oneTimePreKeyId") or "")
        if device_id == encrypted["senderDeviceId"] and one_time_id:
            raise HTTPException(status_code=400, detail="The sender device cannot claim its own one-time prekey.")
        if one_time_id:
            cursor.execute(
                """
                select 1
                from yachat_e2ee_one_time_prekeys
                where device_id = %s and prekey_id = %s
                  and claimed_by_user_id = %s and claimed_by_device_id = %s
                  and claimed_at is not null
                limit 1
                """,
                (device_id, one_time_id, user_id, encrypted["senderDeviceId"]),
            )
            if not cursor.fetchone():
                raise HTTPException(status_code=400, detail="E2EE one-time prekey claim is invalid.")


def validate_shadow_message(cursor, chat_id: str, user_id: str, encrypted: dict[str, Any]) -> None:
    cursor.execute(
        """
        select d.device_id, d.user_id
        from yachat_e2ee_devices d
        join yachat_chat_members cm on cm.user_id = d.user_id
        where cm.chat_id = %s and d.revoked_at is null
        """,
        (chat_id,),
    )
    allowed = {str(row["device_id"]): str(row["user_id"]) for row in cursor.fetchall()}
    envelope_map = {str(item["deviceId"]): item for item in encrypted["envelopes"]}
    if not envelope_map or not set(envelope_map).issubset(set(allowed)):
        raise HTTPException(status_code=400, detail="E2EE envelopes contain an unknown chat device.")
    for device_id, envelope in envelope_map.items():
        if str(envelope["userId"]) != allowed[device_id]:
            raise HTTPException(status_code=400, detail="E2EE envelope ownership is invalid.")
    cursor.execute(
        "select 1 from yachat_e2ee_devices where device_id = %s and user_id = %s and revoked_at is null",
        (encrypted["senderDeviceId"], user_id),
    )
    if not cursor.fetchone():
        raise HTTPException(status_code=409, detail="Register this E2EE device first.")


@app.post("/api/e2ee/device/register")
async def register_e2ee_device(request: Request):
    user = require_user(request)
    bundle = parse_device_registration(await read_json_payload(request))
    user_id = str(user["id"])
    device_id = bundle["deviceId"]
    signed = bundle["signedPreKey"]
    push_preview = bundle.get("pushPreview") or {}
    user_agent = str(request.headers.get("user-agent") or "")[:500]

    with connect_db() as connection:
        with connection.transaction():
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute("select * from yachat_e2ee_devices where device_id = %s limit 1", (device_id,))
                existing = cursor.fetchone()
                if existing and str(existing["user_id"]) != user_id:
                    raise HTTPException(status_code=409, detail="This E2EE device id belongs to another account.")
                if existing:
                    if (
                        str(existing["identity_dh_public"]) != bundle["identityDhPublic"]
                        or str(existing["identity_sign_public"]) != bundle["identitySignPublic"]
                    ):
                        raise HTTPException(
                            status_code=409,
                            detail="This device identity changed. Revoke the old E2EE device before replacing it.",
                        )

                cursor.execute(
                    """
                    insert into yachat_e2ee_devices(
                        device_id, user_id, algorithm, identity_dh_public,
                        identity_sign_public, signed_prekey_id, signed_prekey_public,
                        signed_prekey_signature, protocol_version, capabilities,
                        push_preview_public, push_preview_signature,
                        ready_at, user_agent, created_at, updated_at, last_seen_at, revoked_at
                    )
                    values (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb,
                        %s, %s, case when %s then now() else null end, %s, now(), now(), now(), null
                    )
                    on conflict(device_id) do update
                    set algorithm = excluded.algorithm,
                        signed_prekey_id = excluded.signed_prekey_id,
                        signed_prekey_public = excluded.signed_prekey_public,
                        signed_prekey_signature = excluded.signed_prekey_signature,
                        protocol_version = excluded.protocol_version,
                        capabilities = excluded.capabilities,
                        push_preview_public = excluded.push_preview_public,
                        push_preview_signature = excluded.push_preview_signature,
                        ready_at = case when excluded.protocol_version >= 2 then coalesce(yachat_e2ee_devices.ready_at, now()) else null end,
                        user_agent = excluded.user_agent,
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
                        bundle["protocolVersion"],
                        json.dumps(bundle["capabilities"]),
                        str(push_preview.get("publicKey") or ""),
                        str(push_preview.get("signature") or ""),
                        bundle["phase2Ready"],
                        user_agent,
                    ),
                )

                bind_current_session(
                    cursor,
                    request,
                    user_id=user_id,
                    device_id=device_id,
                    protocol_version=bundle["protocolVersion"],
                    phase2_ready=bundle["phase2Ready"],
                )
                if bundle["phase5Ready"]:
                    cursor.execute(
                        """
                        update public_users
                        set e2ee_required = true,
                            e2ee_min_protocol = greatest(coalesce(e2ee_min_protocol, 2), 5),
                            updated_at = now()
                        where id = %s
                        """,
                        (user_id,),
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
        "protocolVersion": bundle["protocolVersion"],
        "capabilities": bundle["capabilities"],
        "deviceId": device_id,
        "availableOneTimePreKeys": available,
        "needsOneTimePreKeys": available < 12,
        "rolloutPhase": (
            "phase5-ready"
            if bundle["phase5Ready"]
            else "phase4-ready"
            if bundle["phase4Ready"]
            else "phase3-ready"
            if bundle["phase3Ready"]
            else "phase2-ready"
            if bundle["phase2Ready"]
            else "shadow"
        ),
    }


@app.post("/api/e2ee/device/heartbeat")
async def heartbeat_e2ee_device(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    device_id = normalize_device_id(payload.get("deviceId"))
    user_id = str(user["id"])
    with connect_db() as connection:
        with connection.transaction():
            with connection.cursor(row_factory=dict_row) as cursor:
                device = require_bound_sender_device(cursor, request, user_id, device_id)
                cursor.execute(
                    "select count(*) as count from yachat_e2ee_one_time_prekeys where device_id = %s and claimed_at is null",
                    (device_id,),
                )
                available = int(cursor.fetchone()["count"])
    return {
        "ok": True,
        "deviceId": device_id,
        "protocolVersion": int(device.get("protocol_version") or 1),
        "availableOneTimePreKeys": available,
        "needsOneTimePreKeys": available < 12,
        "rolloutPhase": (
            "phase5-ready"
            if (
                int(device.get("protocol_version") or 0) >= _PHASE5_VERSION
                and _PHASE5_REQUIRED_CAPABILITIES.issubset(
                    set(device_capabilities(device.get("capabilities")))
                )
            )
            else "phase4-ready"
            if (
                int(device.get("protocol_version") or 0) >= _PHASE4_VERSION
                and _PHASE4_PUSH_CAPABILITY
                in device_capabilities(device.get("capabilities"))
                and bool(device.get("push_preview_public"))
                and bool(device.get("push_preview_signature"))
            )
            else "phase3-ready"
            if (
                int(device.get("protocol_version") or 0) >= _PHASE3_VERSION
                and _PHASE3_ATTACHMENT_CAPABILITY
                in device_capabilities(device.get("capabilities"))
            )
            else "phase2-ready"
        ),
    }


@app.post("/api/e2ee/device/revoke")
async def revoke_e2ee_device(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    device_id = normalize_device_id(payload.get("deviceId"))
    user_id = str(user["id"])
    with connect_db() as connection:
        with connection.transaction():
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    update yachat_e2ee_devices
                    set revoked_at = now(), updated_at = now()
                    where device_id = %s and user_id = %s and revoked_at is null
                    """,
                    (device_id, user_id),
                )
                revoked = cursor.rowcount > 0
                cursor.execute(
                    """
                    update yachat_sessions
                    set e2ee_capable_at = null, e2ee_version = 0
                    where device_id = %s and user_id = %s
                    """,
                    (device_id, user_id),
                )
    return {"ok": True, "deviceId": device_id, "revoked": revoked}


@app.post("/api/e2ee/bundles/claim")
async def claim_e2ee_bundles(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    sender_device_id = normalize_device_id(payload.get("senderDeviceId"))
    user_id = str(user["id"])

    with connect_db() as connection:
        with connection.transaction():
            with connection.cursor(row_factory=dict_row) as cursor:
                require_bound_sender_device(cursor, request, user_id, sender_device_id)
                rollout = resolve_chat_rollout(cursor, chat_id, user_id)
                if rollout["phase"] == "blocked":
                    return {
                        "ok": False,
                        "chatId": chat_id,
                        "algorithm": "yachat-x3dh-v1",
                        "rolloutPhase": "blocked",
                        "reason": (
                            f"A participant has no active phase {rollout['minimumProtocolVersion']} "
                            "E2EE device or session."
                        ),
                        "minimumProtocolVersion": rollout["minimumProtocolVersion"],
                        "missingDeviceUserIds": rollout["missingDeviceUserIds"],
                        "unreadySessionUserIds": rollout["unreadySessionUserIds"],
                        "attachmentEncryptionReady": False,
                        "phase3MissingDeviceUserIds": rollout["phase3MissingDeviceUserIds"],
                        "phase3UnreadySessionUserIds": rollout["phase3UnreadySessionUserIds"],
                        "bundles": [],
                    }
                bundles = claim_bundle_prekeys(
                    cursor,
                    devices=rollout["devices"],
                    sender_user_id=user_id,
                    sender_device_id=sender_device_id,
                )
                epoch = rollout["epoch"]

    return {
        "ok": True,
        "chatId": chat_id,
        "algorithm": "yachat-x3dh-v1",
        "protocolVersion": (
            rollout["minimumProtocolVersion"]
            if rollout["minimumProtocolVersion"] >= _PHASE5_VERSION
            else _PHASE3_VERSION
            if rollout["attachmentEncryptionReady"]
            else _PHASE2_VERSION
        ),
        "minimumProtocolVersion": rollout["minimumProtocolVersion"],
        "rolloutPhase": rollout["phase"],
        "attachmentEncryptionReady": rollout["attachmentEncryptionReady"],
        "epochId": str(epoch["id"]) if epoch else "",
        "epochVersion": int(epoch["version"]) if epoch else 0,
        "requiredDeviceIds": [str(item["deviceId"]) for item in (epoch["roster"] if epoch else [])],
        "missingDeviceUserIds": rollout["missingDeviceUserIds"],
        "unreadySessionUserIds": rollout["unreadySessionUserIds"],
        "phase3MissingDeviceUserIds": rollout["phase3MissingDeviceUserIds"],
        "phase3UnreadySessionUserIds": rollout["phase3UnreadySessionUserIds"],
        "bundles": bundles,
    }


@app.post("/api/message")
async def send_message(request: Request, background_tasks: BackgroundTasks):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    attachments = clean_attachments(payload.get("attachments"))
    user_id = str(user["id"])
    is_saved_chat = chat_id == "yachat-favorites"
    is_channel_post = chat_id == "yachat-channel"

    if is_channel_post:
        formatted_html, text = prepare_rich_message(payload)
        if not text and not attachments:
            raise HTTPException(status_code=400, detail="Enter a message.")
        body = text or attachment_body(attachments) or "Новое сообщение"
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
                {},
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
        with connection.transaction():
            with connection.cursor(row_factory=dict_row) as cursor:
                if is_saved_chat:
                    chat_id = ensure_saved_chat(cursor, user_id)
                chat = require_chat_member(cursor, chat_id, user_id)
                if not bool(row_value(chat, "can_send") if "can_send" in chat else True):
                    raise HTTPException(status_code=403, detail="This chat is read-only.")
                require_chat_messaging_allowed(cursor, chat, user_id)

                encrypted = parse_e2ee_message(payload.get("e2ee"), chat_id=chat_id, message_id=message_id)
                policy = str(row_value(chat, "e2ee_policy")) or "legacy"
                if encrypted["mode"] == "encrypted":
                    if str(payload.get("text") or "").strip() or str(payload.get("formattedHtml") or "").strip():
                        raise HTTPException(status_code=400, detail="Plaintext fields are forbidden for an encrypted message.")
                    if payload.get("replyToMessageId") or payload.get("forwardedFrom"):
                        raise HTTPException(status_code=400, detail="Encrypted reply metadata must stay inside the ciphertext.")
                    validate_encrypted_message(cursor, request, user_id=user_id, chat=chat, encrypted=encrypted)
                    validate_encrypted_attachment_transport(attachments, encrypted)
                    text = ""
                    formatted_html = ""
                    reply_to_message_id = None
                    forwarded_from = ""
                    push_plaintext = "Новое сообщение"
                else:
                    if policy == "text_encrypted":
                        raise HTTPException(
                            status_code=426,
                            detail="This private chat now requires E2EE phase 2. Update or reopen YaChat.",
                        )
                    formatted_html, text = prepare_rich_message(payload)
                    if not text and not attachments:
                        raise HTTPException(status_code=400, detail="Enter a message.")
                    reply_to_message_id = payload.get("replyToMessageId") or None
                    forwarded_from = str(payload.get("forwardedFrom") or "")[:160]
                    push_plaintext = text or attachment_body(attachments) or "Новое сообщение"
                    if encrypted["mode"] == "shadow":
                        if str(row_value(chat, "kind")) != "private":
                            raise HTTPException(status_code=400, detail="E2EE shadow messages are limited to private chats.")
                        validate_shadow_message(cursor, chat_id, user_id, encrypted)

                cursor.execute(
                    """
                    insert into yachat_messages(
                        id, chat_id, sender_id, text, formatted_html,
                        attachments, reply_to_message_id, forwarded_from,
                        e2ee_version, e2ee_mode, e2ee_ciphertext, e2ee_iv,
                        e2ee_aad, e2ee_envelopes, e2ee_sender_device_id,
                        e2ee_plaintext_digest, e2ee_epoch_id, e2ee_padding_scheme,
                        e2ee_envelope_digest, e2ee_sender_sign_public,
                        e2ee_signature, created_at
                    )
                    values (
                        %s, %s, %s, %s, %s, %s::jsonb, %s, %s,
                        %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s,
                        %s, %s, %s, %s, now()
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
                        reply_to_message_id,
                        forwarded_from,
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
    push_body = push_plaintext if chat_kind == "private" else f"{sender_name}: {push_plaintext}"
    sealed_push = encrypted["mode"] == "encrypted" and int(encrypted.get("version") or 0) >= _PHASE5_VERSION
    deliveries = []
    for recipient_id in recipients:
        if sealed_push:
            outer_title = "ЯЧат"
            outer_body = "Новое сообщение"
            outer_target = "/web"
            outer_tag = f"e2ee:{hash_secret(f'push-route:{message_id}:{recipient_id}')[:32]}"
        else:
            outer_title = push_title
            outer_body = push_body[:240]
            outer_target = push_target
            outer_tag = f"message:{message_id}:{recipient_id}"
        deliveries.append(
            (
                recipient_id,
                outer_title,
                outer_body,
                outer_target,
                outer_tag,
                encrypted_previews_for_user(encrypted, recipient_id),
            )
        )
    background_tasks.add_task(deliver_pushes_background, deliveries)

    rendered_message = attach_e2ee_payload(message_payload(message, user_id), message)
    return {
        "ok": True,
        "message": rendered_message,
        "inserted": inserted,
        "pushQueued": len(deliveries),
        "e2eeRolloutPhase": encrypted["mode"] if encrypted["mode"] != "legacy" else "legacy",
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
