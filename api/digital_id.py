"""YaChat Digital ID and developer identity verification API.

The human-readable Digital ID is only a lookup key. A third-party service gets
proof of identity only after the YaChat user enters a one-time code delivered to
the built-in "Коды подтверждения" bot. The resulting identity token is short
lived, PKCE-bound, and can be consumed exactly once by the service server.
"""

import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import uuid
from datetime import timedelta
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    add_system_delivery_message,
    auth_secret,
    clean_text,
    configured_cors_origins,
    connect_db,
    enforce_rate_limit,
    ensure_schema,
    env_flag,
    format_digital_id,
    hash_secret,
    normalize_digital_id,
    read_json_payload,
    require_user,
    utc_now,
)
from server.push_delivery import send_push_to_user


app = FastAPI(title="YaChat Digital ID API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-YaChat-API-Key"],
)

CHALLENGE_TTL_MINUTES = 10
IDENTITY_TOKEN_TTL_MINUTES = 5
MAX_CODE_ATTEMPTS = 5
PKCE_CHALLENGE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43,86}$")
PKCE_VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
CLIENT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


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


def digital_id_message(client_name: str, purpose: str, digital_id: str, code: str) -> tuple[str, str]:
    display_id = format_digital_id(digital_id)
    text = "\n".join(
        [
            "Код подтверждения цифрового ID",
            "",
            f"Сервис: {client_name}",
            f"Действие: {purpose}",
            f"Цифровой ID: {display_id}",
            f"Код: {code}",
            "",
            f"Код действует {CHALLENGE_TTL_MINUTES} минут.",
            "Введите его только в указанном сервисе. Никому не пересылайте код.",
        ]
    )
    formatted = (
        "<strong>Код подтверждения цифрового ID</strong><br><br>"
        f"Сервис: <strong>{html.escape(client_name)}</strong><br>"
        f"Действие: {html.escape(purpose)}<br>"
        f"Цифровой ID: <strong>{html.escape(display_id)}</strong><br>"
        f"Код: <code>{html.escape(code)}</code><br><br>"
        f"Код действует {CHALLENGE_TTL_MINUTES} минут.<br>"
        "<strong>Введите его только в указанном сервисе. Никому не пересылайте код.</strong>"
    )
    return text, formatted


def public_identity(user: dict[str, Any], client_id: str) -> dict[str, Any]:
    raw_id = normalize_digital_id(user.get("digital_id"))
    return {
        "subject": stable_subject(client_id, str(user.get("id") or "")),
        "displayName": clean_text(
            user.get("display_name") or user.get("preview_name") or user.get("username") or "Пользователь ЯЧата",
            80,
        ),
        "digitalId": format_digital_id(raw_id),
        "rawDigitalId": raw_id,
    }


@app.get("/api/digital-id")
def get_digital_id(request: Request):
    user = require_user(request)
    raw_id = normalize_digital_id(user.get("digital_id"))
    if not raw_id:
        raise HTTPException(status_code=503, detail="Digital ID is temporarily unavailable.")
    return {
        "digitalId": format_digital_id(raw_id),
        "rawDigitalId": raw_id,
        "createdAt": user.get("created_at"),
    }


@app.get("/api/developer/v1/health")
def developer_health():
    ensure_schema()
    return {
        "ok": True,
        "service": "yachat-digital-id",
        "version": "1.0.0",
        "proof": "otp-pkce-one-time-token",
    }


@app.post("/api/developer/v1/identity/initiate")
async def initiate_identity(request: Request):
    enforce_rate_limit(request, "digital-id-initiate", 12, 300)
    ensure_schema()
    payload = await read_json_payload(request, 50_000)
    client_id = normalize_client_id(payload.get("clientId"))
    digital_id = normalize_digital_id(payload.get("digitalId"))
    code_challenge = clean_text(payload.get("codeChallenge"), 100)
    external_reference = clean_text(payload.get("externalReference"), 120)
    purpose = clean_text(payload.get("purpose"), 120) or "Подтверждение личности"
    metadata = clean_metadata(payload.get("metadata"))
    if not client_id or not digital_id:
        raise HTTPException(status_code=400, detail="Enter a valid clientId and YaChat Digital ID.")
    if not PKCE_CHALLENGE_PATTERN.fullmatch(code_challenge):
        raise HTTPException(status_code=400, detail="A valid PKCE S256 codeChallenge is required.")
    if not external_reference:
        raise HTTPException(status_code=400, detail="externalReference is required.")

    code = f"{secrets.randbelow(900000) + 100000}"
    challenge_id = str(uuid.uuid4())
    expires_at = utc_now() + timedelta(minutes=CHALLENGE_TTL_MINUTES)
    origin = request_origin(request)
    client_name = ""
    user_id = ""

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            client = load_client(cursor, request, client_id, browser_flow=True)
            client_name = clean_text(client.get("name"), 80) or client_id
            cursor.execute(
                "select * from public_users where digital_id = %s limit 1",
                (digital_id,),
            )
            user = cursor.fetchone()
            if not user:
                raise HTTPException(status_code=404, detail="YaChat Digital ID was not found.")
            user_id = str(user["id"])

            cursor.execute(
                """
                select count(*)
                from yachat_identity_challenges
                where client_id = %s
                  and user_id = %s
                  and created_at > now() - interval '15 minutes'
                """,
                (client_id, user_id),
            )
            recent_count = int(cursor.fetchone()["count"])
            if recent_count >= 5:
                raise HTTPException(status_code=429, detail="Too many codes were requested. Try again later.")

            cursor.execute(
                """
                update yachat_identity_challenges
                set status = 'replaced'
                where client_id = %s
                  and external_reference = %s
                  and status = 'pending'
                """,
                (client_id, external_reference),
            )
            cursor.execute(
                """
                insert into yachat_identity_challenges(
                    id, client_id, user_id, digital_id, code_hash, code_challenge,
                    purpose, external_reference, request_metadata, request_origin, expires_at
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                """,
                (
                    challenge_id,
                    client_id,
                    user_id,
                    digital_id,
                    hash_secret(f"identity-code:{challenge_id}:{code}"),
                    code_challenge,
                    purpose,
                    external_reference,
                    json.dumps(metadata, ensure_ascii=False),
                    origin,
                    expires_at,
                ),
            )
            message_text, message_html = digital_id_message(client_name, purpose, digital_id, code)
            add_system_delivery_message(
                cursor,
                user_id,
                "yachat-codes",
                message_text,
                expires_at,
                message_html,
            )

    push = send_push_to_user(
        user_id,
        "Коды подтверждения",
        f"{client_name} запрашивает подтверждение цифрового ID",
        "/verificationcodes_bot",
        tag=f"digital-id:{challenge_id}",
        ttl_seconds=CHALLENGE_TTL_MINUTES * 60,
    )
    result: dict[str, Any] = {
        "challengeId": challenge_id,
        "status": "code_sent",
        "delivery": "yachat-codes",
        "expiresAt": expires_at,
        "client": {"id": client_id, "name": client_name},
        "push": {"sent": int(push.get("sent") or 0)},
    }
    if env_flag("YACHAT_RETURN_DEV_CODE", False) and os.getenv("VERCEL_ENV") != "production":
        result["devCode"] = code
    return result


@app.post("/api/developer/v1/identity/confirm")
async def confirm_identity(request: Request):
    enforce_rate_limit(request, "digital-id-confirm", 24, 300)
    ensure_schema()
    payload = await read_json_payload(request, 30_000)
    client_id = normalize_client_id(payload.get("clientId"))
    challenge_id = clean_text(payload.get("challengeId"), 80)
    code = re.sub(r"\D+", "", str(payload.get("code") or ""))[:6]
    verifier = clean_text(payload.get("codeVerifier"), 128)
    if not client_id or not challenge_id or len(code) != 6:
        raise HTTPException(status_code=400, detail="clientId, challengeId, and the six-digit code are required.")
    if not PKCE_VERIFIER_PATTERN.fullmatch(verifier):
        raise HTTPException(status_code=400, detail="A valid PKCE codeVerifier is required.")

    identity_token = secrets.token_urlsafe(48)
    token_expires_at = utc_now() + timedelta(minutes=IDENTITY_TOKEN_TTL_MINUTES)
    failure: tuple[int, str] | None = None
    identity: dict[str, Any] | None = None

    with connect_db() as connection:
        with connection.transaction():
            with connection.cursor(row_factory=dict_row) as cursor:
                load_client(cursor, request, client_id, browser_flow=True)
                cursor.execute(
                    """
                    select c.*, u.display_name, u.preview_name, u.username, u.digital_id
                    from yachat_identity_challenges c
                    join public_users u on u.id = c.user_id
                    where c.id = %s and c.client_id = %s
                    for update
                    """,
                    (challenge_id, client_id),
                )
                row = cursor.fetchone()
                if not row:
                    failure = (404, "Identity challenge was not found.")
                elif row["status"] != "pending":
                    failure = (409, "This identity challenge is no longer active.")
                elif row["expires_at"] <= utc_now():
                    cursor.execute(
                        "update yachat_identity_challenges set status = 'expired' where id = %s",
                        (challenge_id,),
                    )
                    failure = (410, "The confirmation code has expired.")
                elif not hmac.compare_digest(str(row["code_challenge"]), pkce_challenge(verifier)):
                    failure = (401, "PKCE verification failed.")
                else:
                    attempts = int(row["attempts"] or 0) + 1
                    expected_hash = hash_secret(f"identity-code:{challenge_id}:{code}")
                    if not hmac.compare_digest(str(row["code_hash"]), expected_hash):
                        status = "locked" if attempts >= MAX_CODE_ATTEMPTS else "pending"
                        cursor.execute(
                            "update yachat_identity_challenges set attempts = %s, status = %s where id = %s",
                            (attempts, status, challenge_id),
                        )
                        failure = (
                            429 if status == "locked" else 401,
                            "Too many incorrect codes." if status == "locked" else "Incorrect confirmation code.",
                        )
                    else:
                        cursor.execute(
                            """
                            update yachat_identity_challenges
                            set attempts = %s,
                                status = 'verified',
                                verified_at = now(),
                                identity_token_hash = %s,
                                token_expires_at = %s
                            where id = %s
                            """,
                            (
                                attempts,
                                hash_secret(f"identity-token:{identity_token}"),
                                token_expires_at,
                                challenge_id,
                            ),
                        )
                        identity = public_identity(dict(row), client_id)

    if failure:
        raise HTTPException(status_code=failure[0], detail=failure[1])
    return {
        "verified": True,
        "identityToken": identity_token,
        "expiresAt": token_expires_at,
        "identity": identity,
    }


@app.post("/api/developer/v1/identity/consume")
async def consume_identity(request: Request):
    enforce_rate_limit(request, "digital-id-consume", 60, 300)
    ensure_schema()
    payload = await read_json_payload(request, 50_000)
    client_id = normalize_client_id(payload.get("clientId"))
    identity_token = clean_text(payload.get("identityToken"), 300)
    verifier = clean_text(payload.get("codeVerifier"), 128)
    external_reference = clean_text(payload.get("externalReference"), 120)
    transaction_metadata = clean_metadata(payload.get("metadata"))
    if not client_id or not identity_token or not external_reference:
        raise HTTPException(status_code=400, detail="clientId, identityToken, and externalReference are required.")
    if not PKCE_VERIFIER_PATTERN.fullmatch(verifier):
        raise HTTPException(status_code=400, detail="A valid PKCE codeVerifier is required.")

    token_hash = hash_secret(f"identity-token:{identity_token}")
    transaction_id = str(uuid.uuid4())
    result: dict[str, Any] | None = None

    try:
        with connect_db() as connection:
            with connection.transaction():
                with connection.cursor(row_factory=dict_row) as cursor:
                    load_client(cursor, request, client_id, browser_flow=False)
                    cursor.execute(
                        """
                        select c.*, u.display_name, u.preview_name, u.username, u.digital_id
                        from yachat_identity_challenges c
                        join public_users u on u.id = c.user_id
                        where c.identity_token_hash = %s and c.client_id = %s
                        for update
                        """,
                        (token_hash, client_id),
                    )
                    row = cursor.fetchone()
                    if not row:
                        raise HTTPException(status_code=401, detail="Invalid identity token.")
                    if not row["token_expires_at"] or row["token_expires_at"] <= utc_now():
                        raise HTTPException(status_code=410, detail="The identity token has expired.")
                    if str(row["external_reference"] or "") != external_reference:
                        raise HTTPException(status_code=409, detail="externalReference does not match the identity challenge.")
                    if not hmac.compare_digest(str(row["code_challenge"]), pkce_challenge(verifier)):
                        raise HTTPException(status_code=401, detail="PKCE verification failed.")

                    identity = public_identity(dict(row), client_id)
                    if row["status"] == "consumed" and row["consumed_at"] is not None:
                        cursor.execute(
                            """
                            select id, purpose, external_reference
                            from yachat_identity_transactions
                            where challenge_id = %s and client_id = %s
                            limit 1
                            """,
                            (row["id"], client_id),
                        )
                        transaction = cursor.fetchone()
                        if not transaction:
                            raise HTTPException(status_code=409, detail="This identity token has already been consumed.")
                        result = {
                            "verified": True,
                            "replayed": True,
                            "transactionId": str(transaction["id"]),
                            "externalReference": str(transaction["external_reference"]),
                            "purpose": str(transaction["purpose"]),
                            "identity": identity,
                        }
                        return result
                    if row["status"] != "verified" or row["consumed_at"] is not None:
                        raise HTTPException(status_code=409, detail="This identity token is no longer active.")

                    metadata = {
                        "request": row["request_metadata"] if isinstance(row["request_metadata"], dict) else {},
                        "transaction": transaction_metadata,
                    }
                    cursor.execute(
                        """
                        insert into yachat_identity_transactions(
                            id, challenge_id, client_id, user_id, subject, digital_id,
                            purpose, external_reference, metadata
                        )
                        values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                        """,
                        (
                            transaction_id,
                            row["id"],
                            client_id,
                            row["user_id"],
                            identity["subject"],
                            identity["rawDigitalId"],
                            row["purpose"],
                            external_reference,
                            json.dumps(metadata, ensure_ascii=False),
                        ),
                    )
                    cursor.execute(
                        """
                        update yachat_identity_challenges
                        set status = 'consumed', consumed_at = now()
                        where id = %s
                        """,
                        (row["id"],),
                    )
                    result = {
                        "verified": True,
                        "transactionId": transaction_id,
                        "externalReference": external_reference,
                        "purpose": row["purpose"],
                        "identity": identity,
                    }
    except psycopg.errors.UniqueViolation as error:
        raise HTTPException(status_code=409, detail="externalReference has already been used.") from error

    if not result:
        raise HTTPException(status_code=500, detail="Identity transaction could not be created.")
    return result


@app.get("/api/developer/v1/openapi.json")
def developer_openapi():
    return app.openapi()
