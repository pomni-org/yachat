"""Protected personal identity data for YaChat accounts and verified services."""

import base64
import hashlib
import hmac
import re
from datetime import date
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    configured_cors_origins,
    connect_db,
    ensure_schema,
    hash_secret,
    read_json_payload,
    require_user,
)


app = FastAPI(
    title="YaChat Personal Identity API",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "PUT", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-YaChat-API-Key"],
)

CLIENT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
PKCE_VERIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
PERSONAL_NAME_PATTERN = re.compile(r"^[^\x00-\x1f\x7f]{1,80}$")


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "private, no-store")
    response.headers.setdefault("Pragma", "no-cache")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


def clean_name(value: Any) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())[:80]
    if not text or not PERSONAL_NAME_PATTERN.fullmatch(text):
        return ""
    return text


def parse_birth_date(value: Any) -> date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = date.fromisoformat(raw)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Enter birthDate as YYYY-MM-DD.") from error
    if parsed < date(1900, 1, 1) or parsed > date.today():
        raise HTTPException(status_code=400, detail="Enter a valid birth date.")
    return parsed


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def profile_payload(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return {
            "identityState": "required",
            "serviceAccess": False,
            "familyName": "",
            "givenName": "",
            "patronymic": "",
            "birthDate": "",
        }
    state = str(row.get("identity_state") or "required")
    birth_date = row.get("birth_date")
    return {
        "identityState": state,
        "serviceAccess": state == "complete",
        "familyName": str(row.get("family_name") or ""),
        "givenName": str(row.get("given_name") or ""),
        "patronymic": str(row.get("patronymic") or ""),
        "birthDate": birth_date.isoformat() if hasattr(birth_date, "isoformat") else str(birth_date or ""),
        "updatedAt": row.get("updated_at"),
    }


def load_profile(cursor, user_id: str, *, for_update: bool = False) -> dict[str, Any] | None:
    suffix = " for update" if for_update else ""
    cursor.execute(
        f"""
        select user_id, family_name, given_name, patronymic, birth_date,
               identity_state, completed_at, declined_at, updated_at
        from private.yachat_personal_profiles
        where user_id = %s{suffix}
        """,
        (user_id,),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def registration_user(cursor, registration_token: str) -> dict[str, Any] | None:
    if not registration_token:
        return None
    cursor.execute(
        """
        select u.id, c.id as challenge_id
        from public.yachat_auth_challenges c
        join public.public_users u on u.contact_key = c.contact_key
        where c.registration_token_hash = %s
          and c.verified_at is not null
          and c.expires_at > now()
        order by c.verified_at desc
        limit 1
        """,
        (hash_secret(registration_token),),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def user_id_for_write(request: Request, cursor, payload: dict[str, Any]) -> tuple[str, str]:
    try:
        user = require_user(request)
    except HTTPException as error:
        if error.status_code != 401:
            raise
        user = None
    if user and str(user.get("id") or ""):
        return str(user["id"]), "session"

    token = str(payload.get("registrationToken") or "").strip()
    registration = registration_user(cursor, token)
    if not registration:
        raise HTTPException(status_code=401, detail="Sign in or confirm registration first.")
    return str(registration["id"]), str(registration["challenge_id"])


def normalized_scopes(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item or "").strip() for item in value if str(item or "").strip()}


def normalized_origins(value: Any) -> set[str]:
    if not isinstance(value, list):
        return set()
    return {str(item or "").strip().rstrip("/") for item in value if str(item or "").strip()}


def require_developer_client(cursor, request: Request, client_id: str) -> dict[str, Any]:
    if not CLIENT_ID_PATTERN.fullmatch(client_id):
        raise HTTPException(status_code=400, detail="Invalid clientId.")
    cursor.execute(
        """
        select id, name, secret_hash, public_pkce, allowed_origins, scopes, active
        from public.yachat_developer_clients
        where id = %s
        limit 1
        """,
        (client_id,),
    )
    row = cursor.fetchone()
    if not row or not bool(row.get("active")):
        raise HTTPException(status_code=401, detail="Developer client is not active.")
    client = dict(row)
    if "identity:profile" not in normalized_scopes(client.get("scopes")):
        raise HTTPException(status_code=403, detail="Client does not have identity:profile scope.")

    if bool(client.get("public_pkce")):
        origin = str(request.headers.get("origin") or "").strip().rstrip("/")
        if not origin or origin not in normalized_origins(client.get("allowed_origins")):
            raise HTTPException(status_code=403, detail="Origin is not allowed for this client.")
    else:
        supplied = str(request.headers.get("x-yachat-api-key") or "").strip()
        expected = str(client.get("secret_hash") or "")
        if not supplied or not expected or not hmac.compare_digest(hash_secret(supplied), expected):
            raise HTTPException(status_code=401, detail="Developer API key is invalid.")
    return client


@app.get("/api/personal-profile")
def get_personal_profile(request: Request):
    ensure_schema()
    user = require_user(request)
    user_id = str(user.get("id") or "")
    if not user_id:
        raise HTTPException(status_code=401, detail="Sign in first.")
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                row = load_profile(cursor, user_id)
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Personal profile is temporarily unavailable.") from error
    return profile_payload(row)


@app.put("/api/personal-profile")
async def save_personal_profile(request: Request):
    ensure_schema()
    payload = await read_json_payload(request, 30_000)
    decision = str(payload.get("decision") or "save").strip().lower()
    if decision not in {"save", "decline"}:
        raise HTTPException(status_code=400, detail="decision must be save or decline.")

    family_name = clean_name(payload.get("familyName"))
    given_name = clean_name(payload.get("givenName"))
    patronymic = clean_name(payload.get("patronymic"))
    birth_date = parse_birth_date(payload.get("birthDate"))

    if decision == "save" and not all((family_name, given_name, patronymic, birth_date)):
        raise HTTPException(status_code=400, detail="Surname, name, patronymic, and birth date are required.")

    try:
        with connect_db() as connection:
            with connection.transaction():
                with connection.cursor(row_factory=dict_row) as cursor:
                    user_id, auth_source = user_id_for_write(request, cursor, payload)
                    if decision == "decline":
                        cursor.execute(
                            """
                            insert into private.yachat_personal_profiles(
                                user_id, family_name, given_name, patronymic, birth_date,
                                identity_state, completed_at, declined_at, updated_at
                            )
                            values (%s, null, null, null, null, 'declined', null, now(), now())
                            on conflict (user_id) do update set
                                family_name = null,
                                given_name = null,
                                patronymic = null,
                                birth_date = null,
                                identity_state = 'declined',
                                completed_at = null,
                                declined_at = now(),
                                updated_at = now()
                            returning *
                            """,
                            (user_id,),
                        )
                    else:
                        cursor.execute(
                            """
                            insert into private.yachat_personal_profiles(
                                user_id, family_name, given_name, patronymic, birth_date,
                                identity_state, completed_at, declined_at, updated_at
                            )
                            values (%s, %s, %s, %s, %s, 'complete', now(), null, now())
                            on conflict (user_id) do update set
                                family_name = excluded.family_name,
                                given_name = excluded.given_name,
                                patronymic = excluded.patronymic,
                                birth_date = excluded.birth_date,
                                identity_state = 'complete',
                                completed_at = coalesce(private.yachat_personal_profiles.completed_at, now()),
                                declined_at = null,
                                updated_at = now()
                            returning *
                            """,
                            (user_id, family_name, given_name, patronymic, birth_date),
                        )
                    stored = dict(cursor.fetchone())
                    if auth_source != "session":
                        cursor.execute(
                            """
                            update public.yachat_auth_challenges
                            set registration_token_hash = null
                            where id = %s
                            """,
                            (auth_source,),
                        )
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Personal profile could not be saved.") from error
    return profile_payload(stored)


@app.post("/api/developer/v1/identity/profile")
async def developer_identity_profile(request: Request):
    """Return PII only for a previously consumed, PKCE-bound Digital ID proof."""
    ensure_schema()
    payload = await read_json_payload(request, 30_000)
    client_id = str(payload.get("clientId") or "").strip().lower()
    transaction_id = str(payload.get("transactionId") or "").strip()
    external_reference = str(payload.get("externalReference") or "").strip()[:120]
    verifier = str(payload.get("codeVerifier") or "").strip()
    if not transaction_id or not external_reference or not PKCE_VERIFIER_PATTERN.fullmatch(verifier):
        raise HTTPException(
            status_code=400,
            detail="transactionId, externalReference, and a valid PKCE codeVerifier are required.",
        )

    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                client = require_developer_client(cursor, request, client_id)
                cursor.execute(
                    """
                    select t.id, t.user_id, t.subject, t.external_reference,
                           c.code_challenge, c.status,
                           p.family_name, p.given_name, p.patronymic, p.birth_date,
                           p.identity_state, p.updated_at
                    from public.yachat_identity_transactions t
                    join public.yachat_identity_challenges c on c.id = t.challenge_id
                    left join private.yachat_personal_profiles p on p.user_id = t.user_id
                    where t.id = %s
                      and t.client_id = %s
                      and t.external_reference = %s
                    limit 1
                    """,
                    (transaction_id, client_id, external_reference),
                )
                row = cursor.fetchone()
                if not row or str(row.get("status") or "") != "consumed":
                    raise HTTPException(status_code=404, detail="Verified identity transaction was not found.")
                if not hmac.compare_digest(str(row.get("code_challenge") or ""), pkce_challenge(verifier)):
                    raise HTTPException(status_code=401, detail="PKCE verification failed.")

                state = str(row.get("identity_state") or "required")
                if state != "complete":
                    return {
                        "ok": False,
                        "status": "personal_data_missing",
                        "serviceAccess": False,
                        "identityState": state,
                        "subject": str(row.get("subject") or ""),
                        "message": "Required personal data is not available for this account.",
                    }

                birth_date = row.get("birth_date")
                return {
                    "ok": True,
                    "status": "complete",
                    "serviceAccess": True,
                    "subject": str(row.get("subject") or ""),
                    "client": {"id": str(client.get("id") or ""), "name": str(client.get("name") or "")},
                    "profile": {
                        "familyName": str(row.get("family_name") or ""),
                        "givenName": str(row.get("given_name") or ""),
                        "patronymic": str(row.get("patronymic") or ""),
                        "birthDate": birth_date.isoformat() if hasattr(birth_date, "isoformat") else str(birth_date or ""),
                    },
                }
    except HTTPException:
        raise
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Identity profile is temporarily unavailable.") from error
