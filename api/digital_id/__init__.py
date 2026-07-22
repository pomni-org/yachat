"""Shared helpers for the YaChat Digital ID serverless handler.

This package is imported by the hardened handler but is not itself an HTTP
function. Keeping the helpers here lets the secure endpoint replace the legacy
entrypoint without increasing the Vercel function count.
"""

import base64
import hashlib
import hmac
import json
import re
from typing import Any

from fastapi import HTTPException, Request

from api.index import auth_secret, clean_text, hash_secret


CHALLENGE_TTL_MINUTES = 10
IDENTITY_TOKEN_TTL_MINUTES = 5
MAX_CODE_ATTEMPTS = 5
PKCE_CHALLENGE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,86}$")
PKCE_VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
CLIENT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def request_origin(request: Request) -> str:
    return clean_text(request.headers.get("origin"), 300).rstrip("/")


def normalize_client_id(value: Any) -> str:
    client_id = clean_text(value, 64).lower()
    return client_id if CLIENT_ID_PATTERN.fullmatch(client_id) else ""


def clean_metadata(value: Any, *, limit: int = 12_000) -> dict[str, Any]:
    if value in (None, ""):
        return {}
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="metadata must be a JSON object.")
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise HTTPException(status_code=400, detail="metadata must contain valid JSON values.") from error
    if len(encoded.encode("utf-8")) > limit:
        raise HTTPException(status_code=413, detail="metadata is too large.")
    return json.loads(encoded)


def allowed_origins(client: dict[str, Any]) -> set[str]:
    raw = client.get("allowed_origins") or []
    if not isinstance(raw, list):
        return set()
    return {str(origin).strip().rstrip("/") for origin in raw if str(origin).strip()}


def load_client(cursor, request: Request, client_id: str, *, browser_flow: bool) -> dict[str, Any]:
    cursor.execute(
        "select * from yachat_developer_clients where id = %s and active = true limit 1",
        (client_id,),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Unknown or inactive YaChat client.")
    client = dict(row)

    configured_hash = str(client.get("secret_hash") or "")
    api_key = clean_text(request.headers.get("x-yachat-api-key"), 500)
    if configured_hash:
        supplied_hash = hash_secret(f"developer-client:{client_id}:{api_key}") if api_key else ""
        if not supplied_hash or not hmac.compare_digest(configured_hash, supplied_hash):
            raise HTTPException(status_code=401, detail="Invalid YaChat API key.")
        return client

    if not bool(client.get("public_pkce")):
        raise HTTPException(status_code=503, detail="YaChat client authentication is not configured.")

    if browser_flow:
        origin = request_origin(request)
        if not origin or origin not in allowed_origins(client):
            raise HTTPException(status_code=403, detail="This origin is not allowed for the YaChat client.")
    return client


def pkce_challenge(verifier: str) -> str:
    return base64url(hashlib.sha256(verifier.encode("ascii")).digest())


def stable_subject(client_id: str, user_id: str) -> str:
    digest = hmac.new(
        auth_secret().encode("utf-8"),
        f"digital-id-subject-v1:{client_id}:{user_id}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return f"yachat_{base64url(digest)[:32]}"
