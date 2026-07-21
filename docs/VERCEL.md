# YaChat on Vercel

This repository is prepared for a Vercel deployment of the YaChat web UI and Python API.

## What is deployed

- Static renderer files are copied from `src/renderer` into the generated `public` output during `npm run build:vercel`.
- `api/index.py` exposes the Python API for accounts, sessions, public user search, chats, messages, and Web Push subscriptions.
- The web runtime is server-first: accounts, sessions, public users, chats, messages, QR sessions, settings, and push subscriptions go through `/api/*`.
- The desktop Electron runtime can still use the local backend from `src/main.cjs` when it is opened as a local file build.

## What is not deployed

- User runtime data is not stored in the Vercel filesystem.
- Local secrets and `.env` files are ignored.
- The Python API does not read local user folders or private desktop runtime files.

## Required Vercel environment variables

Set these in Vercel Project Settings:

- `SUPABASE_DB_URL`: Supabase Supavisor transaction-pooler connection string (port `6543`). This is the only database variable accepted by the API, so an old provider integration cannot be selected accidentally.
- `YACHAT_AUTH_SECRET`: secret used to hash sessions, confirmation codes, and registration tokens.
- `YACHAT_PUBLIC_USER_LIMIT`: optional, defaults to `100`.
- `YACHAT_PUBLIC_CONTACTS`: optional, defaults to `false`.
- `YACHAT_RETURN_DEV_CODE`: optional, defaults to `false`. Enable only for isolated test builds.
- `YACHAT_TELEGRAM_BOT_TOKEN`: optional Telegram bot token for confirmation-code delivery.
- `YACHAT_TELEGRAM_WEBHOOK_SECRET`: optional secret passed to Telegram `setWebhook` as `secret_token`.
- `YACHAT_VAPID_PUBLIC_KEY`: public VAPID key for browser push notifications.
- `YACHAT_VAPID_PRIVATE_KEY`: private VAPID key for browser push notifications.
- `YACHAT_VAPID_SUBJECT`: optional VAPID subject, for example `mailto:admin@example.com`.
- `YACHAT_CORS_ORIGINS`: optional comma-separated list for external clients. Defaults to `*`.
- `YACHAT_FORCE_HTTPS`: optional, defaults to `true`. Redirects proxied HTTP API requests to HTTPS.

Do not commit real environment values.

## Database contract

The Python API creates and migrates the required tables on first request when Supabase is configured.
The main public account table is `public_users`.

All YaChat tables have Row Level Security enabled and grants to Supabase's `anon` and `authenticated` roles revoked. The browser never receives the database connection string and talks only to the YaChat API.

If an older database was prepared with the previous `public_users` view over `yachat_users`, the API now migrates it on startup:

1. drops the old `public_users` view,
2. creates the writable `public_users` table,
3. copies existing rows from `yachat_users` when that table exists.

Current public account columns:

- `id`
- `username`
- `preview_name`
- `display_name`
- `bio`
- `avatar_url`
- `avatar_accent`
- `created_at`
- `public_key_type`
- `is_public`
- `contact`
- `contact_key`
- `method`
- `updated_at`

Only safe profile fields are returned to the browser. The raw contact is returned only when `YACHAT_PUBLIC_CONTACTS=true`.

Chat and push tables are created with the `yachat_` prefix.
Settings, QR login state, Telegram links, and private system-code messages are also stored server-side in `yachat_user_settings`, `yachat_qr_sessions`, `yachat_telegram_links`, and `yachat_system_messages`.

## Confirmation codes

Production confirmation codes are not returned to the browser unless `YACHAT_RETURN_DEV_CODE=true`.
When a code is requested, the user chooses one secure channel that is already tied to the phone number:

- the built-in YaChat chat `Коды подтверждения` on an existing signed-in device;
- the Telegram bot after the user starts it and shares their own Telegram contact.

The API does not silently switch channels. If the selected channel is not available, it returns a clear error so the user can choose the other method or link the bot first.

Configure the Telegram webhook after setting the env values:

```powershell
$token = "<YACHAT_TELEGRAM_BOT_TOKEN>"
$secret = "<YACHAT_TELEGRAM_WEBHOOK_SECRET>"
$url = "https://your-domain.example/api/telegram/webhook"
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -Body @{ url = $url; secret_token = $secret }
```

See `docs/vercel-users-db.sql` for the server schema if you want to prepare the database manually. The application connects from Vercel through Supavisor transaction mode and disables psycopg prepared statements, as required by that pooler mode.

## Local fallback

The browser fallback is no longer automatic on localhost. This keeps broken Vercel/Supabase setups visible instead of silently creating local-only accounts.

Production web builds are HTTPS-first. If the app is opened through a non-local `http://` URL, the renderer redirects to the same URL on `https://`, and the API adds HSTS on HTTPS responses.

For temporary offline UI testing only, open the app with `?local=1` or set:

```js
localStorage.setItem("yachat-dev-local-fallback", "true")
```

## Notifications

Browser push notifications work through the service worker at `/sw.js`.
They require HTTPS, granted browser notification permission, a saved push subscription, and valid VAPID keys in Vercel environment variables.

When a user sends a message, the API stores it in Postgres and sends Web Push to the other chat members that have subscribed on their phone or device.

## Deployment Protection

The public chat site must not be behind Vercel Deployment Protection/SSO.
If Vercel returns an HTML login page from `/api/*`, the app will now show a server error instead of silently falling back to local browser storage.

## Local checks

```powershell
npm run check
npm run build:vercel
python -m py_compile api/index.py
```

## Vercel Git setup

1. Push this repository to GitHub.
2. Import the repository in Vercel.
3. Use framework preset `Other`.
4. Keep the root directory as the repository root.
5. Vercel will use `vercel.json`:
   - build command: `npm run build:vercel`
   - output directory: `public`
   - Python API: `api/index.py`
