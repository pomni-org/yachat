import os
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


def public_user(row: dict[str, Any]) -> dict[str, Any]:
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
