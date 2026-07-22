"""Privacy-hardened YaChat Digital ID verification API.

The human-readable Digital ID is accepted only as a one-time lookup key. It is
never returned to third-party clients, written to auxiliary verification tables,
or included in verification messages. External services receive only a stable,
client-scoped subject after OTP and PKCE verification.
"""

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

from api.digital_id import (
    CHALLENGE_TTL_MINUTES,
    CLIENT_ID_PATTERN,
    IDENTITY_TOKEN_TTL_MINUTES,
    MAX_CODE_ATTEMPTS,
    PKCE_CHALLENGE_PATTERN,
    PKCE_VERIFIER_PATTERN,
    allowed_origins,
    base64url,
    clean_metadata,
    load_client,
    normalize_client_id,
    pkce_challenge,
    request_origin,
    stable_subject,
)
from api.index import (
    add_system_delivery_message,
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


app = FastAPI(title="YaChat Digital ID API", version="1.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-YaChat-API-Key"],
)


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("Pragma", "no-cache")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


def verified_identity(user: dict[str, Any], client_id: str) -> dict[str, Any]:
    """Return a client-scoped identity proof without exposing the lookup key."""
    return {
        "subject": stable_subject(client_id, str(user.get("user_id") or user.get("id") or "")),
        "displayName": clean_text(
            user.get("display_name") or user.get("preview_name") or user.get("username") or "Пользователь ЯЧата",
            80,
        ),
    }


def verification_message(client_name: str, purpose: str, code: str) -> tuple[str, str]:
    text = "\n".join(
        [
            "Код подтверждения цифрового ID",
            "",
            f"Сервис: {client_name}",
            f"Действие: {purpose}",
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
        f"Код: <code>{html.escape(code)}</code><br><br>"
        f"Код действует {CHALLENGE_TTL_MINUTES} минут.<br>"
        "<strong>Введите его только в указанном сервисе. Никому не пересылайте код.</strong>"
    )
    return text, formatted


def has_column(cursor, table_name: str, column_name: str) -> bool:
    cursor.execute(
        """
        select exists (
            select 1
            from information_schema.columns
            where table_schema = 'public' and table_name = %s and column_name = %s
        ) as present
        """,
        (table_name, column_name),
    )
    row = cursor.fetchone()
    return bool(row["present"] if isinstance(row, dict) else row[0])


def insert_challenge(
    cursor,
    *,
    challenge_id: str,
    client_id: str,
    user_id: str,
    code_hash: str,
    code_challenge: str,
    purpose: str,
    external_reference: str,
    metadata: dict[str, Any],
    origin: str,
    expires_at,
) -> None:
    if has_column(cursor, "yachat_identity_challenges", "digital_id"):
        cursor.execute(
            """
            insert into yachat_identity_challenges(
                id, client_id, user_id, digital_id, code_hash, code_challenge,
                purpose, external_reference, request_metadata, request_origin, expires_at
            )
            values (%s, %s, %s, '[redacted]', %s, %s, %s, %s, %s::jsonb, %s, %s)
            """,
            (
                challenge_id,
                client_id,
                user_id,
                code_hash,
                code_challenge,
                purpose,
                external_reference,
                json.dumps(metadata, ensure_ascii=False),
                origin,
                expires_at,
            ),
        )
        return

    cursor.execute(
        """
        insert into yachat_identity_challenges(
            id, client_id, user_id, code_hash, code_challenge,
            purpose, external_reference, request_metadata, request_origin, expires_at
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
        """,
        (
            challenge_id,
            client_id,
            user_id,
            code_hash,
            code_challenge,
            purpose,
            external_reference,
            json.dumps(metadata, ensure_ascii=False),
            origin,
            expires_at,
        ),
    )


def insert_transaction(
    cursor,
    *,
    transaction_id: str,
    challenge_id: str,
    client_id: str,
    user_id: str,
    subject: str,
    purpose: str,
    external_reference: str,
    metadata: dict[str, Any],
) -> None:
    if has_column(cursor, "yachat_identity_transactions", "digital_id"):
        cursor.execute(
            """
            insert into yachat_identity_transactions(
                id, challenge_id, client_id, user_id, subject, digital_id,
                purpose, external_reference, metadata
            )
            values (%s, %s, %s, %s, %s, '[redacted]', %s, %s, %s::jsonb)
            """,
            (
                transaction_id,
                challenge_id,
                client_id,
                user_id,
                subject,
                purpose,
                external_reference,
                json.dumps(metadata, ensure_ascii=False),
            ),
        )
        return

    cursor.execute(
        """
        insert into yachat_identity_transactions(
            id, challenge_id, client_id, user_id, subject,
            purpose, external_reference, metadata
        )
        values (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        """,
        (
            transaction_id,
            challenge_id,
            client_id,
            user_id,
            subject,
            purpose,
            external_reference,
            json.dumps(metadata, ensure_ascii=False),
        ),
    )


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
        "version": "1.1.0",
        "proof": "otp-pkce-one-time-token",
        "digitalIdExposure": "self-only",
    }


@app.post("/api/developer/v1/identity/initiate")
async def initiate_identity(request: Request):
    enforce_rate_limit(request, "digital-id-initiate", 10, 300)
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
            cursor.execute("select id from public_users where digital_id = %s limit 1", (digital_id,))
            user = cursor.fetchone()
            if not user:
                raise HTTPException(status_code=404, detail="YaChat Digital ID was not found.")
            user_id = str(user["id"])

            cursor.execute(
                """
                select count(*)
                from yachat_identity_challenges
                where client_id = %s and user_id = %s
                  and created_at > now() - interval '15 minutes'
                """,
                (client_id, user_id),
            )
            recent_count = int(cursor.fetchone()["count"])
            if recent_count >= 4:
                raise HTTPException(status_code=429, detail="Too many codes were requested. Try again later.")

            cursor.execute(
                """
                update yachat_identity_challenges
                set status = 'replaced'
                where client_id = %s and external_reference = %s and status = 'pending'
                """,
                (client_id, external_reference),
            )
            insert_challenge(
                cursor,
                challenge_id=challenge_id,
                client_id=client_id,
                user_id=user_id,
                code_hash=hash_secret(f"identity-code:{challenge_id}:{code}"),
                code_challenge=code_challenge,
                purpose=purpose,
                external_reference=external_reference,
                metadata=metadata,
                origin=origin,
                expires_at=expires_at,
            )
            message_text, message_html = verification_message(client_name, purpose, code)
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
    enforce_rate_limit(request, "digital-id-confirm", 20, 300)
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
                    select c.*, u.display_name, u.preview_name, u.username
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
                            set attempts = %s, status = 'verified', verified_at = now(),
                                identity_token_hash = %s, token_expires_at = %s
                            where id = %s
                            """,
                            (
                                attempts,
                                hash_secret(f"identity-token:{identity_token}"),
                                token_expires_at,
                                challenge_id,
                            ),
                        )
                        identity = verified_identity(dict(row), client_id)

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
    enforce_rate_limit(request, "digital-id-consume", 50, 300)
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
                        select c.*, u.display_name, u.preview_name, u.username
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

                    identity = verified_identity(dict(row), client_id)
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
                        return {
                            "verified": True,
                            "replayed": True,
                            "transactionId": str(transaction["id"]),
                            "externalReference": str(transaction["external_reference"]),
                            "purpose": str(transaction["purpose"]),
                            "identity": identity,
                        }
                    if row["status"] != "verified" or row["consumed_at"] is not None:
                        raise HTTPException(status_code=409, detail="This identity token is no longer active.")

                    metadata = {
                        "request": row["request_metadata"] if isinstance(row["request_metadata"], dict) else {},
                        "transaction": transaction_metadata,
                    }
                    insert_transaction(
                        cursor,
                        transaction_id=transaction_id,
                        challenge_id=str(row["id"]),
                        client_id=client_id,
                        user_id=str(row["user_id"]),
                        subject=str(identity["subject"]),
                        purpose=str(row["purpose"]),
                        external_reference=external_reference,
                        metadata=metadata,
                    )
                    cursor.execute(
                        "update yachat_identity_challenges set status = 'consumed', consumed_at = now() where id = %s",
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
