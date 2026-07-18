import base64
import hashlib
import hmac
import json
import os
import urllib.parse
from typing import Any

from psycopg.rows import dict_row

from api.index import auth_secret, connect_db

P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_ALLOWED_CONTENT_ENCODINGS = {"aes128gcm", "aesgcm"}
_vapid_key_cache: tuple[str, str] | None = None


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_base64url(value: str) -> bytes:
    source = str(value or "").strip()
    padding = "=" * ((4 - len(source) % 4) % 4)
    return base64.urlsafe_b64decode(f"{source}{padding}".encode("ascii"))


def _normalize_private_key(value: str) -> str:
    source = str(value or "").strip()
    if not source:
        return ""

    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        if "BEGIN" in source:
            key = serialization.load_pem_private_key(source.encode("utf-8"), password=None)
        else:
            raw = _decode_base64url(source)
            if len(raw) == 32:
                return _base64url(raw)
            key = serialization.load_der_private_key(raw, password=None)

        if isinstance(key, ec.EllipticCurvePrivateKey):
            scalar = key.private_numbers().private_value
            return _base64url(scalar.to_bytes(32, "big"))
    except Exception:
        # pywebpush can also accept a key path or another supported representation.
        return source

    return source


def vapid_key_pair() -> tuple[str, str]:
    global _vapid_key_cache

    configured_public = os.getenv("YACHAT_VAPID_PUBLIC_KEY", "").strip()
    configured_private = os.getenv("YACHAT_VAPID_PRIVATE_KEY", "").strip()
    if configured_public and configured_private:
        return configured_public, _normalize_private_key(configured_private)
    if _vapid_key_cache:
        return _vapid_key_cache

    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
    except Exception:
        return "", ""

    seed = hmac.new(
        auth_secret().encode("utf-8"),
        b"yachat-web-push-v1",
        hashlib.sha256,
    ).digest()
    scalar = int.from_bytes(seed, "big") % (P256_ORDER - 1) + 1
    private_key = ec.derive_private_key(scalar, ec.SECP256R1())
    public_bytes = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )

    # Web Push expects the raw 32-byte P-256 secret multiplier, not a PKCS8 DER container.
    public_value = _base64url(public_bytes)
    private_value = _base64url(scalar.to_bytes(32, "big"))
    _vapid_key_cache = (public_value, private_value)
    return _vapid_key_cache


def vapid_public_key() -> str:
    return vapid_key_pair()[0]


def vapid_private_key() -> str:
    return vapid_key_pair()[1]


def vapid_subject() -> str:
    value = os.getenv("YACHAT_VAPID_SUBJECT", "").strip()
    if value.startswith(("mailto:", "https://", "http://")):
        return value
    return "https://yachat.vercel.app"


def _endpoint_host(endpoint: str) -> str:
    try:
        return urllib.parse.urlparse(endpoint).hostname or "unknown"
    except ValueError:
        return "invalid"


def _topic(value: str) -> str:
    source = str(value or "yachat").encode("utf-8")
    return _base64url(hashlib.sha256(source).digest())[:32]


def _log_push(event: str, **fields: Any) -> None:
    safe = {"event": event, **fields}
    print(json.dumps(safe, ensure_ascii=False, default=str), flush=True)


def push_subscription_count(user_id: str) -> int:
    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "select count(*) from yachat_push_subscriptions where user_id = %s",
                (user_id,),
            )
            row = cursor.fetchone()
            return int(row[0] if row else 0)


def send_push_to_user(
    user_id: str,
    title: str,
    body: str,
    url: str,
    *,
    tag: str = "",
    ttl_seconds: int = 86_400,
) -> dict[str, Any]:
    public_key, private_key = vapid_key_pair()
    result: dict[str, Any] = {
        "subscriptions": 0,
        "sent": 0,
        "failed": 0,
        "removed": 0,
    }
    if not public_key or not private_key:
        result["error"] = "vapid-unavailable"
        _log_push("push_skipped", userId=user_id, reason=result["error"])
        return result

    try:
        from pywebpush import WebPushException, webpush
    except Exception as error:
        result["error"] = "pywebpush-unavailable"
        _log_push("push_skipped", userId=user_id, reason=result["error"], detail=type(error).__name__)
        return result

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                "select * from yachat_push_subscriptions where user_id = %s order by updated_at desc",
                (user_id,),
            )
            subscriptions = [dict(row) for row in cursor.fetchall()]

    result["subscriptions"] = len(subscriptions)
    if not subscriptions:
        _log_push("push_skipped", userId=user_id, reason="no-subscriptions")
        return result

    notification_tag = tag or f"yachat:{url}"
    payload = json.dumps(
        {
            "title": str(title or "ЯЧат")[:120],
            "body": str(body or "Новое сообщение")[:300],
            "url": str(url or "/"),
            "tag": notification_tag,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    claims = {"sub": vapid_subject()}

    for subscription in subscriptions:
        endpoint = str(subscription.get("endpoint") or "")
        encoding = str(subscription.get("content_encoding") or "aes128gcm").lower()
        if encoding not in _ALLOWED_CONTENT_ENCODINGS:
            encoding = "aes128gcm"
        info = {
            "endpoint": endpoint,
            "keys": {
                "p256dh": str(subscription.get("p256dh") or ""),
                "auth": str(subscription.get("auth") or ""),
            },
        }
        try:
            response = webpush(
                subscription_info=info,
                data=payload,
                vapid_private_key=private_key,
                vapid_claims=dict(claims),
                ttl=max(60, min(int(ttl_seconds), 2_592_000)),
                content_encoding=encoding,
                headers={"Urgency": "high", "Topic": _topic(notification_tag)},
                timeout=8,
            )
            status_code = int(getattr(response, "status_code", 201) or 201)
            result["sent"] += 1
            _log_push(
                "push_sent",
                userId=user_id,
                host=_endpoint_host(endpoint),
                status=status_code,
                encoding=encoding,
            )
        except WebPushException as error:
            response = getattr(error, "response", None)
            status_code = getattr(response, "status_code", None)
            response_text = str(getattr(response, "text", "") or "")[:500]
            result["failed"] += 1
            if status_code in {404, 410}:
                with connect_db() as connection:
                    with connection.cursor() as cursor:
                        cursor.execute(
                            "delete from yachat_push_subscriptions where endpoint = %s",
                            (endpoint,),
                        )
                result["removed"] += 1
            _log_push(
                "push_failed",
                userId=user_id,
                host=_endpoint_host(endpoint),
                status=status_code,
                detail=response_text or str(error)[:500],
                encoding=encoding,
            )
        except Exception as error:
            result["failed"] += 1
            _log_push(
                "push_failed",
                userId=user_id,
                host=_endpoint_host(endpoint),
                status=None,
                detail=f"{type(error).__name__}: {str(error)[:500]}",
                encoding=encoding,
            )

    return result
