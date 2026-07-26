import base64
import hashlib
import json
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_KEY_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_EPOCH_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]+={0,2}$")
_CAPABILITY_RE = re.compile(r"^[a-z0-9._:-]{2,80}$")
_ALGORITHM = "yachat-x3dh-v1"
_PHASE2_CAPABILITY = "server-blind-text-v1"
_PHASE3_ATTACHMENT_CAPABILITY = "encrypted-attachments-v1"
_PHASE4_PUSH_CAPABILITY = "encrypted-push-preview-v1"
_PHASE5_CAPABILITIES = {
    "mandatory-e2ee-v1",
    "signed-messages-v1",
    "padded-content-v1",
    "sealed-push-descriptor-v1",
    "encrypted-digital-id-v1",
}
_ATTACHMENT_MODES = {"plaintext", "encrypted"}
_MAX_CIPHERTEXT_CHARS = 12_000_000
_MAX_ENVELOPES = 64
_PUSH_PREVIEW_CIPHERTEXT_BYTES = 1040
_PHASE5_CONTENT_CIPHERTEXT_BYTES = {
    528,
    1040,
    2064,
    4112,
    8208,
    16400,
    32784,
    65552,
}
_P256_FIELD = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_P256_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B


def _text(value: Any, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _decode_b64url(value: Any, *, field: str, expected: set[int], max_chars: int = 512) -> str:
    encoded = _text(value, max_chars)
    if not encoded:
        raise HTTPException(status_code=400, detail=f"Missing E2EE {field}.")
    if not _B64URL_RE.fullmatch(encoded):
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field}.")
    try:
        padded = encoded + "=" * ((4 - len(encoded) % 4) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field}.") from error
    if len(raw) not in expected:
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field} length.")
    return encoded.rstrip("=")


def _b64url_bytes(value: str) -> bytes:
    source = str(value or "")
    return base64.urlsafe_b64decode((source + "=" * ((4 - len(source) % 4) % 4)).encode("ascii"))


def verify_ed25519(public_key: str, signature: str, message: bytes, *, field: str) -> None:
    try:
        Ed25519PublicKey.from_public_bytes(_b64url_bytes(public_key)).verify(
            _b64url_bytes(signature),
            message,
        )
    except (InvalidSignature, ValueError, TypeError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field} signature.") from error


def _decode_p256_public(value: Any, *, field: str) -> str:
    encoded = _decode_b64url(value, field=field, expected={65})
    padded = encoded + "=" * ((4 - len(encoded) % 4) % 4)
    raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    if raw[0] != 4:
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field} format.")
    x = int.from_bytes(raw[1:33], "big")
    y = int.from_bytes(raw[33:65], "big")
    if (
        x >= _P256_FIELD
        or y >= _P256_FIELD
        or (pow(y, 2, _P256_FIELD) - (pow(x, 3, _P256_FIELD) - 3 * x + _P256_B))
        % _P256_FIELD
        != 0
    ):
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field} point.")
    return encoded


def normalize_device_id(value: Any) -> str:
    device_id = _text(value, 128)
    if not _DEVICE_ID_RE.fullmatch(device_id):
        raise HTTPException(status_code=400, detail="Invalid E2EE device id.")
    return device_id


def normalize_key_id(value: Any, field: str = "key id") -> str:
    key_id = _text(value, 128)
    if not _KEY_ID_RE.fullmatch(key_id):
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field}.")
    return key_id


def normalize_epoch_id(value: Any, required: bool = False) -> str:
    epoch_id = _text(value, 128)
    if not epoch_id and not required:
        return ""
    if not _EPOCH_ID_RE.fullmatch(epoch_id):
        raise HTTPException(status_code=400, detail="Invalid E2EE chat epoch id.")
    return epoch_id


def normalize_capabilities(value: Any) -> list[str]:
    raw = value if isinstance(value, list) else []
    result: list[str] = []
    seen: set[str] = set()
    for item in raw[:32]:
        capability = _text(item, 80).lower()
        if not capability or not _CAPABILITY_RE.fullmatch(capability) or capability in seen:
            continue
        seen.add(capability)
        result.append(capability)
    return result


def parse_device_registration(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid E2EE device bundle.")
    algorithm = _text(payload.get("algorithm"), 64) or _ALGORITHM
    if algorithm != _ALGORITHM:
        raise HTTPException(status_code=400, detail="Unsupported E2EE algorithm.")

    protocol_version = _integer(payload.get("protocolVersion"), 1)
    if protocol_version < 1 or protocol_version > 16:
        raise HTTPException(status_code=400, detail="Unsupported E2EE protocol version.")
    capabilities = normalize_capabilities(payload.get("capabilities"))
    if protocol_version >= 2 and _PHASE2_CAPABILITY not in capabilities:
        raise HTTPException(status_code=400, detail="Phase 2 E2EE capability is missing.")
    if protocol_version >= 3 and _PHASE3_ATTACHMENT_CAPABILITY not in capabilities:
        raise HTTPException(status_code=400, detail="Phase 3 encrypted-attachment capability is missing.")
    if protocol_version >= 4 and _PHASE4_PUSH_CAPABILITY not in capabilities:
        raise HTTPException(status_code=400, detail="Phase 4 encrypted-push capability is missing.")
    if protocol_version >= 5 and not _PHASE5_CAPABILITIES.issubset(set(capabilities)):
        raise HTTPException(status_code=400, detail="Phase 5 mandatory-E2EE capabilities are missing.")

    signed = payload.get("signedPreKey") if isinstance(payload.get("signedPreKey"), dict) else {}
    raw_prekeys = payload.get("oneTimePreKeys") if isinstance(payload.get("oneTimePreKeys"), list) else []
    prekeys: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw_prekeys[:100]:
        if not isinstance(item, dict):
            continue
        prekey_id = normalize_key_id(item.get("id"), "one-time prekey id")
        if prekey_id in seen:
            continue
        seen.add(prekey_id)
        prekeys.append({
            "id": prekey_id,
            "publicKey": _decode_b64url(item.get("publicKey"), field="one-time prekey", expected={32}),
        })

    push_preview = None
    if protocol_version >= 4:
        push_preview = {
            "publicKey": _decode_p256_public(
                payload.get("pushPreviewPublic"),
                field="push-preview public key",
            ),
            "signature": _decode_b64url(
                payload.get("pushPreviewSignature"),
                field="push-preview key signature",
                expected={64},
            ),
        }

    identity_sign_public = _decode_b64url(
        payload.get("identitySignPublic"),
        field="identity signing key",
        expected={32},
    )
    signed_prekey_public = _decode_b64url(
        signed.get("publicKey"),
        field="signed prekey",
        expected={32},
    )
    signed_prekey_signature = _decode_b64url(
        signed.get("signature"),
        field="signed prekey signature",
        expected={64},
    )
    if protocol_version >= 5:
        verify_ed25519(
            identity_sign_public,
            signed_prekey_signature,
            _b64url_bytes(signed_prekey_public),
            field="signed prekey",
        )
        if push_preview is None:
            raise HTTPException(status_code=400, detail="Phase 5 push descriptor key is missing.")
        verify_ed25519(
            identity_sign_public,
            push_preview["signature"],
            (
                f"{_ALGORITHM}|push-preview-key|v1|"
                f"{normalize_device_id(payload.get('deviceId'))}|{push_preview['publicKey']}"
            ).encode("utf-8"),
            field="push-preview key",
        )

    return {
        "deviceId": normalize_device_id(payload.get("deviceId")),
        "algorithm": algorithm,
        "protocolVersion": protocol_version,
        "capabilities": capabilities,
        "phase2Ready": protocol_version >= 2 and _PHASE2_CAPABILITY in capabilities,
        "phase3Ready": (
            protocol_version >= 3
            and _PHASE2_CAPABILITY in capabilities
            and _PHASE3_ATTACHMENT_CAPABILITY in capabilities
        ),
        "phase4Ready": (
            protocol_version >= 4
            and _PHASE2_CAPABILITY in capabilities
            and _PHASE3_ATTACHMENT_CAPABILITY in capabilities
            and _PHASE4_PUSH_CAPABILITY in capabilities
            and push_preview is not None
        ),
        "phase5Ready": (
            protocol_version >= 5
            and _PHASE5_CAPABILITIES.issubset(set(capabilities))
            and push_preview is not None
        ),
        "pushPreview": push_preview,
        "identityDhPublic": _decode_b64url(payload.get("identityDhPublic"), field="identity DH key", expected={32}),
        "identitySignPublic": identity_sign_public,
        "signedPreKey": {
            "id": normalize_key_id(signed.get("id"), "signed prekey id"),
            "publicKey": signed_prekey_public,
            "signature": signed_prekey_signature,
        },
        "oneTimePreKeys": prekeys,
    }


def expected_content_aad(
    *,
    version: int,
    chat_id: str,
    message_id: str,
    sender_device_id: str,
    epoch_id: str,
    attachment_mode: str = "plaintext",
) -> str:
    epoch = epoch_id or "shadow"
    base = f"{_ALGORITHM}|content|v{version}|{chat_id}|{message_id}|{sender_device_id}|{epoch}"
    return f"{base}|attachments-{attachment_mode}" if version >= 3 else base


def expected_push_preview_aad(
    *,
    version: int = 1,
    chat_id: str = "",
    message_id: str = "",
    sender_user_id: str = "",
    sender_device_id: str,
    recipient_user_id: str = "",
    recipient_device_id: str,
    recipient_push_preview_public: str,
    context_id: str = "",
) -> str:
    if version >= 2:
        return (
            f"{_ALGORITHM}|push-descriptor|v2|{context_id}|{sender_device_id}|"
            f"{recipient_device_id}|{recipient_push_preview_public}"
        )
    return (
        f"{_ALGORITHM}|push-preview|v1|{chat_id}|{message_id}|"
        f"{sender_user_id}|{sender_device_id}|{recipient_user_id}|{recipient_device_id}|"
        f"{recipient_push_preview_public}"
    )


def parse_push_previews(
    raw: Any,
    *,
    chat_id: str,
    message_id: str,
    sender_device_id: str,
) -> list[dict[str, Any]]:
    if raw in (None, "", []):
        return []
    if not isinstance(raw, list) or len(raw) > _MAX_ENVELOPES:
        raise HTTPException(status_code=400, detail="Invalid E2EE push-preview envelopes.")

    previews: list[dict[str, Any]] = []
    devices: set[str] = set()
    for item in raw:
        version = _integer(item.get("version"), 0) if isinstance(item, dict) else 0
        if not isinstance(item, dict) or version not in {1, 2}:
            raise HTTPException(status_code=400, detail="Invalid E2EE push-preview envelope.")
        device_id = normalize_device_id(item.get("deviceId"))
        if device_id in devices:
            raise HTTPException(status_code=400, detail="Duplicate E2EE push-preview device.")
        devices.add(device_id)
        sender_id = normalize_device_id(item.get("senderDeviceId"))
        if sender_id != sender_device_id:
            raise HTTPException(status_code=400, detail="E2EE push-preview sender device does not match.")
        sender_user_id = ""
        recipient_user_id = ""
        context_id = ""
        if version == 1:
            if (
                _text(item.get("chatId"), 160) != chat_id
                or _text(item.get("messageId"), 64) != message_id
            ):
                raise HTTPException(status_code=400, detail="E2EE push-preview context does not match.")
            sender_user_id = _text(item.get("senderUserId"), 128)
            recipient_user_id = _text(item.get("userId"), 128)
            if not sender_user_id or not recipient_user_id:
                raise HTTPException(status_code=400, detail="Missing E2EE push-preview user context.")
        else:
            if any(
                _text(item.get(field), 160)
                for field in ("chatId", "messageId", "senderUserId", "userId")
            ):
                raise HTTPException(status_code=400, detail="Sealed push descriptor leaks routing metadata.")
            context_id = _decode_b64url(
                item.get("contextId"),
                field="push descriptor context",
                expected={32},
            )
        recipient_push_preview_public = _decode_p256_public(
            item.get("recipientPushPreviewPublic"),
            field="push-preview recipient key",
        )
        aad = _text(item.get("aad"), 900)
        expected_aad = expected_push_preview_aad(
            version=version,
            chat_id=chat_id,
            message_id=message_id,
            sender_user_id=sender_user_id,
            sender_device_id=sender_device_id,
            recipient_user_id=recipient_user_id,
            recipient_device_id=device_id,
            recipient_push_preview_public=recipient_push_preview_public,
            context_id=context_id,
        )
        if aad != expected_aad:
            raise HTTPException(status_code=400, detail="E2EE push-preview associated data does not match.")

        previews.append({
            "version": version,
            "chatId": chat_id if version == 1 else "",
            "messageId": message_id if version == 1 else "",
            "contextId": context_id,
            "userId": recipient_user_id,
            "deviceId": device_id,
            "senderUserId": sender_user_id,
            "senderDeviceId": sender_device_id,
            "recipientPushPreviewPublic": recipient_push_preview_public,
            "senderIdentitySignPublic": _decode_b64url(
                item.get("senderIdentitySignPublic"),
                field="push-preview sender signing key",
                expected={32},
            ),
            "ephemeralKey": _decode_p256_public(
                item.get("ephemeralKey"),
                field="push-preview ephemeral key",
            ),
            "salt": _decode_b64url(item.get("salt"), field="push-preview salt", expected={32}),
            "iv": _decode_b64url(item.get("iv"), field="push-preview IV", expected={12}),
            "ciphertext": _decode_b64url(
                item.get("ciphertext"),
                field="push-preview ciphertext",
                expected={_PUSH_PREVIEW_CIPHERTEXT_BYTES},
                max_chars=1800,
            ),
            "aad": aad,
            "signature": _decode_b64url(
                item.get("signature"),
                field="push-preview signature",
                expected={64},
            ),
        })
    return previews


def push_preview_signature_input(preview: dict[str, Any]) -> bytes:
    return "|".join(
        str(preview.get(field) or "")
        for field in (
            "aad",
            "senderIdentitySignPublic",
            "ephemeralKey",
            "salt",
            "iv",
            "ciphertext",
        )
    ).encode("utf-8")


def canonical_roster(devices: list[dict[str, Any]]) -> list[dict[str, str]]:
    roster = [
        {
            "deviceId": str(item.get("device_id") or item.get("deviceId") or ""),
            "userId": str(item.get("user_id") or item.get("userId") or ""),
        }
        for item in devices
    ]
    roster = [item for item in roster if item["deviceId"] and item["userId"]]
    roster.sort(key=lambda item: (item["userId"], item["deviceId"]))
    return roster


def roster_digest(roster: list[dict[str, str]]) -> str:
    canonical = json.dumps(roster, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def envelope_digest(envelopes: list[dict[str, Any]]) -> str:
    fields = (
        "deviceId",
        "signedPreKeyId",
        "oneTimePreKeyId",
        "senderIdentityKey",
        "ephemeralKey",
        "salt",
        "iv",
        "ciphertext",
    )
    lines = [
        "|".join(str(item.get(field) or "") for field in fields)
        for item in sorted(envelopes, key=lambda item: str(item.get("deviceId") or ""))
    ]
    return base64.urlsafe_b64encode(
        hashlib.sha256("\n".join(lines).encode("utf-8")).digest()
    ).decode("ascii").rstrip("=")


def message_signature_input(parsed: dict[str, Any]) -> bytes:
    return (
        f"{_ALGORITHM}|message-signature|v1|{parsed['aad']}|{parsed['iv']}|"
        f"{parsed['ciphertext']}|{parsed['plaintextDigest']}|{parsed['envelopeDigest']}"
    ).encode("utf-8")


def parse_e2ee_message(raw: Any, *, chat_id: str, message_id: str) -> dict[str, Any]:
    legacy = {
        "version": 0,
        "mode": "legacy",
        "epochId": "",
        "ciphertext": "",
        "iv": "",
        "aad": "",
        "envelopes": [],
        "senderDeviceId": "",
        "plaintextDigest": "",
        "attachmentMode": "plaintext",
        "pushPreviews": [],
        "paddingScheme": "",
        "envelopeDigest": "",
        "senderIdentitySignPublic": "",
        "signature": "",
    }
    if raw in (None, "", {}):
        return legacy
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="Invalid E2EE message payload.")

    version = _integer(raw.get("version"), 0)
    mode = _text(raw.get("mode"), 16).lower()
    if version not in {1, 2, 3, 5} or mode not in {"shadow", "encrypted"}:
        raise HTTPException(status_code=400, detail="Unsupported E2EE message version.")
    if mode == "encrypted" and version < 2:
        raise HTTPException(status_code=400, detail="Server-blind messages require E2EE protocol version 2.")
    if _text(raw.get("chatId"), 160) != chat_id or _text(raw.get("messageId"), 64) != message_id:
        raise HTTPException(status_code=400, detail="E2EE message context does not match the request.")

    attachment_mode = _text(raw.get("attachmentMode"), 24).lower() or "plaintext"
    if attachment_mode not in _ATTACHMENT_MODES:
        raise HTTPException(status_code=400, detail="Unsupported E2EE attachment mode.")
    if version >= 3 and (mode != "encrypted" or attachment_mode != "encrypted"):
        raise HTTPException(status_code=400, detail="E2EE protocol version 3 requires encrypted attachments.")
    if version < 3 and attachment_mode != "plaintext":
        raise HTTPException(status_code=400, detail="Encrypted attachments require E2EE protocol version 3.")
    padding_scheme = _text(raw.get("paddingScheme"), 32).lower()
    if version >= 5 and padding_scheme != "bucket-v1":
        raise HTTPException(status_code=400, detail="E2EE protocol version 5 requires bucket padding.")
    if version < 5 and padding_scheme:
        raise HTTPException(status_code=400, detail="E2EE padding requires protocol version 5.")

    epoch_id = normalize_epoch_id(raw.get("epochId"), required=mode == "encrypted")
    sender_device_id = normalize_device_id(raw.get("senderDeviceId"))
    push_previews = parse_push_previews(
        raw.get("pushPreviews"),
        chat_id=chat_id,
        message_id=message_id,
        sender_device_id=sender_device_id,
    )
    if push_previews and mode != "encrypted":
        raise HTTPException(status_code=400, detail="E2EE push previews require server-blind encryption.")
    expected_aad = expected_content_aad(
        version=version,
        chat_id=chat_id,
        message_id=message_id,
        sender_device_id=sender_device_id,
        epoch_id=epoch_id,
        attachment_mode=attachment_mode,
    )
    aad = _text(raw.get("aad"), 900)
    legacy_shadow_aad = f"{_ALGORITHM}|content|{chat_id}|{message_id}|{sender_device_id}"
    accepted_legacy_shadow = mode == "shadow" and version == 1 and aad == legacy_shadow_aad
    if aad != expected_aad and not accepted_legacy_shadow:
        raise HTTPException(status_code=400, detail="E2EE associated data does not match the message context.")

    ciphertext = _text(raw.get("ciphertext"), _MAX_CIPHERTEXT_CHARS)
    if not ciphertext or len(ciphertext) >= _MAX_CIPHERTEXT_CHARS:
        raise HTTPException(status_code=413, detail="E2EE ciphertext is too large.")
    if not _B64URL_RE.fullmatch(ciphertext):
        raise HTTPException(status_code=400, detail="Invalid E2EE ciphertext.")
    try:
        padded = ciphertext + "=" * ((4 - len(ciphertext) % 4) % 4)
        decoded_ciphertext = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise HTTPException(status_code=400, detail="Invalid E2EE ciphertext.") from error
    if len(decoded_ciphertext) < 17:
        raise HTTPException(status_code=400, detail="Invalid E2EE ciphertext length.")
    if version >= 5 and len(decoded_ciphertext) not in _PHASE5_CONTENT_CIPHERTEXT_BYTES:
        raise HTTPException(status_code=400, detail="E2EE protocol version 5 ciphertext is not bucket padded.")

    raw_envelopes = raw.get("envelopes") if isinstance(raw.get("envelopes"), list) else []
    if not raw_envelopes or len(raw_envelopes) > _MAX_ENVELOPES:
        raise HTTPException(status_code=400, detail="Invalid E2EE recipient envelopes.")

    envelopes: list[dict[str, Any]] = []
    devices: set[str] = set()
    for item in raw_envelopes:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Invalid E2EE recipient envelope.")
        device_id = normalize_device_id(item.get("deviceId"))
        if device_id in devices:
            raise HTTPException(status_code=400, detail="Duplicate E2EE recipient device.")
        devices.add(device_id)
        user_id = _text(item.get("userId"), 128)
        if not user_id:
            raise HTTPException(status_code=400, detail="Missing E2EE recipient user id.")
        one_time_id = _text(item.get("oneTimePreKeyId"), 128)
        if one_time_id:
            one_time_id = normalize_key_id(one_time_id, "one-time prekey id")
        envelopes.append({
            "deviceId": device_id,
            "userId": user_id,
            "signedPreKeyId": normalize_key_id(item.get("signedPreKeyId"), "signed prekey id"),
            "oneTimePreKeyId": one_time_id,
            "senderIdentityKey": _decode_b64url(item.get("senderIdentityKey"), field="sender identity key", expected={32}),
            "ephemeralKey": _decode_b64url(item.get("ephemeralKey"), field="ephemeral key", expected={32}),
            "salt": _decode_b64url(item.get("salt"), field="envelope salt", expected={32}),
            "iv": _decode_b64url(item.get("iv"), field="envelope IV", expected={12}),
            "ciphertext": _decode_b64url(item.get("ciphertext"), field="wrapped content key", expected={48}),
        })

    calculated_envelope_digest = envelope_digest(envelopes)
    supplied_envelope_digest = _text(raw.get("envelopeDigest"), 64)
    sender_identity_sign_public = ""
    signature = ""
    if version >= 5:
        if supplied_envelope_digest != calculated_envelope_digest:
            raise HTTPException(status_code=400, detail="E2EE recipient envelope digest does not match.")
        sender_identity_sign_public = _decode_b64url(
            raw.get("senderIdentitySignPublic"),
            field="message sender signing key",
            expected={32},
        )
        signature = _decode_b64url(
            raw.get("signature"),
            field="message signature",
            expected={64},
        )

    return {
        "version": version,
        "mode": mode,
        "epochId": epoch_id,
        "ciphertext": ciphertext.rstrip("="),
        "iv": _decode_b64url(raw.get("iv"), field="message IV", expected={12}),
        "aad": aad,
        "envelopes": envelopes,
        "senderDeviceId": sender_device_id,
        "plaintextDigest": _decode_b64url(raw.get("plaintextDigest"), field="plaintext digest", expected={32}),
        "attachmentMode": attachment_mode,
        "pushPreviews": push_previews,
        "paddingScheme": padding_scheme,
        "envelopeDigest": supplied_envelope_digest if version >= 5 else calculated_envelope_digest,
        "senderIdentitySignPublic": sender_identity_sign_public,
        "signature": signature,
    }


def e2ee_message_columns(parsed: dict[str, Any]) -> tuple[Any, ...]:
    persisted_envelopes = [
        {key: value for key, value in envelope.items() if key != "userId"}
        if int(parsed["version"]) >= 5
        else envelope
        for envelope in parsed["envelopes"]
    ]
    return (
        int(parsed["version"]),
        str(parsed["mode"]),
        str(parsed["ciphertext"]),
        str(parsed["iv"]),
        str(parsed["aad"]),
        json.dumps(persisted_envelopes, ensure_ascii=False),
        str(parsed["senderDeviceId"]),
        str(parsed["plaintextDigest"]),
        str(parsed["epochId"]) or None,
        str(parsed.get("paddingScheme") or ""),
        str(parsed.get("envelopeDigest") or ""),
        str(parsed.get("senderIdentitySignPublic") or ""),
        str(parsed.get("signature") or ""),
    )


def e2ee_payload_from_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    mode = str(row.get("e2ee_mode") or "legacy")
    version = int(row.get("e2ee_version") or 0)
    if version <= 0 or mode == "legacy":
        return None
    envelopes = row.get("e2ee_envelopes") or []
    if isinstance(envelopes, str):
        try:
            envelopes = json.loads(envelopes)
        except json.JSONDecodeError:
            envelopes = []
    return {
        "version": version,
        "mode": mode,
        "epochId": str(row.get("e2ee_epoch_id") or ""),
        "ciphertext": str(row.get("e2ee_ciphertext") or ""),
        "iv": str(row.get("e2ee_iv") or ""),
        "aad": str(row.get("e2ee_aad") or ""),
        "envelopes": envelopes if isinstance(envelopes, list) else [],
        "senderDeviceId": str(row.get("e2ee_sender_device_id") or ""),
        "plaintextDigest": str(row.get("e2ee_plaintext_digest") or ""),
        "attachmentMode": "encrypted" if version >= 3 else "plaintext",
        "paddingScheme": str(row.get("e2ee_padding_scheme") or ""),
        "envelopeDigest": str(row.get("e2ee_envelope_digest") or ""),
        "senderIdentitySignPublic": str(row.get("e2ee_sender_sign_public") or ""),
        "signature": str(row.get("e2ee_signature") or ""),
    }


def attach_e2ee_payload(payload: dict[str, Any], row: dict[str, Any] | None) -> dict[str, Any]:
    encrypted = e2ee_payload_from_row(row)
    if encrypted:
        payload["e2ee"] = encrypted
        payload["encrypted"] = encrypted["mode"] == "encrypted"
        payload["e2eeShadow"] = encrypted["mode"] == "shadow"
    return payload
