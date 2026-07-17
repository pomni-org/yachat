from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "api" / "index.py"


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, got {count}")
    return source.replace(old, new, 1)


def regex_once(source: str, pattern: str, replacement: str, label: str, flags: int = 0) -> str:
    result, count = re.subn(pattern, replacement, source, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, got {count}")
    return result


api = API.read_text("utf-8")

api = replace_once(
    api,
    "QR_SESSION_TTL_MINUTES = 5\n",
    "DEVICE_CODE_TTL_MINUTES = 10\nQR_SESSION_TTL_MINUTES = 5\n",
    "device code ttl",
)

api = replace_once(
    api,
    "def generate_token() -> str:\n    return secrets.token_urlsafe(36)\n\n\n",
    '''def generate_token() -> str:\n    return secrets.token_urlsafe(36)\n\n\nDEVICE_CODE_ALPHABETS = {\n    "ru": "АБВГДЕЖЗКЛМНПРСТУФХЦЧШЭЮЯ",\n    "en": "ABCDEFGHJKLMNPQRSTUVWXYZ",\n}\n\n\ndef normalize_device_code(value: Any) -> str:\n    return re.sub(r"[^0-9A-ZА-ЯЁ]+", "", str(value or "").upper().replace("Ё", "Е"))[:6]\n\n\ndef format_device_code(value: str) -> str:\n    normalized = normalize_device_code(value)\n    return f"{normalized[:3]}-{normalized[3:]}" if len(normalized) == 6 else normalized\n\n\ndef generate_device_code(language: str = "ru") -> tuple[str, str]:\n    alphabet = DEVICE_CODE_ALPHABETS["en" if language == "en" else "ru"]\n    letter_count = secrets.choice((2, 3))\n    raw = "".join(secrets.choice(alphabet) for _ in range(letter_count))\n    raw += "".join(str(secrets.randbelow(10)) for _ in range(6 - letter_count))\n    return raw, format_device_code(raw)\n\n\n''',
    "device code helpers",
)

api = replace_once(
    api,
    'f"Код: <strong>{html.escape(code)}</strong><br><br>"',
    'f"Код: <code>{html.escape(code)}</code><br><br>"',
    "verification code monospace",
)

api = replace_once(
    api,
    '''        "create index if not exists yachat_push_subscriptions_user_idx on yachat_push_subscriptions(user_id)",\n        """\n        create table if not exists yachat_user_settings (''',
    '''        "create index if not exists yachat_push_subscriptions_user_idx on yachat_push_subscriptions(user_id)",\n        """\n        create table if not exists yachat_device_codes (\n            id text primary key,\n            user_id text not null references public_users(id) on delete cascade,\n            code_hash text not null unique,\n            display_code text not null,\n            language text default 'ru',\n            created_at timestamptz default now(),\n            expires_at timestamptz not null,\n            used_at timestamptz\n        )\n        """,\n        "create index if not exists yachat_device_codes_user_idx on yachat_device_codes(user_id, created_at desc)",\n        "create index if not exists yachat_device_codes_expiry_idx on yachat_device_codes(expires_at, used_at)",\n        """\n        create table if not exists yachat_data_migrations (\n            id text primary key,\n            applied_at timestamptz default now()\n        )\n        """,\n        """\n        create table if not exists yachat_user_settings (''',
    "device code schema",
)

api = replace_once(
    api,
    '''def cleanup_removed_test_messages(cursor) -> None:\n    cursor.execute(\n        "delete from yachat_messages where trim(coalesce(text, '')) = any(%s)",\n        (list(REMOVED_TEST_MESSAGE_TEXTS),),\n    )\n\n\ndef ensure_schema() -> None:''',
    '''def cleanup_removed_test_messages(cursor) -> None:\n    cursor.execute(\n        "delete from yachat_messages where trim(coalesce(text, '')) = any(%s)",\n        (list(REMOVED_TEST_MESSAGE_TEXTS),),\n    )\n\n\ndef apply_data_migrations(cursor) -> None:\n    migration_id = "2026-07-clear-verification-code-history"\n    cursor.execute("select 1 from yachat_data_migrations where id = %s limit 1", (migration_id,))\n    if cursor.fetchone():\n        return\n    cursor.execute("delete from yachat_system_messages where chat_id = 'yachat-codes'")\n    cursor.execute("insert into yachat_data_migrations(id, applied_at) values (%s, now())", (migration_id,))\n\n\ndef ensure_schema() -> None:''',
    "one-time history migration",
)

api = replace_once(
    api,
    '''                for statement in statements:\n                    cursor.execute(statement)\n                cleanup_removed_test_messages(cursor)''',
    '''                for statement in statements:\n                    cursor.execute(statement)\n                apply_data_migrations(cursor)\n                cleanup_removed_test_messages(cursor)''',
    "run data migration",
)

api = regex_once(
    api,
    r'''def system_chat_messages\(chat_id: str\) -> list\[dict\[str, Any\]\]:\n(?:    .*\n)+?\n\ndef system_message_payload''',
    '''def system_chat_messages(chat_id: str) -> list[dict[str, Any]]:\n    return []\n\n\ndef system_message_payload''',
    "remove codes intro",
)

api = replace_once(
    api,
    '''                vapid_private_key=private_key,\n                vapid_claims=claims,\n            )''',
    '''                vapid_private_key=private_key,\n                vapid_claims=claims,\n                ttl=0,\n                headers={"Urgency": "high"},\n            )''',
    "high urgency push",
)

endpoints = r'''

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
    if len(raw_code) != 6 or not any(character.isalpha() for character in raw_code) or not any(character.isdigit() for character in raw_code):
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
'''

api = replace_once(api, '\n\n@app.get("/api/status")\n', endpoints + '\n\n@app.get("/api/status")\n', "device code endpoints")

api = api.replace('clean_text(payload.get("avatarDataUrl"), 900000)', 'clean_text(payload.get("avatarDataUrl"), 3500000)')
api = api.replace('clean_text(payload.get("avatarDataUrl"), 900000)', 'clean_text(payload.get("avatarDataUrl"), 3500000)')

for marker in (
    'DEVICE_CODE_TTL_MINUTES = 10',
    '@app.post("/api/device-code/redeem")',
    '2026-07-clear-verification-code-history',
    'ttl=0',
    'def system_chat_messages(chat_id: str) -> list[dict[str, Any]]:\n    return []',
):
    if marker not in api:
        raise RuntimeError(f"missing marker after patch: {marker}")

API.write_text(api, "utf-8")
