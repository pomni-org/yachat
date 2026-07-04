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

- `YACHAT_USERS_DB_URL`: hosted Postgres connection string. The API also accepts `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_URL`, `POSTGRES_URL_POOLER`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL`, `NEON_DATABASE_URL`, `NEON_DATABASE_URL_UNPOOLED`, and `SUPABASE_DB_URL`.
- `YACHAT_AUTH_SECRET`: secret used to hash sessions, confirmation codes, and registration tokens.
- `YACHAT_PUBLIC_USER_LIMIT`: optional, defaults to `100`.
- `YACHAT_PUBLIC_CONTACTS`: optional, defaults to `false`.
- `YACHAT_RETURN_DEV_CODE`: optional, defaults to `true`. Keep it enabled for test builds without an SMS provider.
- `YACHAT_VAPID_PUBLIC_KEY`: public VAPID key for browser push notifications.
- `YACHAT_VAPID_PRIVATE_KEY`: private VAPID key for browser push notifications.
- `YACHAT_VAPID_SUBJECT`: optional VAPID subject, for example `mailto:admin@example.com`.
- `YACHAT_CORS_ORIGINS`: optional comma-separated list for external clients. Defaults to `*`.
- `YACHAT_FORCE_HTTPS`: optional, defaults to `true`. Redirects proxied HTTP API requests to HTTPS.

Do not commit real environment values.

## Database contract

The Python API creates and migrates the required tables on first request when Postgres is configured.
The main public account table is `public_users`.

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
Settings and QR login state are also stored server-side in `yachat_user_settings` and `yachat_qr_sessions`.

See `docs/vercel-users-db.sql` for a starter public-user schema if you want to prepare the database manually.

## Local fallback

The browser fallback is no longer automatic on localhost. This keeps broken Vercel/Postgres setups visible instead of silently creating local-only accounts.

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
