# YaChat on Vercel

This repository is prepared for a Vercel deployment of the YaChat web UI and Python API.

## What is deployed

- Static renderer files are copied from `src/renderer` into the generated `public` output during `npm run build:vercel`.
- `api/index.py` exposes the Python API for accounts, sessions, public user search, chats, messages, and Web Push subscriptions.
- The desktop Electron runtime still uses the local backend from `src/main.cjs`.

## What is not deployed

- User runtime data is not stored in the Vercel filesystem.
- Local secrets and `.env` files are ignored.
- The Python API does not read local user folders or private desktop runtime files.

## Required Vercel environment variables

Set these in Vercel Project Settings:

- `YACHAT_USERS_DB_URL`: hosted Postgres connection string. `DATABASE_URL` is also accepted.
- `YACHAT_AUTH_SECRET`: secret used to hash sessions, confirmation codes, and registration tokens.
- `YACHAT_PUBLIC_USER_LIMIT`: optional, defaults to `100`.
- `YACHAT_PUBLIC_CONTACTS`: optional, defaults to `false`.
- `YACHAT_RETURN_DEV_CODE`: optional, defaults to `true`. Keep it enabled for test builds without an SMS provider.
- `YACHAT_VAPID_PUBLIC_KEY`: public VAPID key for browser push notifications.
- `YACHAT_VAPID_PRIVATE_KEY`: private VAPID key for browser push notifications.
- `YACHAT_VAPID_SUBJECT`: optional VAPID subject, for example `mailto:admin@example.com`.

Do not commit real environment values.

## Database contract

The Python API creates and migrates the required tables on first request when Postgres is configured.
The main public account table is `public_users`.

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

See `docs/vercel-users-db.sql` for a starter public-user schema if you want to prepare the database manually.

## Notifications

Browser push notifications work through the service worker at `/sw.js`.
They require HTTPS, granted browser notification permission, a saved push subscription, and valid VAPID keys in Vercel environment variables.

When a user sends a message, the API stores it in Postgres and sends Web Push to the other chat members that have subscribed on their phone or device.

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
