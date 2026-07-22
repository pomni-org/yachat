"""Owner-only YaChat Digital ID endpoint and privacy-safe user lookup.

The human-readable ID is returned only to the currently authenticated account.
Creation is atomic and one-time; the database rejects every later attempt to
change an existing ID. Sidebar lookup accepts Latin and Cyrillic IDs but never
returns the lookup key in its response.
"""

import re
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from psycopg.rows import dict_row

from api.index import connect_db, enforce_rate_limit, ensure_schema, public_user, require_user


LATIN_DIGITAL_ID = re.compile(r"^[ABCDEFGHJKLMNPQRSTUVWXYZ]{2,3}[0-9]{3,4}$")
CYRILLIC_DIGITAL_ID = re.compile(r"^[АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЭЮЯ]{2,3}[0-9]{3,4}$")

app = FastAPI(
    title="YaChat private Digital ID boundary",
    version="1.5.0",
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
                    # The one-argument database function reads the persisted UI
                    # language and chooses Cyrillic or Latin only on first creation.
                    cursor.execute(
                        "select public.yachat_get_or_create_digital_id(%s) as digital_id",
                        (user_id,),
                    )
                    row = cursor.fetchone()
    except psycopg.Error as error:
        if getattr(error, "sqlstate", "") == "P0002":
            raise HTTPException(status_code=404, detail="Account not found.") from error
        raise HTTPException(status_code=503, detail="Digital ID is temporarily unavailable.") from error

    raw_id = normalize_digital_id(row.get("digital_id") if row else "")
    if not raw_id:
        raise HTTPException(status_code=503, detail="Digital ID is temporarily unavailable.")

    return {
        "digitalId": format_digital_id(raw_id),
        "createdAt": user.get("created_at"),
        "immutable": True,
    }


@app.get("/api/digital-id")
def get_or_create_owned_digital_id(request: Request):
    return owned_digital_id(request)


@app.post("/api/digital-id")
def create_owned_digital_id_once(request: Request):
    return owned_digital_id(request)


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
                    cursor.execute(
                        """
                        select id, username, preview_name, display_name, bio,
                               avatar_url, avatar_accent, created_at, public_key_type
                        from public_users
                        where id <> %s
                          and coalesce(is_public, true) = true
                          and upper(coalesce(digital_id, '')) = %s
                        limit 1
                        """,
                        (str(current.get("id") or ""), digital_id),
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
        "version": "1.5.0",
        "proof": "otp-pkce-one-time-token",
        "digitalIdExposure": "owner-session-only",
        "immutable": True,
        "alphabets": ["latin", "cyrillic"],
    }


# Reuse this already-deployed serverless boundary for the developer identity
# flow. Monkey-patch the legacy module before importing the secure routes so
# every endpoint uses the same Latin/Cyrillic contract without creating a
# thirteenth Vercel function on the Hobby plan.
from api import index as index_api  # noqa: E402

index_api.normalize_digital_id = normalize_digital_id
index_api.format_digital_id = format_digital_id

from api.digital_id_secure import app as identity_app  # noqa: E402

app.mount("/", identity_app)
