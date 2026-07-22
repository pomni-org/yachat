"""Owner-only YaChat Digital ID endpoint.

The human-readable ID is returned only to the currently authenticated account.
Creation is atomic and one-time; the database rejects every later attempt to
change an existing ID. Third-party identity verification never receives it.
"""

import psycopg
from fastapi import FastAPI, HTTPException, Request
from psycopg.rows import dict_row

from api.index import connect_db, ensure_schema, format_digital_id, normalize_digital_id, require_user


app = FastAPI(
    title="YaChat private Digital ID boundary",
    version="1.3.0",
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
                    cursor.execute(
                        "select public.yachat_get_or_create_digital_id(%s) as digital_id",
                        (user_id,),
                    )
                    row = cursor.fetchone()
    except psycopg.errors.NoDataFound as error:
        raise HTTPException(status_code=404, detail="Account not found.") from error
    except psycopg.Error as error:
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


@app.get("/api/developer/v1/health")
def digital_id_health():
    return {
        "ok": True,
        "service": "yachat-digital-id",
        "version": "1.3.0",
        "proof": "otp-pkce-one-time-token",
        "digitalIdExposure": "owner-session-only",
        "immutable": True,
    }
