"""Owner-only encrypted YaChat Digital ID vault and privacy-safe lookup."""

import json
import re
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from psycopg.rows import dict_row

from api.index import (
    connect_db,
    enforce_rate_limit,
    ensure_schema,
    hash_secret,
    public_user,
    read_json_payload,
    request_token,
    require_user,
)
from server.digital_id_vault import (
    digital_id_lookup_hash,
    digital_id_signature_input,
    digital_id_vault_payload,
    parse_digital_id_vault,
)
from server.e2ee import normalize_device_id, verify_ed25519


LATIN_DIGITAL_ID = re.compile(
    r"^(?:[ABCDEFGHJKLMNPQRSTUVWXYZ]{2}[0-9]{4}|[ABCDEFGHJKLMNPQRSTUVWXYZ]{3}[0-9]{3})$"
)
CYRILLIC_DIGITAL_ID = re.compile(
    r"^(?:[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{2}[0-9]{4}|[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ]{3}[0-9]{3})$"
)
PHASE5_CAPABILITIES = [
    "mandatory-e2ee-v1",
    "signed-messages-v1",
    "padded-content-v1",
    "sealed-push-descriptor-v1",
    "encrypted-digital-id-v1",
]

app = FastAPI(
    title="YaChat private Digital ID boundary",
    version="2.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "private, no-store")
    response.headers.setdefault("Pragma", "no-cache")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


def normalize_digital_id(value: Any) -> str:
    normalized = re.sub(r"[^A-ZА-ЯЁ0-9]+", "", str(value or "").upper()).replace("Ё", "Е")
    if normalized.startswith("YC") and len(normalized) == 8:
        normalized = normalized[2:]
    normalized = normalized[:6]
    return normalized if len(normalized) == 6 and (
        LATIN_DIGITAL_ID.fullmatch(normalized) or CYRILLIC_DIGITAL_ID.fullmatch(normalized)
    ) else ""


def format_digital_id(value: Any) -> str:
    normalized = normalize_digital_id(value)
    return f"{normalized[:3]} — {normalized[3:]}" if normalized else ""


def sql_like(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def require_phase5_device(cursor, request: Request, user_id: str) -> dict[str, Any]:
    device_id = normalize_device_id(request.headers.get("x-yachat-e2ee-device"))
    token = request_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in first.")
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
          and s.e2ee_version >= 5
          and d.revoked_at is null
          and d.ready_at is not null
          and d.protocol_version >= 5
          and d.capabilities ?& %s
        limit 1
        """,
        (hash_secret(token), user_id, device_id, PHASE5_CAPABILITIES),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=426, detail="Register a phase 5 E2EE device first.")
    return dict(row)


def account_device_bundles(cursor, user_id: str) -> list[dict[str, str]]:
    cursor.execute(
        """
        select device_id, identity_dh_public, identity_sign_public
        from yachat_e2ee_devices
        where user_id = %s
          and revoked_at is null
          and ready_at is not null
          and protocol_version >= 5
          and capabilities ?& %s
          and last_seen_at > now() - interval '90 days'
        order by device_id
        """,
        (user_id, PHASE5_CAPABILITIES),
    )
    return [
        {
            "deviceId": str(row["device_id"]),
            "identityDhPublic": str(row["identity_dh_public"]),
            "identitySignPublic": str(row["identity_sign_public"]),
        }
        for row in cursor.fetchall()
    ]


def owned_digital_id(request: Request) -> dict[str, object]:
    user = require_user(request)
    user_id = str(user.get("id") or "")
    if not user_id:
        raise HTTPException(status_code=401, detail="Sign in first.")

    ensure_schema()
    try:
        with connect_db() as connection:
            with connection.transaction():
                with connection.cursor(row_factory=dict_row) as cursor:
                    require_phase5_device(cursor, request, user_id)
                    cursor.execute(
                        "select * from yachat_digital_id_vaults where user_id = %s limit 1",
                        (user_id,),
                    )
                    vault = cursor.fetchone()
                    if vault:
                        return {
                            "e2eeVault": digital_id_vault_payload(dict(vault)),
                            "createdAt": user.get("created_at"),
                            "immutable": True,
                            "migrationComplete": True,
                        }

                    cursor.execute(
                        "select digital_id from public_users where id = %s for update",
                        (user_id,),
                    )
                    row = cursor.fetchone()
                    if row and not normalize_digital_id(row.get("digital_id")):
                        cursor.execute(
                            """
                            update public_users
                            set digital_id = public.yachat_generate_digital_id(),
                                updated_at = now()
                            where id = %s and digital_id is null
                            returning digital_id
                            """,
                            (user_id,),
                        )
                        row = cursor.fetchone() or row
                    raw_id = normalize_digital_id(row.get("digital_id") if row else "")
                    if not raw_id:
                        raise HTTPException(
                            status_code=503,
                            detail="Digital ID is temporarily unavailable.",
                        )
                    bundles = account_device_bundles(cursor, user_id)
                    if not bundles:
                        raise HTTPException(status_code=426, detail="No phase 5 Digital ID device is active.")
                    return {
                        "migrationRequired": True,
                        "migrationDigitalId": raw_id,
                        "deviceBundles": bundles,
                        "createdAt": user.get("created_at"),
                        "immutable": True,
                    }
    except psycopg.Error as error:
        if getattr(error, "sqlstate", "") == "P0002":
            raise HTTPException(status_code=404, detail="Account not found.") from error
        raise HTTPException(status_code=503, detail="Digital ID is temporarily unavailable.") from error


@app.get("/api/digital-id")
def get_or_create_owned_digital_id(request: Request):
    return owned_digital_id(request)


@app.post("/api/digital-id")
async def store_encrypted_owned_digital_id(request: Request):
    user = require_user(request)
    user_id = str(user.get("id") or "")
    payload = await read_json_payload(request, 80_000)
    if payload.get("action") != "migrate":
        raise HTTPException(status_code=400, detail="Unsupported Digital ID vault action.")
    vault = parse_digital_id_vault(payload.get("vault"), user_id=user_id)

    with connect_db() as connection:
        with connection.transaction():
            with connection.cursor(row_factory=dict_row) as cursor:
                sender_device = require_phase5_device(cursor, request, user_id)
                if (
                    vault["senderDeviceId"] != str(sender_device["device_id"])
                    or vault["senderIdentitySignPublic"]
                    != str(sender_device["identity_sign_public"])
                ):
                    raise HTTPException(status_code=400, detail="Digital ID vault sender is not bound.")
                verify_ed25519(
                    vault["senderIdentitySignPublic"],
                    vault["signature"],
                    digital_id_signature_input(vault),
                    field="Digital ID vault",
                )

                bundles = account_device_bundles(cursor, user_id)
                bundle_map = {item["deviceId"]: item for item in bundles}
                envelope_map = {item["deviceId"]: item for item in vault["envelopes"]}
                if set(envelope_map) != set(bundle_map):
                    raise HTTPException(
                        status_code=409,
                        detail="Digital ID vault does not cover every active phase 5 device.",
                    )
                for device_id, envelope in envelope_map.items():
                    if envelope["recipientIdentityKey"] != bundle_map[device_id]["identityDhPublic"]:
                        raise HTTPException(
                            status_code=409,
                            detail="A Digital ID recipient identity key changed.",
                        )

                cursor.execute(
                    "select digital_id, digital_id_lookup_hash from public_users where id = %s for update",
                    (user_id,),
                )
                account = cursor.fetchone()
                raw_id = normalize_digital_id(account.get("digital_id") if account else "")
                if not raw_id or str(account.get("digital_id_lookup_hash") or ""):
                    raise HTTPException(
                        status_code=409,
                        detail="The immutable Digital ID has already been migrated.",
                    )
                lookup_hash = digital_id_lookup_hash(raw_id)

                cursor.execute(
                    """
                    insert into yachat_digital_id_vaults(
                        user_id, version, algorithm, ciphertext, iv, aad, envelopes,
                        plaintext_digest, sender_device_id, sender_identity_sign_public,
                        envelope_digest, signature, created_at, updated_at
                    )
                    values (
                        %s, %s, %s, %s, %s, %s, %s::jsonb,
                        %s, %s, %s, %s, %s, now(), now()
                    )
                    returning *
                    """,
                    (
                        user_id,
                        vault["version"],
                        vault["algorithm"],
                        vault["ciphertext"],
                        vault["iv"],
                        vault["aad"],
                        json.dumps(vault["envelopes"], ensure_ascii=False),
                        vault["plaintextDigest"],
                        vault["senderDeviceId"],
                        vault["senderIdentitySignPublic"],
                        vault["envelopeDigest"],
                        vault["signature"],
                    ),
                )
                stored = dict(cursor.fetchone())
                cursor.execute(
                    """
                    update public_users
                    set digital_id = null,
                        digital_id_lookup_hash = %s,
                        e2ee_required = true,
                        e2ee_min_protocol = greatest(e2ee_min_protocol, 5),
                        e2ee_migrated_at = coalesce(e2ee_migrated_at, now()),
                        updated_at = now()
                    where id = %s
                    """,
                    (lookup_hash, user_id),
                )
    return {
        "e2eeVault": digital_id_vault_payload(stored),
        "createdAt": user.get("created_at"),
        "immutable": True,
        "migrationComplete": True,
    }


@app.get("/api/users/search")
def search_public_users(request: Request):
    enforce_rate_limit(request, "user-directory-search", 90, 60)
    current = require_user(request)
    query = str(request.query_params.get("query") or request.query_params.get("q") or "").strip()[:120]
    digital_id = normalize_digital_id(query)
    digits = re.sub(r"\D+", "", query)
    text = query.lower().lstrip("@").strip()

    if not digital_id and len(text) < 2 and len(digits) < 3:
        return {"users": []}

    ensure_schema()
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                if digital_id:
                    lookup_hash = digital_id_lookup_hash(digital_id)
                    cursor.execute(
                        """
                        select id, username, preview_name, display_name, bio,
                               avatar_url, avatar_accent, created_at, public_key_type
                        from public_users
                        where id <> %s
                          and coalesce(is_public, true) = true
                          and (
                            digital_id_lookup_hash = %s
                            or upper(coalesce(digital_id, '')) = %s
                          )
                        limit 1
                        """,
                        (str(current.get("id") or ""), lookup_hash, digital_id),
                    )
                else:
                    text_pattern = sql_like(text)
                    digit_pattern = sql_like(digits) if digits else "__no_digit_match__"
                    cursor.execute(
                        """
                        select id, username, preview_name, display_name, bio,
                               avatar_url, avatar_accent, created_at, public_key_type
                        from public_users
                        where id <> %s
                          and coalesce(is_public, true) = true
                          and (
                            lower(coalesce(username, '')) like %s escape '\\'
                            or lower(coalesce(preview_name, '')) like %s escape '\\'
                            or lower(coalesce(display_name, '')) like %s escape '\\'
                            or regexp_replace(coalesce(contact, ''), '\\D+', '', 'g') like %s escape '\\'
                            or regexp_replace(coalesce(contact_key, ''), '\\D+', '', 'g') like %s escape '\\'
                          )
                        order by
                          case when lower(coalesce(username, '')) = %s then 0 else 1 end,
                          updated_at desc nulls last,
                          created_at desc nulls last
                        limit 25
                        """,
                        (
                            str(current.get("id") or ""),
                            text_pattern,
                            text_pattern,
                            text_pattern,
                            digit_pattern,
                            digit_pattern,
                            text,
                        ),
                    )
                users = [public_user(dict(row)) for row in cursor.fetchall()]
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error

    return {"users": users}


@app.get("/api/developer/v1/health")
def digital_id_health():
    return {
        "ok": True,
        "service": "yachat-digital-id",
        "version": "2.0.0",
        "proof": "otp-pkce-one-time-token",
        "digitalIdExposure": "client-encrypted-owner-vault",
        "immutable": True,
        "alphabets": ["latin", "cyrillic"],
    }


# Reuse this already-deployed serverless boundary for the developer identity
# flow. Patch the legacy module before importing the secure routes so every
# endpoint uses the same Latin/Cyrillic contract without creating a thirteenth
# Vercel function on the Hobby plan.
from api import index as index_api  # noqa: E402

index_api.normalize_digital_id = normalize_digital_id
index_api.format_digital_id = format_digital_id

from api import digital_id_secure as identity_api  # noqa: E402

identity_app = identity_api.app
app.mount("/", identity_app)
