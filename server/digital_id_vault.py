import base64
import hashlib
import hmac
import os
from typing import Any

from fastapi import HTTPException

from server.e2ee import (
    _decode_b64url,
    _text,
    identity_dh_signature_input,
    normalize_device_id,
    verify_ed25519,
)

_ALGORITHM = "yachat-x3dh-v1"
_DIGITAL_ID_CIPHERTEXT_BYTES = 272
_MAX_VAULT_ENVELOPES = 32


def _digital_id_lookup_secret() -> str:
    return (
        os.getenv("YACHAT_DIGITAL_ID_HMAC_SECRET")
        or os.getenv("YACHAT_AUTH_SECRET")
        or ""
    )


def digital_id_lookup_configured() -> bool:
    return len(_digital_id_lookup_secret()) >= 32


def digital_id_lookup_hash(value: str) -> str:
    normalized = str(value or "").strip().upper()
    secret = _digital_id_lookup_secret()
    if len(secret) < 32:
        raise HTTPException(
            status_code=503,
            detail="Digital ID private lookup is not configured.",
        )
    return hmac.new(
        secret.encode("utf-8"),
        b"yachat-digital-id-lookup-v1\x00" + normalized.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def digital_id_envelope_digest(envelopes: list[dict[str, str]]) -> str:
    fields = (
        "deviceId",
        "recipientIdentityKey",
        "recipientIdentitySignPublic",
        "recipientIdentityDhSignature",
        "ephemeralKey",
        "salt",
        "iv",
        "ciphertext",
    )
    material = "\n".join(
        "|".join(str(item.get(field) or "") for field in fields)
        for item in sorted(envelopes, key=lambda item: str(item.get("deviceId") or ""))
    )
    return base64.urlsafe_b64encode(hashlib.sha256(material.encode("utf-8")).digest()).decode(
        "ascii"
    ).rstrip("=")


def digital_id_signature_input(vault: dict[str, Any]) -> bytes:
    return (
        f"{_ALGORITHM}|digital-id-signature|v1|{vault['aad']}|{vault['iv']}|"
        f"{vault['ciphertext']}|{vault['plaintextDigest']}|{vault['envelopeDigest']}"
    ).encode("utf-8")


def parse_digital_id_vault(raw: Any, *, user_id: str) -> dict[str, Any]:
    if not isinstance(raw, dict) or int(raw.get("version") or 0) != 1:
        raise HTTPException(status_code=400, detail="Invalid encrypted Digital ID vault.")
    if _text(raw.get("algorithm"), 64) != _ALGORITHM:
        raise HTTPException(status_code=400, detail="Unsupported Digital ID encryption algorithm.")

    aad = _text(raw.get("aad"), 400)
    expected_aad = f"{_ALGORITHM}|digital-id|v1|{user_id}"
    if aad != expected_aad:
        raise HTTPException(status_code=400, detail="Digital ID vault context does not match the account.")

    raw_envelopes = raw.get("envelopes")
    if (
        not isinstance(raw_envelopes, list)
        or not raw_envelopes
        or len(raw_envelopes) > _MAX_VAULT_ENVELOPES
    ):
        raise HTTPException(status_code=400, detail="Invalid Digital ID recipient envelopes.")

    envelopes: list[dict[str, str]] = []
    device_ids: set[str] = set()
    for item in raw_envelopes:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Invalid Digital ID recipient envelope.")
        device_id = normalize_device_id(item.get("deviceId"))
        if device_id in device_ids:
            raise HTTPException(status_code=400, detail="Duplicate Digital ID recipient device.")
        device_ids.add(device_id)
        envelope = {
            "deviceId": device_id,
            "recipientIdentityKey": _decode_b64url(
                item.get("recipientIdentityKey"),
                field="Digital ID recipient identity key",
                expected={32},
            ),
            "recipientIdentitySignPublic": _decode_b64url(
                item.get("recipientIdentitySignPublic"),
                field="Digital ID recipient signing key",
                expected={32},
            ),
            "recipientIdentityDhSignature": _decode_b64url(
                item.get("recipientIdentityDhSignature"),
                field="Digital ID recipient identity DH signature",
                expected={64},
            ),
            "ephemeralKey": _decode_b64url(
                item.get("ephemeralKey"),
                field="Digital ID ephemeral key",
                expected={32},
            ),
            "salt": _decode_b64url(
                item.get("salt"),
                field="Digital ID envelope salt",
                expected={32},
            ),
            "iv": _decode_b64url(
                item.get("iv"),
                field="Digital ID envelope IV",
                expected={12},
            ),
            "ciphertext": _decode_b64url(
                item.get("ciphertext"),
                field="Digital ID wrapped content key",
                expected={48},
            ),
        }
        verify_ed25519(
            envelope["recipientIdentitySignPublic"],
            envelope["recipientIdentityDhSignature"],
            identity_dh_signature_input(device_id, envelope["recipientIdentityKey"]),
            field="Digital ID recipient identity DH key",
        )
        envelopes.append(envelope)

    calculated_digest = digital_id_envelope_digest(envelopes)
    envelope_digest = _text(raw.get("envelopeDigest"), 64)
    if envelope_digest != calculated_digest:
        raise HTTPException(status_code=400, detail="Digital ID envelope digest does not match.")

    return {
        "version": 1,
        "algorithm": _ALGORITHM,
        "ciphertext": _decode_b64url(
            raw.get("ciphertext"),
            field="Digital ID ciphertext",
            expected={_DIGITAL_ID_CIPHERTEXT_BYTES},
            max_chars=800,
        ),
        "iv": _decode_b64url(raw.get("iv"), field="Digital ID IV", expected={12}),
        "aad": aad,
        "envelopes": envelopes,
        "plaintextDigest": _decode_b64url(
            raw.get("plaintextDigest"),
            field="Digital ID plaintext digest",
            expected={32},
        ),
        "senderDeviceId": normalize_device_id(raw.get("senderDeviceId")),
        "senderIdentitySignPublic": _decode_b64url(
            raw.get("senderIdentitySignPublic"),
            field="Digital ID sender signing key",
            expected={32},
        ),
        "envelopeDigest": envelope_digest,
        "signature": _decode_b64url(
            raw.get("signature"),
            field="Digital ID vault signature",
            expected={64},
        ),
    }


def digital_id_vault_payload(row: dict[str, Any]) -> dict[str, Any]:
    envelopes = row.get("envelopes")
    return {
        "version": int(row.get("version") or 1),
        "algorithm": str(row.get("algorithm") or _ALGORITHM),
        "ciphertext": str(row.get("ciphertext") or ""),
        "iv": str(row.get("iv") or ""),
        "aad": str(row.get("aad") or ""),
        "envelopes": envelopes if isinstance(envelopes, list) else [],
        "plaintextDigest": str(row.get("plaintext_digest") or ""),
        "senderDeviceId": str(row.get("sender_device_id") or ""),
        "senderIdentitySignPublic": str(row.get("sender_identity_sign_public") or ""),
        "envelopeDigest": str(row.get("envelope_digest") or ""),
        "signature": str(row.get("signature") or ""),
    }
