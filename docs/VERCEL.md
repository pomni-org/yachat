# YaChat on Vercel

This repository is prepared for a safe Vercel preview of the YaChat web UI.

## What is deployed

- Static renderer files are copied from `src/renderer` into the generated `public` output during `npm run build:vercel`.
- `api/index.py` exposes a small Python API for public user directory data.
- The desktop Electron runtime still uses the local backend from `src/main.cjs`.

## What is not deployed

- User runtime data is ignored by Git and Vercel.
- Local secrets and `.env` files are ignored.
- The Python API does not read local user folders or private desktop runtime files.

## Required Vercel environment variables

Set these in Vercel Project Settings:

- `YACHAT_USERS_DB_URL`: hosted Postgres connection string.
- `YACHAT_PUBLIC_USER_LIMIT`: optional, defaults to `100`.
- `YACHAT_PUBLIC_CONTACTS`: optional, defaults to `false`.

Do not commit real environment values.

## Database contract

The Python API reads from a database view or table named `public_users`.
Use a view so private account data can stay in internal tables while the app receives only safe public fields.

Expected columns:

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

Optional column:

- `contact`, returned only when `YACHAT_PUBLIC_CONTACTS=true`

See `docs/vercel-users-db.sql` for a starter schema.

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

