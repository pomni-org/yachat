import re
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from api.index import (
    clean_text,
    configured_cors_origins,
    connect_db,
    enforce_rate_limit,
    read_json_payload,
    require_user,
)
from server.push_delivery import push_subscription_count, send_push_to_user, vapid_public_key

app = FastAPI(title="YaChat push API", version="0.4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

_DEVICE_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


def normalize_content_encoding(value: Any) -> str:
    encoding = str(value or "aes128gcm").strip().lower()
    return encoding if encoding in {"aes128gcm", "aesgcm"} else "aes128gcm"


def normalize_device_id(value: Any) -> str:
    device_id = clean_text(value, 128)
    return device_id if _DEVICE_ID_PATTERN.fullmatch(device_id) else ""


@app.get("/api/push/public-key")
def push_public_key():
    key = vapid_public_key()
    return {"enabled": bool(key), "publicKey": key, "version": 4}


@app.get("/api/push/status")
def push_status(request: Request):
    user = require_user(request)
    count = push_subscription_count(str(user["id"]))
    return {
        "enabled": bool(vapid_public_key()),
        "subscribed": count > 0,
        "subscriptions": count,
    }


@app.post("/api/push/subscribe")
async def push_subscribe(request: Request):
    user = require_user(request)
    payload = await read_json_payload(request)
    endpoint = clean_text(payload.get("endpoint"), 2048)
    keys = payload.get("keys") if isinstance(payload.get("keys"), dict) else {}
    p256dh = clean_text(keys.get("p256dh"), 512)
    auth = clean_text(keys.get("auth"), 256)
    content_encoding = normalize_content_encoding(
        payload.get("contentEncoding") or payload.get("content_encoding")
    )
    device_id = normalize_device_id(payload.get("deviceId") or payload.get("device_id"))
    user_agent = clean_text(request.headers.get("user-agent"), 500)
    user_id = str(user["id"])
    if not endpoint or not p256dh or not auth:
        raise HTTPException(status_code=400, detail="Invalid push subscription.")

    removed_subscriptions = 0
    with connect_db() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "select user_id from yachat_push_subscriptions where endpoint = %s limit 1",
                (endpoint,),
            )
            previous = cursor.fetchone()

            if device_id:
                cursor.execute(
                    """
                    delete from yachat_push_subscriptions
                    where user_id = %s
                      and endpoint <> %s
                      and (
                        device_id = %s
                        or (
                          coalesce(device_id, '') = ''
                          and %s <> ''
                          and user_agent = %s
                        )
                      )
                    returning endpoint
                    """,
                    (user_id, endpoint, device_id, user_agent, user_agent),
                )
                removed_subscriptions = len(cursor.fetchall())

            cursor.execute(
                """
                insert into yachat_push_subscriptions(
                    endpoint, user_id, p256dh, auth, content_encoding,
                    user_agent, device_id, updated_at
                )
                values (%s, %s, %s, %s, %s, %s, %s, now())
                on conflict (endpoint) do update
                set user_id = excluded.user_id,
                    p256dh = excluded.p256dh,
                    auth = excluded.auth,
                    content_encoding = excluded.content_encoding,
                    user_agent = excluded.user_agent,
                    device_id = case
                        when excluded.device_id <> '' then excluded.device_id
                        else yachat_push_subscriptions.device_id
                    end,
                    updated_at = now()
                """,
                (
                    endpoint,
                    user_id,
                    p256dh,
                    auth,
                    content_encoding,
                    user_agent,
                    device_id,
                ),
            )

    return {
        "ok": True,
        "created": previous is None,
        "contentEncoding": content_encoding,
        "deviceId": device_id,
        "removedSubscriptions": removed_subscriptions,
        "subscriptions": push_subscription_count(user_id),
    }


@app.post("/api/push/test")
async def push_test(request: Request):
    user = require_user(request)
    enforce_rate_limit(request, "push-test", 5, 600)
    await read_json_payload(request)
    result = send_push_to_user(
        str(user["id"]),
        "ЯЧат",
        "Фоновые уведомления работают",
        "/",
        tag="push-test",
        ttl_seconds=600,
    )
    return {"ok": result.get("sent", 0) > 0, **result}
