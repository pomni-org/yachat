import hmac
import html

from fastapi import FastAPI, HTTPException, Request

from api.index import (
    clean_text,
    connect_db,
    contact_key,
    ensure_schema,
    normalize_contact,
    telegram_webhook_secret,
)
from api.telegram_brand import (
    branded_heading,
    send_telegram_html_message,
    telegram_bot_token,
    telegram_contact_keyboard,
    telegram_remove_keyboard,
)

app = FastAPI(title="YaChat Telegram bot API", version="0.4.0")


@app.middleware("http")
async def harden_response(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
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
                cursor.execute(
                    "delete from yachat_telegram_links where telegram_user_id = %s",
                    (telegram_user_id,),
                )
        send_telegram_html_message(
            chat_id,
            f"{branded_heading('unlink', 'Привязка удалена')}\n\n"
            "Коды ЯЧата сюда больше не придут.",
            telegram_remove_keyboard(),
        )
        return {"ok": True}

    contact = message.get("contact") if isinstance(message.get("contact"), dict) else None
    if contact:
        contact_user_id = str(contact.get("user_id") or "")
        phone = normalize_contact(contact.get("phone_number"))
        key = contact_key(phone)

        if not contact_user_id or contact_user_id != telegram_user_id or not key:
            send_telegram_html_message(
                chat_id,
                f"{branded_heading('warning', 'Нужен ваш Telegram-номер')}\n\n"
                "Нажмите кнопку ниже и отправьте свой контакт.",
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

        send_telegram_html_message(
            chat_id,
            f"{branded_heading('success', 'Готово')}\n\n"
            f"Коды входа ЯЧата для номера <code>{html.escape(phone)}</code> будут приходить сюда.\n\n"
            "Если передумаете, отправьте <code>/stop</code>.",
            telegram_remove_keyboard(),
        )
        return {"ok": True}

    send_telegram_html_message(
        chat_id,
        f"{branded_heading('hello', 'Бот кодов ЯЧата')}\n\n"
        "Нажмите кнопку ниже и поделитесь номером, чтобы привязать Telegram к подтверждению входа.",
        telegram_contact_keyboard(),
    )
    return {"ok": True}
