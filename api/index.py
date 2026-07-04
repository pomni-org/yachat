import hashlib
import hmac
import json
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from psycopg.rows import dict_row


app = FastAPI(title="YaChat API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.getenv("YACHAT_CORS_ORIGINS", "*").split(",")
        if origin.strip()
    ]
    or ["*"],
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
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
REMOVED_TEST_MESSAGE_TEXTS = ("Приыет?",)
DEFAULT_SETTINGS = {
    "language": "ru",
    "theme": "dark",
    "themeSource": "system",
    "country": "RU",
    "countryCode": "+7",
}
QR_SESSION_TTL_MINUTES = 5

_schema_ready = False


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


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
        "create index if not exists yachat_messages_chat_created_idx on yachat_messages(chat_id, created_at)",
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


def normalize_contact(contact: Any) -> str:
    return re.sub(r"\s+", " ", str(contact or "").strip())


def contact_key(contact: Any) -> str:
    return re.sub(r"[^\d+a-z@._-]+", "", normalize_contact(contact).lower())


def contact_lookup_keys(value: Any) -> set[str]:
    normalized = contact_key(value)
    digits = re.sub(r"\D+", "", str(value or ""))
    keys: set[str] = set()

    if normalized:
        keys.add(normalized)

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


def normalize_username(value: Any) -> str:
    username = re.sub(r"[^a-z0-9_]+", "_", str(value or "").strip().lower().lstrip("@"))
    username = re.sub(r"^_+|_+$", "", username)[:24]
    return username if len(username) >= 3 else ""


def hash_secret(value: str) -> str:
    return hmac.new(auth_secret().encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def generate_token() -> str:
    return secrets.token_urlsafe(36)


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
    ensure_schema()
    token = request_token(request)
    if not token:
        return None

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

    text = term.lower().lstrip("@")
    text_like = f"%{text}%"
    contact_like = f"%{contact_key(term).lstrip('@')}%"
    digits_like = f"%{digits}%" if digits else "__no_digits_match__"
    columns = ", ".join((*PUBLIC_USER_FIELDS, "contact", "contact_key"))
    query = f"""
        select {columns}
        from public_users
        where coalesce(is_public, true) = true
          and (
            lower(coalesce(username::text, '')) like %s
            or lower(coalesce(preview_name::text, '')) like %s
            or lower(coalesce(display_name::text, '')) like %s
            or lower(coalesce(contact::text, '')) like %s
            or lower(coalesce(contact_key::text, '')) like %s
            or regexp_replace(coalesce(contact::text, ''), '\\D+', '', 'g') like %s
          )
        order by created_at desc nulls last
        limit %s
    """

    try:
        with connect_db() as connection:
            with connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    query,
                    (text_like, text_like, text_like, text_like, contact_like, digits_like, min(public_limit(), 25)),
                )
                return [public_user(dict(row)) for row in cursor.fetchall()]
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
                      )
                    order by created_at desc nulls last
                    limit %s
                    """,
                    (requested_keys, requested_keys, public_limit()),
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


def system_chats(now_value: datetime | None = None) -> list[dict[str, Any]]:
    created_at = now_value or utc_now()
    codes_intro = "Здесь будут появляться одноразовые коды подтверждения для входа, банков, магазинов и сервисов."
    channel_intro = "Канал ЯЧата запущен. Здесь будут новости приложения, изменения и служебные объявления."
    return [
        {
            "id": "yachat-favorites",
            "kind": "saved",
            "title": "Избранное",
            "subtitle": "Сообщения для себя",
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
            "locked": True,
            "verified": True,
            "pinned": True,
            "canSend": False,
            "avatar": "codes",
            "avatarDataUrl": "./assets/yachat-codes-avatar.webp",
            "createdAt": created_at,
            "lastAt": created_at,
            "lastMessage": codes_intro,
            "unread": 0,
        },
        {
            "id": "yachat-channel",
            "kind": "channel",
            "title": "Канал ЯЧата",
            "subtitle": "Канал",
            "locked": True,
            "verified": True,
            "pinned": True,
            "canSend": False,
            "avatar": "channel",
            "avatarDataUrl": "./assets/yachat-logo-COLOR.png",
            "createdAt": created_at,
            "lastAt": created_at,
            "lastMessage": channel_intro,
            "unread": 0,
        },
    ]


def system_chat_messages(chat_id: str) -> list[dict[str, Any]]:
    messages = {
        "yachat-codes": (
            "bot",
            "Здесь будут появляться одноразовые коды подтверждения для входа, банков, магазинов и сервисов.",
        ),
        "yachat-channel": (
            "channel",
            "Канал ЯЧата запущен. Здесь будут новости приложения, изменения и служебные объявления.",
        ),
    }
    entry = messages.get(chat_id)
    if not entry:
        return []
    author, text = entry
    return [
        {
            "id": f"{chat_id}-intro",
            "chatId": chat_id,
            "author": author,
            "authorId": "yachat",
            "text": text,
            "attachments": [],
            "replyToMessageId": None,
            "forwardedFrom": "",
            "createdAt": utc_now(),
            "editedAt": None,
        }
    ]


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


def chat_summary(cursor, chat: dict[str, Any], user_id: str) -> dict[str, Any]:
    chat_id = str(chat["id"])
    members = chat_members(cursor, chat_id)
    profiles = {str(row["id"]): user_profile(row) for row in members}
    other = next((row for row in members if str(row["id"]) != user_id), members[0] if members else {})

    cursor.execute(
        """
        select text, attachments, created_at
        from yachat_messages
        where chat_id = %s and deleted_at is null
        order by created_at desc
        limit 1
        """,
        (chat_id,),
    )
    last = cursor.fetchone()

    cursor.execute(
        """
        select count(*) as count
        from yachat_messages m
        join yachat_chat_members cm on cm.chat_id = m.chat_id and cm.user_id = %s
        where m.chat_id = %s
          and m.deleted_at is null
          and coalesce(m.sender_id, '') <> %s
          and m.created_at > coalesce(cm.last_read_at, '1970-01-01T00:00:00Z'::timestamptz)
        """,
        (user_id, chat_id, user_id),
    )
    unread = int(cursor.fetchone()["count"])
    attachment_text = ""
    attachments = row_value(last, "attachments")
    if isinstance(attachments, list) and attachments:
        kind = str(attachments[0].get("kind") or "")
        attachment_text = "Фото" if kind == "image" else "Видео" if kind == "video" else "Файл"

    title = str(row_value(chat, "title"))
    subtitle = str(row_value(chat, "description"))
    avatar_data_url = str(row_value(chat, "avatar_url"))
    if chat["kind"] == "private" and other:
        title = str(row_value(other, "display_name", "preview_name", "username"))
        username = str(row_value(other, "username"))
        subtitle = f"@{username}" if username else "Личный чат"
        avatar_data_url = str(row_value(other, "avatar_url")) or avatar_data_url
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
        "verified": bool(row_value(chat, "verified")),
        "pinned": bool(row_value(chat, "pinned")),
        "canSend": bool(row_value(chat, "can_send") if "can_send" in chat else True),
        "avatar": str(chat["kind"]),
        "avatarDataUrl": avatar_data_url,
        "avatarAccent": str(row_value(chat, "avatar_accent")) or "#471AFF",
        "inviteCode": str(row_value(chat, "invite_code")),
        "createdAt": row_value(chat, "created_at"),
        "lastAt": row_value(last, "created_at") or row_value(chat, "created_at"),
        "lastMessage": str(row_value(last, "text")) or attachment_text,
        "unread": unread,
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
            chats = [chat_summary(cursor, dict(row), user_id) for row in cursor.fetchall()]

    return [*system_chats(), *chats]


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


def message_payload(row: dict[str, Any], current_user_id: str) -> dict[str, Any]:
    return {
        "id": str(row_value(row, "id")),
        "chatId": str(row_value(row, "chat_id")),
        "author": "user" if str(row_value(row, "sender_id")) == current_user_id else "contact",
        "authorId": str(row_value(row, "sender_id")),
        "text": str(row_value(row, "text")),
        "attachments": row_value(row, "attachments") if isinstance(row_value(row, "attachments"), list) else [],
        "replyToMessageId": row_value(row, "reply_to_message_id") or None,
        "forwardedFrom": str(row_value(row, "forwarded_from")),
        "createdAt": row_value(row, "created_at"),
        "editedAt": row_value(row, "edited_at") or None,
    }


def get_chat_messages(chat_id: str, user_id: str) -> list[dict[str, Any]]:
    if chat_id == "yachat-favorites":
        chat_id = saved_chat_id(user_id)
    elif chat_id.startswith("yachat-"):
        return system_chat_messages(chat_id)

    ensure_schema()
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            require_chat_member(cursor, chat_id, user_id)
            cursor.execute(
                """
                select *
                from yachat_messages
                where chat_id = %s and deleted_at is null
                order by created_at asc
                limit 500
                """,
                (chat_id,),
            )
            return [message_payload(dict(row), user_id) for row in cursor.fetchall()]


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


def send_push_to_user(user_id: str, title: str, body: str, url: str) -> None:
    public_key = os.getenv("YACHAT_VAPID_PUBLIC_KEY", "").strip()
    private_key = os.getenv("YACHAT_VAPID_PRIVATE_KEY", "").strip()
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


@app.get("/api/status")
def status():
    return {
        "storage": "vercel-postgres" if database_url() else "not-configured",
        "users": "database-public-directory" if database_url() else "not-configured",
        "databaseEnv": database_env_name(),
        "webUrl": None,
        "lanUrl": None,
        "notifications": bool(os.getenv("YACHAT_VAPID_PUBLIC_KEY") and os.getenv("YACHAT_VAPID_PRIVATE_KEY")),
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
    ensure_schema()
    payload = await request.json()
    contact = normalize_contact(payload.get("contact"))
    method = "phone" if payload.get("method") == "phone" else "email"
    key = contact_key(contact)
    if not key:
        raise HTTPException(status_code=400, detail="Enter a phone number.")

    code = f"{secrets.randbelow(900000) + 100000}"
    challenge_id = str(uuid.uuid4())
    expires_at = utc_now() + timedelta(minutes=10)
    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                insert into yachat_auth_challenges(id, contact, contact_key, method, code_hash, expires_at)
                values (%s, %s, %s, %s, %s, %s)
                """,
                (challenge_id, contact, key, method, hash_secret(code), expires_at),
            )

    result = {"id": challenge_id, "method": method, "contact": contact, "expiresAt": expires_at}
    if env_flag("YACHAT_RETURN_DEV_CODE", True):
        result["devCode"] = code
    return result


@app.post("/api/verify")
async def verify_challenge(request: Request):
    ensure_schema()
    payload = await request.json()
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

            existing = find_user_by_contact(key)
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
    ensure_schema()
    payload = await request.json()
    registration_token = str(payload.get("registrationToken") or "")
    display_name = clean_text(payload.get("displayName"), 60)
    username = normalize_username(payload.get("username")) or f"user_{secrets.randbelow(9000) + 1000}"
    bio = clean_text(payload.get("bio"), 140)
    avatar_url = clean_text(payload.get("avatarDataUrl"), 900000)
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

            existing = find_user_by_contact(str(challenge["contact_key"]))
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
    payload = await request.json()
    display_name = clean_text(payload.get("displayName"), 60)
    username = normalize_username(payload.get("username"))
    bio = clean_text(payload.get("bio"), 140)
    avatar_url = clean_text(payload.get("avatarDataUrl"), 900000)
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
    payload = await request.json()
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


@app.post("/api/contacts/lookup")
async def contacts_lookup(request: Request):
    payload = await request.json()
    return fetch_contact_matches(payload_contacts(payload))


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
    payload = await request.json()
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
                    insert into yachat_chats(id, kind, title, description, owner_id, created_at, updated_at)
                    values (%s, 'group', %s, %s, %s, now(), now())
                    returning *
                    """,
                    (chat_id, clean_text(payload.get("title"), 60), clean_text(payload.get("description"), 180), user["id"]),
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
    payload = await request.json()
    chat_id = str(payload.get("chatId") or "")

    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
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
                params.append(clean_text(payload.get("avatarDataUrl"), 900000))

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
    payload = await request.json()
    chat_id = str(payload.get("chatId") or "")

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


@app.post("/api/chat/leave")
async def leave_chat(request: Request):
    user = require_user(request)
    payload = await request.json()
    chat_id = str(payload.get("chatId") or "")

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


@app.post("/api/message")
async def send_message(request: Request):
    user = require_user(request)
    payload = await request.json()
    chat_id = str(payload.get("chatId") or "")
    text = clean_text(payload.get("text"), 4000)
    attachments = payload.get("attachments") if isinstance(payload.get("attachments"), list) else []
    if not text and not attachments:
        raise HTTPException(status_code=400, detail="Enter a message.")
    is_saved_chat = chat_id == "yachat-favorites"
    if chat_id.startswith("yachat-") and not is_saved_chat:
        raise HTTPException(status_code=400, detail="System chats are local only.")

    message_id = str(uuid.uuid4())
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            if is_saved_chat:
                chat_id = ensure_saved_chat(cursor, str(user["id"]))
            chat = require_chat_member(cursor, chat_id, str(user["id"]))
            if not bool(row_value(chat, "can_send") if "can_send" in chat else True):
                raise HTTPException(status_code=403, detail="This chat is read-only.")

            cursor.execute(
                """
                insert into yachat_messages(id, chat_id, sender_id, text, attachments, reply_to_message_id, created_at)
                values (%s, %s, %s, %s, %s::jsonb, %s, now())
                returning *
                """,
                (
                    message_id,
                    chat_id,
                    user["id"],
                    text,
                    json.dumps(attachments[:8]),
                    payload.get("replyToMessageId") or None,
                ),
            )
            message = dict(cursor.fetchone())
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
            recipients = [] if is_saved_chat else [str(row["user_id"]) for row in cursor.fetchall()]

    sender_name = str(row_value(user, "display_name", "preview_name", "username")) or "YaChat"
    body = text or "Новое вложение"
    for recipient_id in recipients:
        send_push_to_user(recipient_id, sender_name, body[:160], f"/?chat={chat_id}")

    return {
        "chats": list_user_chats(str(user["id"])),
        "messages": get_chat_messages(chat_id, str(user["id"])),
        "message": message_payload(message, str(user["id"])),
    }


@app.post("/api/chat/mark-read")
async def mark_chat_read(request: Request):
    user = require_user(request)
    payload = await request.json()
    chat_id = str(payload.get("chatId") or "")
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
    payload = await request.json()
    chat_id = str(payload.get("chatId") or "")
    message_id = str(payload.get("messageId") or "")
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            require_chat_member(cursor, chat_id, str(user["id"]))
            cursor.execute("select created_at from yachat_messages where id = %s and chat_id = %s", (message_id, chat_id))
            row = cursor.fetchone()
            if row:
                cursor.execute(
                    "update yachat_chat_members set last_read_at = %s where chat_id = %s and user_id = %s",
                    (row["created_at"] - timedelta(milliseconds=1), chat_id, user["id"]),
                )
    return {"chats": list_user_chats(str(user["id"]))}


@app.post("/api/message/delete")
async def delete_message(request: Request):
    user = require_user(request)
    payload = await request.json()
    chat_id = str(payload.get("chatId") or "")
    ids = payload.get("messageIds") if isinstance(payload.get("messageIds"), list) else [payload.get("messageId")]
    ids = [str(item or "") for item in ids if str(item or "")]
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            require_chat_member(cursor, chat_id, str(user["id"]))
            cursor.execute(
                "update yachat_messages set deleted_at = now() where chat_id = %s and sender_id = %s and id = any(%s)",
                (chat_id, user["id"], ids),
            )
    return {"chats": list_user_chats(str(user["id"])), "messages": get_chat_messages(chat_id, str(user["id"]))}


@app.post("/api/message/update")
async def update_message(request: Request):
    user = require_user(request)
    payload = await request.json()
    chat_id = str(payload.get("chatId") or "")
    message_id = str(payload.get("messageId") or "")
    text = clean_text(payload.get("text"), 4000)
    if not text:
        raise HTTPException(status_code=400, detail="Enter a message.")
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            require_chat_member(cursor, chat_id, str(user["id"]))
            cursor.execute(
                """
                update yachat_messages
                set text = %s, edited_at = now()
                where id = %s and chat_id = %s and sender_id = %s and deleted_at is null
                """,
                (text, message_id, chat_id, user["id"]),
            )
    return {"chats": list_user_chats(str(user["id"])), "messages": get_chat_messages(chat_id, str(user["id"]))}


@app.post("/api/message/forward")
async def forward_message(request: Request):
    user = require_user(request)
    payload = await request.json()
    from_chat_id = str(payload.get("fromChatId") or "")
    to_chat_id = str(payload.get("toChatId") or "")
    message_id = str(payload.get("messageId") or "")
    with connect_db() as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            require_chat_member(cursor, from_chat_id, str(user["id"]))
            require_chat_member(cursor, to_chat_id, str(user["id"]))
            cursor.execute("select * from yachat_messages where id = %s and chat_id = %s and deleted_at is null", (message_id, from_chat_id))
            source = cursor.fetchone()
            if not source:
                raise HTTPException(status_code=404, detail="Message not found.")
            cursor.execute(
                """
                insert into yachat_messages(id, chat_id, sender_id, text, attachments, forwarded_from, created_at)
                values (%s, %s, %s, %s, %s::jsonb, %s, now())
                """,
                (
                    str(uuid.uuid4()),
                    to_chat_id,
                    user["id"],
                    source["text"],
                    json.dumps(source["attachments"] or []),
                    from_chat_id,
                ),
            )
            cursor.execute("update yachat_chats set updated_at = now() where id = %s", (to_chat_id,))
    return {"chatId": to_chat_id, "chats": list_user_chats(str(user["id"])), "messages": get_chat_messages(to_chat_id, str(user["id"]))}


@app.post("/api/qr/create")
async def create_qr_session(request: Request):
    await request.json()
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
    payload = await request.json()
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
    payload = await request.json()
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
    key = os.getenv("YACHAT_VAPID_PUBLIC_KEY", "").strip()
    return {"enabled": bool(key), "publicKey": key}


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    user = require_user(request)
    payload = await request.json()
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
