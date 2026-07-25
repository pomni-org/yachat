import base64
import json
import re
from typing import Any

from fastapi import HTTPException

_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_KEY_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_ALGORITHM = "yachat-x3dh-v1"
_MAX_CIPHERTEXT_CHARS = 12_000_000
_MAX_ENVELOPES = 64


def _text(value: Any, limit: int) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]


def _decode_b64url(value: Any, *, field: str, expected: set[int], max_chars: int = 512) -> str:
    encoded = _text(value, max_chars)
    if not encoded:
        raise HTTPException(status_code=400, detail=f"Missing E2EE {field}.")
    try:
        padded = encoded + "=" * ((4 - len(encoded) % 4) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field}.") from error
    if len(raw) not in expected:
        raise HTTPException(status_code=400, detail=f"Invalid E2EE {field} length.")
    return encoded.rstrip("=")


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


def parse_device_registration(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid E2EE device bundle.")
    algorithm = _text(payload.get("algorithm"), 64) or _ALGORITHM
    if algorithm != _ALGORITHM:
        raise HTTPException(status_code=400, detail="Unsupported E2EE algorithm.")

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

    return {
        "deviceId": normalize_device_id(payload.get("deviceId")),
        "algorithm": algorithm,
        "identityDhPublic": _decode_b64url(payload.get("identityDhPublic"), field="identity DH key", expected={32}),
        "identitySignPublic": _decode_b64url(payload.get("identitySignPublic"), field="identity signing key", expected={32}),
        "signedPreKey": {
            "id": normalize_key_id(signed.get("id"), "signed prekey id"),
            "publicKey": _decode_b64url(signed.get("publicKey"), field="signed prekey", expected={32}),
            "signature": _decode_b64url(signed.get("signature"), field="signed prekey signature", expected={64}),
        },
        "oneTimePreKeys": prekeys,
    }


def parse_e2ee_message(raw: Any, *, chat_id: str, message_id: str) -> dict[str, Any]:
    legacy = {
        "version": 0,
        "mode": "legacy",
        "ciphertext": "",
        "iv": "",
        "aad": "",
        "envelopes": [],
        "senderDeviceId": "",
        "plaintextDigest": "",
    }
    if raw in (None, "", {}):
        return legacy
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail="Invalid E2EE message payload.")

    version = int(raw.get("version") or 0)
    mode = _text(raw.get("mode"), 16).lower()
    if version != 1 or mode not in {"shadow", "encrypted"}:
        raise HTTPException(status_code=400, detail="Unsupported E2EE message version.")
    if _text(raw.get("chatId"), 160) != chat_id or _text(raw.get("messageId"), 64) != message_id:
        raise HTTPException(status_code=400, detail="E2EE message context does not match the request.")

    ciphertext = _text(raw.get("ciphertext"), _MAX_CIPHERTEXT_CHARS)
    if not ciphertext or len(ciphertext) >= _MAX_CIPHERTEXT_CHARS:
        raise HTTPException(status_code=413, detail="E2EE ciphertext is too large.")
    try:
        padded = ciphertext + "=" * ((4 - len(ciphertext) % 4) % 4)
        decoded_ciphertext = base64.urlsafe_b64decode(padded.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise HTTPException(status_code=400, detail="Invalid E2EE ciphertext.") from error
    if len(decoded_ciphertext) < 17:
        raise HTTPException(status_code=400, detail="Invalid E2EE ciphertext length.")

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
        one_time_id = _text(item.get("oneTimePreKeyId"), 128)
        if one_time_id:
            one_time_id = normalize_key_id(one_time_id, "one-time prekey id")
        envelopes.append({
            "deviceId": device_id,
            "userId": _text(item.get("userId"), 128),
            "signedPreKeyId": normalize_key_id(item.get("signedPreKeyId"), "signed prekey id"),
            "oneTimePreKeyId": one_time_id,
            "senderIdentityKey": _decode_b64url(item.get("senderIdentityKey"), field="sender identity key", expected={32}),
            "ephemeralKey": _decode_b64url(item.get("ephemeralKey"), field="ephemeral key", expected={32}),
            "salt": _decode_b64url(item.get("salt"), field="envelope salt", expected={32}),
            "iv": _decode_b64url(item.get("iv"), field="envelope IV", expected={12}),
            "ciphertext": _decode_b64url(item.get("ciphertext"), field="wrapped content key", expected={48}),
        })

    return {
        "version": version,
        "mode": mode,
        "ciphertext": ciphertext.rstrip("="),
        "iv": _decode_b64url(raw.get("iv"), field="message IV", expected={12}),
        "aad": _text(raw.get("aad"), 800),
        "envelopes": envelopes,
        "senderDeviceId": normalize_device_id(raw.get("senderDeviceId")),
        "plaintextDigest": _decode_b64url(raw.get("plaintextDigest"), field="plaintext digest", expected={32}),
    }


def e2ee_message_columns(parsed: dict[str, Any]) -> tuple[Any, ...]:
    return (
        int(parsed["version"]),
        str(parsed["mode"]),
        str(parsed["ciphertext"]),
        str(parsed["iv"]),
        str(parsed["aad"]),
        json.dumps(parsed["envelopes"], ensure_ascii=False),
        str(parsed["senderDeviceId"]),
        str(parsed["plaintextDigest"]),
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
        "ciphertext": str(row.get("e2ee_ciphertext") or ""),
        "iv": str(row.get("e2ee_iv") or ""),
        "aad": str(row.get("e2ee_aad") or ""),
        "envelopes": envelopes if isinstance(envelopes, list) else [],
        "senderDeviceId": str(row.get("e2ee_sender_device_id") or ""),
        "plaintextDigest": str(row.get("e2ee_plaintext_digest") or ""),
    }


def attach_e2ee_payload(payload: dict[str, Any], row: dict[str, Any] | None) -> dict[str, Any]:
    encrypted = e2ee_payload_from_row(row)
    if encrypted:
        payload["e2ee"] = encrypted
        payload["encrypted"] = encrypted["mode"] == "encrypted"
        payload["e2eeShadow"] = encrypted["mode"] == "shadow"
    return payload
