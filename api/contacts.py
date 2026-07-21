import hashlib
import hmac
import json
import os
import re
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row

from api.database import auth_secret, connect_db, secure_server_tables

KNOWN_DIAL_CODES = tuple(sorted({
    "7", "375", "994", "374", "995", "996", "373", "992", "998", "971", "93",
    "591", "243", "242", "57", "53", "20", "1473", "62", "91", "964", "855",
    "1869", "965", "856", "961", "95", "60", "505", "92", "680", "974", "966",
    "66", "993", "90", "255", "58", "84", "55", "86", "220", "27",
}, key=len, reverse=True))
MAX_REQUEST_BYTES = 2_000_000
MAX_CONTACT_RECORDS = 5_000
MAX_PHONE_NUMBERS = 10_000
MIN_PHONE_DIGITS = 6
MAX_PHONE_DIGITS = 18

app = FastAPI(title="YaChat Contacts API", version="1.0.0")


def configured_cors_origins() -> list[str]:
    raw = os.getenv("YACHAT_CORS_ORIGINS", "").strip()
    if raw:
        return [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip() and origin.strip() != "*"]

    origins = {"https://yachat.vercel.app"}
    if os.getenv("VERCEL_URL"):
        origins.add(f"https://{os.getenv('VERCEL_URL', '').strip().rstrip('/')}")
    if os.getenv("YACHAT_WEB_ORIGIN"):
        origins.add(os.getenv("YACHAT_WEB_ORIGIN", "").strip().rstrip("/"))
    origins.update({
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
    })
    return sorted(origin for origin in origins if origin)


app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


def hash_secret(value: str) -> str:
    return hmac.new(auth_secret().encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def request_token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header.lower().startswith("bearer ") else ""


def current_user(cursor, request: Request) -> dict[str, Any]:
    token = request_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in first.")

    cursor.execute(
        """
        select u.*
        from yachat_sessions s
        join public_users u on u.id = s.user_id
        where s.token_hash = %s and s.expires_at > now()
        limit 1
        """,
        (hash_secret(token),),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Sign in first.")
    return dict(row)


def ensure_contacts_schema(cursor) -> None:
    cursor.execute(
        """
        create table if not exists yachat_imported_contacts (
            owner_id text not null references public_users(id) on delete cascade,
            phone_key text not null,
            phone_raw text not null default '',
            contact_name text not null default '',
            match_keys text[] not null default '{}',
            created_at timestamptz not null default now(),
            primary key(owner_id, phone_key)
        )
        """
    )
    cursor.execute(
        "alter table yachat_imported_contacts add column if not exists match_keys text[] not null default '{}'"
    )
    cursor.execute(
        "create index if not exists yachat_imported_contacts_phone_idx on yachat_imported_contacts(phone_key)"
    )
    secure_server_tables(cursor, ("yachat_imported_contacts",))


def clean_text(value: Any, limit: int) -> str:
    return " ".join(str(value or "").replace("\x00", "").split())[:limit]


def phone_digits(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def detect_dial_code(value: Any) -> str:
    digits = phone_digits(value)
    for code in KNOWN_DIAL_CODES:
        if digits.startswith(code):
            return code
    return ""


def normalized_phone(value: Any, owner_dial_code: str) -> tuple[str, list[str]] | None:
    source = clean_text(value, 64)
    digits = phone_digits(source)
    if not (MIN_PHONE_DIGITS <= len(digits) <= MAX_PHONE_DIGITS):
        return None

    keys: list[str] = []

    def add(candidate: str) -> None:
        if MIN_PHONE_DIGITS <= len(candidate) <= MAX_PHONE_DIGITS and candidate not in keys:
            keys.append(candidate)

    explicit_international = source.lstrip().startswith("+")
    add(digits)

    if owner_dial_code == "7" and len(digits) == 11 and digits.startswith("8"):
        add(f"7{digits[1:]}")

    if not explicit_international and owner_dial_code:
        local_digits = digits
        if owner_dial_code == "7" and len(local_digits) == 11 and local_digits.startswith("8"):
            local_digits = local_digits[1:]
        elif local_digits.startswith("0"):
            local_digits = local_digits.lstrip("0")

        if local_digits and not local_digits.startswith(owner_dial_code):
            add(f"{owner_dial_code}{local_digits}")

    canonical = keys[-1] if not explicit_international and owner_dial_code else keys[0]
    if owner_dial_code == "7" and len(digits) == 11 and digits.startswith("8"):
        canonical = f"7{digits[1:]}"
    return canonical, keys


async def read_payload(request: Request) -> dict[str, Any]:
    body = await request.body()
    if len(body) > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="Contact import is too large.")
    if not body:
        return {}
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail="Invalid JSON body.") from error
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON body must be an object.")
    return payload


def payload_contact_rows(payload: dict[str, Any], owner_dial_code: str) -> list[dict[str, Any]]:
    raw_contacts = payload.get("contacts")
    if not isinstance(raw_contacts, list):
        raw_contacts = []
    if len(raw_contacts) > MAX_CONTACT_RECORDS:
        raise HTTPException(status_code=413, detail="Too many contact records.")

    rows_by_key: dict[str, dict[str, Any]] = {}
    phone_count = 0

    for item in raw_contacts:
        if isinstance(item, dict):
            name = clean_text(item.get("name"), 120)
            raw_phones = item.get("phones")
            if not isinstance(raw_phones, list):
                raw_phones = [item.get("phone") or item.get("tel") or item.get("contact")]
        else:
            name = ""
            raw_phones = [item]

        for raw_phone in raw_phones:
            phone_count += 1
            if phone_count > MAX_PHONE_NUMBERS:
                raise HTTPException(status_code=413, detail="Too many phone numbers.")

            normalized = normalized_phone(raw_phone, owner_dial_code)
            if not normalized:
                continue
            key, match_keys = normalized
            if key in rows_by_key:
                continue
            rows_by_key[key] = {
                "phone_key": key,
                "phone_raw": clean_text(raw_phone, 64),
                "contact_name": name,
                "match_keys": match_keys,
            }

    return list(rows_by_key.values())


def public_contact_payload(user: dict[str, Any], imported: dict[str, Any]) -> dict[str, Any]:
    display_name = str(user.get("display_name") or user.get("preview_name") or user.get("username") or "Пользователь")
    return {
        "id": str(user.get("id") or ""),
        "username": str(user.get("username") or ""),
        "previewName": str(user.get("preview_name") or display_name),
        "displayName": display_name,
        "bio": str(user.get("bio") or ""),
        "avatarDataUrl": str(user.get("avatar_url") or ""),
        "avatarAccent": str(user.get("avatar_accent") or "#471AFF"),
        "createdAt": user.get("created_at"),
        "publicKeyType": str(user.get("public_key_type") or "x25519"),
        "matchedContact": str(imported.get("phone_raw") or ""),
        "contactName": str(imported.get("contact_name") or ""),
    }


def contacts_snapshot(cursor, owner_id: str) -> dict[str, Any]:
    cursor.execute(
        """
        select phone_key, phone_raw, contact_name, match_keys, created_at
        from yachat_imported_contacts
        where owner_id = %s
        order by created_at asc, phone_key asc
        """,
        (owner_id,),
    )
    imported_rows = [dict(row) for row in cursor.fetchall()]
    all_keys = sorted({
        str(key)
        for row in imported_rows
        for key in ([row.get("phone_key")] + list(row.get("match_keys") or []))
        if key
    })

    users_by_digits: dict[str, dict[str, Any]] = {}
    if all_keys:
        cursor.execute(
            """
            select u.*,
                   regexp_replace(coalesce(u.contact_key, u.contact, ''), '[^0-9]+', '', 'g') as contact_digits
            from public_users u
            where u.id <> %s
              and coalesce(u.is_public, true) = true
              and regexp_replace(coalesce(u.contact_key, u.contact, ''), '[^0-9]+', '', 'g') = any(%s)
            """,
            (owner_id, all_keys),
        )
        for row in cursor.fetchall():
            user = dict(row)
            digits = str(user.pop("contact_digits", "") or "")
            if digits:
                users_by_digits[digits] = user

    matches_by_user: dict[str, dict[str, Any]] = {}
    for imported in imported_rows:
        keys = [str(imported.get("phone_key") or ""), *[str(key) for key in imported.get("match_keys") or []]]
        user = next((users_by_digits[key] for key in keys if key in users_by_digits), None)
        if not user:
            continue
        user_id = str(user.get("id") or "")
        if user_id and user_id not in matches_by_user:
            matches_by_user[user_id] = public_contact_payload(user, imported)

    last_imported_at = imported_rows[-1].get("created_at") if imported_rows else None
    return {
        "contacts": list(matches_by_user.values()),
        "importedCount": len(imported_rows),
        "matchedCount": len(matches_by_user),
        "lastImportedAt": last_imported_at,
    }


@app.middleware("http")
async def harden_responses(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_REQUEST_BYTES:
                return JSONResponse(status_code=413, content={"detail": "Contact import is too large."})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length."})

    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


@app.get("/api/contacts")
def get_contacts(request: Request):
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                ensure_contacts_schema(cursor)
                user = current_user(cursor, request)
                return contacts_snapshot(cursor, str(user["id"]))
    except HTTPException:
        raise
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Contacts database is unavailable.") from error


async def import_contacts_payload(request: Request) -> dict[str, Any]:
    payload = await read_payload(request)
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                ensure_contacts_schema(cursor)
                user = current_user(cursor, request)
                owner_id = str(user["id"])
                owner_dial_code = detect_dial_code(user.get("contact"))
                rows = payload_contact_rows(payload, owner_dial_code)
                if not rows:
                    raise HTTPException(status_code=400, detail="No valid phone numbers were provided.")

                added = 0
                for row in rows:
                    cursor.execute(
                        """
                        insert into yachat_imported_contacts(
                            owner_id, phone_key, phone_raw, contact_name, match_keys, created_at
                        )
                        values (%s, %s, %s, %s, %s, now())
                        on conflict(owner_id, phone_key) do nothing
                        """,
                        (
                            owner_id,
                            row["phone_key"],
                            row["phone_raw"],
                            row["contact_name"],
                            row["match_keys"],
                        ),
                    )
                    added += max(0, cursor.rowcount)

                snapshot = contacts_snapshot(cursor, owner_id)
                snapshot.update({"addedCount": added, "receivedCount": len(rows)})
                return snapshot
    except HTTPException:
        raise
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Contacts database is unavailable.") from error


@app.post("/api/contacts/import")
async def import_contacts(request: Request):
    return await import_contacts_payload(request)


@app.post("/api/contacts/lookup")
async def lookup_and_store_contacts(request: Request):
    return await import_contacts_payload(request)
