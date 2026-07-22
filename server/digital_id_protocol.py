"""Shared helpers for the YaChat Digital ID verification protocol."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import urllib.parse
from typing import Any

from fastapi import HTTPException, Request

from server.database import auth_secret

CHALLENGE_TTL_MINUTES = 10
IDENTITY_TOKEN_TTL_MINUTES = 10
MAX_CODE_ATTEMPTS = 5

CLIENT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
PKCE_CHALLENGE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,128}$")
PKCE_VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def normalize_client_id(value: Any) -> str:
    candidate = str(value or "").strip().lower()
    return candidate if CLIENT_ID_PATTERN.fullmatch(candidate) else ""


def pkce_challenge(verifier: str) -> str:
    return base64url(hashlib.sha256(str(verifier).encode("utf-8")).digest())


def stable_subject(client_id: str, user_id: str) -> str:
    digest = hmac.new(
        auth_secret().encode("utf-8"),
        f"digital-id-subject:{client_id}:{user_id}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64url(digest)


def request_origin(request: Request) -> str:
    origin = str(request.headers.get("origin") or "").strip().rstrip("/")
    if origin:
        return origin
    referer = str(request.headers.get("referer") or "").strip()
    if not referer:
        return ""
    parsed = urllib.parse.urlsplit(referer)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""


def allowed_origins(client: dict[str, Any]) -> set[str]:
    raw = client.get("allowed_origins") or []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = []
    return {
        str(origin).strip().rstrip("/")
        for origin in (raw if isinstance(raw, list) else [])
        if str(origin).strip() and str(origin).strip() != "*"
    }


def clean_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    for key, item in list(value.items())[:32]:
        clean_key = str(key or "").replace("\x00", "").strip()[:80]
        if not clean_key:
            continue
        if isinstance(item, (str, int, float, bool)) or item is None:
            result[clean_key] = str(item).replace("\x00", "")[:1000] if isinstance(item, str) else item
        elif isinstance(item, list):
            result[clean_key] = [
                str(entry).replace("\x00", "")[:300]
                for entry in item[:20]
                if isinstance(entry, (str, int, float, bool)) or entry is None
            ]
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    return result if len(encoded.encode("utf-8")) <= 8_000 else {}


def _secret_hash(value: str) -> str:
    return hmac.new(
        auth_secret().encode("utf-8"),
        value.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _origin_is_allowed(request: Request, client: dict[str, Any]) -> bool:
    origins = allowed_origins(client)
    origin = request_origin(request)
    return not origins or bool(origin and origin in origins)


def load_client(cursor, request: Request, client_id: str, *, browser_flow: bool) -> dict[str, Any]:
    normalized = normalize_client_id(client_id)
    if not normalized:
        raise HTTPException(status_code=400, detail="Invalid clientId.")

    cursor.execute(
        "select * from yachat_developer_clients where id = %s and active = true limit 1",
        (normalized,),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Unknown or inactive YaChat client.")
    client = dict(row)

    scopes = client.get("scopes") or []
    if isinstance(scopes, str):
        try:
            scopes = json.loads(scopes)
        except json.JSONDecodeError:
            scopes = []
    if "identity:verify" not in (scopes if isinstance(scopes, list) else []):
        raise HTTPException(status_code=403, detail="The client cannot verify identities.")

    secret_hash = str(client.get("secret_hash") or "")
    public_pkce = bool(client.get("public_pkce"))

    if browser_flow:
        if not public_pkce:
            raise HTTPException(status_code=403, detail="This client does not allow browser PKCE flows.")
        if not _origin_is_allowed(request, client):
            raise HTTPException(status_code=403, detail="This origin is not allowed for the YaChat client.")
        return client

    provided_secret = str(request.headers.get("x-yachat-api-key") or "").strip()
    if secret_hash:
        candidates = (
            _secret_hash(provided_secret),
            _secret_hash(f"developer-client:{normalized}:{provided_secret}"),
        ) if provided_secret else ()
        if not any(hmac.compare_digest(secret_hash, candidate) for candidate in candidates):
            raise HTTPException(status_code=401, detail="Invalid YaChat API key.")
    elif not public_pkce or not _origin_is_allowed(request, client):
        raise HTTPException(status_code=401, detail="A server API key is required for this client.")

    return client
