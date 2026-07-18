import secrets
import uuid
from datetime import timedelta
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row

from api.index import (
    add_system_delivery_message,
    configured_cors_origins,
    connect_db,
    contact_key,
    delivery_method,
    enforce_rate_limit,
    ensure_schema,
    env_flag,
    find_user_by_contact_cursor,
    hash_secret,
    normalize_contact,
    read_json_payload,
    send_telegram_verification_code,
    telegram_bot_token,
    telegram_links_for_contact,
    utc_now,
    verification_code_html,
    verification_code_text,
)
from server.push_delivery import send_push_to_user

app = FastAPI(title="YaChat challenge API", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_cors_origins(),
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


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
    delivery: dict[str, Any] = {"yachat": False, "telegram": False, "dev": False}
    return_dev_code = env_flag("YACHAT_RETURN_DEV_CODE", False)
    existing_user_id = ""

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
                existing_user_id = str(existing_user["id"])
                add_system_delivery_message(
                    cursor,
                    existing_user_id,
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

    push: dict[str, Any] = {}
    if existing_user_id and delivery["yachat"]:
        push = send_push_to_user(
            existing_user_id,
            "Коды подтверждения",
            "Получен новый одноразовый код",
            "/verificationcodes_bot",
            tag="verification-code",
            ttl_seconds=600,
        )

    result: dict[str, Any] = {
        "id": challenge_id,
        "method": method,
        "contact": contact,
        "expiresAt": expires_at,
        "deliveryMethod": selected_delivery,
        "delivery": delivery,
        "push": push,
    }
    if return_dev_code:
        result["devCode"] = code
        delivery["dev"] = True
    return result
