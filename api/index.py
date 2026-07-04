import os
import re
from typing import Any

import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


app = FastAPI(title="YaChat API", version="0.1.0")

PUBLIC_USER_FIELDS = (
    "id",
    "username",
    "preview_name",
    "display_name",
    "bio",
    "avatar_url",
    "avatar_accent",
    "created_at",
    "public_key_type",
)


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def public_limit() -> int:
    try:
        return max(1, min(int(os.getenv("YACHAT_PUBLIC_USER_LIMIT", "100")), 500))
    except ValueError:
        return 100


def database_url() -> str:
    return os.getenv("YACHAT_USERS_DB_URL", "").strip()


def connect_db():
    url = database_url()
    if not url:
        return None
    return psycopg.connect(url, autocommit=True)


def row_value(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    return ""


def contact_lookup_keys(value: Any) -> set[str]:
    digits = re.sub(r"\D+", "", str(value or ""))
    keys: set[str] = set()

    if not digits:
        return keys

    keys.add(digits)

    if len(digits) == 11 and digits.startswith("8"):
        keys.add(f"7{digits[1:]}")

    if len(digits) == 11 and digits.startswith("7"):
        keys.add(digits[1:])

    if len(digits) == 10:
        keys.add(f"7{digits}")

    return keys


def payload_contacts(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return []

    raw_contacts = payload.get("contacts") or payload.get("phones") or []
    if not isinstance(raw_contacts, list):
        return []

    contacts: list[str] = []
    for item in raw_contacts[:500]:
        if isinstance(item, dict):
            value = item.get("phone") or item.get("tel") or item.get("contact")
        else:
            value = item

        value = str(value or "").strip()
        if value:
            contacts.append(value)

    return contacts


def public_user(row: dict[str, Any], matched_contact: str = "") -> dict[str, Any]:
    display_name = row_value(row, "display_name", "preview_name", "username")
    user = {
        "id": str(row_value(row, "id")),
        "username": str(row_value(row, "username")),
        "previewName": str(row_value(row, "preview_name", "display_name", "username")),
        "displayName": str(display_name),
        "bio": str(row_value(row, "bio")),
        "avatarDataUrl": str(row_value(row, "avatar_url", "avatar_data_url")),
        "avatarAccent": str(row_value(row, "avatar_accent")) or "#471AFF",
        "createdAt": row_value(row, "created_at"),
        "matchedContact": matched_contact,
        "encrypted": True,
        "publicKeyType": str(row_value(row, "public_key_type")) or "x25519",
    }

    if env_flag("YACHAT_PUBLIC_CONTACTS", False):
        user["contact"] = str(row_value(row, "contact"))
    else:
        user["contact"] = ""

    return user


def fetch_public_users() -> list[dict[str, Any]]:
    url = database_url()
    if not url:
        return []

    columns = ", ".join(PUBLIC_USER_FIELDS)
    query = f"""
        select {columns}
        from public_users
        where coalesce(is_public, true) = true
        order by created_at desc nulls last
        limit %s
    """

    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(query, (public_limit(),))
                return [public_user(dict(row)) for row in cursor.fetchall()]
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


def fetch_user_search(value: str) -> list[dict[str, Any]]:
    term = str(value or "").strip()
    digits = re.sub(r"\D+", "", term)

    if not term or (len(term) < 2 and len(digits) < 3) or not database_url():
        return []

    text = term.lower().lstrip("@")
    text_like = f"%{text}%"
    digits_like = f"%{digits}%" if digits else "__no_digits_match__"
    columns = ", ".join((*PUBLIC_USER_FIELDS, "contact"))
    query = f"""
        select {columns}
        from public_users
        where coalesce(is_public, true) = true
          and (
            lower(coalesce(username::text, '')) like %s
            or lower(coalesce(preview_name::text, '')) like %s
            or lower(coalesce(display_name::text, '')) like %s
            or regexp_replace(coalesce(contact::text, ''), '\\D+', '', 'g') like %s
          )
        order by created_at desc nulls last
        limit %s
    """

    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(query, (text_like, text_like, text_like, digits_like, min(public_limit(), 25)))
                return [public_user(dict(row)) for row in cursor.fetchall()]
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


def fetch_contact_matches(contacts: list[str]) -> list[dict[str, Any]]:
    if not contacts or not database_url():
        return []

    requested: set[str] = set()
    submitted_by_key: dict[str, str] = {}

    for contact in contacts:
        for key in contact_lookup_keys(contact):
            requested.add(key)
            submitted_by_key.setdefault(key, contact)

    if not requested:
        return []

    columns = ", ".join((*PUBLIC_USER_FIELDS, "contact"))
    query = f"""
        select {columns}
        from public_users
        where coalesce(is_public, true) = true
        order by created_at desc nulls last
        limit %s
    """

    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(query, (public_limit(),))
                rows = [dict(row) for row in cursor.fetchall()]
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error

    matches: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for row in rows:
        match_key = next((key for key in contact_lookup_keys(row_value(row, "contact")) if key in requested), "")
        user_id = str(row_value(row, "id"))

        if not match_key or user_id in seen_ids:
            continue

        seen_ids.add(user_id)
        matches.append(public_user(row, submitted_by_key.get(match_key, "")))

    return matches


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/api/status")
def status():
    return {
        "storage": "vercel-static",
        "users": "database-public-directory" if database_url() else "not-configured",
        "webUrl": None,
        "lanUrl": None,
        "encryption": {
            "storage": "external-database",
            "kdf": "provider-managed",
            "identity": "public-directory"
        }
    }


@app.get("/api/users")
def users():
    return fetch_public_users()


@app.get("/api/users/search")
def users_search(q: str = ""):
    return fetch_user_search(q)


@app.post("/api/contacts/lookup")
async def contacts_lookup(request: Request):
    payload = await request.json()
    return fetch_contact_matches(payload_contacts(payload))


@app.get("/api/health")
def health():
    return {"ok": True, "usersDatabaseConfigured": bool(database_url())}


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def unsupported_api(path: str):
    return JSONResponse(
        status_code=404,
        content={
            "error": "This Vercel build exposes only the safe public users API. The messenger runtime uses local browser storage for other actions."
        },
    )
