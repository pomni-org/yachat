import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
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
DEVICE_CODE_TTL_MINUTES = 10
QR_SESSION_TTL_MINUTES = 5
MAX_JSON_BODY_BYTES = int(os.getenv("YACHAT_MAX_JSON_BODY_BYTES", "12000000"))
MAX_ATTACHMENT_DATA_URL_BYTES = int(os.getenv("YACHAT_MAX_ATTACHMENT_DATA_URL_BYTES", "9000000"))
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
        )


def cleanup_removed_test_messages(cursor) -> None:
    cursor.execute(
        "delete from yachat_messages where trim(coalesce(text, '')) = any(%s)",
        (list(REMOVED_TEST_MESSAGE_TEXTS),),
    )


def apply_data_migrations(cursor) -> None:
    migration_id = "2026-07-clear-verification-code-history"
    cursor.execute("select 1 from yachat_data_migrations where id = %s limit 1", (migration_id,))
    if cursor.fetchone():
        return
    cursor.execute("delete from yachat_system_messages where chat_id = 'yachat-codes'")
    cursor.execute("insert into yachat_data_migrations(id, applied_at) values (%s, now())", (migration_id,))


def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready or not database_url():
        return

    statements = [
        "alter table public_users add column if not exists contact text",
        "alter table public_users add column if not exists contact_key text",
        "alter table public_users add column if not exists method text default 'phone'",
        "alter table public_users add column if not exists username text",
        "alter table public_users add column if not exists preview_name text",
        "alter table public_users add column if not exists display_name text",
        "alter table public_users add column if not exists bio text default ''",
        "alter table public_users add column if not exists avatar_url text default ''",
        "alter table public_users add column if not exists avatar_accent text default '#471AFF'",
        "alter table public_users add column if not exists created_at timestamptz default now()",
        "alter table public_users add column if not exists updated_at timestamptz default now()",
        "alter table public_users add column if not exists public_key_type text default 'x25519'",
        "alter table public_users add column if not exists is_public boolean default true",
        """
        update public_users
        set contact_key = nullif(regexp_replace(lower(coalesce(contact, '')), '[^0-9+a-z@._-]+', '', 'g'), '')
        where coalesce(contact_key, '') = '' and coalesce(contact, '') <> ''
        """,
        "update public_users set updated_at = coalesce(updated_at, created_at, now()) where updated_at is null",
        "create unique index if not exists public_users_contact_key_idx on public_users(contact_key) where contact_key is not null and contact_key <> ''",
        "create unique index if not exists public_users_username_idx on public_users(lower(username)) where username is not null and username <> ''",
        """
        create table if not exists yachat_auth_challenges (
            id text primary key,
            contact text not null,
            contact_key text not null,
            method text default 'phone',
            code_hash text not null,
            registration_token_hash text,
            created_at timestamptz default now(),
            expires_at timestamptz not null,
            verified_at timestamptz
        )
        """,
        "create index if not exists yachat_auth_challenges_contact_idx on yachat_auth_challenges(contact_key, created_at desc)",
        "create index if not exists yachat_auth_challenges_expires_idx on yachat_auth_challenges(expires_at)",
        """
        create table if not exists yachat_system_messages (
            id text primary key,
            user_id text not null references public_users(id) on delete cascade,
            chat_id text not null,
            author_id text default 'yachat',
            text text default '',
            attachments jsonb default '[]'::jsonb,
            system_kind text default '',
            created_at timestamptz default now(),
            expires_at timestamptz
        )
        """,
        "alter table yachat_system_messages add column if not exists author_id text default 'yachat'",
        "alter table yachat_system_messages add column if not exists attachments jsonb default '[]'::jsonb",
        "alter table yachat_system_messages add column if not exists formatted_html text default ''",
        "create index if not exists yachat_system_messages_user_chat_idx on yachat_system_messages(user_id, chat_id, created_at)",
        """
        create table if not exists yachat_system_chats (
            id text primary key,
            title text default '',
            description text default '',
            avatar_url text default '',
            updated_at timestamptz default now()
        )
        """,
        """
        create table if not exists yachat_telegram_links (
            telegram_user_id text primary key,
            chat_id text not null,
            contact text not null,
            contact_key text not null,
            username text default '',
            first_name text default '',
            updated_at timestamptz default now()
        )
        """,
        "create index if not exists yachat_telegram_links_contact_idx on yachat_telegram_links(contact_key)",
        """
        create table if not exists yachat_sessions (
            token_hash text primary key,
            user_id text not null references public_users(id) on delete cascade,
            created_at timestamptz default now(),
            expires_at timestamptz not null
        )
        """,
        "create index if not exists yachat_sessions_user_idx on yachat_sessions(user_id)",
        """
        create table if not exists yachat_chats (
            id text primary key,
            kind text not null default 'private',
            title text default '',
            description text default '',
            owner_id text references public_users(id) on delete set null,
            locked boolean default false,
            verified boolean default false,
            pinned boolean default false,
            can_send boolean default true,
            avatar_url text default '',
            avatar_accent text default '#471AFF',
            invite_code text,
            created_at timestamptz default now(),
            updated_at timestamptz default now()
        )
        """,
        """
        create table if not exists yachat_chat_members (
            chat_id text not null references yachat_chats(id) on delete cascade,
            user_id text not null references public_users(id) on delete cascade,
            role text default 'member',
            joined_at timestamptz default now(),
            last_read_at timestamptz default '1970-01-01T00:00:00Z',
            primary key(chat_id, user_id)
        )
        """,
        "create index if not exists yachat_chat_members_user_idx on yachat_chat_members(user_id)",
        """
        create table if not exists yachat_messages (
            id text primary key,
            chat_id text not null references yachat_chats(id) on delete cascade,
            sender_id text references public_users(id) on delete set null,
            text text default '',
            attachments jsonb default '[]'::jsonb,
            reply_to_message_id text,
            forwarded_from text default '',
            created_at timestamptz default now(),
            edited_at timestamptz,
            deleted_at timestamptz
        )
        """,
        "alter table yachat_messages add column if not exists formatted_html text default ''",
        "create index if not exists yachat_messages_chat_created_idx on yachat_messages(chat_id, created_at)",
        "create index if not exists yachat_messages_unread_idx on yachat_messages(chat_id, created_at, sender_id) where deleted_at is null",
        """
        create table if not exists yachat_message_hidden (
            message_id text not null references yachat_messages(id) on delete cascade,
            user_id text not null references public_users(id) on delete cascade,
            hidden_at timestamptz default now(),
            primary key(message_id, user_id)
        )
        """,
        "create index if not exists yachat_message_hidden_user_idx on yachat_message_hidden(user_id, message_id)",
        """
        create table if not exists yachat_user_blocks (
            blocker_id text not null references public_users(id) on delete cascade,
            blocked_id text not null references public_users(id) on delete cascade,
            created_at timestamptz default now(),
            primary key(blocker_id, blocked_id),
            check(blocker_id <> blocked_id)
        )
        """,
        "create index if not exists yachat_user_blocks_blocked_idx on yachat_user_blocks(blocked_id, blocker_id)",
        """
        create table if not exists yachat_push_subscriptions (
            endpoint text primary key,
            user_id text not null references public_users(id) on delete cascade,
            p256dh text not null,
            auth text not null,
            content_encoding text default 'aes128gcm',
            user_agent text default '',
            created_at timestamptz default now(),
            updated_at timestamptz default now()
        )
        """,
        "create index if not exists yachat_push_subscriptions_user_idx on yachat_push_subscriptions(user_id)",
        """
        create table if not exists yachat_device_codes (
            id text primary key,
            user_id text not null references public_users(id) on delete cascade,
            code_hash text not null unique,
            display_code text not null,
            language text default 'ru',
            created_at timestamptz default now(),
            expires_at timestamptz not null,
            used_at timestamptz
        )
        """,
        "create index if not exists yachat_device_codes_user_idx on yachat_device_codes(user_id, created_at desc)",
        "create index if not exists yachat_device_codes_expiry_idx on yachat_device_codes(expires_at, used_at)",
        """
        create table if not exists yachat_data_migrations (
            id text primary key,
            applied_at timestamptz default now()
        )
        """,
        """
        create table if not exists yachat_user_settings (
            user_id text primary key references public_users(id) on delete cascade,
            language text default 'ru',
            theme text default 'dark',
            theme_source text default 'system',
            country text default 'RU',
            country_code text default '+7',
            updated_at timestamptz default now()
        )
        """,
        """
        create table if not exists yachat_qr_sessions (
            id text primary key,
            token_hash text not null,
            status text default 'pending',
            account_id text references public_users(id) on delete cascade,
            created_at timestamptz default now(),
            expires_at timestamptz not null,
            approved_at timestamptz
        )
        """,
        "create index if not exists yachat_qr_sessions_status_idx on yachat_qr_sessions(status, expires_at)",
    ]

    try:
        with connect_db() as connection:
            with connection.cursor() as cursor:
                ensure_public_users_table(cursor)
                for statement in statements:
                    cursor.execute(statement)
                apply_data_migrations(cursor)
                cleanup_removed_test_messages(cursor)
        _schema_ready = True
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


def row_value(row: dict[str, Any] | None, *keys: str) -> Any:
    if not row:
        return ""
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    return ""


def clean_text(value: Any, limit: int = 500) -> str:
    return str(value or "").replace("\x00", "").strip()[:limit]



RICH_TAG_ALIASES = {"b": "strong", "i": "em", "del": "s"}
RICH_FORMAT_TAGS = {"strong", "em", "u", "s", "code"}
RICH_LINK_SCHEMES = {"http", "https", "mailto", "tel"}


class RichMessageSanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = RICH_TAG_ALIASES.get(tag.lower(), tag.lower())
        if normalized == "br":
            self.parts.append("<br>")
            return
        if normalized in RICH_FORMAT_TAGS:
            self.parts.append(f"<{normalized}>")
            self.stack.append(normalized)
            return
        if normalized != "a":
            return

        href = next((value for name, value in attrs if name.lower() == "href"), "") or ""
        safe = safe_rich_url(href)
        if not safe:
            return
        self.parts.append(
            f'<a href="{html.escape(safe, quote=True)}" target="_blank" rel="noopener noreferrer">'
        )
        self.stack.append("a")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        normalized = RICH_TAG_ALIASES.get(tag.lower(), tag.lower())
        if normalized != "br":
            self.handle_endtag(normalized)

    def handle_endtag(self, tag: str) -> None:
        normalized = RICH_TAG_ALIASES.get(tag.lower(), tag.lower())
        if normalized not in self.stack:
            return
        while self.stack:
            current = self.stack.pop()
            self.parts.append(f"</{current}>")
            if current == normalized:
                break

    def handle_data(self, data: str) -> None:
        self.parts.append(html.escape(data, quote=False))

    def result(self) -> str:
        while self.stack:
            self.parts.append(f"</{self.stack.pop()}>")
        return "".join(self.parts)


def safe_rich_url(value: object) -> str:
    source = str(value or "").strip()
    if not source:
        return ""
    prepared = source if re.match(r"^[a-z][a-z0-9+.-]*:", source, re.I) else f"https://{source}"
    try:
        parsed = urllib.parse.urlparse(prepared)
    except ValueError:
        return ""
    if parsed.scheme.lower() not in RICH_LINK_SCHEMES:
        return ""
    if parsed.scheme.lower() in {"http", "https"} and not parsed.netloc:
        return ""
    return prepared


def clean_rich_html(value: object) -> str:
    source = str(value or "")[:24000]
    if not source:
        return ""
    sanitizer = RichMessageSanitizer()
    try:
        sanitizer.feed(source)
        sanitizer.close()
    except (ValueError, TypeError):
        return ""
    result = sanitizer.result()
    result = re.sub(r"(?:<br>\s*){3,}", "<br><br>", result, flags=re.I)
    return result.strip()


def rich_html_plain_text(value: str) -> str:
    source = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    source = re.sub(r"</?(?:strong|em|u|s|code|a)(?:\s[^>]*)?>", "", source, flags=re.I)
    return html.unescape(source).replace("\r", "")


def prepare_rich_message(payload: dict[str, object]) -> tuple[str, str]:
    formatted_html = clean_rich_html(payload.get("formattedHtml"))
    text = str(payload.get("text") or "").replace("\x00", "").strip()
    if formatted_html:
        formatted_text = rich_html_plain_text(formatted_html).strip()
        if formatted_text:
            text = formatted_text
        else:
            formatted_html = ""
    if len(text) > 4000:
        raise HTTPException(status_code=400, detail="Message is too long.")
    return formatted_html, text


def identity_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().lower().lstrip("@"))


def is_murochko_profile(row: dict[str, Any] | None) -> bool:
    if not row:
        return False

    values = (
        row_value(row, "username"),
        row_value(row, "display_name"),
        row_value(row, "preview_name"),
        row_value(row, "title"),
    )
    return any(identity_text(value) in {"murochko", "мурочко"} for value in values)


def verification_fields(row: dict[str, Any] | None) -> dict[str, Any]:
    if is_murochko_profile(row):
        return {
            "verified": True,
            "roleLabel": "Владелец",
            "verifiedTitle": "Мурочко",
            "verifiedDescription": "Владелец ЯЧата. Этот значок подтверждает главный системный аккаунт.",
        }

    return {
        "verified": False,
        "roleLabel": "",
        "verifiedTitle": "",
        "verifiedDescription": "",
    }


def system_owner_profile(cursor) -> dict[str, Any] | None:
    cursor.execute(
        """
        select *
        from public_users
        where lower(username) = 'murochko'
           or lower(display_name) = 'мурочко'
           or lower(preview_name) = 'мурочко'
        order by updated_at desc nulls last, created_at desc nulls last
        limit 1
        """
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def system_chat_settings(cursor, chat_id: str) -> dict[str, Any]:
    cursor.execute("select * from yachat_system_chats where id = %s limit 1", (chat_id,))
    row = cursor.fetchone()
    return dict(row) if row else {}


def clean_chat_id(value: Any, *, allow_empty: bool = False) -> str:
    chat_id = str(value or "").strip()
    if allow_empty and not chat_id:
        return ""
    if len(chat_id) > 96 or not CHAT_ID_PATTERN.match(chat_id):
        raise HTTPException(status_code=400, detail="Invalid chat id.")
    return chat_id


def clean_attachments(value: Any) -> list[dict[str, Any]]:
    attachments = value if isinstance(value, list) else []
    result: list[dict[str, Any]] = []

    for item in attachments[:8]:
        if not isinstance(item, dict):
            continue
        try:
            size = int(item.get("size") or 0)
        except (TypeError, ValueError):
            size = 0
        mime = clean_text(item.get("mime"), 120) or "application/octet-stream"
        kind = clean_text(item.get("kind"), 20)
        if kind not in {"image", "video", "file"}:
            kind = "image" if mime.startswith("image/") else "video" if mime.startswith("video/") else "file"
        raw_data_url = str(item.get("dataUrl") or "")
        if len(raw_data_url) > MAX_ATTACHMENT_DATA_URL_BYTES:
            raise HTTPException(status_code=413, detail="Attachment is too large.")
        data_url = clean_text(raw_data_url, MAX_ATTACHMENT_DATA_URL_BYTES)
        if data_url and not data_url.startswith("data:"):
            data_url = ""
        result.append(
            {
                "id": clean_text(item.get("id"), 80) or str(uuid.uuid4()),
                "name": clean_text(item.get("name"), 180) or "file",
                "mime": mime,
                "kind": kind,
                "size": max(0, min(size, MAX_ATTACHMENT_DATA_URL_BYTES)),
                "dataUrl": data_url,
            }
        )

    return result


def normalize_contact(contact: Any) -> str:
    return re.sub(r"\s+", " ", str(contact or "").strip())


def contact_key(contact: Any) -> str:
    return re.sub(r"[^\d+a-z@._-]+", "", normalize_contact(contact).lower())


def contact_lookup_keys(value: Any) -> set[str]:
    normalized = contact_key(value)
    digits = re.sub(r"\D+", "", str(value or ""))
    keys: set[str] = set()

    def add_key(key: str) -> None:
        clean = str(key or "").strip().lower()
        if not clean:
            return
        keys.add(clean)
        if clean.startswith("+"):
            keys.add(clean[1:])

    add_key(normalized)

    if not digits:
        return keys

    add_key(digits)
    add_key(f"+{digits}")
    if len(digits) == 11 and digits.startswith("8"):
        add_key(f"7{digits[1:]}")
        add_key(f"+7{digits[1:]}")
    if len(digits) == 11 and digits.startswith("7"):
        add_key(digits[1:])
    if len(digits) == 10:
        add_key(f"7{digits}")
        add_key(f"+7{digits}")

    return keys


def sql_like_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def normalize_username(value: Any) -> str:
    username = re.sub(r"[^a-z0-9_]+", "_", str(value or "").strip().lower().lstrip("@"))
    username = re.sub(r"^_+|_+$", "", username)[:24]
    return username if len(username) >= 3 else ""


def hash_secret(value: str) -> str:
    return hmac.new(auth_secret().encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def generate_token() -> str:
    return secrets.token_urlsafe(36)


DEVICE_CODE_ALPHABETS = {
    "ru": "АБВГДЕЖЗКЛМНПРСТУФХЦЧШЭЮЯ",
    "en": "ABCDEFGHJKLMNPQRSTUVWXYZ",
}


def normalize_device_code(value: Any) -> str:
    return re.sub(r"[^0-9A-ZА-ЯЁ]+", "", str(value or "").upper().replace("Ё", "Е"))[:6]


def format_device_code(value: str) -> str:
    normalized = normalize_device_code(value)
    return f"{normalized[:3]}-{normalized[3:]}" if len(normalized) == 6 else normalized


def generate_device_code(language: str = "ru") -> tuple[str, str]:
    alphabet = DEVICE_CODE_ALPHABETS["en" if language == "en" else "ru"]
    letter_count = secrets.choice((2, 3))
    raw = "".join(secrets.choice(alphabet) for _ in range(letter_count))
    raw += "".join(str(secrets.randbelow(10)) for _ in range(6 - letter_count))
    return raw, format_device_code(raw)


def verification_code_text(contact: str, code: str) -> str:
    return "\n".join(
        [
            "🔐 Код подтверждения ЯЧата",
            "",
            f"Номер: {contact}",
            f"Код: {code}",
            "",
            "⌛ Действует 10 минут.",
            "⚠️ Никому его не сообщайте.",
        ]
    )


def verification_code_html(contact: str, code: str) -> str:
    return (
        "<strong>🔐 Код подтверждения ЯЧата</strong><br><br>"
        f"Номер: <strong>{html.escape(contact)}</strong><br>"
        f"Код: <code>{html.escape(code)}</code><br><br>"
        "⌛ Действует 10 минут.<br>"
        "<strong>⚠️ Никому его не сообщайте.</strong>"
    )


def telegram_md_code(value: Any) -> str:
    text = str(value or "").replace("\\", "\\\\").replace("`", "\\`")
    return f"`{text}`"


def telegram_verification_code_text(contact: str, code: str) -> str:
    return "\n".join(
        [
            "🔐 *Код подтверждения ЯЧата*",
            "",
            f"Номер: {telegram_md_code(contact)}",
            f"Код: {telegram_md_code(code)}",
            "",
            "⏳ Действует 10 минут\\.",
            "⚠️ Никому его не сообщайте\\.",
        ]
    )


def telegram_request(method: str, payload: dict[str, Any]) -> bool:
    token = telegram_bot_token()
    if not token:
        return False

    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = json.loads(response.read().decode("utf-8"))
            return bool(body.get("ok"))
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
        return False


def send_telegram_message(
    chat_id: str,
    text: str,
    reply_markup: dict[str, Any] | None = None,
    parse_mode: str = "",
) -> bool:
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    if parse_mode:
        payload["parse_mode"] = parse_mode
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    return telegram_request("sendMessage", payload)


def send_telegram_markdown_message(chat_id: str, text: str, reply_markup: dict[str, Any] | None = None) -> bool:
    return send_telegram_message(chat_id, text, reply_markup, "MarkdownV2")


def telegram_contact_keyboard() -> dict[str, Any]:
    return {
        "keyboard": [[{"text": "📱 Поделиться номером", "request_contact": True}]],
        "resize_keyboard": True,
        "one_time_keyboard": True,
    }


def telegram_remove_keyboard() -> dict[str, Any]:
    return {"remove_keyboard": True}


def delivery_method(value: Any) -> str:
    return "telegram" if str(value or "").strip().lower() == "telegram" else "yachat"


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
        **verification_fields(row),
    }

    user["contact"] = str(row_value(row, "contact")) if env_flag("YACHAT_PUBLIC_CONTACTS", False) else ""
    return user


def public_account(row: dict[str, Any], session_token: str = "") -> dict[str, Any]:
    account = {
        "id": str(row_value(row, "id")),
        "title": "YaChat",
        "displayName": str(row_value(row, "display_name", "preview_name", "username")),
        "username": str(row_value(row, "username")),
        "bio": str(row_value(row, "bio")),
        "contact": str(row_value(row, "contact")),
        "method": str(row_value(row, "method")) or "phone",
        "avatarDataUrl": str(row_value(row, "avatar_url", "avatar_data_url")),
        "avatarAccent": str(row_value(row, "avatar_accent")) or "#471AFF",
        "createdAt": row_value(row, "created_at"),
        "status": "account-created",
        "encrypted": True,
        **verification_fields(row),
    }
    if session_token:
        account["sessionToken"] = session_token
    return account


def payload_contacts(payload: Any) -> list[str]:
    if not isinstance(payload, dict):
        return []

    raw_contacts = payload.get("contacts") or payload.get("phones") or []
    if not isinstance(raw_contacts, list):
        return []

    contacts: list[str] = []
    for item in raw_contacts[:500]:
        value = item.get("phone") or item.get("tel") or item.get("contact") if isinstance(item, dict) else item
        value = str(value or "").strip()
        if value:
            contacts.append(value)

    return contacts


def request_token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return ""


def current_user(request: Request) -> dict[str, Any] | None:
    token = request_token(request)
    if not token:
        return None

    ensure_schema()
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
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
                return dict(row) if row else None
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


def require_user(request: Request) -> dict[str, Any]:
    user = current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in first.")
    return user


def insert_session(cursor, user_id: str) -> str:
    token = generate_token()
    expires_at = utc_now() + timedelta(days=90)
    cursor.execute(
        """
        insert into yachat_sessions(token_hash, user_id, expires_at)
        values (%s, %s, %s)
        """,
        (hash_secret(token), user_id, expires_at),
    )
    return token


def create_session(user_id: str) -> str:
    with connect_db() as connection:
        with connection.cursor() as cursor:
            return insert_session(cursor, user_id)


def find_user_by_contact(key: str) -> dict[str, Any] | None:
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute("select * from public_users where contact_key = %s limit 1", (key,))
            row = cursor.fetchone()
            return dict(row) if row else None


def find_user_by_contact_cursor(cursor, value: Any) -> dict[str, Any] | None:
    keys = sorted(contact_lookup_keys(value))
    if not keys:
        return None

    cursor.execute(
        """
        select *
        from public_users
        where lower(coalesce(contact_key::text, '')) = any(%s)
           or regexp_replace(coalesce(contact::text, ''), '\\D+', '', 'g') = any(%s)
           or regexp_replace(coalesce(contact_key::text, ''), '\\D+', '', 'g') = any(%s)
        order by created_at desc nulls last
        limit 1
        """,
        (keys, keys, keys),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def add_system_delivery_message(
    cursor,
    user_id: str,
    chat_id: str,
    text: str,
    expires_at: datetime | None = None,
    formatted_html: str = "",
) -> None:
    cursor.execute(
        """
        insert into yachat_system_messages(
            id, user_id, chat_id, text, formatted_html, system_kind, expires_at
        )
        values (%s, %s, %s, %s, %s, 'verification-code', %s)
        """,
        (str(uuid.uuid4()), user_id, chat_id, text, clean_rich_html(formatted_html), expires_at),
    )


def telegram_links_for_contact(cursor, contact: str) -> list[dict[str, Any]]:
    keys = sorted(contact_lookup_keys(contact))
    if not keys:
        return []

    cursor.execute(
        """
        select *
        from yachat_telegram_links
        where contact_key = any(%s)
        order by updated_at desc
        limit 5
        """,
        (keys,),
    )
    rows = [dict(row) for row in cursor.fetchall()]
    seen: set[str] = set()
    links: list[dict[str, Any]] = []
    for row in rows:
        chat_id = str(row_value(row, "chat_id"))
        if chat_id and chat_id not in seen:
            seen.add(chat_id)
            links.append(row)
    return links


def send_telegram_verification_code(links: list[dict[str, Any]], contact: str, code: str) -> int:
    text = telegram_verification_code_text(contact, code)
    sent = 0
    for link in links:
        chat_id = str(row_value(link, "chat_id"))
        if chat_id and send_telegram_markdown_message(chat_id, text):
            sent += 1
    return sent


def username_taken(cursor, username: str, exclude_user_id: str = "") -> bool:
    if not username:
        return False
    if exclude_user_id:
        cursor.execute(
            "select 1 from public_users where lower(username) = lower(%s) and id <> %s limit 1",
            (username, exclude_user_id),
        )
    else:
        cursor.execute("select 1 from public_users where lower(username) = lower(%s) limit 1", (username,))
    return bool(cursor.fetchone())


def fetch_public_users() -> list[dict[str, Any]]:
    require_database()
    ensure_schema()

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

    require_database()
    if not term or (len(term) < 2 and len(digits) < 3):
        return []
    ensure_schema()

    text = sql_like_escape(term.lower().lstrip("@"))
    text_like = f"%{text}%"
    normalized_contact = sql_like_escape(contact_key(term).lstrip("@+"))
    contact_like = f"%{normalized_contact}%" if normalized_contact else "__no_contact_match__"
    digits_like = f"%{sql_like_escape(digits)}%" if digits else "__no_digits_match__"
    exact_keys = sorted(contact_lookup_keys(term))
    username_exact = term.lower().lstrip("@")
    username_prefix = f"{sql_like_escape(username_exact)}%"
    columns = ", ".join((*PUBLIC_USER_FIELDS, "contact", "contact_key"))
    query = f"""
        select {columns}
        from public_users
        where coalesce(is_public, true) = true
          and (
            lower(coalesce(username::text, '')) like %s escape '\\'
            or lower(coalesce(preview_name::text, '')) like %s escape '\\'
            or lower(coalesce(display_name::text, '')) like %s escape '\\'
            or lower(coalesce(contact::text, '')) like %s escape '\\'
            or lower(coalesce(contact_key::text, '')) like %s escape '\\'
            or regexp_replace(coalesce(contact::text, ''), '\\D+', '', 'g') like %s escape '\\'
            or regexp_replace(coalesce(contact_key::text, ''), '\\D+', '', 'g') like %s escape '\\'
            or lower(coalesce(contact_key::text, '')) = any(%s)
            or regexp_replace(coalesce(contact::text, ''), '\\D+', '', 'g') = any(%s)
            or regexp_replace(coalesce(contact_key::text, ''), '\\D+', '', 'g') = any(%s)
          )
        order by
          case
            when lower(coalesce(username::text, '')) = %s then 0
            when lower(coalesce(username::text, '')) like %s escape '\\' then 1
            when lower(coalesce(display_name::text, '')) like %s escape '\\'
              or lower(coalesce(preview_name::text, '')) like %s escape '\\' then 2
            when lower(coalesce(contact_key::text, '')) = any(%s)
              or regexp_replace(coalesce(contact::text, ''), '\\D+', '', 'g') = any(%s)
              or regexp_replace(coalesce(contact_key::text, ''), '\\D+', '', 'g') = any(%s) then 3
            else 4
          end,
          updated_at desc nulls last,
          created_at desc nulls last
        limit %s
    """

    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    query,
                    (
                        text_like,
                        text_like,
                        text_like,
                        text_like,
                        contact_like,
                        digits_like,
                        digits_like,
                        exact_keys,
                        exact_keys,
                        exact_keys,
                        username_exact,
                        username_prefix,
                        username_prefix,
                        username_prefix,
                        exact_keys,
                        exact_keys,
                        exact_keys,
                        min(public_limit(), 25),
                    ),
                )
                return [public_user(dict(row)) for row in cursor.fetchall()]
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


def fetch_user_by_username(username: str) -> dict[str, Any] | None:
    normalized = normalize_username(username)
    if not normalized:
        return None

    require_database()
    ensure_schema()
    columns = ", ".join(PUBLIC_USER_FIELDS)
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    f"""
                    select {columns}
                    from public_users
                    where coalesce(is_public, true) = true
                      and lower(username) = lower(%s)
                    limit 1
                    """,
                    (normalized,),
                )
                row = cursor.fetchone()
                return public_user(dict(row)) if row else None
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error


def fetch_contact_matches(contacts: list[str]) -> list[dict[str, Any]]:
    require_database()
    if not contacts:
        return []
    ensure_schema()

    requested: set[str] = set()
    submitted_by_key: dict[str, str] = {}
    for contact in contacts:
        for key in contact_lookup_keys(contact):
            requested.add(key)
            submitted_by_key.setdefault(key, contact)

    if not requested:
        return []

    requested_keys = sorted(requested)
    columns = ", ".join((*PUBLIC_USER_FIELDS, "contact", "contact_key"))
    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    f"""
                    select {columns}
                    from public_users
                    where coalesce(is_public, true) = true
                      and (
                        lower(coalesce(contact_key::text, '')) = any(%s)
                        or regexp_replace(coalesce(contact::text, ''), '\\D+', '', 'g') = any(%s)
                        or regexp_replace(coalesce(contact_key::text, ''), '\\D+', '', 'g') = any(%s)
                      )
                    order by created_at desc nulls last
                    limit %s
                    """,
                    (requested_keys, requested_keys, requested_keys, public_limit()),
                )
                rows = [dict(row) for row in cursor.fetchall()]
    except psycopg.Error as error:
        raise HTTPException(status_code=503, detail="Users database is unavailable.") from error

    matches: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for row in rows:
        row_keys = contact_lookup_keys(row_value(row, "contact"))
        row_keys.update(contact_lookup_keys(row_value(row, "contact_key")))
        match_key = next((key for key in row_keys if key in requested), "")
        user_id = str(row_value(row, "id"))
        if not match_key or user_id in seen_ids:
            continue
        seen_ids.add(user_id)
        matches.append(public_user(row, submitted_by_key.get(match_key, "")))

    return matches


def user_profile(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row_value(row, "id")),
        "username": str(row_value(row, "username")),
        "displayName": str(row_value(row, "display_name", "preview_name", "username")),
        "previewName": str(row_value(row, "preview_name", "display_name", "username")),
        "avatarDataUrl": str(row_value(row, "avatar_url")),
        "avatarAccent": str(row_value(row, "avatar_accent")) or "#471AFF",
        **verification_fields(row),
    }


def normalize_settings(payload: dict[str, Any] | None, base: dict[str, Any] | None = None) -> dict[str, Any]:
    source = {**DEFAULT_SETTINGS, **(base or {})}
    payload = payload if isinstance(payload, dict) else {}

    language = str(payload.get("language") or source.get("language") or "ru")
    theme = str(payload.get("theme") or source.get("theme") or "dark")
    theme_source = str(payload.get("themeSource") or payload.get("theme_source") or source.get("themeSource") or "system")
    country = clean_text(payload.get("country") or source.get("country") or "RU", 8) or "RU"
    country_code = clean_text(payload.get("countryCode") or payload.get("country_code") or source.get("countryCode") or "+7", 8) or "+7"

    return {
        "language": "en" if language == "en" else "ru",
        "theme": theme if theme in {"dark", "light"} else "dark",
        "themeSource": theme_source if theme_source in {"manual", "system"} else "system",
        "country": country,
        "countryCode": country_code,
    }


def settings_from_row(row: dict[str, Any] | None) -> dict[str, Any]:
    if not row:
        return dict(DEFAULT_SETTINGS)
    return normalize_settings(
        {
            "language": row_value(row, "language"),
            "theme": row_value(row, "theme"),
            "themeSource": row_value(row, "theme_source"),
            "country": row_value(row, "country"),
            "countryCode": row_value(row, "country_code"),
        }
    )


def get_user_settings(user_id: str) -> dict[str, Any]:
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute("select * from yachat_user_settings where user_id = %s limit 1", (user_id,))
            row = cursor.fetchone()
            return settings_from_row(dict(row) if row else None)


def save_user_settings(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    settings = normalize_settings(payload, get_user_settings(user_id))
    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                insert into yachat_user_settings(user_id, language, theme, theme_source, country, country_code, updated_at)
                values (%s, %s, %s, %s, %s, %s, now())
                on conflict (user_id) do update
                set language = excluded.language,
                    theme = excluded.theme,
                    theme_source = excluded.theme_source,
                    country = excluded.country,
                    country_code = excluded.country_code,
                    updated_at = now()
                """,
                (
                    user_id,
                    settings["language"],
                    settings["theme"],
                    settings["themeSource"],
                    settings["country"],
                    settings["countryCode"],
                ),
            )
    return settings


def system_chats(
    now_value: datetime | None = None,
    latest_messages: dict[str, dict[str, Any]] | None = None,
    owner_profile: dict[str, Any] | None = None,
    channel_settings: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    created_at = now_value or utc_now()
    latest_messages = latest_messages or {}
    channel_settings = channel_settings or {}
    codes_latest = latest_messages.get("yachat-codes") or {}
    channel_latest = latest_messages.get("yachat-channel") or {}
    codes_intro = "Здесь будут появляться одноразовые коды подтверждения для входа, банков, магазинов и сервисов."
    channel_intro = "ЯЧат запущен. Здесь будут новости приложения, изменения и служебные объявления."
    owner = owner_profile or {}
    owner_name = str(row_value(owner, "display_name", "preview_name", "username")) or SYSTEM_OWNER["displayName"]
    owner_username = str(row_value(owner, "username")) or SYSTEM_OWNER["username"]
    owner_avatar = str(row_value(owner, "avatar_url", "avatar_data_url"))
    owner_avatar_accent = str(row_value(owner, "avatar_accent")) or "#471AFF"
    channel_title = str(row_value(channel_settings, "title")) or "ЯЧат"
    channel_description = str(row_value(channel_settings, "description")) or channel_intro
    channel_avatar = str(row_value(channel_settings, "avatar_url"))
    if not channel_avatar or any(
        legacy_icon in channel_avatar
        for legacy_icon in ("yachat-logo-COLOR", "yachat-avatar.svg", "yachat-SVG-color")
    ):
        channel_avatar = "./assets/yachat-icon-square.png"
    return [
        {
            "id": "yachat-favorites",
            "kind": "saved",
            "title": "Избранное",
            "subtitle": "Сообщения для себя",
            "description": "Сообщения для себя",
            "profileAbout": "Сообщения для себя",
            "locked": True,
            "verified": False,
            "pinned": True,
            "canSend": True,
            "avatar": "favorites",
            "createdAt": created_at,
            "lastAt": created_at,
            "lastMessage": "",
            "unread": 0,
        },
        {
            "id": "yachat-codes",
            "kind": "bot",
            "title": "Коды подтверждения",
            "subtitle": "Ваши одноразовые коды",
            "description": "Ваши одноразовые коды от банков, магазинов и сервисов",
            "profileUsername": "verificationcodes_bot",
            "profileUrl": "https://yachat.vercel.app/verificationcodes_bot",
            "profileAbout": "Ваши одноразовые коды от банков, магазинов и сервисов",
            "profileKindLabel": "Системный бот",
            "locked": True,
            "verified": True,
            "verifiedTitle": "Коды подтверждения",
            "verifiedDescription": "Системный бот ЯЧата для одноразовых кодов. Историю этого бота очистить нельзя.",
            "pinned": True,
            "canSend": False,
            "avatar": "codes",
            "avatarDataUrl": "./assets/yachat-avatar.svg",
            "createdAt": created_at,
            "lastAt": row_value(codes_latest, "created_at") or created_at,
            "lastMessage": str(row_value(codes_latest, "text")),
            "unread": 0,
        },
        {
            "id": "yachat-channel",
            "kind": "channel",
            "title": channel_title,
            "subtitle": "Системный канал",
            "description": channel_description,
            "profileUsername": "yachat_channel",
            "profileUrl": "https://yachat.vercel.app/yachat_channel",
            "profileAbout": channel_description,
            "profileKindLabel": "Системный канал",
            "ownerId": str(row_value(owner, "id")) or SYSTEM_OWNER["id"],
            "ownerName": owner_name,
            "ownerUsername": owner_username,
            "ownerAvatarDataUrl": owner_avatar,
            "ownerAvatarAccent": owner_avatar_accent,
            "locked": True,
            "verified": True,
            "verifiedTitle": "ЯЧат",
            "verifiedDescription": "Системный канал ЯЧата. Все аккаунты подписаны автоматически; писать и чистить историю может только владелец Мурочко.",
            "pinned": True,
            "canSend": False,
            "avatar": "channel",
            "avatarDataUrl": channel_avatar,
            "createdAt": created_at,
            "lastAt": row_value(channel_latest, "created_at") or created_at,
            "lastMessage": str(row_value(channel_latest, "text")),
            "unread": 0,
        },
    ]


def system_chat_messages(chat_id: str) -> list[dict[str, Any]]:
    return []


def system_message_payload(row: dict[str, Any], current_user_id: str = "") -> dict[str, Any]:
    chat_id = str(row_value(row, "chat_id"))
    author_id = str(row_value(row, "author_id")) or "yachat"
    attachments = row_value(row, "attachments")
    return {
        "id": str(row_value(row, "id")),
        "chatId": chat_id,
        "author": "channel" if chat_id == "yachat-channel" else "user" if author_id and author_id == current_user_id else "bot",
        "authorId": author_id,
        "text": str(row_value(row, "text")),
        "formattedHtml": clean_rich_html(row_value(row, "formatted_html")),
        "attachments": attachments if isinstance(attachments, list) else [],
        "replyToMessageId": None,
        "forwardedFrom": "",
        "createdAt": row_value(row, "created_at"),
        "editedAt": None,
    }


def latest_system_messages(cursor, user_id: str) -> dict[str, dict[str, Any]]:
    cursor.execute(
        """
        select distinct on (chat_id) *
        from yachat_system_messages
        where user_id = %s
          and (chat_id <> 'yachat-channel' or system_kind = 'channel-post')
        order by chat_id, created_at desc
        """,
        (user_id,),
    )
    return {str(row["chat_id"]): dict(row) for row in cursor.fetchall()}


def system_messages_for_user(cursor, chat_id: str, user_id: str) -> list[dict[str, Any]]:
    cursor.execute(
        """
        select *
        from yachat_system_messages
        where user_id = %s
          and chat_id = %s
          and (chat_id <> 'yachat-channel' or system_kind = 'channel-post')
        order by created_at asc
        limit 500
        """,
        (user_id, chat_id),
    )
    return [system_message_payload(dict(row), user_id) for row in cursor.fetchall()]


def chat_members(cursor, chat_id: str) -> list[dict[str, Any]]:
    cursor.execute(
        """
        select u.*
        from yachat_chat_members cm
        join public_users u on u.id = cm.user_id
        where cm.chat_id = %s
        order by cm.joined_at asc
        """,
        (chat_id,),
    )
    return [dict(row) for row in cursor.fetchall()]


def private_chat_peer_id(cursor, chat_id: str, user_id: str) -> str:
    cursor.execute(
        "select user_id from yachat_chat_members where chat_id = %s and user_id <> %s order by joined_at asc limit 1",
        (chat_id, user_id),
    )
    row = cursor.fetchone()
    return str(row_value(row, "user_id"))


def chat_block_flags(cursor, user_id: str, peer_id: str) -> tuple[bool, bool]:
    if not peer_id:
        return False, False
    cursor.execute(
        """
        select blocker_id, blocked_id
        from yachat_user_blocks
        where (blocker_id = %s and blocked_id = %s)
           or (blocker_id = %s and blocked_id = %s)
        """,
        (user_id, peer_id, peer_id, user_id),
    )
    rows = [dict(row) for row in cursor.fetchall()]
    blocked_by_me = any(str(row["blocker_id"]) == user_id for row in rows)
    blocked_me = any(str(row["blocker_id"]) == peer_id for row in rows)
    return blocked_by_me, blocked_me


def require_private_chat_peer(cursor, chat_id: str, user_id: str) -> tuple[dict[str, Any], str]:
    chat = require_chat_member(cursor, chat_id, user_id)
    if str(row_value(chat, "kind")) != "private":
        raise HTTPException(status_code=400, detail="Only private chat users can be blocked.")
    peer_id = private_chat_peer_id(cursor, chat_id, user_id)
    if not peer_id:
        raise HTTPException(status_code=404, detail="User not found.")
    return chat, peer_id


def require_chat_messaging_allowed(cursor, chat: dict[str, Any], user_id: str) -> None:
    if str(row_value(chat, "kind")) != "private":
        return
    peer_id = private_chat_peer_id(cursor, str(row_value(chat, "id")), user_id)
    blocked_by_me, blocked_me = chat_block_flags(cursor, user_id, peer_id)
    if blocked_by_me or blocked_me:
        raise HTTPException(status_code=403, detail="Messages cannot be sent while this user is blocked.")


def chat_summary(cursor, chat: dict[str, Any], user_id: str) -> dict[str, Any]:
    chat_id = str(chat["id"])
    members = chat_members(cursor, chat_id)
    profiles = {str(row["id"]): user_profile(row) for row in members}
    other = next((row for row in members if str(row["id"]) != user_id), members[0] if members else {})

    cursor.execute(
        """
        select m.text, m.attachments, m.created_at
        from yachat_messages m
        where m.chat_id = %s and m.deleted_at is null
          and not exists (
              select 1 from yachat_message_hidden h
              where h.message_id = m.id and h.user_id = %s
          )
        order by created_at desc
        limit 1
        """,
        (chat_id, user_id),
    )
    last = cursor.fetchone()

    cursor.execute(
        """
        select count(*) as count
        from yachat_messages m
        join yachat_chat_members cm on cm.chat_id = m.chat_id and cm.user_id = %s
        where m.chat_id = %s
          and m.deleted_at is null
          and not exists (
              select 1 from yachat_message_hidden h
              where h.message_id = m.id and h.user_id = %s
          )
          and coalesce(m.sender_id, '') <> %s
          and m.created_at > coalesce(cm.last_read_at, '1970-01-01T00:00:00Z'::timestamptz)
        """,
        (user_id, chat_id, user_id, user_id),
    )
    unread = int(cursor.fetchone()["count"])
    attachment_text = ""
    attachments = row_value(last, "attachments")
    if isinstance(attachments, list) and attachments:
        kind = str(attachments[0].get("kind") or "")
        attachment_text = "Фото" if kind == "image" else "Видео" if kind == "video" else "Файл"

    title = str(row_value(chat, "title"))
    subtitle = ""
    avatar_data_url = str(row_value(chat, "avatar_url"))
    profile_username = ""
    profile_url = ""
    profile_about = str(row_value(chat, "description"))
    profile_kind_label = "Группа" if chat["kind"] == "group" else ""
    verified = bool(row_value(chat, "verified"))
    verified_meta: dict[str, Any] = {}
    blocked_by_me = False
    blocked_me = False
    if chat["kind"] == "private" and other:
        peer_id = str(row_value(other, "id"))
        blocked_by_me, blocked_me = chat_block_flags(cursor, user_id, peer_id)
        title = str(row_value(other, "display_name", "preview_name", "username"))
        username = str(row_value(other, "username"))
        subtitle = f"@{username}" if username else "Личный чат"
        avatar_data_url = str(row_value(other, "avatar_url")) or avatar_data_url
        profile_username = username
        profile_url = f"https://yachat.vercel.app/{username}" if username else ""
        profile_about = str(row_value(other, "bio"))
        profile_kind_label = ""
        verified_meta = verification_fields(other)
        verified = bool(verified_meta.get("verified"))
    elif chat["kind"] == "group":
        subtitle = subtitle or f"{max(len(members), 1)} участников"

    return {
        "id": chat_id,
        "kind": str(chat["kind"]),
        "title": title or "ЯЧат",
        "subtitle": subtitle or "",
        "description": str(row_value(chat, "description")),
        "participantIds": [str(row["id"]) for row in members],
        "participantProfiles": profiles,
        "ownerId": str(row_value(chat, "owner_id")),
        "locked": bool(row_value(chat, "locked")),
        "verified": verified,
        "verifiedTitle": str(verified_meta.get("verifiedTitle") or ""),
        "verifiedDescription": str(verified_meta.get("verifiedDescription") or ""),
        "roleLabel": str(verified_meta.get("roleLabel") or ""),
        "pinned": bool(row_value(chat, "pinned")),
        "canSend": bool(row_value(chat, "can_send") if "can_send" in chat else True) and not blocked_by_me and not blocked_me,
        "blockedByMe": blocked_by_me,
        "blockedMe": blocked_me,
        "avatar": str(chat["kind"]),
        "avatarDataUrl": avatar_data_url,
        "avatarAccent": str(row_value(chat, "avatar_accent")) or "#471AFF",
        "profileUsername": profile_username,
        "profileUrl": profile_url,
        "profileAbout": profile_about,
        "profileKindLabel": profile_kind_label,
        "inviteCode": str(row_value(chat, "invite_code")),
        "createdAt": row_value(chat, "created_at"),
        "lastAt": row_value(last, "created_at") or row_value(chat, "created_at"),
        "lastMessage": str(row_value(last, "text")) or attachment_text,
        "unread": unread,
    }


def attachment_preview_text(attachments: Any) -> str:
    if not isinstance(attachments, list) or not attachments:
        return ""

    kind = str(attachments[0].get("kind") or "")
    if kind == "image":
        return "Фото"
    if kind == "video":
        return "Видео"
    return "Файл"


def chat_summary_cached(
    chat: dict[str, Any],
    user_id: str,
    members: list[dict[str, Any]],
    last: dict[str, Any] | None,
    unread: int = 0,
    blocked_by_user_ids: set[str] | None = None,
    blocking_user_ids: set[str] | None = None,
) -> dict[str, Any]:
    chat_id = str(chat["id"])
    profiles = {str(row["id"]): user_profile(row) for row in members}
    other = next((row for row in members if str(row["id"]) != user_id), members[0] if members else {})
    attachment_text = attachment_preview_text(row_value(last, "attachments"))

    title = str(row_value(chat, "title"))
    subtitle = ""
    avatar_data_url = str(row_value(chat, "avatar_url"))
    profile_username = ""
    profile_url = ""
    profile_about = str(row_value(chat, "description"))
    profile_kind_label = "Группа" if chat["kind"] == "group" else ""
    verified = bool(row_value(chat, "verified"))
    verified_meta: dict[str, Any] = {}
    blocked_by_me = False
    blocked_me = False

    if chat["kind"] == "private" and other:
        peer_id = str(row_value(other, "id"))
        blocked_by_me = peer_id in (blocked_by_user_ids or set())
        blocked_me = peer_id in (blocking_user_ids or set())
        title = str(row_value(other, "display_name", "preview_name", "username"))
        username = str(row_value(other, "username"))
        subtitle = f"@{username}" if username else "Личный чат"
        avatar_data_url = str(row_value(other, "avatar_url")) or avatar_data_url
        profile_username = username
        profile_url = f"https://yachat.vercel.app/{username}" if username else ""
        profile_about = str(row_value(other, "bio"))
        profile_kind_label = ""
        verified_meta = verification_fields(other)
        verified = bool(verified_meta.get("verified"))
    elif chat["kind"] == "group":
        subtitle = subtitle or f"{max(len(members), 1)} участников"

    return {
        "id": chat_id,
        "kind": str(chat["kind"]),
        "title": title or "ЯЧат",
        "subtitle": subtitle or "",
        "description": str(row_value(chat, "description")),
        "participantIds": [str(row["id"]) for row in members],
        "participantProfiles": profiles,
        "ownerId": str(row_value(chat, "owner_id")),
        "locked": bool(row_value(chat, "locked")),
        "verified": verified,
        "verifiedTitle": str(verified_meta.get("verifiedTitle") or ""),
        "verifiedDescription": str(verified_meta.get("verifiedDescription") or ""),
        "roleLabel": str(verified_meta.get("roleLabel") or ""),
        "pinned": bool(row_value(chat, "pinned")),
        "canSend": bool(row_value(chat, "can_send") if "can_send" in chat else True) and not blocked_by_me and not blocked_me,
        "blockedByMe": blocked_by_me,
        "blockedMe": blocked_me,
        "avatar": str(chat["kind"]),
        "avatarDataUrl": avatar_data_url,
        "avatarAccent": str(row_value(chat, "avatar_accent")) or "#471AFF",
        "profileUsername": profile_username,
        "profileUrl": profile_url,
        "profileAbout": profile_about,
        "profileKindLabel": profile_kind_label,
        "inviteCode": str(row_value(chat, "invite_code")),
        "createdAt": row_value(chat, "created_at"),
        "lastAt": row_value(last, "created_at") or row_value(chat, "created_at"),
        "lastMessage": str(row_value(last, "text")) or attachment_text,
        "unread": int(unread or 0),
    }


def list_user_chats(user_id: str) -> list[dict[str, Any]]:
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                select c.*
                from yachat_chats c
                join yachat_chat_members cm on cm.chat_id = c.id
                where cm.user_id = %s
                  and c.kind <> 'saved'
                order by c.pinned desc, c.updated_at desc, c.created_at desc
                """,
                (user_id,),
            )
            chat_rows = [dict(row) for row in cursor.fetchall()]
            latest_messages = latest_system_messages(cursor, user_id)
            owner_profile = system_owner_profile(cursor)
            channel_settings = system_chat_settings(cursor, "yachat-channel")

            if not chat_rows:
                return system_chats(
                    latest_messages=latest_messages,
                    owner_profile=owner_profile,
                    channel_settings=channel_settings,
                )

            chat_ids = [str(row["id"]) for row in chat_rows]
            members_by_chat: dict[str, list[dict[str, Any]]] = defaultdict(list)
            cursor.execute(
                """
                select cm.chat_id as member_chat_id, u.*
                from yachat_chat_members cm
                join public_users u on u.id = cm.user_id
                where cm.chat_id = any(%s)
                order by cm.chat_id, cm.joined_at asc
                """,
                (chat_ids,),
            )
            for row in cursor.fetchall():
                member = dict(row)
                members_by_chat[str(member.pop("member_chat_id"))].append(member)

            latest_by_chat: dict[str, dict[str, Any]] = {}
            cursor.execute(
                """
                select distinct on (m.chat_id) m.chat_id, m.text, m.attachments, m.created_at
                from yachat_messages m
                where m.chat_id = any(%s) and m.deleted_at is null
                  and not exists (
                      select 1 from yachat_message_hidden h
                      where h.message_id = m.id and h.user_id = %s
                  )
                order by m.chat_id, m.created_at desc
                """,
                (chat_ids, user_id),
            )
            for row in cursor.fetchall():
                latest_by_chat[str(row["chat_id"])] = dict(row)

            unread_by_chat: dict[str, int] = {}
            cursor.execute(
                """
                select m.chat_id, count(*) as count
                from yachat_messages m
                join yachat_chat_members cm on cm.chat_id = m.chat_id and cm.user_id = %s
                where m.chat_id = any(%s)
                  and m.deleted_at is null
                  and not exists (
                      select 1 from yachat_message_hidden h
                      where h.message_id = m.id and h.user_id = %s
                  )
                  and coalesce(m.sender_id, '') <> %s
                  and m.created_at > coalesce(cm.last_read_at, '1970-01-01T00:00:00Z'::timestamptz)
                group by m.chat_id
                """,
                (user_id, chat_ids, user_id, user_id),
            )
            for row in cursor.fetchall():
                unread_by_chat[str(row["chat_id"])] = int(row["count"])

            cursor.execute(
                """
                select blocker_id, blocked_id
                from yachat_user_blocks
                where blocker_id = %s or blocked_id = %s
                """,
                (user_id, user_id),
            )
            block_rows = [dict(row) for row in cursor.fetchall()]
            blocked_by_user_ids = {
                str(row["blocked_id"])
                for row in block_rows
                if str(row["blocker_id"]) == user_id
            }
            blocking_user_ids = {
                str(row["blocker_id"])
                for row in block_rows
                if str(row["blocked_id"]) == user_id
            }

            chats = [
                chat_summary_cached(
                    chat,
                    user_id,
                    members_by_chat.get(str(chat["id"]), []),
                    latest_by_chat.get(str(chat["id"])),
                    unread_by_chat.get(str(chat["id"]), 0),
                    blocked_by_user_ids,
                    blocking_user_ids,
                )
                for chat in chat_rows
            ]

    return [
        *system_chats(
            latest_messages=latest_messages,
            owner_profile=owner_profile,
            channel_settings=channel_settings,
        ),
        *chats,
    ]


def require_chat_member(cursor, chat_id: str, user_id: str) -> dict[str, Any]:
    cursor.execute(
        """
        select c.*
        from yachat_chats c
        join yachat_chat_members cm on cm.chat_id = c.id
        where c.id = %s and cm.user_id = %s
        limit 1
        """,
        (chat_id, user_id),
    )
    row = cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return dict(row)


def message_payload(
    row: dict[str, Any],
    current_user_id: str,
    recipient_read_times: list[datetime] | None = None,
) -> dict[str, Any]:
    sender_id = str(row_value(row, "sender_id"))
    payload = {
        "id": str(row_value(row, "id")),
        "chatId": str(row_value(row, "chat_id")),
        "author": "user" if sender_id == current_user_id else "contact",
        "authorId": sender_id,
        "text": str(row_value(row, "text")),
        "formattedHtml": clean_rich_html(row_value(row, "formatted_html")),
        "attachments": row_value(row, "attachments") if isinstance(row_value(row, "attachments"), list) else [],
        "replyToMessageId": row_value(row, "reply_to_message_id") or None,
        "forwardedFrom": str(row_value(row, "forwarded_from")),
        "createdAt": row_value(row, "created_at"),
        "editedAt": row_value(row, "edited_at") or None,
    }

    if sender_id == current_user_id:
        created_at = row_value(row, "created_at")
        read_times = [value for value in (recipient_read_times or []) if value is not None]
        read_by_every_recipient = bool(read_times) and all(value >= created_at for value in read_times)
        payload["deliveryStatus"] = "read" if read_by_every_recipient else "sent"

    return payload


def get_chat_messages(chat_id: str, user_id: str) -> list[dict[str, Any]]:
    chat_id = clean_chat_id(chat_id)
    is_saved_chat = chat_id == "yachat-favorites"
    if is_saved_chat:
        chat_id = saved_chat_id(user_id)
    elif chat_id.startswith("yachat-"):
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                return [
                    *system_chat_messages(chat_id),
                    *system_messages_for_user(cursor, chat_id, user_id),
                ]

    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if is_saved_chat:
                chat_id = ensure_saved_chat(cursor, user_id)
            require_chat_member(cursor, chat_id, user_id)
            cursor.execute(
                """
                select m.*
                from yachat_messages m
                where m.chat_id = %s and m.deleted_at is null
                  and not exists (
                      select 1 from yachat_message_hidden h
                      where h.message_id = m.id and h.user_id = %s
                  )
                order by m.created_at asc
                limit 500
                """,
                (chat_id, user_id),
            )
            message_rows = [dict(row) for row in cursor.fetchall()]
            cursor.execute(
                """
                select last_read_at
                from yachat_chat_members
                where chat_id = %s and user_id <> %s
                """,
                (chat_id, user_id),
            )
            recipient_read_times = [row["last_read_at"] for row in cursor.fetchall()]
            return [message_payload(row, user_id, recipient_read_times) for row in message_rows]


def messenger_snapshot(user_id: str, chat_id: str = "", username: str = "") -> dict[str, Any]:
    active_chat_id = clean_chat_id(chat_id, allow_empty=True)
    route_user = fetch_user_by_username(username) if normalize_username(username) else None
    chats = list_user_chats(user_id)
    chat_ids = {str(chat["id"]) for chat in chats}

    if route_user:
        route_chat = next(
            (
                chat
                for chat in chats
                if chat.get("kind") == "private"
                and str(route_user["id"]) in {str(item) for item in chat.get("participantIds", [])}
            ),
            None,
        )
        if route_chat:
            active_chat_id = str(route_chat["id"])

    if active_chat_id not in chat_ids:
        active_chat_id = str(chats[0]["id"]) if chats else ""

    return {
        "chats": chats,
        "activeChatId": active_chat_id or None,
        "messages": get_chat_messages(active_chat_id, user_id) if active_chat_id else [],
        "routeUser": route_user,
    }


def deterministic_private_chat_id(user_a: str, user_b: str) -> str:
    pair = ":".join(sorted([user_a, user_b]))
    return f"private-{hashlib.sha256(pair.encode('utf-8')).hexdigest()[:32]}"


def saved_chat_id(user_id: str) -> str:
    return f"saved-{hashlib.sha256(user_id.encode('utf-8')).hexdigest()[:32]}"


def ensure_saved_chat(cursor, user_id: str) -> str:
    chat_id = saved_chat_id(user_id)
    cursor.execute(
        """
        insert into yachat_chats(id, kind, title, owner_id, created_at, updated_at)
        values (%s, 'saved', 'Избранное', %s, now(), now())
        on conflict (id) do update set updated_at = yachat_chats.updated_at
        """,
        (chat_id, user_id),
    )
    cursor.execute(
        """
        insert into yachat_chat_members(chat_id, user_id, role)
        values (%s, %s, 'owner')
        on conflict (chat_id, user_id) do nothing
        """,
        (chat_id, user_id),
    )
    return chat_id


def resolve_message_chat_id(cursor, requested_chat_id: str, user_id: str) -> str:
    if requested_chat_id == "yachat-favorites":
        return ensure_saved_chat(cursor, user_id)
    return requested_chat_id


def can_manage_chat(chat: dict[str, Any], user_id: str) -> bool:
    if not chat or bool(row_value(chat, "locked")) or str(row_value(chat, "kind")) != "group":
        return False
    owner_id = str(row_value(chat, "owner_id"))
    return not owner_id or owner_id == user_id


def invite_url(code: str) -> str:
    return f"yachat://join/{code}"


def parse_qr_payload(value: Any) -> dict[str, str] | None:
    source = str(value or "").strip()
    if not source:
        return None

    try:
        parsed = json.loads(source)
        if parsed.get("a") == "yc" and parsed.get("t") == "l" and parsed.get("i") and parsed.get("k"):
            return {"id": str(parsed["i"]), "token": str(parsed["k"])}
    except (TypeError, ValueError, AttributeError):
        pass

    match = re.match(r"^yachat://login/([^/]+)/([^/]+)$", source)
    if match:
        return {"id": match.group(1), "token": match.group(2)}

    return None


P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_vapid_key_cache: tuple[str, str] | None = None


def vapid_key_pair() -> tuple[str, str]:
    global _vapid_key_cache
    configured_public = os.getenv("YACHAT_VAPID_PUBLIC_KEY", "").strip()
    configured_private = os.getenv("YACHAT_VAPID_PRIVATE_KEY", "").strip()
    if configured_public and configured_private:
        return configured_public, configured_private
    if _vapid_key_cache:
        return _vapid_key_cache

    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
    except Exception:
        return "", ""

    seed = hmac.new(
        auth_secret().encode("utf-8"),
        b"yachat-web-push-v1",
        hashlib.sha256,
    ).digest()
    scalar = int.from_bytes(seed, "big") % (P256_ORDER - 1) + 1
    private_key = ec.derive_private_key(scalar, ec.SECP256R1())
    public_bytes = private_key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    private_der = private_key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_value = base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode("ascii")
    private_value = base64.urlsafe_b64encode(private_der).rstrip(b"=").decode("ascii")
    _vapid_key_cache = (public_value, private_value)
    return _vapid_key_cache


def vapid_public_key() -> str:
    return vapid_key_pair()[0]


def vapid_private_key() -> str:
    return vapid_key_pair()[1]


def send_push_to_user(user_id: str, title: str, body: str, url: str) -> None:
    public_key = vapid_public_key()
    private_key = vapid_private_key()
    if not public_key or not private_key:
        return

    try:
        from pywebpush import WebPushException, webpush
    except Exception:
        return

    payload = json.dumps({"title": title, "body": body, "url": url})
    claims = {"sub": os.getenv("YACHAT_VAPID_SUBJECT", "mailto:admin@yachat.local")}

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute("select * from yachat_push_subscriptions where user_id = %s", (user_id,))
            subscriptions = [dict(row) for row in cursor.fetchall()]

    for subscription in subscriptions:
        info = {
            "endpoint": subscription["endpoint"],
            "keys": {
                "p256dh": subscription["p256dh"],
                "auth": subscription["auth"],
            },
        }
        try:
            webpush(
                subscription_info=info,
                data=payload,
                vapid_private_key=private_key,
                vapid_claims=claims,
                ttl=120,
                headers={"Urgency": "high"},
            )
        except WebPushException as error:
            status_code = getattr(getattr(error, "response", None), "status_code", None)
            if status_code in {404, 410}:
                with connect_db() as connection:
                    with connection.cursor() as cursor:
                        cursor.execute("delete from yachat_push_subscriptions where endpoint = %s", (subscription["endpoint"],))
        except Exception:
            continue


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if env_flag("YACHAT_FORCE_HTTPS", True) and forwarded_proto == "http":
        return RedirectResponse(str(request.url.replace(scheme="https")), status_code=308)

    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if forwarded_proto == "https" or request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.post("/api/telegram/webhook")
async def telegram_webhook(request: Request):
    if not telegram_bot_token():
        raise HTTPException(status_code=404, detail="Telegram bot is not configured.")

    secret = telegram_webhook_secret()
    if secret:
        supplied = request.headers.get("x-telegram-bot-api-secret-token") or ""
        if not hmac.compare_digest(supplied, secret):
            raise HTTPException(status_code=403, detail="Forbidden.")

    ensure_schema()
    update = await request.json()
    message = update.get("message") or update.get("edited_message") or {}
    if not isinstance(message, dict):
        return {"ok": True}

    chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
    sender = message.get("from") if isinstance(message.get("from"), dict) else {}
    chat_id = str(chat.get("id") or "")
    telegram_user_id = str(sender.get("id") or "")
    text = str(message.get("text") or "").strip()

    if not chat_id or not telegram_user_id:
        return {"ok": True}

    if text.startswith("/stop"):
        with connect_db() as connection:
            with connection.cursor() as cursor:
                cursor.execute("delete from yachat_telegram_links where telegram_user_id = %s", (telegram_user_id,))
        send_telegram_markdown_message(
            chat_id,
            "🧹 *Привязка удалена*\n\nКоды ЯЧата сюда больше не придут\\.",
            telegram_remove_keyboard(),
        )
        return {"ok": True}

    contact = message.get("contact") if isinstance(message.get("contact"), dict) else None
    if contact:
        contact_user_id = str(contact.get("user_id") or "")
        phone = normalize_contact(contact.get("phone_number"))
        key = contact_key(phone)

        if not contact_user_id or contact_user_id != telegram_user_id or not key:
            send_telegram_markdown_message(
                chat_id,
                "⚠️ *Нужен ваш Telegram\\-номер*\n\nНажмите кнопку ниже и отправьте свой контакт\\.",
                telegram_contact_keyboard(),
            )
            return {"ok": True}

        with connect_db() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    insert into yachat_telegram_links(
                        telegram_user_id, chat_id, contact, contact_key, username, first_name, updated_at
                    )
                    values (%s, %s, %s, %s, %s, %s, now())
                    on conflict (telegram_user_id) do update
                    set chat_id = excluded.chat_id,
                        contact = excluded.contact,
                        contact_key = excluded.contact_key,
                        username = excluded.username,
                        first_name = excluded.first_name,
                        updated_at = now()
                    """,
                    (
                        telegram_user_id,
                        chat_id,
                        phone,
                        key,
                        clean_text(sender.get("username"), 64),
                        clean_text(sender.get("first_name"), 64),
                    ),
                )

        send_telegram_markdown_message(
            chat_id,
            f"✅ *Готово*\n\nКоды входа ЯЧата для номера {telegram_md_code(phone)} будут приходить сюда\\.\n\nЕсли передумаете, отправьте {telegram_md_code('/stop')}\\.",
            telegram_remove_keyboard(),
        )
        return {"ok": True}

    send_telegram_markdown_message(
        chat_id,
        "👋 *Бот кодов ЯЧата*\n\nНажмите кнопку ниже и поделитесь номером, чтобы привязать Telegram к подтверждению входа\\.",
        telegram_contact_keyboard(),
    )
    return {"ok": True}


@app.get("/api/device-code")
def current_device_code(request: Request):
    user = require_user(request)
    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                select display_code, language, created_at, expires_at
                from yachat_device_codes
                where user_id = %s and used_at is null and expires_at > now()
                order by created_at desc
                limit 1
                """,
                (user["id"],),
            )
            row = cursor.fetchone()
    if not row:
        return {"code": "", "expiresAt": None, "ttlSeconds": DEVICE_CODE_TTL_MINUTES * 60}
    return {
        "code": str(row["display_code"]),
        "language": str(row["language"] or "ru"),
        "createdAt": row["created_at"],
        "expiresAt": row["expires_at"],
        "ttlSeconds": DEVICE_CODE_TTL_MINUTES * 60,
    }


@app.post("/api/device-code")
async def create_device_code(request: Request):
    user = require_user(request)
    enforce_rate_limit(request, "device-code-create", 20, 600)
    payload = await read_json_payload(request)
    language = "en" if str(payload.get("language") or "").lower() == "en" else "ru"
    expires_at = utc_now() + timedelta(minutes=DEVICE_CODE_TTL_MINUTES)

    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "update yachat_device_codes set used_at = now() where user_id = %s and used_at is null",
                (user["id"],),
            )
            for _ in range(20):
                raw_code, display_code = generate_device_code(language)
                try:
                    cursor.execute(
                        """
                        insert into yachat_device_codes(
                            id, user_id, code_hash, display_code, language, created_at, expires_at
                        )
                        values (%s, %s, %s, %s, %s, now(), %s)
                        """,
                        (str(uuid.uuid4()), user["id"], hash_secret(raw_code), display_code, language, expires_at),
                    )
                    return {
                        "code": display_code,
                        "language": language,
                        "expiresAt": expires_at,
                        "ttlSeconds": DEVICE_CODE_TTL_MINUTES * 60,
                    }
                except psycopg.errors.UniqueViolation:
                    continue
    raise HTTPException(status_code=503, detail="Could not create a sign-in code.")


@app.post("/api/device-code/redeem")
async def redeem_device_code(request: Request):
    enforce_rate_limit(request, "device-code-redeem", 18, 300)
    ensure_schema()
    payload = await read_json_payload(request)
    raw_code = normalize_device_code(payload.get("code"))
    if not re.fullmatch(r"(?:[A-ZА-Я]{2}\d{4}|[A-ZА-Я]{3}\d{3})", raw_code):
        raise HTTPException(status_code=400, detail="Enter the complete six-character code.")

    with connect_db() as connection:
        with connection.transaction():
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    """
                    update yachat_device_codes
                    set used_at = now()
                    where id = (
                        select id
                        from yachat_device_codes
                        where code_hash = %s and used_at is null and expires_at > now()
                        order by created_at desc
                        limit 1
                    )
                    returning user_id
                    """,
                    (hash_secret(raw_code),),
                )
                redeemed = cursor.fetchone()
                if not redeemed:
                    raise HTTPException(status_code=401, detail="The sign-in code is invalid or expired.")
                cursor.execute("select * from public_users where id = %s limit 1", (redeemed["user_id"],))
                user = cursor.fetchone()
                if not user:
                    raise HTTPException(status_code=404, detail="Account not found.")
                token = insert_session(cursor, str(user["id"]))
                return {
                    "ok": True,
                    "account": public_account(dict(user), token),
                    "sessionToken": token,
                }


@app.get("/api/status")
def status():
    return {
        "storage": "vercel-postgres" if database_url() else "not-configured",
        "users": "database-public-directory" if database_url() else "not-configured",
        "databaseEnv": database_env_name(),
        "webUrl": None,
        "lanUrl": None,
        "notifications": bool(vapid_public_key() and vapid_private_key()),
        "telegram": bool(telegram_bot_token()),
        "encryption": {
            "storage": "external-database",
            "kdf": "provider-managed",
            "identity": "public-directory",
        },
    }


@app.get("/api/health")
def health():
    if database_url():
        ensure_schema()
    return {"ok": True, "usersDatabaseConfigured": bool(database_url())}


@app.get("/api/account")
def account(request: Request):
    user = current_user(request)
    return public_account(user) if user else None


@app.get("/api/bootstrap")
def bootstrap(request: Request, chatId: str = "", username: str = ""):
    user = current_user(request)
    settings = get_user_settings(str(user["id"])) if user else dict(DEFAULT_SETTINGS)
    result: dict[str, Any] = {
        "authenticated": bool(user),
        "account": public_account(user) if user else None,
        "settings": settings,
        "chats": [],
        "messages": [],
        "activeChatId": None,
        "routeUser": None,
    }

    if user:
        result.update(messenger_snapshot(str(user["id"]), chatId, username))
    elif normalize_username(username) and database_url():
        result["routeUser"] = fetch_user_by_username(username)

    return result


@app.get("/api/users/check-username")
def check_username(request: Request, username: str = ""):
    ensure_schema()
    normalized = normalize_username(username)
    if not normalized:
        return {"username": "", "available": False, "reason": "Username: 3-24 characters, Latin letters, digits, or underscore."}

    user = current_user(request)
    exclude_user_id = str(user["id"]) if user else ""
    with connect_db() as connection:
        with connection.cursor() as cursor:
            available = not username_taken(cursor, normalized, exclude_user_id)

    return {"username": normalized, "available": available}


@app.post("/api/challenge")
async def create_challenge(request: Request):
    enforce_rate_limit(request, "challenge", 8, 300)
    ensure_schema()
    payload = await read_json_payload(request)
    contact = normalize_contact(payload.get("contact"))
    method = "phone" if payload.get("method") == "phone" else "email"
    selected_delivery = delivery_method(payload.get("deliveryMethod") or payload.get("delivery"))
    key = contact_key(contact)
    if not key:
        raise HTTPException(status_code=400, detail="Enter a phone number.")

    code = f"{secrets.randbelow(900000) + 100000}"
    challenge_id = str(uuid.uuid4())
    expires_at = utc_now() + timedelta(minutes=10)
    delivery = {"yachat": False, "telegram": False, "dev": False}
    return_dev_code = env_flag("YACHAT_RETURN_DEV_CODE", False)

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            existing_user = find_user_by_contact_cursor(cursor, contact)
            telegram_links = telegram_links_for_contact(cursor, contact)

            if selected_delivery == "yachat" and not existing_user and not return_dev_code:
                raise HTTPException(
                    status_code=409,
                    detail="No signed-in YaChat device is available for this number. Choose Telegram or open YaChat on another device.",
                )
            if selected_delivery == "telegram" and not telegram_links and not return_dev_code:
                raise HTTPException(
                    status_code=409,
                    detail="Telegram is not linked for this number. Start the YaChat code bot and share your phone number first.",
                )
            if selected_delivery == "telegram" and not telegram_bot_token() and not return_dev_code:
                raise HTTPException(status_code=503, detail="Telegram code bot is not configured.")

            cursor.execute(
                """
                insert into yachat_auth_challenges(id, contact, contact_key, method, code_hash, expires_at)
                values (%s, %s, %s, %s, %s, %s)
                """,
                (challenge_id, contact, key, method, hash_secret(code), expires_at),
            )

            if selected_delivery == "yachat" and existing_user:
                add_system_delivery_message(
                    cursor,
                    str(existing_user["id"]),
                    "yachat-codes",
                    verification_code_text(contact, code),
                    expires_at,
                    verification_code_html(contact, code),
                )
                delivery["yachat"] = True

            if selected_delivery == "telegram":
                telegram_sent = send_telegram_verification_code(telegram_links, contact, code)
                delivery["telegram"] = telegram_sent > 0

            if not delivery["yachat"] and not delivery["telegram"] and not return_dev_code:
                raise HTTPException(status_code=503, detail="The code could not be delivered. Try again later.")

    result = {"id": challenge_id, "method": method, "contact": contact, "expiresAt": expires_at, "deliveryMethod": selected_delivery}
    if return_dev_code:
        result["devCode"] = code
        delivery["dev"] = True
    result["delivery"] = delivery
    return result


@app.post("/api/verify")
async def verify_challenge(request: Request):
    enforce_rate_limit(request, "verify", 20, 300)
    ensure_schema()
    payload = await read_json_payload(request)
    code = re.sub(r"\D+", "", str(payload.get("code") or ""))[:6]
    contact = normalize_contact(payload.get("contact"))
    key = contact_key(contact)
    if not code or not key:
        return {"ok": False, "reason": "Request a code first."}

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                select *
                from yachat_auth_challenges
                where contact_key = %s and expires_at > now()
                order by created_at desc
                limit 1
                """,
                (key,),
            )
            challenge = cursor.fetchone()
            if not challenge or not hmac.compare_digest(str(challenge["code_hash"]), hash_secret(code)):
                return {"ok": False, "reason": "Wrong code."}

            existing = find_user_by_contact_cursor(cursor, contact)
            if existing:
                token = insert_session(cursor, str(existing["id"]))
                cursor.execute("update yachat_auth_challenges set verified_at = now() where id = %s", (challenge["id"],))
                return {
                    "ok": True,
                    "contact": contact,
                    "method": challenge["method"],
                    "accountExists": True,
                    "account": public_account(existing, token),
                    "sessionToken": token,
                }

            registration_token = generate_token()
            cursor.execute(
                """
                update yachat_auth_challenges
                set verified_at = now(), registration_token_hash = %s
                where id = %s
                """,
                (hash_secret(registration_token), challenge["id"]),
            )
            return {
                "ok": True,
                "contact": contact,
                "method": challenge["method"],
                "accountExists": False,
                "registrationToken": registration_token,
            }


@app.post("/api/account")
async def create_account(request: Request):
    enforce_rate_limit(request, "create-account", 12, 600)
    ensure_schema()
    payload = await read_json_payload(request)
    registration_token = str(payload.get("registrationToken") or "")
    display_name = clean_text(payload.get("displayName"), 60)
    username = normalize_username(payload.get("username")) or f"user_{secrets.randbelow(9000) + 1000}"
    bio = clean_text(payload.get("bio"), 140)
    avatar_url = clean_text(payload.get("avatarDataUrl"), 3500000)
    avatar_accent = clean_text(payload.get("avatarAccent") or "#471AFF", 24)
    if not display_name:
        raise HTTPException(status_code=400, detail="Enter a name.")
    if not registration_token:
        raise HTTPException(status_code=401, detail="Confirm the code first.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                select *
                from yachat_auth_challenges
                where registration_token_hash = %s and verified_at is not null and expires_at > now()
                order by verified_at desc
                limit 1
                """,
                (hash_secret(registration_token),),
            )
            challenge = cursor.fetchone()
            if not challenge:
                raise HTTPException(status_code=401, detail="Confirm the code first.")

            existing = find_user_by_contact_cursor(cursor, str(challenge["contact"]))
            if existing:
                token = insert_session(cursor, str(existing["id"]))
                return public_account(existing, token)

            if username_taken(cursor, username):
                raise HTTPException(status_code=409, detail="Username is already taken.")

            user_id = str(uuid.uuid4())
            cursor.execute(
                """
                insert into public_users(
                    id, contact, contact_key, method, username, preview_name, display_name,
                    bio, avatar_url, avatar_accent, created_at, updated_at, public_key_type, is_public
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now(), 'x25519', true)
                returning *
                """,
                (
                    user_id,
                    challenge["contact"],
                    challenge["contact_key"],
                    challenge["method"],
                    username,
                    display_name,
                    display_name,
                    bio,
                    avatar_url,
                    avatar_accent,
                ),
            )
            user = dict(cursor.fetchone())
            token = insert_session(cursor, user_id)
            return public_account(user, token)


@app.post("/api/account/update")
async def update_account(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    display_name = clean_text(payload.get("displayName"), 60)
    username = normalize_username(payload.get("username"))
    bio = clean_text(payload.get("bio"), 140)
    avatar_url = clean_text(payload.get("avatarDataUrl"), 3500000)
    avatar_accent = clean_text(payload.get("avatarAccent") or row_value(user, "avatar_accent") or "#471AFF", 24)

    if not display_name:
        raise HTTPException(status_code=400, detail="Enter a name.")
    if not username:
        raise HTTPException(status_code=400, detail="Username: 3-24 characters, Latin letters, digits, or underscore.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if username_taken(cursor, username, str(user["id"])):
                raise HTTPException(status_code=409, detail="Username is already taken.")

            cursor.execute(
                """
                update public_users
                set username = %s,
                    preview_name = %s,
                    display_name = %s,
                    bio = %s,
                    avatar_url = %s,
                    avatar_accent = %s,
                    updated_at = now()
                where id = %s
                returning *
                """,
                (username, display_name, display_name, bio, avatar_url, avatar_accent, user["id"]),
            )
            updated = cursor.fetchone()
            if not updated:
                raise HTTPException(status_code=404, detail="Account not found.")
            return public_account(dict(updated))


@app.post("/api/logout")
def logout(request: Request):
    token = request_token(request)
    if token and database_url():
        ensure_schema()
        with connect_db() as connection:
            with connection.cursor() as cursor:
                cursor.execute("delete from yachat_sessions where token_hash = %s", (hash_secret(token),))
    return {"ok": True}


@app.post("/api/account/delete")
def delete_profile(request: Request):
    user = require_user(request)
    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute("delete from public_users where id = %s", (user["id"],))
            cursor.execute(
                """
                delete from yachat_chats c
                where not exists (
                    select 1 from yachat_chat_members cm where cm.chat_id = c.id
                )
                """
            )
    return {"ok": True, "deleted": True}


@app.get("/api/settings")
def get_settings(request: Request):
    user = current_user(request)
    if not user:
        return dict(DEFAULT_SETTINGS)
    return get_user_settings(str(user["id"]))


@app.post("/api/settings")
async def update_settings(request: Request):
    payload = await read_json_payload(request)
    user = current_user(request)
    if not user:
        return normalize_settings(payload)
    return save_user_settings(str(user["id"]), payload)


@app.get("/api/users")
def users():
    return fetch_public_users()


@app.get("/api/users/search")
def users_search(q: str = ""):
    return fetch_user_search(q)


@app.get("/api/users/by-username")
def user_by_username(username: str = ""):
    return fetch_user_by_username(username)


@app.post("/api/contacts/lookup")
async def contacts_lookup(request: Request):
    payload = await read_json_payload(request)
    return fetch_contact_matches(payload_contacts(payload))


@app.get("/api/messenger")
def messenger(request: Request, chatId: str = "", username: str = ""):
    user = require_user(request)
    return messenger_snapshot(str(user["id"]), chatId, username)


@app.get("/api/chats")
def chats(request: Request):
    user = require_user(request)
    return list_user_chats(str(user["id"]))


@app.get("/api/messages")
def messages(request: Request, chatId: str = ""):
    user = require_user(request)
    return get_chat_messages(chatId, str(user["id"]))


@app.post("/api/chat")
async def create_chat(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    kind = "group" if payload.get("kind") == "group" else "private"
    selected_ids = [
        str(item or "").strip()
        for item in (payload.get("participantIds") if isinstance(payload.get("participantIds"), list) else [])
        if str(item or "").strip() and str(item or "").strip() != str(user["id"])
    ]
    if kind == "private" and len(selected_ids) != 1:
        raise HTTPException(status_code=400, detail="Choose one person.")
    if kind == "group" and not selected_ids:
        raise HTTPException(status_code=400, detail="Add at least one person.")
    if kind == "group" and not clean_text(payload.get("title"), 60):
        raise HTTPException(status_code=400, detail="Enter a group name.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute("select id from public_users where id = any(%s)", (selected_ids,))
            found_ids = {str(row["id"]) for row in cursor.fetchall()}
            selected_ids = [user_id for user_id in selected_ids if user_id in found_ids]
            if kind == "private" and len(selected_ids) != 1:
                raise HTTPException(status_code=404, detail="User not found.")
            if kind == "group" and not selected_ids:
                raise HTTPException(status_code=404, detail="User not found.")

            if kind == "private":
                chat_id = deterministic_private_chat_id(str(user["id"]), selected_ids[0])
                cursor.execute(
                    """
                    insert into yachat_chats(id, kind, title, owner_id, created_at, updated_at)
                    values (%s, 'private', '', %s, now(), now())
                    on conflict (id) do update set updated_at = yachat_chats.updated_at
                    returning *
                    """,
                    (chat_id, user["id"]),
                )
            else:
                chat_id = f"group-{uuid.uuid4()}"
                cursor.execute(
                    """
                    insert into yachat_chats(id, kind, title, description, avatar_url, owner_id, created_at, updated_at)
                    values (%s, 'group', %s, %s, %s, %s, now(), now())
                    returning *
                    """,
                    (
                        chat_id,
                        clean_text(payload.get("title"), 60),
                        clean_text(payload.get("description"), 180),
                        clean_text(payload.get("avatarDataUrl"), 3500000),
                        user["id"],
                    ),
                )
            chat = dict(cursor.fetchone())

            for member_id in [str(user["id"]), *selected_ids]:
                cursor.execute(
                    """
                    insert into yachat_chat_members(chat_id, user_id, role)
                    values (%s, %s, %s)
                    on conflict (chat_id, user_id) do nothing
                    """,
                    (chat_id, member_id, "owner" if member_id == str(user["id"]) else "member"),
                )

            return {
                "chat": chat_summary(cursor, chat, str(user["id"])),
                "chats": list_user_chats(str(user["id"])),
                "messages": get_chat_messages(chat_id, str(user["id"])),
            }


@app.post("/api/chat/update")
async def update_chat(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if chat_id == "yachat-channel":
                if not is_murochko_profile(user):
                    raise HTTPException(status_code=403, detail="Only Murochko can edit the YaChat channel.")

                title = clean_text(payload.get("title"), 60) or "ЯЧат"
                description = clean_text(payload.get("description"), 180) or "ЯЧат запущен. Здесь будут новости приложения, изменения и служебные объявления."
                avatar_url = clean_text(payload.get("avatarDataUrl"), 3500000)
                cursor.execute(
                    """
                    insert into yachat_system_chats(id, title, description, avatar_url, updated_at)
                    values ('yachat-channel', %s, %s, %s, now())
                    on conflict (id) do update
                    set title = excluded.title,
                        description = excluded.description,
                        avatar_url = excluded.avatar_url,
                        updated_at = now()
                    returning *
                    """,
                    (title, description, avatar_url),
                )
                connection.commit()
                chats = list_user_chats(str(user["id"]))
                return {
                    "chat": next((chat for chat in chats if chat["id"] == "yachat-channel"), None),
                    "chats": chats,
                    "messages": get_chat_messages(chat_id, str(user["id"])),
                }

            chat = require_chat_member(cursor, chat_id, str(user["id"]))
            if not can_manage_chat(chat, str(user["id"])):
                raise HTTPException(status_code=403, detail="Only the group owner can edit this chat.")

            updates: list[str] = []
            params: list[Any] = []

            if "title" in payload:
                title = clean_text(payload.get("title"), 60)
                if not title:
                    raise HTTPException(status_code=400, detail="Enter a group name.")
                updates.append("title = %s")
                params.append(title)

            if "description" in payload:
                updates.append("description = %s")
                params.append(clean_text(payload.get("description"), 180))

            if "avatarDataUrl" in payload:
                updates.append("avatar_url = %s")
                params.append(clean_text(payload.get("avatarDataUrl"), 3500000))

            if updates:
                params.append(chat_id)
                cursor.execute(
                    f"""
                    update yachat_chats
                    set {", ".join(updates)}, updated_at = now()
                    where id = %s
                    returning *
                    """,
                    params,
                )
                chat = dict(cursor.fetchone())

            return {
                "chat": chat_summary(cursor, chat, str(user["id"])),
                "chats": list_user_chats(str(user["id"])),
                "messages": get_chat_messages(chat_id, str(user["id"])),
            }


@app.post("/api/chat/invite")
async def create_chat_invite(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat = require_chat_member(cursor, chat_id, str(user["id"]))
            if not can_manage_chat(chat, str(user["id"])):
                raise HTTPException(status_code=403, detail="Only the group owner can invite people.")

            code = str(row_value(chat, "invite_code")) or f"YC-{secrets.token_hex(4).upper()}"
            cursor.execute(
                """
                update yachat_chats
                set invite_code = %s, updated_at = now()
                where id = %s
                returning *
                """,
                (code, chat_id),
            )
            chat = dict(cursor.fetchone())

            return {
                "chat": chat_summary(cursor, chat, str(user["id"])),
                "chats": list_user_chats(str(user["id"])),
                "inviteCode": code,
                "inviteUrl": invite_url(code),
            }


@app.post("/api/chat/block")
async def block_chat_user(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    if chat_id.startswith("yachat-"):
        raise HTTPException(status_code=400, detail="Only private chat users can be blocked.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat, peer_id = require_private_chat_peer(cursor, chat_id, str(user["id"]))
            cursor.execute(
                """
                insert into yachat_user_blocks(blocker_id, blocked_id, created_at)
                values (%s, %s, now())
                on conflict(blocker_id, blocked_id) do nothing
                """,
                (user["id"], peer_id),
            )
            summary = chat_summary(cursor, chat, str(user["id"]))

    return {
        "chat": summary,
        "chats": list_user_chats(str(user["id"])),
        "messages": get_chat_messages(chat_id, str(user["id"])),
    }


@app.post("/api/chat/unblock")
async def unblock_chat_user(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    if chat_id.startswith("yachat-"):
        raise HTTPException(status_code=400, detail="Only private chat users can be unblocked.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat, peer_id = require_private_chat_peer(cursor, chat_id, str(user["id"]))
            cursor.execute(
                "delete from yachat_user_blocks where blocker_id = %s and blocked_id = %s",
                (user["id"], peer_id),
            )
            summary = chat_summary(cursor, chat, str(user["id"]))

    return {
        "chat": summary,
        "chats": list_user_chats(str(user["id"])),
        "messages": get_chat_messages(chat_id, str(user["id"])),
    }


@app.post("/api/chat/leave")
async def leave_chat(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))

    if chat_id.startswith("yachat-"):
        raise HTTPException(status_code=400, detail="System chats cannot be left.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat = require_chat_member(cursor, chat_id, str(user["id"]))
            if bool(row_value(chat, "locked")):
                raise HTTPException(status_code=400, detail="This chat cannot be left.")

            cursor.execute(
                "delete from yachat_chat_members where chat_id = %s and user_id = %s",
                (chat_id, user["id"]),
            )

            cursor.execute("select user_id from yachat_chat_members where chat_id = %s order by joined_at asc", (chat_id,))
            remaining = [str(row["user_id"]) for row in cursor.fetchall()]
            if not remaining:
                cursor.execute("delete from yachat_chats where id = %s", (chat_id,))
            elif str(row_value(chat, "owner_id")) == str(user["id"]):
                cursor.execute(
                    "update yachat_chats set owner_id = %s, updated_at = now() where id = %s",
                    (remaining[0], chat_id),
                )

    chats = list_user_chats(str(user["id"]))
    return {"chats": chats, "activeChatId": chats[0]["id"] if chats else None}


@app.post("/api/chat/delete")
async def delete_chat(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))

    if chat_id.startswith("yachat-"):
        raise HTTPException(status_code=400, detail="System chats cannot be deleted.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            chat = require_chat_member(cursor, chat_id, str(user["id"]))
            if str(row_value(chat, "kind")) != "group" or bool(row_value(chat, "locked")):
                raise HTTPException(status_code=400, detail="Only groups can be deleted.")
            if str(row_value(chat, "owner_id")) != str(user["id"]):
                raise HTTPException(status_code=403, detail="Only the group owner can delete this chat.")

            cursor.execute("delete from yachat_chats where id = %s", (chat_id,))

    chats = list_user_chats(str(user["id"]))
    return {"chats": chats, "activeChatId": chats[0]["id"] if chats else None}


@app.post("/api/chat/clear-history")
async def clear_chat_history(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    requested_chat_id = clean_chat_id(payload.get("chatId"))
    chat_id = requested_chat_id
    system_chat = False

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if requested_chat_id == "yachat-favorites":
                chat_id = ensure_saved_chat(cursor, str(user["id"]))
            elif requested_chat_id.startswith("yachat-"):
                if requested_chat_id == "yachat-codes":
                    raise HTTPException(status_code=403, detail="This system chat history cannot be cleared.")
                if requested_chat_id == "yachat-channel" and not is_murochko_profile(user):
                    raise HTTPException(status_code=403, detail="Only Murochko can clear the YaChat channel history.")
                if requested_chat_id == "yachat-channel":
                    cursor.execute("delete from yachat_system_messages where chat_id = %s", (requested_chat_id,))
                else:
                    cursor.execute(
                        "delete from yachat_system_messages where user_id = %s and chat_id = %s",
                        (user["id"], requested_chat_id),
                    )
                system_chat = True
            else:
                require_chat_member(cursor, chat_id, str(user["id"]))

            if not system_chat:
                cursor.execute(
                    "update yachat_messages set deleted_at = now() where chat_id = %s and deleted_at is null",
                    (chat_id,),
                )
                cursor.execute(
                    "update yachat_chat_members set last_read_at = now() where chat_id = %s and user_id = %s",
                    (chat_id, user["id"]),
                )

    return {
        "chats": list_user_chats(str(user["id"])),
        "messages": get_chat_messages(requested_chat_id, str(user["id"])),
    }


@app.post("/api/message")
async def send_message(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    formatted_html, text = prepare_rich_message(payload)
    attachments = clean_attachments(payload.get("attachments"))
    if not text and not attachments:
        raise HTTPException(status_code=400, detail="Enter a message.")
    is_saved_chat = chat_id == "yachat-favorites"
    is_channel_post = chat_id == "yachat-channel"
    if is_channel_post:
        if not is_murochko_profile(user):
            raise HTTPException(status_code=403, detail="Only Murochko can post to the YaChat channel.")

        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute("select id from public_users")
                user_ids = [str(row["id"]) for row in cursor.fetchall()]
                if not user_ids:
                    user_ids = [str(user["id"])]
                message_id = str(uuid.uuid4())
                for target_user_id in user_ids:
                    cursor.execute(
                        """
                        insert into yachat_system_messages(
                            id, user_id, chat_id, author_id, text, formatted_html,
                            attachments, system_kind, created_at
                        )
                        values (%s, %s, 'yachat-channel', %s, %s, %s, %s::jsonb, 'channel-post', now())
                        """,
                        (
                            message_id if target_user_id == str(user["id"]) else str(uuid.uuid4()),
                            target_user_id,
                            user["id"],
                            text,
                            formatted_html,
                            json.dumps(attachments[:8]),
                        ),
                    )

        return {
            "chats": list_user_chats(str(user["id"])),
            "messages": get_chat_messages("yachat-channel", str(user["id"])),
        }

    if chat_id.startswith("yachat-") and not is_saved_chat:
        raise HTTPException(status_code=400, detail="System chats are local only.")

    client_message_id = str(payload.get("clientMessageId") or "").strip()
    try:
        message_id = str(uuid.UUID(client_message_id)) if client_message_id else str(uuid.uuid4())
    except (ValueError, AttributeError, TypeError):
        message_id = str(uuid.uuid4())

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if is_saved_chat:
                chat_id = ensure_saved_chat(cursor, str(user["id"]))
            chat = require_chat_member(cursor, chat_id, str(user["id"]))
            if not bool(row_value(chat, "can_send") if "can_send" in chat else True):
                raise HTTPException(status_code=403, detail="This chat is read-only.")
            require_chat_messaging_allowed(cursor, chat, str(user["id"]))

            cursor.execute(
                """
                insert into yachat_messages(
                    id, chat_id, sender_id, text, formatted_html,
                    attachments, reply_to_message_id, created_at
                )
                values (%s, %s, %s, %s, %s, %s::jsonb, %s, now())
                on conflict(id) do nothing
                returning *
                """,
                (
                    message_id,
                    chat_id,
                    user["id"],
                    text,
                    formatted_html,
                    json.dumps(attachments[:8]),
                    payload.get("replyToMessageId") or None,
                ),
            )
            inserted_row = cursor.fetchone()
            inserted = inserted_row is not None
            if inserted:
                message = dict(inserted_row)
            else:
                cursor.execute(
                    """
                    select *
                    from yachat_messages
                    where id = %s and chat_id = %s and sender_id = %s and deleted_at is null
                    limit 1
                    """,
                    (message_id, chat_id, user["id"]),
                )
                existing_row = cursor.fetchone()
                if not existing_row:
                    raise HTTPException(status_code=409, detail="Message id conflict.")
                message = dict(existing_row)
            cursor.execute("update yachat_chats set updated_at = now() where id = %s", (chat_id,))
            cursor.execute(
                "update yachat_chat_members set last_read_at = now() where chat_id = %s and user_id = %s",
                (chat_id, user["id"]),
            )
            cursor.execute(
                """
                select user_id
                from yachat_chat_members
                where chat_id = %s and user_id <> %s
                """,
                (chat_id, user["id"]),
            )
            recipients = [] if is_saved_chat or not inserted else [str(row["user_id"]) for row in cursor.fetchall()]

    sender_name = str(row_value(user, "display_name", "preview_name", "username")) or "YaChat"
    body = text or "Новое вложение"
    sender_username = str(row_value(user, "username"))
    push_target = f"/{sender_username}" if str(row_value(chat, "kind")) == "private" and sender_username else f"/?chat={chat_id}"
    for recipient_id in recipients:
        send_push_to_user(recipient_id, sender_name, body[:160], push_target)

    return {
        "chats": list_user_chats(str(user["id"])),
        "messages": get_chat_messages(chat_id, str(user["id"])),
        "message": message_payload(message, str(user["id"])),
    }


@app.post("/api/chat/mark-read")
async def mark_chat_read(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    chat_id = clean_chat_id(payload.get("chatId"))
    if not chat_id.startswith("yachat-"):
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                require_chat_member(cursor, chat_id, str(user["id"]))
                cursor.execute(
                    "update yachat_chat_members set last_read_at = now() where chat_id = %s and user_id = %s",
                    (chat_id, user["id"]),
                )
    return {"chats": list_user_chats(str(user["id"])), "messages": get_chat_messages(chat_id, str(user["id"]))}


@app.post("/api/message/mark-unread")
async def mark_message_unread(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    requested_chat_id = clean_chat_id(payload.get("chatId"))
    message_id = str(payload.get("messageId") or "")
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if requested_chat_id.startswith("yachat-") and requested_chat_id != "yachat-favorites":
                raise HTTPException(status_code=400, detail="This message cannot be marked unread.")
            chat_id = resolve_message_chat_id(cursor, requested_chat_id, str(user["id"]))
            require_chat_member(cursor, chat_id, str(user["id"]))
            cursor.execute("select created_at from yachat_messages where id = %s and chat_id = %s", (message_id, chat_id))
            row = cursor.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Message not found.")
            cursor.execute(
                "update yachat_chat_members set last_read_at = %s where chat_id = %s and user_id = %s",
                (row["created_at"] - timedelta(milliseconds=1), chat_id, user["id"]),
            )
    return {"chats": list_user_chats(str(user["id"]))}


@app.post("/api/message/delete")
async def delete_message(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    requested_chat_id = clean_chat_id(payload.get("chatId"))
    scope = str(payload.get("scope") or "everyone").strip().lower()
    if scope not in {"self", "everyone"}:
        raise HTTPException(status_code=400, detail="Choose how to delete the message.")
    ids = payload.get("messageIds") if isinstance(payload.get("messageIds"), list) else [payload.get("messageId")]
    ids = list(dict.fromkeys(str(item or "") for item in ids if str(item or "")))
    if not ids:
        raise HTTPException(status_code=400, detail="Select a message first.")
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if requested_chat_id.startswith("yachat-") and requested_chat_id != "yachat-favorites":
                raise HTTPException(status_code=403, detail="This message cannot be deleted.")
            chat_id = resolve_message_chat_id(cursor, requested_chat_id, str(user["id"]))
            require_chat_member(cursor, chat_id, str(user["id"]))
            cursor.execute(
                "select id, sender_id from yachat_messages where chat_id = %s and id = any(%s) and deleted_at is null",
                (chat_id, ids),
            )
            messages = [dict(row) for row in cursor.fetchall()]
            if len(messages) != len(ids):
                raise HTTPException(status_code=404, detail="Message not found.")
            if scope == "self":
                cursor.execute(
                    """
                    insert into yachat_message_hidden(message_id, user_id, hidden_at)
                    select id, %s, now()
                    from yachat_messages
                    where chat_id = %s and id = any(%s) and deleted_at is null
                    on conflict(message_id, user_id) do nothing
                    """,
                    (user["id"], chat_id, ids),
                )
            else:
                if any(str(row_value(message, "sender_id")) != str(user["id"]) for message in messages):
                    raise HTTPException(status_code=403, detail="You can delete only your own messages for everyone.")
                cursor.execute(
                    "update yachat_messages set deleted_at = now() where chat_id = %s and sender_id = %s and id = any(%s)",
                    (chat_id, user["id"], ids),
                )
    return {
        "chats": list_user_chats(str(user["id"])),
        "messages": get_chat_messages(requested_chat_id, str(user["id"])),
    }


@app.post("/api/message/update")
async def update_message(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    requested_chat_id = clean_chat_id(payload.get("chatId"))
    message_id = str(payload.get("messageId") or "")
    formatted_html, text = prepare_rich_message(payload)
    if not text:
        raise HTTPException(status_code=400, detail="Enter a message.")
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if requested_chat_id.startswith("yachat-") and requested_chat_id != "yachat-favorites":
                raise HTTPException(status_code=403, detail="This message cannot be edited.")
            chat_id = resolve_message_chat_id(cursor, requested_chat_id, str(user["id"]))
            require_chat_member(cursor, chat_id, str(user["id"]))
            cursor.execute(
                "select sender_id from yachat_messages where id = %s and chat_id = %s and deleted_at is null",
                (message_id, chat_id),
            )
            message = cursor.fetchone()
            if not message:
                raise HTTPException(status_code=404, detail="Message not found.")
            if str(row_value(message, "sender_id")) != str(user["id"]):
                raise HTTPException(status_code=403, detail="This message cannot be edited.")
            cursor.execute(
                """
                update yachat_messages
                set text = %s, formatted_html = %s, edited_at = now()
                where id = %s and chat_id = %s and sender_id = %s and deleted_at is null
                """,
                (text, formatted_html, message_id, chat_id, user["id"]),
            )
    return {
        "chats": list_user_chats(str(user["id"])),
        "messages": get_chat_messages(requested_chat_id, str(user["id"])),
    }


@app.post("/api/message/forward")
async def forward_message(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    requested_from_chat_id = clean_chat_id(payload.get("fromChatId"))
    requested_to_chat_id = clean_chat_id(payload.get("toChatId"))
    message_id = str(payload.get("messageId") or "")
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if requested_from_chat_id.startswith("yachat-") and requested_from_chat_id != "yachat-favorites":
                raise HTTPException(status_code=400, detail="This message cannot be forwarded.")
            if requested_to_chat_id.startswith("yachat-") and requested_to_chat_id != "yachat-favorites":
                raise HTTPException(status_code=400, detail="Messages cannot be forwarded to this chat.")
            from_chat_id = resolve_message_chat_id(cursor, requested_from_chat_id, str(user["id"]))
            to_chat_id = resolve_message_chat_id(cursor, requested_to_chat_id, str(user["id"]))
            require_chat_member(cursor, from_chat_id, str(user["id"]))
            target_chat = require_chat_member(cursor, to_chat_id, str(user["id"]))
            if not bool(row_value(target_chat, "can_send") if "can_send" in target_chat else True):
                raise HTTPException(status_code=403, detail="This chat is read-only.")
            require_chat_messaging_allowed(cursor, target_chat, str(user["id"]))
            cursor.execute("select * from yachat_messages where id = %s and chat_id = %s and deleted_at is null", (message_id, from_chat_id))
            source = cursor.fetchone()
            if not source:
                raise HTTPException(status_code=404, detail="Message not found.")
            cursor.execute(
                """
                insert into yachat_messages(
                    id, chat_id, sender_id, text, formatted_html,
                    attachments, forwarded_from, created_at
                )
                values (%s, %s, %s, %s, %s, %s::jsonb, %s, now())
                """,
                (
                    str(uuid.uuid4()),
                    to_chat_id,
                    user["id"],
                    source["text"],
                    clean_rich_html(row_value(source, "formatted_html")),
                    json.dumps(source["attachments"] or []),
                    from_chat_id,
                ),
            )
            cursor.execute("update yachat_chats set updated_at = now() where id = %s", (to_chat_id,))
    return {
        "chatId": requested_to_chat_id,
        "chats": list_user_chats(str(user["id"])),
        "messages": get_chat_messages(requested_to_chat_id, str(user["id"])),
    }


@app.post("/api/qr/create")
async def create_qr_session(request: Request):
    await read_json_payload(request)
    ensure_schema()
    session_id = secrets.token_urlsafe(8)
    token = secrets.token_urlsafe(18)
    expires_at = utc_now() + timedelta(minutes=QR_SESSION_TTL_MINUTES)
    qr_payload = json.dumps({"a": "yc", "t": "l", "i": session_id, "k": token}, separators=(",", ":"))

    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                insert into yachat_qr_sessions(id, token_hash, status, expires_at)
                values (%s, %s, 'pending', %s)
                """,
                (session_id, hash_secret(token), expires_at),
            )

    return {
        "id": session_id,
        "token": token,
        "payload": qr_payload,
        "status": "pending",
        "expiresAt": expires_at,
    }


@app.post("/api/qr/confirm")
async def confirm_qr_session(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    parsed = parse_qr_payload(payload.get("payload"))
    if not parsed:
        raise HTTPException(status_code=400, detail="Invalid YaChat QR code.")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute("select * from yachat_qr_sessions where id = %s limit 1", (parsed["id"],))
            session_row = cursor.fetchone()
            if not session_row or not hmac.compare_digest(str(session_row["token_hash"]), hash_secret(parsed["token"])):
                raise HTTPException(status_code=404, detail="QR session not found.")

            if session_row["expires_at"] < utc_now():
                cursor.execute("update yachat_qr_sessions set status = 'expired' where id = %s", (parsed["id"],))
                raise HTTPException(status_code=400, detail="QR code expired.")

            cursor.execute(
                """
                update yachat_qr_sessions
                set status = 'approved', account_id = %s, approved_at = now()
                where id = %s
                """,
                (user["id"], parsed["id"]),
            )

    return {"ok": True, "status": "approved", "account": public_account(user)}


@app.post("/api/qr/status")
async def qr_session_status(request: Request):
    ensure_schema()
    payload = await read_json_payload(request)
    parsed = parse_qr_payload(payload.get("payload")) or {
        "id": str(payload.get("id") or ""),
        "token": str(payload.get("token") or ""),
    }
    if not parsed["id"] or not parsed["token"]:
        return {"status": "missing"}

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute("select * from yachat_qr_sessions where id = %s limit 1", (parsed["id"],))
            session_row = cursor.fetchone()
            if not session_row or not hmac.compare_digest(str(session_row["token_hash"]), hash_secret(parsed["token"])):
                return {"status": "missing"}

            if session_row["expires_at"] < utc_now() and session_row["status"] == "pending":
                cursor.execute("update yachat_qr_sessions set status = 'expired' where id = %s", (parsed["id"],))
                return {"id": parsed["id"], "status": "expired", "expiresAt": session_row["expires_at"]}

            result = {
                "id": parsed["id"],
                "status": session_row["status"],
                "expiresAt": session_row["expires_at"],
                "approvedAt": session_row["approved_at"],
            }

            if session_row["status"] == "approved" and session_row["account_id"]:
                cursor.execute("select * from public_users where id = %s limit 1", (session_row["account_id"],))
                account_row = cursor.fetchone()
                if account_row:
                    token = insert_session(cursor, str(session_row["account_id"]))
                    result["account"] = public_account(dict(account_row), token)
                    result["sessionToken"] = token

            return result


@app.get("/api/push/public-key")
def push_public_key():
    key = vapid_public_key()
    return {"enabled": bool(key), "publicKey": key}


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    endpoint = clean_text(payload.get("endpoint"), 2048)
    keys = payload.get("keys") if isinstance(payload.get("keys"), dict) else {}
    p256dh = clean_text(keys.get("p256dh"), 512)
    auth = clean_text(keys.get("auth"), 256)
    if not endpoint or not p256dh or not auth:
        raise HTTPException(status_code=400, detail="Invalid push subscription.")
    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                insert into yachat_push_subscriptions(endpoint, user_id, p256dh, auth, user_agent, updated_at)
                values (%s, %s, %s, %s, %s, now())
                on conflict (endpoint) do update
                set user_id = excluded.user_id,
                    p256dh = excluded.p256dh,
                    auth = excluded.auth,
                    user_agent = excluded.user_agent,
                    updated_at = now()
                """,
                (endpoint, user["id"], p256dh, auth, clean_text(request.headers.get("user-agent"), 500)),
            )
    return {"ok": True}


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def unsupported_api(path: str):
    return JSONResponse(status_code=404, content={"error": "Unsupported API route."})
