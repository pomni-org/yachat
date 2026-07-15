import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from psycopg.rows import dict_row


def configured_cors_origins() -> list[str]:
    def enabled(name: str, default: bool = False) -> bool:
        value = os.getenv(name)
        if value is None:
            return default
        return value.strip().lower() in {"1", "true", "yes", "on"}

    raw = os.getenv("YACHAT_CORS_ORIGINS", "").strip()
    if raw:
        origins = [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]
        if "*" in origins and not enabled("YACHAT_ALLOW_ANY_ORIGIN", False):
            origins.remove("*")
        return origins

    origins = {"https://yachat.vercel.app"}
    if os.getenv("VERCEL_URL"):
        origins.add(f"https://{os.getenv('VERCEL_URL', '').strip().rstrip('/')}")
    if os.getenv("YACHAT_WEB_ORIGIN"):
        origins.add(os.getenv("YACHAT_WEB_ORIGIN", "").strip().rstrip("/"))
    if enabled("YACHAT_ALLOW_LOCAL_CORS", True):
        origins.update({
            "http://localhost:3000",
            "http://localhost:5173",
            "http://127.0.0.1:3000",
            "http://127.0.0.1:5173",
        })
    return sorted(origin for origin in origins if origin)


app = FastAPI(title="YaChat API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Telegram-Bot-Api-Secret-Token"],
)

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

DATABASE_ENV_NAMES = (
    "YACHAT_USERS_DB_URL",
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "POSTGRES_URL_POOLER",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
    "POSTGRES_URL_NO_SSL",
    "NEON_DATABASE_URL",
    "NEON_DATABASE_URL_UNPOOLED",
    "SUPABASE_DB_URL",
)
REMOVED_TEST_MESSAGE_TEXTS = ("Приыет?", "Привет?")
DEFAULT_SETTINGS = {
    "language": "ru",
    "theme": "dark",
    "themeSource": "system",
    "country": "RU",
    "countryCode": "+7",
}
SYSTEM_OWNER = {
    "id": "murochko",
    "username": "murochko",
    "displayName": "Мурочко",
    "roleLabel": "Владелец",
    "verified": True,
    "verifiedTitle": "Мурочко",
    "verifiedDescription": "Владелец ЯЧата. Этот значок подтверждает главный системный аккаунт.",
}
QR_SESSION_TTL_MINUTES = 5
MAX_JSON_BODY_BYTES = int(os.getenv("YACHAT_MAX_JSON_BODY_BYTES", "6000000"))
MAX_ATTACHMENT_DATA_URL_BYTES = int(os.getenv("YACHAT_MAX_ATTACHMENT_DATA_URL_BYTES", "1200000"))
CHAT_ID_PATTERN = re.compile(r"^(yachat-[a-z0-9-]+|private-[a-f0-9]{32}|group-[a-f0-9-]{36}|saved-[a-f0-9]{32}|search-user-[a-zA-Z0-9_-]{1,80})$")
_rate_limits: dict[str, list[float]] = {}

_schema_ready = False


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@app.middleware("http")
async def harden_api_responses(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if request.url.path.startswith("/api/") and content_length:
        try:
            if int(content_length) > MAX_JSON_BODY_BYTES:
                return JSONResponse(status_code=413, content={"detail": "Request is too large."})
        except ValueError:
            return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length."})

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


async def read_json_payload(request: Request, limit: int = MAX_JSON_BODY_BYTES) -> dict[str, Any]:
    body = await request.body()
    if len(body) > limit:
        raise HTTPException(status_code=413, detail="Request is too large.")
    if not body:
        return {}
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail="Invalid JSON body.") from error
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON body must be an object.")
    return payload


def client_rate_key(request: Request, scope: str) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",", 1)[0].strip() or (request.client.host if request.client else "unknown")
    return f"{scope}:{ip}"


def enforce_rate_limit(request: Request, scope: str, limit: int, window_seconds: int) -> None:
    now = time.monotonic()
    key = client_rate_key(request, scope)
    cutoff = now - window_seconds
    hits = [stamp for stamp in _rate_limits.get(key, []) if stamp >= cutoff]
    if len(hits) >= limit:
        raise HTTPException(status_code=429, detail="Too many attempts. Try again later.")
    hits.append(now)
    _rate_limits[key] = hits

    if len(_rate_limits) > 4096:
        for old_key in list(_rate_limits.keys())[:512]:
            _rate_limits.pop(old_key, None)


def public_limit() -> int:
    try:
        return max(1, min(int(os.getenv("YACHAT_PUBLIC_USER_LIMIT", "100")), 500))
    except ValueError:
        return 100


def database_url() -> str:
    for name in DATABASE_ENV_NAMES:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def database_env_name() -> str:
    for name in DATABASE_ENV_NAMES:
        if os.getenv(name, "").strip():
            return name
    return ""


def auth_secret() -> str:
    return os.getenv("YACHAT_AUTH_SECRET") or database_url() or "yachat-dev-secret"


def telegram_bot_token() -> str:
    return os.getenv("YACHAT_TELEGRAM_BOT_TOKEN", "").strip()


def telegram_webhook_secret() -> str:
    return os.getenv("YACHAT_TELEGRAM_WEBHOOK_SECRET", "").strip()


def connect_db():
    url = database_url()
    if not url:
        raise HTTPException(
            status_code=503,
            detail="Users database is not configured. Set YACHAT_USERS_DB_URL or DATABASE_URL in Vercel.",
        )
    return psycopg.connect(url, autocommit=True)


def require_database() -> None:
    if not database_url():
        raise HTTPException(
            status_code=503,
            detail="Users database is not configured. Set YACHAT_USERS_DB_URL or DATABASE_URL in Vercel.",
        )


def relation_kind(cursor, relation_name: str) -> str:
    cursor.execute(
        """
        select c.relkind
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema()
          and c.relname = %s
        limit 1
        """,
        (relation_name,),
    )
    row = cursor.fetchone()
    return str(row[0] if row and not isinstance(row, dict) else row.get("relkind", "") if row else "")


def table_exists(cursor, relation_name: str) -> bool:
    return relation_kind(cursor, relation_name) in {"r", "p"}


def ensure_public_users_table(cursor) -> None:
    kind = relation_kind(cursor, "public_users")
    migrate_legacy_users = kind in {"v", "m"} and table_exists(cursor, "yachat_users")

    if kind == "v":
        cursor.execute("drop view if exists public_users")
    elif kind == "m":
        cursor.execute("drop materialized view if exists public_users")
    elif kind and kind not in {"r", "p"}:
        raise psycopg.ProgrammingError("public_users exists but is not a writable table")

    cursor.execute(
        """
        create table if not exists public_users (
            id text primary key,
            contact text,
            contact_key text,
            method text default 'phone',
            username text,
            preview_name text,
            display_name text,
            bio text default '',
            avatar_url text default '',
            avatar_accent text default '#471AFF',
            created_at timestamptz default now(),
            updated_at timestamptz default now(),
            public_key_type text default 'x25519',
            is_public boolean default true
        )
        """
    )

    if migrate_legacy_users:
        cursor.execute(
            """
            insert into public_users(
                id, contact, contact_key, method, username, preview_name, display_name,
                bio, avatar_url, avatar_accent, created_at, updated_at, public_key_type, is_public
            )
            select
                id,
                coalesce(contact, ''),
                nullif(regexp_replace(lower(coalesce(contact, '')), '[^0-9+a-z@._-]+', '', 'g'), ''),
                'phone',
                username,
                coalesce(display_name, username),
                coalesce(display_name, username),
                coalesce(bio, ''),
                coalesce(avatar_url, ''),
                coalesce(avatar_accent, '#471AFF'),
                coalesce(created_at, now()),
                coalesce(created_at, now()),
                coalesce(public_key_type, 'x25519'),
                coalesce(is_public, true)
            from yachat_users
            on conflict (id) do nothing
            """